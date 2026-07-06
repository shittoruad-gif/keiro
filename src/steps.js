'use strict';

// ステップ配信エンジン：友だち追加（必要なら流入経路別）をトリガーに、
// 設定したシナリオ（複数メッセージ＋待ち時間）を自動配信する。
const logger = require('./logger');
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const line = require('./line');

// ---- キャンペーン CRUD ----

function listCampaigns(db, tenantId) {
  const rows = db.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM step_messages m WHERE m.campaign_id = c.id) AS steps,
       (SELECT COUNT(*) FROM step_enrollments e WHERE e.campaign_id = c.id) AS enrolled,
       (SELECT COUNT(*) FROM step_enrollments e WHERE e.campaign_id = c.id AND e.status='active') AS active_enrolled
     FROM step_campaigns c WHERE c.tenant_id = ? ORDER BY c.created_at DESC`
  ).all(tenantId);
  return rows;
}

function getCampaign(db, tenantId, id) {
  const c = db.prepare('SELECT * FROM step_campaigns WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!c) return null;
  c.messages = db.prepare('SELECT id, position, delay_minutes, text FROM step_messages WHERE campaign_id = ? ORDER BY position').all(id);
  return c;
}

function createCampaign(db, tenantId, { name, media, audienceTag, active }) {
  const id = newId('cmp');
  const now = Date.now();
  db.prepare(
    `INSERT INTO step_campaigns (id, tenant_id, name, media, audience_tag, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, String(name || '無題のシナリオ'), media ? String(media).trim() : null,
    audienceTag ? String(audienceTag).trim() : null, active ? 1 : 0, now, now);
  return getCampaign(db, tenantId, id);
}

function updateCampaign(db, tenantId, id, fields) {
  const c = db.prepare('SELECT id FROM step_campaigns WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!c) return null;
  const sets = [], vals = [];
  if ('name' in fields && fields.name !== undefined) { sets.push('name = ?'); vals.push(String(fields.name)); }
  if ('media' in fields && fields.media !== undefined) { sets.push('media = ?'); vals.push(fields.media ? String(fields.media).trim() : null); }
  if ('audienceTag' in fields && fields.audienceTag !== undefined) { sets.push('audience_tag = ?'); vals.push(fields.audienceTag ? String(fields.audienceTag).trim() : null); }
  if ('active' in fields && fields.active !== undefined) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(Date.now(), id);
    db.prepare(`UPDATE step_campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getCampaign(db, tenantId, id);
}

/** ステップ（メッセージ列）を丸ごと置き換える。steps=[{delay_minutes, text}] 順番がposition。 */
function setSteps(db, tenantId, campaignId, steps) {
  const c = db.prepare('SELECT id FROM step_campaigns WHERE id = ? AND tenant_id = ?').get(campaignId, tenantId);
  if (!c) return null;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM step_messages WHERE campaign_id = ?').run(campaignId);
    let pos = 1;
    for (const s of steps || []) {
      const text = (s.text || '').toString();
      if (!text.trim()) continue;
      db.prepare(
        `INSERT INTO step_messages (id, campaign_id, position, delay_minutes, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(newId('stp'), campaignId, pos++, Math.max(0, parseInt(s.delay_minutes, 10) || 0), text, Date.now());
    }
  });
  tx();
  return getCampaign(db, tenantId, campaignId);
}

function deleteCampaign(db, tenantId, id) {
  const c = db.prepare('SELECT id FROM step_campaigns WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!c) return { deleted: 0 };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM step_sends WHERE enrollment_id IN (SELECT id FROM step_enrollments WHERE campaign_id = ?)').run(id);
    db.prepare('DELETE FROM step_enrollments WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM step_messages WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM step_campaigns WHERE id = ?').run(id);
  });
  tx();
  return { deleted: 1 };
}

// ---- 登録（enroll）----

/**
 * 友だちを該当キャンペーンに登録する。
 * - media 未指定（友だち追加時）: media が空のキャンペーン（=全員向け）に登録
 * - media 指定（claim一致時）  : media が一致するキャンペーン（=流入経路別）に登録
 * 同一(キャンペーン,友だち)でactiveな登録が既にあれば重複登録しない。
 * @returns {number} 新規登録数
 */
/** 1キャンペーンへ登録（重複activeはスキップ）。成功で1、スキップで0。 */
function _enrollOne(db, tenantId, lineUserId, campaignId) {
  const first = db.prepare('SELECT delay_minutes FROM step_messages WHERE campaign_id = ? ORDER BY position LIMIT 1').get(campaignId);
  if (!first) return 0; // ステップ未設定のキャンペーンは登録しない
  const dup = db.prepare(
    "SELECT 1 FROM step_enrollments WHERE campaign_id = ? AND line_user_id = ? AND status = 'active'"
  ).get(campaignId, lineUserId);
  if (dup) return 0;
  const now = Date.now();
  db.prepare(
    `INSERT INTO step_enrollments (id, tenant_id, campaign_id, line_user_id, status, next_position, next_send_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`
  ).run(newId('enr'), tenantId, campaignId, lineUserId, now + first.delay_minutes * 60000, now, now);
  return 1;
}

