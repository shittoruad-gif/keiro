'use strict';
// チャネルアクセストークンの自動発行・自動更新。
// Channel ID と Channel secret が揃っていれば、LINE Developersを開かずにトークンを発行できる
// （v2 client_credentials・30日有効）。期限の7日前を切ったら自動で再発行して差し替える。
const line = require('./line');
const tenantmod = require('./tenant');
const logger = require('./logger');

const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

/** 指定テナントのトークンを発行して保存する。 */
async function issueForTenant(db, tenant, opts = {}) {
  const settings = tenantmod.resolveSettings(tenant);
  const channelId = String(opts.channelId || tenant.line_channel_id || '').trim();
  const secret = opts.channelSecret || settings.line.channelSecret;
  if (!channelId) return { ok: false, error: 'Channel ID が未設定です' };
  if (!secret) return { ok: false, error: 'Channel secret が未設定です' };
  const r = await (opts.issue || line.issueChannelAccessToken)(channelId, secret);
  if (!r.ok) return { ok: false, error: r.error || 'トークン発行に失敗しました', http_status: r.http_status };
  const expiresAt = Date.now() + r.expiresIn * 1000;
  tenantmod.updateTenantSettings(db, tenant.id, {
    line_channel_access_token: r.accessToken,
    line_channel_id: channelId,
    line_token_expires_at: expiresAt,
    line_token_auto: 1,
  });
  // 新しいトークンが出せた＝接続は生きている。毎朝の疎通チェックで付いた「失効」の印を外す
  db.prepare('UPDATE tenants SET line_token_error_at = NULL WHERE id = ?').run(tenant.id);
  logger.info('line token issued', { tenant_id: tenant.id, expires_at: expiresAt });
  return { ok: true, expiresAt };
}

/**
 * Channel ID ＋ Channel secret だけでLINEにつなぐ（店舗の画面・運営画面の共通処理）。
 * 2026-10-25 Auto Shop ZERO 様（@094fhnfy）：前の業者のプロバイダーでMessaging APIが有効化されていて、
 * 長期トークンを誰も発行できない。Channel ID と Channel secret は公式アカウントの管理画面
 * （設定 → Messaging API）で見られるので、それだけでつながるようにする。
 *
 * トークンは 30日の短期トークン（v2）をKeiroが発行し、期限の7日前に自動で出し直す（processTokenRenewals）。
 * ステートレス（v3）も Channel secret だけで出せるが、15分で切れるため使わない
 * （Keiroは保存したトークンを読んで送る作りで、更新が1回つまずくと15分で全送信が止まる）。
 *
 * 長期トークン（accessToken）を渡したときはそれを使い、自動更新はしない。
 * 発行・確認に失敗したときは何も保存しない（今の設定を壊さない）。
 * 返り値: { ok, mode: 'auto'|'manual', bot_name, basic_id, expires_at } / { ok:false, error }
 */
async function connect(db, tenant, opts = {}) {
  const channelId = String(opts.channelId || '').replace(/\s/g, '');
  const secretIn = String(opts.channelSecret || '').replace(/\s/g, '');
  const tokenIn = String(opts.accessToken || '').trim();
  const settings = tenantmod.resolveSettings(tenant);
  const secret = secretIn || settings.line.channelSecret;
  if (!secret) return { ok: false, error: 'Channel secret を入力してください' };
  if (secretIn && !/^[0-9a-f]{32}$/i.test(secretIn)) return { ok: false, error: 'Channel secret は英数字32文字です。コピーの範囲をご確認ください' };
  if (!tokenIn) {
    const cid = channelId || String(tenant.line_channel_id || '');
    if (!cid) return { ok: false, error: 'Channel ID を入力してください' };
    if (!/^\d{6,12}$/.test(cid)) return { ok: false, error: 'Channel ID は数字（10桁ほど）です。コピーの範囲をご確認ください' };
  }
  const botInfo = opts.botInfo || line.getBotInfo;

  let token, expiresAt = null, mode;
  if (tokenIn) {
    token = tokenIn; mode = 'manual';
  } else {
    const r = await (opts.issue || line.issueChannelAccessToken)(channelId || tenant.line_channel_id, secret);
    if (!r.ok) {
      const bad = r.http_status === 400 || r.http_status === 401;
      return { ok: false, http_status: r.http_status, error: bad
        ? 'LINEがトークンを発行しませんでした。Channel ID と Channel secret が同じ公式アカウントのものか、ご確認ください（' + (r.error || 'invalid') + '）'
        : 'LINEにつながりませんでした。少し時間をおいて、もう一度お試しください（' + (r.error || r.http_status) + '）' };
    }
    token = r.accessToken; expiresAt = Date.now() + r.expiresIn * 1000; mode = 'auto';
  }
  // 保存する前に、このトークンで公式アカウントの情報が取れるか確かめる
  const info = await botInfo(token);
  if (!info || !info.ok) {
    return { ok: false, http_status: info && info.http_status, error: mode === 'manual'
      ? 'このアクセストークンでは公式アカウントにつながりませんでした（失効しているか、別のアカウントのものです）'
      : '発行したトークンで公式アカウントにつながりませんでした（' + ((info && info.http_status) || '') + '）' };
  }
  const fields = { line_channel_access_token: token, line_token_auto: mode === 'auto' ? 1 : 0, line_token_expires_at: expiresAt };
  if (secretIn) fields.line_channel_secret = secretIn;
  if (channelId) fields.line_channel_id = channelId;
  tenantmod.updateTenantSettings(db, tenant.id, fields);
  db.prepare('UPDATE tenants SET line_token_error_at = NULL WHERE id = ?').run(tenant.id);
  const bot = (info.info) || {};
  logger.info('line connected', { tenant_id: tenant.id, mode, by: opts.by || 'tenant', basic_id: bot.basicId || null });
  return { ok: true, mode, bot_name: bot.displayName || null, basic_id: bot.basicId || null, expires_at: expiresAt };
}

