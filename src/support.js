'use strict';

// クライアント（院）向けサポートチャット。
// 院の質問にはまずAIが回答し、解決しない場合は運営へエスカレーションできる。
// スレッドはテナントごとに1本（チャット形式・support_messages）。
const { newId } = require('./sign');

function saveMessage(db, { tenantId, sender, text, escalated }) {
  const id = newId('sup');
  db.prepare(
    `INSERT INTO support_messages (id, tenant_id, sender, text, escalated, read_by_tenant, read_by_operator, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, sender, String(text).slice(0, 4000), escalated ? 1 : 0,
    sender === 'tenant' ? 1 : 0,          // 自分の発言は自分にとって既読
    sender === 'operator' ? 1 : 0,
    Date.now());
  return db.prepare('SELECT * FROM support_messages WHERE id = ?').get(id);
}

function listForTenant(db, tenantId, limit) {
  return db.prepare(
    'SELECT * FROM support_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(tenantId, limit || 100).reverse();
}

function markReadByTenant(db, tenantId) {
  db.prepare('UPDATE support_messages SET read_by_tenant = 1 WHERE tenant_id = ? AND read_by_tenant = 0').run(tenantId);
}

function markReadByOperator(db, tenantId) {
  db.prepare('UPDATE support_messages SET read_by_operator = 1 WHERE tenant_id = ? AND read_by_operator = 0').run(tenantId);
}

function unreadForTenant(db, tenantId) {
  return db.prepare(
    "SELECT COUNT(*) n FROM support_messages WHERE tenant_id = ? AND read_by_tenant = 0 AND sender = 'operator'"
  ).get(tenantId).n;
}

/**
 * 運営向け: スレッド一覧（テナント単位）。
 * escalated_pending = 最後の「運営宛の質問」より後に運営の返信が無い状態。
 */
function listThreads(db) {
  const rows = db.prepare(`
    SELECT m.tenant_id,
           t.name, t.email,
           MAX(m.created_at) AS last_at,
           SUM(CASE WHEN m.read_by_operator = 0 AND m.sender = 'tenant' THEN 1 ELSE 0 END) AS unread,
           MAX(CASE WHEN m.escalated = 1 THEN m.created_at ELSE 0 END) AS last_escalated_at,
           MAX(CASE WHEN m.sender = 'operator' THEN m.created_at ELSE 0 END) AS last_operator_at
    FROM support_messages m
    JOIN tenants t ON t.id = m.tenant_id
    GROUP BY m.tenant_id
    ORDER BY last_at DESC`).all();
  return rows.map((r) => {
    const last = db.prepare(
      'SELECT sender, text FROM support_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(r.tenant_id);
    return {
      tenant_id: r.tenant_id, name: r.name, email: r.email,
      last_at: r.last_at, unread: r.unread,
      escalated_pending: r.last_escalated_at > 0 && r.last_escalated_at > r.last_operator_at,
      last_text: last ? `${last.sender === 'tenant' ? '院' : last.sender === 'operator' ? '運営' : 'AI'}: ${String(last.text).slice(0, 60)}` : '',
    };
  });
}

/** 運営KPI: 未対応（エスカレーション済みで運営未返信）のスレッド数。 */
function pendingCount(db) {
  return listThreads(db).filter((t) => t.escalated_pending).length;
}

module.exports = {
  saveMessage, listForTenant, listThreads,
  markReadByTenant, markReadByOperator, unreadForTenant, pendingCount,
};
