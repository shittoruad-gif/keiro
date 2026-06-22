'use strict';

const config = require('./config');
const logger = require('./logger');
const { sha256hex, newId } = require('./sign');

/**
 * Meta Conversions API へ Lead を送信。
 * fbc は "fb.1.<クリック時刻ms>.<fbclid>"、external_id=sha256(line_user_id)。
 */
async function sendMeta({ lineUserId, fbclid, clickMs, ip, ua, eventSourceUrl }) {
  if (!config.meta.pixelId || !config.meta.capiToken) {
    return { ok: false, skipped: true, reason: 'META未設定' };
  }
  const url = `https://graph.facebook.com/${config.meta.graphVersion}/${config.meta.pixelId}/events`;

  const userData = { external_id: sha256hex(lineUserId) };
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  if (fbclid && clickMs) userData.fbc = `fb.1.${clickMs}.${fbclid}`;

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: eventSourceUrl || config.baseUrl,
      user_data: userData,
    }],
    access_token: config.meta.capiToken,
  };
  if (config.meta.testEventCode) payload.test_event_code = config.meta.testEventCode;

  return postJson(url, {}, payload);
}

/**
 * TikTok Events API へ CompleteRegistration を送信。Access-Token ヘッダ。
 */
async function sendTikTok({ lineUserId, ttclid, ip, ua, eventSourceUrl }) {
  if (!config.tiktok.pixelId || !config.tiktok.accessToken) {
    return { ok: false, skipped: true, reason: 'TIKTOK未設定' };
  }
  const url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

  const user = { external_id: sha256hex(lineUserId) };
  if (ip) user.ip = ip;
  if (ua) user.user_agent = ua;
  if (ttclid) user.ttclid = ttclid;

  const payload = {
    event_source: 'web',
    event_source_id: config.tiktok.pixelId,
    data: [{
      event: 'CompleteRegistration',
      event_time: Math.floor(Date.now() / 1000),
      user,
      page: { url: eventSourceUrl || config.baseUrl },
    }],
  };

  return postJson(url, { 'Access-Token': config.tiktok.accessToken }, payload);
}

/**
 * Google はサーバ→サーバ送信に OAuth が必要なため現状はスタブ。
 * gclid を記録し、ここに Google Ads API / Enhanced Conversions の差し込み口を用意する。
 */
async function sendGoogle({ gclid }) {
  if (!config.google.enabled) {
    return { ok: false, skipped: true, reason: 'GOOGLE_ENABLED=false' };
  }
  // TODO: Google Ads API (Click Conversions / Enhanced Conversions) を実装。
  // 必要: OAuth2 リフレッシュトークン, developer-token, customer-id, conversion action。
  return {
    ok: false,
    skipped: true,
    reason: 'Google連携は未実装（gclid記録のみ）',
    response: JSON.stringify({ gclid: gclid || null }),
  };
}

async function postJson(url, headers, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return { ok: res.ok, http_status: res.status, response: text };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

/** platform名でディスパッチ（初回送信・リトライ共通）。 */
function sendByPlatform(platform, ctx) {
  if (platform === 'meta') return sendMeta(ctx);
  if (platform === 'tiktok') return sendTikTok(ctx);
  if (platform === 'google') return sendGoogle(ctx);
  return Promise.resolve({ ok: false, skipped: true, reason: `未知の媒体: ${platform}` });
}

/** 指数バックオフ（秒）。1回目失敗→60s, 120s, 240s … 上限1h。 */
function backoffMs(attempts) {
  const base = 60;
  const sec = Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), 3600);
  return sec * 1000;
}

/** linkのmedia設定から送信対象媒体を決める。未指定なら有効な全媒体。 */
function resolveTargets(link) {
  const media = ((link && link.media) || '').trim();
  if (media) return media.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const t = [];
  if (config.meta.pixelId && config.meta.capiToken) t.push('meta');
  if (config.tiktok.pixelId && config.tiktok.accessToken) t.push('tiktok');
  if (config.google.enabled) t.push('google');
  return t;
}

/**
 * 媒体振り分け→各媒体へ送信→ postbacks に記録。
 * 失敗（スキップを除く）はリトライ待ち(done=0)として登録する。
 */
async function dispatchPostbacks(db, { follow, click, link, ip, ua, eventSourceUrl }) {
  const targets = resolveTargets(link);
  const baseCtx = {
    lineUserId: follow.line_user_id,
    fbclid: click && click.fbclid,
    clickMs: click && click.created_at,
    ttclid: click && click.ttclid,
    gclid: click && click.gclid,
    ip, ua, eventSourceUrl,
  };

  const results = [];
  for (const platform of targets) {
    const ctx = Object.assign({ platform }, baseCtx);
    const r = await sendByPlatform(platform, ctx);
    const now = Date.now();
    const retryable = !r.ok && !r.skipped;
    db.prepare(
      `INSERT INTO postbacks
       (id, follow_id, platform, ok, http_status, response, attempts, done, next_retry_at, ctx_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(
      newId('pb'), follow.id, platform,
      r.ok ? 1 : 0, r.http_status || null, r.response || r.reason || null,
      retryable ? 0 : 1,
      retryable ? now + backoffMs(1) : null,
      retryable ? JSON.stringify(ctx) : null,
      now, now
    );
    if (retryable) logger.warn('postback failed, scheduled retry', { platform, follow_id: follow.id, http_status: r.http_status });
    results.push({ platform, ...r });
  }
  return results;
}

/**
 * リトライ待ちのポストバックを再送する。スケジューラから定期実行。
 * @returns {{retried:number, ok:number}}
 */
async function retryDuePostbacks(db) {
  const now = Date.now();
  const due = db.prepare(
    `SELECT * FROM postbacks
     WHERE done = 0 AND next_retry_at IS NOT NULL AND next_retry_at <= ?
     ORDER BY next_retry_at ASC LIMIT 50`
  ).all(now);

  let okCount = 0;
  for (const pb of due) {
    let ctx;
    try { ctx = JSON.parse(pb.ctx_json || '{}'); } catch { ctx = {}; }
    const attempts = pb.attempts + 1;
    const r = await sendByPlatform(pb.platform, ctx);
    const finished = r.ok || r.skipped || attempts >= config.postbackMaxAttempts;
    db.prepare(
      `UPDATE postbacks
       SET ok = ?, http_status = ?, response = ?, attempts = ?, done = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      r.ok ? 1 : 0, r.http_status || null, r.response || r.reason || null,
      attempts, finished ? 1 : 0,
      finished ? null : Date.now() + backoffMs(attempts),
      Date.now(), pb.id
    );
    if (r.ok) okCount++;
    logger.info('postback retry', { platform: pb.platform, attempts, ok: r.ok, finished });
  }
  return { retried: due.length, ok: okCount };
}

module.exports = { sendMeta, sendTikTok, sendGoogle, sendByPlatform, dispatchPostbacks, retryDuePostbacks };
