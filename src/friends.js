'use strict';

// 友だち管理（CRM）。line_user_id 単位で1件。
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const line = require('./line');

/** 友だち追加時に登録/更新（再追加なら active に戻す）。 */
function upsertFollow(db, { tenantId, lineUserId, displayName }) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM friends WHERE tenant_id = ? AND line_user_id = ?').get(tenantId, lineUserId);
  if (existing) {
    db.prepare("UPDATE friends SET status='active', last_event_at=?, display_name=COALESCE(?, display_name) WHERE id=?")
      .run(now, displayName || null, existing.id);
    return existing.id;
  }
  const id = newId('frd');
  db.prepare(
    `INSERT INTO friends (id, tenant_id, line_user_id, display_name, status, created_at, last_event_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, tenantId, lineUserId, displayName || null, now, now);
  return id;
}

/** 流入経路（媒体・リンク）を設定（未設定のときだけ上書き）。 */
function setSource(db, { tenantId, lineUserId, media, linkId }) {
  db.prepare(
    `UPDATE friends SET source_media = COALESCE(source_media, ?), source_link_id = COALESCE(source_link_id, ?)
     WHERE tenant_id = ? AND line_user_id = ?`
  ).run(media || null, linkId || null, tenantId, lineUserId);
}

function markBlocked(db, tenantId, lineUserId) {
  db.prepare("UPDATE friends SET status='blocked', last_event_at=? WHERE tenant_id=? AND line_user_id=?")
    .run(Date.now(), tenantId, lineUserId);
}

function setTags(db, tenantId, friendId, tags) {
  const norm = Array.isArray(tags) ? tags.join(',') : String(tags || '');
  const info = db.prepare('UPDATE friends SET tags=? WHERE id=? AND tenant_id=?').run(norm.trim() || null, friendId, tenantId);
  return info.changes;
}

function counts(db, tenantId) {
  const one = (sql) => db.prepare(sql).get(tenantId).n;
  return {
    total: one('SELECT COUNT(*) n FROM friends WHERE tenant_id=?'),
    active: one("SELECT COUNT(*) n FROM friends WHERE tenant_id=? AND status='active'"),
    blocked: one("SELECT COUNT(*) n FROM friends WHERE tenant_id=? AND status='blocked'"),
    attributed: one("SELECT COUNT(*) n FROM friends WHERE tenant_id=? AND source_media IS NOT NULL AND source_media<>''"),
  };
}

function listFriends(db, tenantId, { media, status, tag, limit } = {}) {
  const where = ['tenant_id = ?'];
  const args = [tenantId];
  if (status) { where.push('status = ?'); args.push(status); }
  if (media) { where.push('source_media = ?'); args.push(media); }
  if (tag) { where.push("(',' || IFNULL(tags,'') || ',') LIKE ?"); args.push('%,' + tag + ',%'); }
  args.push(Math.min(parseInt(limit, 10) || 100, 1000));
  const rows = db.prepare(
    `SELECT id, line_user_id, display_name, source_media, tags, birthday, status, created_at, last_event_at
     FROM friends WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...args);
  return rows.map((r) => ({ ...r, line_user_id_short: r.line_user_id ? r.line_user_id.slice(0, 8) + '…' : null, line_user_id: undefined }));
}

/** セグメントに該当する active な friend の line_user_id 一覧を返す（配信対象解決）。 */
function getRecipients(db, tenantId, audienceType, audienceValue) {
  if (audienceType === 'media') {
    return db.prepare("SELECT line_user_id FROM friends WHERE tenant_id=? AND status='active' AND source_media=?")
      .all(tenantId, audienceValue || '').map((r) => r.line_user_id);
  }
  if (audienceType === 'matched') {
    return db.prepare("SELECT line_user_id FROM friends WHERE tenant_id=? AND status='active' AND source_media IS NOT NULL AND source_media<>''")
      .all(tenantId).map((r) => r.line_user_id);
  }
  if (audienceType === 'tag') {
    return db.prepare("SELECT line_user_id FROM friends WHERE tenant_id=? AND status='active' AND (',' || IFNULL(tags,'') || ',') LIKE ?")
      .all(tenantId, '%,' + (audienceValue || '') + ',%').map((r) => r.line_user_id);
  }
  // all
  return db.prepare("SELECT line_user_id FROM friends WHERE tenant_id=? AND status='active'")
    .all(tenantId).map((r) => r.line_user_id);
}

/** 特定の友だちに1対1のLINEメッセージを送信。 */
async function pushToFriend(db, tenant, friendId, text) {
  const friend = db.prepare('SELECT * FROM friends WHERE id=? AND tenant_id=?').get(friendId, tenant.id);
  if (!friend) return { error: '友だちが見つかりません' };
  if (!friend.line_user_id) return { error: 'LINE IDが不明です' };
  const token = resolveSettings(tenant).line.channelAccessToken;
  if (!token) return { error: 'LINEアクセストークンが未設定です' };
  return line.pushMessage(token, friend.line_user_id, [{ type: 'text', text }]);
}

module.exports = { upsertFollow, setSource, markBlocked, setTags, counts, listFriends, getRecipients, pushToFriend };
