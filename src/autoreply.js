'use strict';

// キーワード自動応答。友だちからのテキストにキーワードが含まれれば自動返信。
const { newId } = require('./sign');

function listRules(db, tenantId) {
  return db.prepare('SELECT * FROM autoreplies WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
}

function createRule(db, tenantId, { keyword, match_type, reply_text, active, audience_tag }) {
  const id = newId('arp');
  db.prepare(
    `INSERT INTO autoreplies (id, tenant_id, keyword, match_type, reply_text, audience_tag, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, String(keyword || '').trim(), match_type === 'exact' ? 'exact' : 'contains',
    String(reply_text || ''), audience_tag ? String(audience_tag).trim() : null,
    active === false ? 0 : 1, Date.now());
  return db.prepare('SELECT * FROM autoreplies WHERE id = ?').get(id);
}

function updateRule(db, tenantId, id, fields) {
  const r = db.prepare('SELECT id FROM autoreplies WHERE id=? AND tenant_id=?').get(id, tenantId);
  if (!r) return null;
  const sets = [], vals = [];
  if (fields.keyword !== undefined) { sets.push('keyword=?'); vals.push(String(fields.keyword).trim()); }
  if (fields.match_type !== undefined) { sets.push('match_type=?'); vals.push(fields.match_type === 'exact' ? 'exact' : 'contains'); }
  if (fields.reply_text !== undefined) { sets.push('reply_text=?'); vals.push(String(fields.reply_text)); }
  if (fields.audience_tag !== undefined) { sets.push('audience_tag=?'); vals.push(fields.audience_tag ? String(fields.audience_tag).trim() : null); }
  if (fields.active !== undefined) { sets.push('active=?'); vals.push(fields.active ? 1 : 0); }
  if (sets.length) { vals.push(id); db.prepare(`UPDATE autoreplies SET ${sets.join(', ')} WHERE id=?`).run(...vals); }
  return db.prepare('SELECT * FROM autoreplies WHERE id = ?').get(id);
}

function deleteRule(db, tenantId, id) {
  const info = db.prepare('DELETE FROM autoreplies WHERE id=? AND tenant_id=?').run(id, tenantId);
  return { deleted: info.changes };
}

/**
 * 受信テキストに一致する有効ルールの返信文を返す（なければnull）。
 * タグ別出し分け: lineUserId を渡すと、友だちのタグに合う「対象タグ」付きルールを優先。
 * 対象タグ付きルールは、そのタグを持たない友だちには発火しない（タグ無しルールがフォールバック）。
 */
function findReply(db, tenantId, text, lineUserId) {
  if (!text) return null;
  let friendTags = [];
  if (lineUserId) {
    const fr = db.prepare('SELECT tags FROM friends WHERE tenant_id=? AND line_user_id=?').get(tenantId, lineUserId);
    friendTags = String((fr && fr.tags) || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  const rules = db.prepare("SELECT * FROM autoreplies WHERE tenant_id=? AND active=1 ORDER BY created_at").all(tenantId);
  let fallback = null;
  for (const r of rules) {
    const kw = (r.keyword || '').trim();
    if (!kw) continue;
    const hit = r.match_type === 'exact' ? text.trim() === kw : text.includes(kw);
    if (!hit) continue;
    if (r.audience_tag) {
      if (friendTags.includes(r.audience_tag)) return r.reply_text; // タグ一致＝最優先
      continue; // タグ不一致＝このルールは対象外
    }
    if (fallback === null) fallback = r.reply_text; // タグ無し＝フォールバック（先勝ち）
  }
  return fallback;
}

module.exports = { listRules, createRule, updateRule, deleteRule, findReply };
