'use strict';
// 短縮URL（/s/<code>）。配信文の長いURL（友だち別トークン付きフォーム・クーポン等）を短くする。
// 同じテナント×同じURLは同じコードを再利用する。
const crypto = require('crypto');
const config = require('./config');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(len = 7) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** URLを短縮して短縮URL（絶対URL）を返す。失敗時は元のURLを返す（配信を止めない）。 */
function shorten(db, tenantId, url) {
  try {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return u;
    const hit = db.prepare('SELECT code FROM short_urls WHERE tenant_id = ? AND url = ?').get(tenantId, u);
    if (hit) return `${config.baseUrl}/s/${hit.code}`;
    for (let i = 0; i < 5; i++) {
      const code = genCode();
      try {
        db.prepare('INSERT INTO short_urls (code, tenant_id, url, created_at) VALUES (?, ?, ?, ?)').run(code, tenantId, u, Date.now());
        return `${config.baseUrl}/s/${code}`;
      } catch (e) { /* code collision: retry */ }
    }
    return u;
  } catch { return String(url || ''); }
}

function resolve(db, code) {
  const row = db.prepare('SELECT url FROM short_urls WHERE code = ?').get(String(code || ''));
  return row ? row.url : null;
}

/** タップを記録して遷移先を返す（遷移先の u トークンから友だちを特定）。 */
function recordClick(db, code) {
  const row = db.prepare('SELECT code, tenant_id, url FROM short_urls WHERE code = ?').get(String(code || ''));
  if (!row) return null;
  let lineUserId = null;
  try {
    const u = new URL(row.url).searchParams.get('u');
    if (u) {
      const payload = require('./sign').verifyToken(config.secret, u, 10 * 365 * 24 * 3600);
      if (payload && payload.t === row.tenant_id && payload.u) lineUserId = payload.u;
    }
  } catch { /* noop */ }
  try {
    db.prepare('INSERT INTO short_clicks (id, code, tenant_id, line_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(require('./sign').newId('sc'), row.code, row.tenant_id, lineUserId, Date.now());
  } catch { /* 計測失敗でも遷移は止めない */ }
  return row.url;
}

/** 短縮URLごとのタップ集計（テナント）。遷移先の種類（フォーム/クーポン/計測URL/その他）を付ける。 */
function listStats(db, tenantId, sinceMs) {
  const since = sinceMs || 0;
  const rows = db.prepare(
    `SELECT s.code, s.url, s.created_at,
       (SELECT COUNT(*) FROM short_clicks c WHERE c.code = s.code AND c.created_at >= ?) AS clicks,
       (SELECT COUNT(DISTINCT line_user_id) FROM short_clicks c WHERE c.code = s.code AND c.created_at >= ? AND line_user_id IS NOT NULL) AS unique_friends
     FROM short_urls s WHERE s.tenant_id = ? ORDER BY s.created_at DESC`
  ).all(since, since, tenantId);
  const kind = (url) => /\/f\//.test(url) ? 'form' : /\/coupon/.test(url) ? 'coupon' : /\/r\//.test(url) ? 'tracked_url' : 'other';
  return rows.map((r) => ({ code: r.code, short_url: `${config.baseUrl}/s/${r.code}`, kind: kind(r.url), dest: r.url.replace(/[?&]u=[^&]+/, ''), clicks: r.clicks, unique_friends: r.unique_friends, created_at: r.created_at }));
}


module.exports = { shorten, resolve, genCode, recordClick, listStats };