function enrollFriend(db, { tenantId, lineUserId, media }) {
  if (!tenantId || !lineUserId) return 0;
  const campaigns = (media && String(media).trim())
    ? db.prepare("SELECT id FROM step_campaigns WHERE tenant_id = ? AND active = 1 AND media = ?").all(tenantId, String(media).trim())
    : db.prepare("SELECT id FROM step_campaigns WHERE tenant_id = ? AND active = 1 AND (media IS NULL OR media = '')").all(tenantId);

  let created = 0;
  for (const c of campaigns) created += _enrollOne(db, tenantId, lineUserId, c.id);
  if (created) logger.info('step enroll', { tenant_id: tenantId, created, media: media || null });
  return created;
}

/** タグ一致のキャンペーン(audience_tag)へ登録する（会話ボットの分岐用）。 */
function enrollByTag(db, { tenantId, lineUserId, tag }) {
  if (!tenantId || !lineUserId || !tag) return 0;
  const campaigns = db.prepare(
    "SELECT id FROM step_campaigns WHERE tenant_id = ? AND active = 1 AND audience_tag = ?"
  ).all(tenantId, String(tag).trim());
  let created = 0;
  for (const c of campaigns) created += _enrollOne(db, tenantId, lineUserId, c.id);
  if (created) logger.info('step enroll by tag', { tenant_id: tenantId, created, tag });
  return created;
}

/** 特定のキャンペーンへ直接登録する（会話ボットの選択肢が明示指定した場合）。 */
function enrollInCampaign(db, { tenantId, lineUserId, campaignId }) {
  if (!tenantId || !lineUserId || !campaignId) return 0;
  const c = db.prepare('SELECT id FROM step_campaigns WHERE id = ? AND tenant_id = ? AND active = 1').get(campaignId, tenantId);
  if (!c) return 0;
  const created = _enrollOne(db, tenantId, lineUserId, campaignId);
  if (created) logger.info('step enroll in campaign', { tenant_id: tenantId, campaign_id: campaignId });
  return created;
}

/** ブロック/友だち解除時に進行中の配信を止める。 */
function stopEnrollments(db, tenantId, lineUserId) {
  const info = db.prepare(
    "UPDATE step_enrollments SET status='stopped', updated_at=? WHERE tenant_id=? AND line_user_id=? AND status='active'"
  ).run(Date.now(), tenantId, lineUserId);
  return info.changes;
}

// ---- 配信スケジューラ ----

/**
 * 配信予定時刻を過ぎたステップを送信する。
 * @param {object} [opts]
 * @param {number} [opts.now]    現在時刻(ms)
 * @param {Function} [opts.sender] (accessToken, toUserId, text) => Promise<{ok,skipped,http_status,response}>
 */
async function processDueSteps(db, opts = {}) {
  const now = opts.now || Date.now();
  const sender = opts.sender || line.pushMessage;
  const due = db.prepare(
    `SELECT e.* FROM step_enrollments e
     WHERE e.status='active' AND e.next_send_at IS NOT NULL AND e.next_send_at <= ?
     ORDER BY e.next_send_at ASC LIMIT 100`
  ).all(now);

  let sent = 0;
  for (const e of due) {
    const campaign = db.prepare('SELECT * FROM step_campaigns WHERE id = ?').get(e.campaign_id);
    if (!campaign || !campaign.active) {
      // キャンペーンが無効化/削除された → 配信停止
      db.prepare("UPDATE step_enrollments SET status='stopped', updated_at=? WHERE id=?").run(now, e.id);
      continue;
    }
    const msg = db.prepare('SELECT * FROM step_messages WHERE campaign_id = ? AND position = ?').get(e.campaign_id, e.next_position);
    if (!msg) { // もうメッセージがない
      db.prepare("UPDATE step_enrollments SET status='done', next_send_at=NULL, updated_at=? WHERE id=?").run(now, e.id);
      continue;
    }
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(e.tenant_id);
    const token = tenant ? resolveSettings(tenant).line.channelAccessToken : '';
    const r = await sender(token, e.line_user_id, msg.text);
    db.prepare(
      `INSERT INTO step_sends (id, tenant_id, enrollment_id, position, ok, http_status, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId('snd'), e.tenant_id, e.id, msg.position, r.ok ? 1 : 0, r.http_status || null, r.response || r.reason || null, Date.now());
    if (r.ok) sent++;
    else logger.warn('step send not ok', { enrollment: e.id, position: msg.position, reason: r.reason || r.http_status });

    // 結果に関わらず次へ進める（詰まり防止）。ブロック等はunfollowでstopされる。
    const next = db.prepare('SELECT delay_minutes FROM step_messages WHERE campaign_id = ? AND position = ?').get(e.campaign_id, e.next_position + 1);
    if (next) {
      db.prepare("UPDATE step_enrollments SET next_position=next_position+1, next_send_at=?, updated_at=? WHERE id=?")
        .run(Date.now() + next.delay_minutes * 60000, Date.now(), e.id);
    } else {
      db.prepare("UPDATE step_enrollments SET status='done', next_send_at=NULL, updated_at=? WHERE id=?").run(Date.now(), e.id);
    }
  }
  return { due: due.length, sent };
}

module.exports = {
  listCampaigns, getCampaign, createCampaign, updateCampaign, setSteps, deleteCampaign,
  enrollFriend, enrollByTag, enrollInCampaign, stopEnrollments, processDueSteps,
};
