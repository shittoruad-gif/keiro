'use strict';

const logger = require('./logger');
const config = require('./config');
const { sha256hex, newId } = require('./sign');
const { resolveSettings } = require('./tenant');

/**
 * Meta Conversions API へ Lead を送信。settings.meta を使用。
 * fbc は "fb.1.<クリック時刻ms>.<fbclid>"、external_id=sha256(line_user_id)。
 */
async function sendMeta(settings, { lineUserId, fbclid, clickMs, ip, ua, eventSourceUrl }) {
  const m = settings.meta;
  if (!m.pixelId || !m.capiToken) return { ok: false, skipped: true, reason: 'META未設定' };
  const url = `https://graph.facebook.com/${m.graphVersion}/${m.pixelId}/events`;

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
    access_token: m.capiToken,
  };
  if (m.testEventCode) payload.test_event_code = m.testEventCode;
  return postJson(url, {}, payload);
}

/** TikTok Events API へ CompleteRegistration を送信。Access-Token ヘッダ。 */
async function sendTikTok(settings, { lineUserId, ttclid, ip, ua, eventSourceUrl }) {
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
      event_time: Math.floor(Date.now() / 1000),
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
  settings = settings || resolveSettings(tenant);
  const targets = resolveTargets(link, settings);
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

module.exports = { sendMeta, sendTikTok, sendGoogle, sendByPlatform, dispatchPostbacks, retryDuePostbacks };