/**
 * つながっているかを、保存されている値だけで判定する（LINEに問い合わせない・同期）。
 *  connected: Channel secret とトークンがあり、毎朝の疎通チェックで失効の印が付いていない
 *  working:   connected に加えて、LINEからの連絡（Webhook）を一度でも受け取った
 * 「完了しています」「正常に動作しております」は working のときだけ出す（2026-10-25 誤表示の修正）。
 */
function health(tenant) {
  const s = tenantmod.resolveSettings(tenant);
  const secretSet = !!s.line.channelSecret;
  const tokenSet = !!s.line.channelAccessToken;
  const tokenError = !!tenant.line_token_error_at;
  const connected = secretSet && tokenSet && !tokenError;
  return {
    secret_set: secretSet, token_set: tokenSet, token_error: tokenError,
    webhook_received: !!tenant.webhook_last_at,
    connected, working: connected && !!tenant.webhook_last_at,
    auto: !!tenant.line_token_auto, expires_at: tenant.line_token_expires_at || null,
    channel_id: tenant.line_channel_id || null,
  };
}

/**
 * Webhookの送り先をKeiroに切り替える。切り替える前の値は tenants.line_webhook_prev_url に残す（戻すため）。
 * すでにKeiroを向いていれば何もしない。
 */
async function switchWebhook(db, tenant, webhookUrl, opts = {}) {
  const token = tenantmod.resolveSettings(tenant).line.channelAccessToken;
  if (!token) return { ok: false, error: '先にLINEにつないでください' };
  const get = opts.get || line.getWebhookEndpoint;
  const set = opts.set || line.setWebhookEndpoint;
  const cur = await get(token);
  if (!cur.ok) return { ok: false, error: 'いまのWebhookの送り先を読めませんでした（' + (cur.error || cur.http_status) + '）' };
  if (cur.endpoint === webhookUrl) return { ok: true, changed: false, endpoint: cur.endpoint, active: cur.active };
  const r = await set(token, webhookUrl);
  if (!r.ok) return { ok: false, error: 'Webhookの送り先を切り替えられませんでした（' + (r.error || r.http_status) + '）' };
  db.prepare('UPDATE tenants SET line_webhook_prev_url = ?, updated_at = ? WHERE id = ?').run(cur.endpoint || '', Date.now(), tenant.id);
  logger.info('line webhook switched', { tenant_id: tenant.id, by: opts.by || 'tenant', had_prev: !!cur.endpoint });
  return { ok: true, changed: true, endpoint: webhookUrl, prev_endpoint: cur.endpoint || '', active: cur.active };
}

/** 自動発行テナントのうち期限が近い/不明なものを再発行する（スケジューラから呼ぶ）。 */
async function processTokenRenewals(db, opts = {}) {
  const now = opts.now || Date.now();
  const rows = db.prepare(
    "SELECT * FROM tenants WHERE role='tenant' AND line_token_auto=1 AND line_channel_id IS NOT NULL AND line_channel_secret IS NOT NULL"
  ).all();
  let renewed = 0, failed = 0;
  for (const t of rows) {
    const exp = Number(t.line_token_expires_at || 0);
    if (exp && exp - now > RENEW_BEFORE_MS) continue;
    const r = await issueForTenant(db, t, { issue: opts.issue });
    if (r.ok) renewed++;
    else { failed++; logger.warn('line token renew failed', { tenant_id: t.id, err: r.error }); }
  }
  return { checked: rows.length, renewed, failed };
}

module.exports = { issueForTenant, processTokenRenewals, connect, health, switchWebhook, RENEW_BEFORE_MS };
