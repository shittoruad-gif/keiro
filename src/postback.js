'use strict';

const logger = require('./logger');
const config = require('./config');
const { sha256hex, newId } = require('./sign');
const { resolveSettings } = require('./tenant');

/**
 * Meta Conversions API へ Lead を送信。settings.meta を使用。
 * fbc は "fb.1.<クリック時刻ms>.<fbclid>"、external_id=sha256(line_user_id)。
 */
async function sendMeta(settings, { lineUserId, fbclid, clickMs, ip, ua, eventSourceUrl, eventId, eventTime, eventName, phHash, emHash, value }) {
  const m = settings.meta;
  if (!m.pixelId || !m.capiToken) return { ok: false, skipped: true, reason: 'META未設定' };
  const url = `https://graph.facebook.com/${m.graphVersion}/${m.pixelId}/events`;

  const userData = {};
  if (lineUserId) userData.external_id = sha256hex(lineUserId);
  // フォームの回答から取った電話・メール（保存・再送用の ctx には、暗号化した値だけを置く）
  if (phHash) userData.ph = [phHash];
  if (emHash) userData.em = [emHash];
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  if (fbclid && clickMs) userData.fbc = `fb.1.${clickMs}.${fbclid}`;

  const payload = {
    data: [{
      event_name: eventName || 'Lead',
      // event_id/event_time は再送でも同一値（ctx由来）。Metaがこれで重複排除しLeadの二重計上を防ぐ。
      event_id: eventId || undefined,
      event_time: eventTime || Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: eventSourceUrl || config.baseUrl,
      user_data: userData,
      ...(value != null ? { custom_data: { currency: 'JPY', value: Number(value) || 0 } } : {}),
    }],
    access_token: m.capiToken,
  };
  if (m.testEventCode) payload.test_event_code = m.testEventCode;
  return postJson(url, {}, payload);
}

/** TikTok Events API へ CompleteRegistration を送信。Access-Token ヘッダ。 */
async function sendTikTok(settings, { lineUserId, ttclid, ip, ua, eventSourceUrl, eventId, eventTime }) {
  const t = settings.tiktok;
  if (!t.pixelId || !t.accessToken) return { ok: false, skipped: true, reason: 'TIKTOK未設定' };
  const url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

  const user = { external_id: sha256hex(lineUserId) };
  if (ip) user.ip = ip;
  if (ua) user.user_agent = ua;
  if (ttclid) user.ttclid = ttclid;

  const payload = {
    event_source: 'web',
    event_source_id: t.pixelId,
    data: [{
      event: 'CompleteRegistration',
      // event_id/event_time は再送でも同一値（ctx由来）でTikTok側の重複排除に使う。
      event_id: eventId || undefined,
      event_time: eventTime || Math.floor(Date.now() / 1000),
      user,
      page: { url: eventSourceUrl || config.baseUrl },
    }],
  };
  return postJson(url, { 'Access-Token': t.accessToken }, payload);
}

/** Google はOAuthが必要なため現状スタブ（gclid記録のみ・差し込み口）。 */
async function sendGoogle(settings, { gclid }) {
  if (!settings.google.enabled) return { ok: false, skipped: true, reason: 'GOOGLE無効' };
  // TODO: Google Ads API (Click/Enhanced Conversions) 実装の差し込み口。
  return { ok: false, skipped: true, reason: 'Google連携は未実装（gclid記録のみ）', response: JSON.stringify({ gclid: gclid || null }) };
}

async function postJson(url, headers, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // CAPIハングで再送ループが詰まるのを防ぐ
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, http_status: res.status, response: text };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function sendByPlatform(platform, settings, ctx) {
  if (platform === 'meta') return sendMeta(settings, ctx);
  if (platform === 'tiktok') return sendTikTok(settings, ctx);
  if (platform === 'google') return sendGoogle(settings, ctx);
  return Promise.resolve({ ok: false, skipped: true, reason: `未知の媒体: ${platform}` });
}

function backoffMs(attempts) {
  const sec = Math.min(60 * Math.pow(2, Math.max(0, attempts - 1)), 3600);
  return sec * 1000;
}

