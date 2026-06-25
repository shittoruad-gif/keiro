'use strict';

// 一斉配信・セグメント配信（即時／予約）。
const logger = require('./logger');
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const friends = require('./friends');
const line = require('./line');

function listBroadcasts(db, tenantId) {
  return db.prepare('SELECT * FROM broadcasts WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
}

function getBroadcast(db, tenantId, id) {
  return db.prepare('SELECT * FROM broadcasts WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}

function createBroadcast(db, tenantId, { name, text, audience_type, audience_value, scheduled_at }) {
  const id = newId('bcs');
  const now = Date.now();
  const sched = scheduled_at ? parseInt(scheduled_at, 10) : null;
  const status = sched && sched > now ? 'scheduled' : 'draft';
  db.prepare(
    `INSERT INTO broadcasts (id, tenant_id, name, text, audience_type, audience_value, status, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, name || null, String(text || ''), audience_type || 'all', audience_value || null, status, sched, now, now);
  return getBroadcast(db, tenantId, id);
}

function deleteBroadcast(db, tenantId, id) {
  const b = getBroadcast(db, tenantId, id);
  if (!b) return { deleted: 0 };
  if (b.status === 'sending') return { deleted: 0, error: '送信中は削除できません' };
  db.prepare('DELETE FROM broadcasts WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  return { deleted: 1 };
}

/** 配信実行。対象を解決して multicast を500件ずつ送る。 */
async function sendBroadcast(db, tenantId, id, opts = {}) {
  const sender = opts.sender || line.multicast;
  const b = getBroadcast(db, tenantId, id);
  if (!b) return { error: 'not found' };
  if (b.status === 'sent' || b.status === 'sending') return { error: 'すでに送信済み/送信中です' };
  if (!b.text || !b.text.trim()) return { error: '本文が空です' };

  db.prepare("UPDATE broadcasts SET status='sending', updated_at=? WHERE id=?").run(Date.now(), id);
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  const token = tenant ? resolveSettings(tenant).line.channelAccessToken : '';
  const recipients = friends.getRecipients(db, tenantId, b.audience_type, b.audience_value);

  let sent = 0, fail = 0;
  for (let i = 0; i < recipients.length; i += 500) {
    const batch = recipients.slice(i, i + 500);
    const r = await sender(token, batch, b.text);
    if (r.ok) sent += batch.length; else fail += batch.length;
    if (!r.ok && !r.skipped) logger.warn('broadcast batch failed', { id, http_status: r.http_status });
  }
  const status = fail && !sent ? 'failed' : 'sent';
  db.prepare("UPDATE broadcasts SET status=?, sent_count=?, fail_count=?, updated_at=? WHERE id=?")
    .run(status, sent, fail, Date.now(), id);
  logger.info('broadcast sent', { tenant_id: tenantId, id, recipients: recipients.length, sent, fail });
  return { status, recipients: recipients.length, sent, fail };
}

/** 予約配信のうち時刻が来たものを送る（スケジューラから）。 */
async function processScheduledBroadcasts(db, opts = {}) {
  const now = opts.now || Date.now();
  const due = db.prepare("SELECT id, tenant_id FROM broadcasts WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?").all(now);
  for (const b of due) {
    try { await sendBroadcast(db, b.tenant_id, b.id, opts); }
    catch (e) { logger.error('scheduled broadcast error', { id: b.id, err: String((e && e.message) || e) }); }
  }
  return { processed: due.length };
}

module.exports = { listBroadcasts, getBroadcast, createBroadcast, deleteBroadcast, sendBroadcast, processScheduledBroadcasts };
