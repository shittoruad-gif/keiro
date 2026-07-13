'use strict';

// 配信内リンクのタップ計測（Lステップの「URLクリック測定」相当）。
// 短縮URL /r/:id を配信本文に {url:ID} で差し込むと、友だち別のタップまで記録できる。
const config = require('./config');
const { newId, verifyToken } = require('./sign');
const friends = require('./friends');

function listUrls(db, tenantId) {
  return db.prepare(
    `SELECT u.*,
       (SELECT COUNT(*) FROM url_clicks c WHERE c.url_id = u.id) AS clicks,
       (SELECT COUNT(DISTINCT c.line_user_id) FROM url_clicks c WHERE c.url_id = u.id AND c.line_user_id IS NOT NULL) AS unique_friends
     FROM tracked_urls u WHERE u.tenant_id = ? ORDER BY u.created_at DESC`
  ).all(tenantId).map((u) => ({ ...u, short_url: `${config.baseUrl}/r/${u.id}`, placeholder: `{url:${u.id}}` }));
}

function createUrl(db, tenantId, { name, destUrl }) {
  const dest = String(destUrl || '').trim();
  if (!/^https?:\/\//.test(dest)) return { error: 'リンク先URLは http(s):// で始まる形式で入力してください' };
  const id = newId('turl');
  db.prepare('INSERT INTO tracked_urls (id, tenant_id, name, dest_url, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, tenantId, String(name || 'リンク'), dest, Date.now());
  return { id, short_url: `${config.baseUrl}/r/${id}`, placeholder: `{url:${id}}` };
}

function deleteUrl(db, tenantId, id) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM url_clicks WHERE url_id = ? AND tenant_id = ?').run(id, tenantId);
    db.prepare('DELETE FROM tracked_urls WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  });
  tx();
  return { ok: true };
}

/** クリックした友だちの一覧（誰が・いつ）。 */
function listClicks(db, tenantId, urlId, limit = 300) {
  return db.prepare(
    `SELECT c.created_at, f.display_name, c.line_user_id IS NOT NULL AS identified
     FROM url_clicks c
     LEFT JOIN friends f ON f.tenant_id = c.tenant_id AND f.line_user_id = c.line_user_id
     WHERE c.tenant_id = ? AND c.url_id = ? ORDER BY c.created_at DESC LIMIT ?`
  ).all(tenantId, urlId, limit);
}

/**
 * クリックを記録してリダイレクト先URLを返す。uトークンがあれば友だち特定＋スコア加点。
 * @returns {string|null} リダイレクト先（見つからなければnull）
 */
function recordClick(db, urlId, uToken) {
  const u = db.prepare('SELECT * FROM tracked_urls WHERE id = ?').get(urlId);
  if (!u) return null;
  let lineUserId = null;
  if (uToken) {
    const payload = verifyToken(config.secret, uToken);
    if (payload && payload.t === u.tenant_id && payload.u) lineUserId = payload.u;
  }
  db.prepare('INSERT INTO url_clicks (id, url_id, tenant_id, line_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(newId('uc'), u.id, u.tenant_id, lineUserId, Date.now());
  if (lineUserId) friends.addScore(db, u.tenant_id, lineUserId, 3);
  return u.dest_url;
}

module.exports = { listUrls, createUrl, deleteUrl, listClicks, recordClick };
