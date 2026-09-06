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

module.exports = { shorten, resolve, genCode };