/** link.media（未指定なら院で有効な全媒体）から送信対象を決める。 */
function resolveTargets(link, settings) {
  const media = ((link && link.media) || '').trim();
  if (media) return media.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const t = [];
  if (settings.meta.pixelId && settings.meta.capiToken) t.push('meta');
  if (settings.tiktok.pixelId && settings.tiktok.accessToken) t.push('tiktok');
  if (settings.google.enabled) t.push('google');
  return t;
}

/**
 * 媒体振り分け→各媒体へ送信→ postbacks に記録（テナント別設定で送信）。
 */
async function dispatchPostbacks(db, { tenant, settings, follow, click, link, ip, ua, eventSourceUrl }) {
  // 広告CV連携はプロプラン限定（ライトは流入計測のみ。契約書 別紙「プラン別 機能一覧」）
  const limits = require('./billing').planLimits(tenant);
  if (!limits.metaCv) return [];
  settings = settings || resolveSettings(tenant);
  const targets = resolveTargets(link, settings);
  const baseCtx = {
    lineUserId: follow.line_user_id,
    fbclid: click && click.fbclid,
    clickMs: click && click.created_at,
    ttclid: click && click.ttclid,
    gclid: click && click.gclid,
    ip, ua, eventSourceUrl,
    // 再送でも不変の重複排除キー（1回の友だち追加=1コンバージョン）。ctxに保存され再送時も同値。
    eventId: follow.id,
    eventTime: Math.floor(Date.now() / 1000),
  };

  const results = [];
  for (const platform of targets) {
    const ctx = Object.assign({ platform }, baseCtx);
    const r = await sendByPlatform(platform, settings, ctx);
    const now = Date.now();
    const retryable = !r.ok && !r.skipped;
    db.prepare(
      `INSERT INTO postbacks
       (id, tenant_id, follow_id, platform, ok, http_status, response, attempts, done, next_retry_at, ctx_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(
      newId('pb'), follow.tenant_id || (tenant && tenant.id) || null, follow.id, platform,
      r.ok ? 1 : 0, r.http_status || null, r.response || r.reason || null,
      retryable ? 0 : 1,
      retryable ? now + backoffMs(1) : null,
      retryable ? JSON.stringify(ctx) : null,
      now, now
    );
    if (retryable) logger.warn('postback failed, scheduled retry', { platform, follow_id: follow.id });
    results.push({ platform, ...r });
  }
  return results;
}

/** 電話: 数字だけにし、先頭の0を81（日本の国番号）に。09012345678 → 819012345678 */
function normPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 13) return '';
  if (d.startsWith('81')) return d;
  return d.startsWith('0') ? '81' + d.slice(1) : d;
}

/** フォームの回答から、電話・メールらしい項目を拾う（項目の種類か、見出しの言葉で判定） */
function contactFromAnswers(form, answers) {
  let phone = ''; let email = '';
  for (const f of (form.fields || [])) {
    const v = String((answers || {})[f.label] || '').trim();
    if (!v) continue;
    if (!phone && (f.type === 'tel' || /電話|TEL|携帯/i.test(f.label))) phone = normPhone(v);
    if (!email && (f.type === 'email' || /メール|mail/i.test(f.label)) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) email = v.toLowerCase();
  }
  return { phone, email };
}

/**
 * フォームの回答を、広告の成果（予約=Schedule／問い合わせ=Lead）として Meta へ送る（2026-10-06）。
 * ・フォームに「広告の成果として送る」が設定され、Meta連携（プロ）が有効なときだけ
 * ・回答者が友だち追加の計測リンク経由なら、そのクリック（fbclid）と LINE の ID で照合できる
 * ・電話・メールは暗号化（SHA-256）してから送る。回答1件につき1回（event_id=回答ID）
 * ・失敗しても回答の受け付けは止めない。友だち追加の記録がある回答は、Lead と同じ仕組みで再送する
 */
async function dispatchFormConversion(db, { tenant, form, result, ip, ua }) {
  const eventName = form.meta_event === 'Schedule' || form.meta_event === 'Lead' ? form.meta_event : null;
  if (!eventName || !tenant || !result) return null;
  const limits = require('./billing').planLimits(tenant);
  if (!limits.metaCv) return null;
  const settings = resolveSettings(tenant);
  if (!settings.meta.pixelId || !settings.meta.capiToken) return null;

  const { phone, email } = contactFromAnswers(form, result.answers);
  let follow = null; let click = null;
  if (result.line_user_id) {
    follow = db.prepare('SELECT * FROM follows WHERE tenant_id = ? AND line_user_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(tenant.id, result.line_user_id) || null;
    if (follow && follow.click_id) click = db.prepare('SELECT * FROM clicks WHERE id = ?').get(follow.click_id) || null;
  }
  if (!result.line_user_id && !phone && !email) return { ok: false, skipped: true, reason: '照合できる情報なし' };

  const ctx = {
    platform: 'meta', eventName,
    lineUserId: result.line_user_id || null,
    fbclid: click && click.fbclid, clickMs: click && click.created_at,
    phHash: phone ? sha256hex(phone) : null, emHash: email ? sha256hex(email) : null,
    ip, ua, eventSourceUrl: `${config.baseUrl}/f/${form.id}`,
    eventId: result.answer_id, eventTime: Math.floor(Date.now() / 1000),
  };
  const r = await sendMeta(settings, ctx);
  const retryable = !r.ok && !r.skipped;
  if (follow) {
    const now = Date.now();
    // 送るのは IP・UA を含む ctx だが、再送が要るときだけ残す（成功したら残さない）
    db.prepare(
      `INSERT INTO postbacks
       (id, tenant_id, follow_id, platform, ok, http_status, response, attempts, done, next_retry_at, ctx_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(newId('pb'), tenant.id, follow.id, 'meta', r.ok ? 1 : 0, r.http_status || null,
      (`[${eventName}] ` + (r.response || r.reason || '')).slice(0, 2000),
      retryable ? 0 : 1, retryable ? now + backoffMs(1) : null, retryable ? JSON.stringify(ctx) : null, now, now);
  }
  if (r.ok) logger.info('form conversion sent', { tenant_id: tenant.id, form_id: form.id, event: eventName });
  else logger.warn('form conversion not sent', { tenant_id: tenant.id, form_id: form.id, event: eventName, http_status: r.http_status, reason: r.reason });
  return r;
}

/** リトライ待ちポストバックを再送（テナントを引いて設定解決）。 */
async function retryDuePostbacks(db) {
  const now = Date.now();
  const due = db.prepare(
    `SELECT * FROM postbacks WHERE done = 0 AND next_retry_at IS NOT NULL AND next_retry_at <= ?
     ORDER BY next_retry_at ASC LIMIT 50`
  ).all(now);

  let okCount = 0;
  for (const pb of due) {
    let ctx;
    try { ctx = JSON.parse(pb.ctx_json || '{}'); } catch { ctx = {}; }
    const tenant = pb.tenant_id ? db.prepare('SELECT * FROM tenants WHERE id = ?').get(pb.tenant_id) : null;
    const settings = tenant ? resolveSettings(tenant) : null;
    const attempts = pb.attempts + 1;
    const r = settings
      ? await sendByPlatform(pb.platform, settings, ctx)
      : { ok: false, skipped: true, reason: 'テナント不明' };
    const finished = r.ok || r.skipped || attempts >= config.postbackMaxAttempts;
    db.prepare(
      `UPDATE postbacks SET ok = ?, http_status = ?, response = ?, attempts = ?, done = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      r.ok ? 1 : 0, r.http_status || null, r.response || r.reason || null,
      attempts, finished ? 1 : 0, finished ? null : Date.now() + backoffMs(attempts),
      Date.now(), pb.id
    );
    if (r.ok) okCount++;
  }
  return { retried: due.length, ok: okCount };
}

module.exports = { sendMeta, sendTikTok, sendGoogle, sendByPlatform, dispatchPostbacks, retryDuePostbacks, dispatchFormConversion, contactFromAnswers, normPhone };
