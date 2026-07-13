'use strict';

// 1:1チャット受信箱（Lステップの「個別トーク」相当）。
// 受信テキストはwebhookで全プラン保存し、閲覧・返信APIをプロ限定にする
// （ライト→プロへ変更した際に過去の会話が見えるようにするため）。
const { newId } = require('./sign');
const line = require('./line');
const friends = require('./friends');

function saveMessage(db, { tenantId, lineUserId, direction, text }) {
  const id = newId('im');
  db.prepare(
    `INSERT INTO inbox_messages (id, tenant_id, line_user_id, direction, text, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, lineUserId, direction === 'out' ? 'out' : 'in', String(text).slice(0, 5000),
    direction === 'out' ? 1 : 0, Date.now());
  return id;
}

/** スレッド一覧（友だちごとの最新メッセージ＋未読数）。 */
function listThreads(db, tenantId, limit = 100) {
  return db.prepare(
    `SELECT m.line_user_id,
            (SELECT text FROM inbox_messages WHERE tenant_id = ? AND line_user_id = m.line_user_id ORDER BY created_at DESC LIMIT 1) AS last_text,
            MAX(m.created_at) AS last_at,
            SUM(CASE WHEN m.direction = 'in' AND m.read = 0 THEN 1 ELSE 0 END) AS unread,
            f.display_name, f.tags
     FROM inbox_messages m
     LEFT JOIN friends f ON f.tenant_id = m.tenant_id AND f.line_user_id = m.line_user_id
     WHERE m.tenant_id = ?
     GROUP BY m.line_user_id
     ORDER BY last_at DESC LIMIT ?`
  ).all(tenantId, tenantId, limit);
}

function listMessages(db, tenantId, lineUserId, limit = 200) {
  return db.prepare(
    `SELECT id, direction, text, created_at FROM inbox_messages
     WHERE tenant_id = ? AND line_user_id = ? ORDER BY created_at ASC LIMIT ?`
  ).all(tenantId, lineUserId, limit);
}

function markRead(db, tenantId, lineUserId) {
  db.prepare("UPDATE inbox_messages SET read = 1 WHERE tenant_id = ? AND line_user_id = ? AND direction = 'in'")
    .run(tenantId, lineUserId);
}

function unreadCount(db, tenantId) {
  return db.prepare("SELECT COUNT(*) n FROM inbox_messages WHERE tenant_id = ? AND direction = 'in' AND read = 0")
    .get(tenantId).n;
}

/** 返信を送信し会話ログに残す。 */
async function sendReply(db, tenant, settings, lineUserId, text) {
  const token = settings.line.channelAccessToken;
  if (!token) return { error: 'LINEのアクセストークンが未設定です' };
  const r = await line.pushMessage(token, lineUserId, String(text).slice(0, 2000));
  if (!r.ok) return { error: `送信に失敗しました（HTTP ${r.http_status}）` };
  saveMessage(db, { tenantId: tenant.id, lineUserId, direction: 'out', text });
  return { ok: true };
}

module.exports = { saveMessage, listThreads, listMessages, markRead, unreadCount, sendReply };
