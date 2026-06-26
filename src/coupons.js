'use strict';

const logger = require('./logger');
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const friends = require('./friends');
const line = require('./line');

function listCoupons(db, tenantId) {
  const rows = db.prepare('SELECT * FROM coupons WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId);
  return rows.map((c) => {
    const sent = db.prepare('SELECT COUNT(*) n FROM coupon_uses WHERE coupon_id = ?').get(c.id).n;
    const used = db.prepare('SELECT COUNT(*) n FROM coupon_uses WHERE coupon_id = ? AND used_at IS NOT NULL').get(c.id).n;
    return { ...c, sent_count: sent, used_count: used };
  });
}

function getCoupon(db, tenantId, id) {
  return db.prepare('SELECT * FROM coupons WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}

function createCoupon(db, tenantId, data) {
  const id = newId('cpn');
  const now = Date.now();
  db.prepare(
    `INSERT INTO coupons (id, tenant_id, title, description, discount_text, expires_at, audience_type, audience_value, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    id, tenantId,
    String(data.title || '').trim(),
    data.description ? String(data.description).trim() : null,
    data.discount_text ? String(data.discount_text).trim() : null,
    data.expires_at ? Number(data.expires_at) : null,
    data.audience_type || 'all',
    data.audience_value ? String(data.audience_value).trim() : null,
    now, now
  );
  return getCoupon(db, tenantId, id);
}

function updateCoupon(db, tenantId, id, data) {
  const c = getCoupon(db, tenantId, id);
  if (!c) return null;
  const fields = [], vals = [];
  if (data.title           !== undefined) { fields.push('title = ?');          vals.push(String(data.title).trim()); }
  if (data.description     !== undefined) { fields.push('description = ?');    vals.push(data.description || null); }
  if (data.discount_text   !== undefined) { fields.push('discount_text = ?');  vals.push(data.discount_text || null); }
  if (data.expires_at      !== undefined) { fields.push('expires_at = ?');     vals.push(data.expires_at ? Number(data.expires_at) : null); }
  if (data.audience_type   !== undefined) { fields.push('audience_type = ?');  vals.push(data.audience_type); }
  if (data.audience_value  !== undefined) { fields.push('audience_value = ?'); vals.push(data.audience_value || null); }
  if (data.active          !== undefined) { fields.push('active = ?');          vals.push(data.active ? 1 : 0); }
  if (!fields.length) return c;
  fields.push('updated_at = ?'); vals.push(Date.now());
  vals.push(id, tenantId);
  db.prepare(`UPDATE coupons SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...vals);
  return getCoupon(db, tenantId, id);
}

function deleteCoupon(db, tenantId, id) {
  if (!getCoupon(db, tenantId, id)) return { deleted: 0 };
  db.prepare('DELETE FROM coupon_uses WHERE coupon_id = ?').run(id);
  db.prepare('DELETE FROM coupons WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  return { deleted: 1 };
}

async function sendCoupon(db, tenantId, couponId, opts) {
  const sender = (opts && opts.sender) || line.multicast;
  const c = getCoupon(db, tenantId, couponId);
  if (!c) return { error: 'クーポンが見つかりません' };

  const now = Date.now();
  if (c.expires_at && c.expires_at < now) return { error: '有効期限が切れています' };

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  const token  = tenant ? resolveSettings(tenant).line.channelAccessToken : '';
  if (!token) return { error: 'LINEのChannel Access Tokenが未設定です' };

  const recipientIds = friends.getRecipients(db, tenantId, c.audience_type || 'all', c.audience_value);
  if (!recipientIds.length) return { error: '配信対象の友だちがいません' };

  const expiresStr = c.expires_at
    ? `有効期限: ${new Date(c.expires_at).toLocaleDateString('ja-JP')}まで`
    : '有効期限: なし';
  const msg = [
    `【クーポン】${c.title}`,
    c.discount_text || '',
    c.description   || '',
    expiresStr,
    '─────────────',
    'スタッフにこのメッセージをお見せください',
  ].filter(Boolean).join('\n');

  let sent = 0, fail = 0;
  for (let i = 0; i < recipientIds.length; i += 500) {
    const batch = recipientIds.slice(i, i + 500);
    const r = await sender(token, batch, msg);
    if (r.ok) sent += batch.length; else fail += batch.length;
    if (!r.ok && !r.skipped) logger.warn('coupon send batch failed', { couponId, http_status: r.http_status });
  }

  if (sent > 0) {
    const insert = db.prepare(
      'INSERT INTO coupon_uses (id, coupon_id, tenant_id, line_user_id, sent_at) VALUES (?, ?, ?, ?, ?)'
    );
    const tx = db.transaction(() => {
      for (const uid of recipientIds) insert.run(newId('cuse'), couponId, tenantId, uid, now);
    });
    tx();
    logger.info('coupon sent', { tenantId, couponId, sent, fail });
  }
  return { ok: sent > 0, sent, fail };
}

function markUsed(db, tenantId, couponId, lineUserId) {
  const row = db.prepare(
    'SELECT * FROM coupon_uses WHERE coupon_id = ? AND tenant_id = ? AND line_user_id = ? AND used_at IS NULL ORDER BY sent_at DESC LIMIT 1'
  ).get(couponId, tenantId, lineUserId);
  if (!row) return { error: '対象が見つかりません（未送信またはすでに使用済み）' };
  db.prepare('UPDATE coupon_uses SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { ok: true };
}

module.exports = { listCoupons, getCoupon, createCoupon, updateCoupon, deleteCoupon, sendCoupon, markUsed };
