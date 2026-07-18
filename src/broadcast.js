'use strict';

// 一斉配信・セグメント配信（即時／予約）。
const logger = require('./logger');
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const friends = require('./friends');
const line = require('./line');
const { hasPersonalization, renderMessage } = require('./templating');
const billing = require('./billing');

function listBroadcasts(db, tenantId) {
  return db.prepare('SELECT * FROM broadcasts WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
}

function getBroadcast(db, tenantId, id) {
  return db.prepare('SELECT * FROM broadcasts WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}

function createBroadcast(db, tenantId, { name, text, audience_type, audience_value, scheduled_at, image_url }) {
  const id = newId('bcs');
  const now = Date.now();
  // 予約時刻が指定されていれば予約扱い。過去時刻でも黙って下書きにせず、直近(now)で即送信対象にする。
  const schedRaw = scheduled_at ? parseInt(scheduled_at, 10) : null;
  const sched = schedRaw ? Math.max(schedRaw, now) : null;
  const status = sched ? 'scheduled' : 'draft';
  db.prepare(
    `INSERT INTO broadcasts (id, tenant_id, name, text, audience_type, audience_value, status, scheduled_at, image_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, name || null, String(text || ''), audience_type || 'all', audience_value || null, status, sched,
    image_url ? String(image_url).trim() : null, now, now);
  return getBroadcast(db, tenantId, id);
}

function deleteBroadcast(db, tenantId, id) {
  const b = getBroadcast(db, tenantId, id);
  if (!b) return { deleted: 0 };
  if (b.status === 'sending') return { deleted: 0, error: '送信中は削除できません' };
  db.prepare('DELETE FROM broadcasts WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  return { deleted: 1 };
}

/**
 * 配信実行。通常は multicast を500件ずつ送る。
 * 本文に差し込み変数（{name}/{form:ID}/{url:ID}）がある場合は、友だちごとに
 * 本文を展開して個別push（Lステップと同じ方式。multicastは全員同一文のため）。
 */
async function sendBroadcast(db, tenantId, id, opts = {}) {
  const sender = opts.sender || line.multicast;
  const b = getBroadcast(db, tenantId, id);
  if (!b) return { error: 'not found' };
  if (b.status === 'sent' || b.status === 'sending') return { error: 'すでに送信済み/送信中です' };
  if (!b.text || !b.text.trim()) return { error: '本文が空です' };

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  // 停止中・無料期間満了・未契約のテナントは配信しない（予約作成後に停止/失効した場合の誤送信を防止）。
  // status だけでなく実時間の課金状態(isMeasurementActive)で判定＝イベント無しで満了したケースも塞ぐ。
  if (!tenant || !billing.isMeasurementActive(db, tenant)) return { error: 'アカウントが停止中または無料期間満了のため配信できません' };

  db.prepare("UPDATE broadcasts SET status='sending', updated_at=? WHERE id=?").run(Date.now(), id);
  const token = resolveSettings(tenant).line.channelAccessToken;
  const recipients = friends.getRecipients(db, tenantId, b.audience_type, b.audience_value);

  let sent = 0, fail = 0;
  if (hasPersonalization(b.text)) {
    // 個別push（差し込みあり）
    const pushSender = opts.pushSender || line.pushMessages;
    const nameOf = db.prepare('SELECT display_name FROM friends WHERE tenant_id = ? AND line_user_id = ?');
    for (const uid of recipients) {
      const f = nameOf.get(tenantId, uid);
      const text = renderMessage(b.text, { tenantId, lineUserId: uid, displayName: f && f.display_name });
      const r = await pushSender(token, uid, line.buildTextImageMessages(text, b.image_url));
      if (r.ok) sent++; else fail++;
    }
  } else {
    // multicast（全員同一文）
    for (let i = 0; i < recipients.length; i += 500) {
      const batch = recipients.slice(i, i + 500);
      const r = await sender(token, batch, line.buildTextImageMessages(b.text, b.image_url));
      if (r.ok) sent += batch.length; else fail += batch.length;
      if (!r.ok && !r.skipped) logger.warn('broadcast batch failed', { id, http_status: r.http_status });
    }
  }
  const status = fail && !sent ? 'failed' : 'sent';
  db.prepare("UPDATE broadcasts SET status=?, sent_count=?, fail_count=?, updated_at=? WHERE id=?")
    .run(status, sent, fail, Date.now(), id);
  logger.info('broadcast sent', { tenant_id: tenantId, id, recipients: recipients.length, sent, fail });
  return { status, recipients: recipients.length, sent, fail };
}

/** 予約配信のうち時刻が来たものを送る（スケジューラから）。 */
const STALE_BROADCAST_MS = 24 * 3600 * 1000; // 予約時刻を大幅に過ぎた配信は「不発」で確定する

async function processScheduledBroadcasts(db, opts = {}) {
  const now = opts.now || Date.now();
  // 予約時刻を24時間以上過ぎたものは失効させる（停止中や障害で滞留した配信が、後日テナント再開時に
  // 突然発火して古い告知が全員に届くのを防ぐ）。
  const staleCut = now - STALE_BROADCAST_MS;
  const stale = db.prepare("UPDATE broadcasts SET status='canceled', updated_at=? WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at < ?").run(now, staleCut);
  if (stale.changes) logger.warn('scheduled broadcasts expired (too late)', { count: stale.changes });

  const due = db.prepare("SELECT id, tenant_id FROM broadcasts WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?").all(now);
  for (const b of due) {
    try { await sendBroadcast(db, b.tenant_id, b.id, opts); }
    catch (e) { logger.error('scheduled broadcast error', { id: b.id, err: String((e && e.message) || e) }); }
  }
  return { processed: due.length };
}

module.exports = { listBroadcasts, getBroadcast, createBroadcast, deleteBroadcast, sendBroadcast, processScheduledBroadcasts };
