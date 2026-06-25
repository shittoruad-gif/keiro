'use strict';

// キーワード自動応答。友だちからのテキストにキーワードが含まれれば自動返信。
const { newId } = require('./sign');

function listRules(db, tenantId) {
  return db.prepare('SELECT * FROM autoreplies WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
}

function createRule(db, tenantId, { keyword, match_type, reply_text, active }) {
  const id = newId('arp');
  db.prepare(
    `INSERT INTO autoreplies (id, tenant_id, keyword, match_type, reply_text, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, String(keyword || '').trim(), match_type === 'exact' ? 'exact' : 'contains',
    String(reply_text || ''), active === false ? 0 : 1, Date.now());
  return db.prepare('SELECT * FROM autoreplies WHERE id = ?').get(id);
}

function updateRule(db, tenantId, id, fields) {
  const r = db.prepare('SELECT id FROM autoreplies WHERE id=? AND tenant_id=?').get(id, tenantId);
  if (!r) return null;
  const sets = [], vals = [];
  if (fields.keyword !== undefined) { sets.push('keyword=?'); vals.push(String(fields.keyword).trim()); }
  if (fields.match_type !== undefined) { sets.push('match_type=?'); vals.push(fields.match_type === 'exact' ? 'exact' : 'contains'); }
  if (fields.reply_text !== undefined) { sets.push('reply_text=?'); vals.push(String(fields.reply_text)); }
  if (fields.active !== undefined) { sets.push('active=?'); vals.push(fields.active ? 1 : 0); }
  if (sets.length) { vals.push(id); db.prepare(`UPDATE autoreplies SET ${sets.join(', ')} WHERE id=?`).run(...vals); }
  return db.prepare('SELECT * FROM autoreplies WHERE id = ?').get(id);
}

function deleteRule(db, tenantId, id) {
  const info = db.prepare('DELETE FROM autoreplies WHERE id=? AND tenant_id=?').run(id, tenantId);
  return { deleted: info.changes };
}

/** 受信テキストに一致する最初の有効ルールの返信文を返す（なければnull）。 */
function findReply(db, tenantId, text) {
  if (!text) return null;
  const rules = db.prepare("SELECT * FROM autoreplies WHERE tenant_id=? AND active=1").all(tenantId);
  for (const r of rules) {
    const kw = (r.keyword || '').trim();
    if (!kw) continue;
    if (r.match_type === 'exact') {
      if (text.trim() === kw) return r.reply_text;
    } else if (text.includes(kw)) {
      return r.reply_text;
    }
  }
  return null;
}

module.exports = { listRules, createRule, updateRule, deleteRule, findReply };
