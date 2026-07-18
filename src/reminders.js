'use strict';

// リマインダ配信（Lステップの「リマインダ配信」相当）。
// 友だちごとに基準日（予約日など）を設定し、オフセット日数×送信時刻で自動配信する。
// 例: 「-7日 9時: 1週間後にご予約です」「-1日 18時: 明日お待ちしています」「0日 8時: 本日ご来院日です」
const logger = require('./logger');
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const { renderMessage } = require('./templating');
const line = require('./line');

function listCampaigns(db, tenantId) {
  const rows = db.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM reminder_steps s WHERE s.campaign_id = c.id) AS step_count,
       (SELECT COUNT(*) FROM reminder_enrollments e WHERE e.campaign_id = c.id AND e.status = 'active') AS active_enrollments
     FROM reminder_campaigns c WHERE c.tenant_id = ? ORDER BY c.created_at DESC`
  ).all(tenantId);
  return rows;
}

function getCampaign(db, tenantId, id) {
  const c = db.prepare('SELECT * FROM reminder_campaigns WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!c) return null;
  c.steps = db.prepare('SELECT * FROM reminder_steps WHERE campaign_id = ? ORDER BY offset_days, send_hour, sort').all(c.id);
  return c;
}

function createCampaign(db, tenantId, { name, active }) {
  const id = newId('rmc');
  db.prepare(
    `INSERT INTO reminder_campaigns (id, tenant_id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, String(name || 'リマインダ'), active === false ? 0 : 1, Date.now(), Date.now());
  return getCampaign(db, tenantId, id);
}

function updateCampaign(db, tenantId, id, fields) {
  const c = db.prepare('SELECT id FROM reminder_campaigns WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!c) return null;
  const sets = []; const vals = [];
  if ('name' in fields) { sets.push('name = ?'); vals.push(String(fields.name || '')); }
  if ('active' in fields) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(Date.now(), id);
    db.prepare(`UPDATE reminder_campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getCampaign(db, tenantId, id);
}

function deleteCampaign(db, tenantId, id) {
  const c = db.prepare('SELECT id FROM reminder_campaigns WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!c) return { error: 'not found' };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM reminder_sends WHERE enrollment_id IN (SELECT id FROM reminder_enrollments WHERE campaign_id = ?)').run(id);
    db.prepare('DELETE FROM reminder_enrollments WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM reminder_steps WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM reminder_campaigns WHERE id = ?').run(id);
  });
  tx();
  return { ok: true };
}

/** ステップ（オフセット日数・時刻・本文）を丸ごと置換。steps=[{offset_days, send_hour, text}] */
function setSteps(db, tenantId, campaignId, steps) {
  const c = db.prepare('SELECT id FROM reminder_campaigns WHERE id = ? AND tenant_id = ?').get(campaignId, tenantId);
  if (!c) return null;
  const nowMs = Date.now();
  const newStepIds = [];
  const tx = db.transaction(() => {
    // 旧ステップの送信記録は孤児になるため削除（done判定・再送判定の汚染を防ぐ）。
    db.prepare(
      `DELETE FROM reminder_sends WHERE enrollment_id IN (SELECT id FROM reminder_enrollments WHERE campaign_id = ?)`
    ).run(campaignId);
    db.prepare('DELETE FROM reminder_steps WHERE campaign_id = ?').run(campaignId);
    let sort = 0;
    for (const s of steps || []) {
      const text = (s.text || '').toString().trim();
      if (!text) continue;
      const sid = newId('rms');
      const offset = parseInt(s.offset_days, 10) || 0;
      const hour = Math.min(23, Math.max(0, parseInt(s.send_hour, 10) || 9));
      db.prepare(
        `INSERT INTO reminder_steps (id, campaign_id, offset_days, send_hour, text, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(sid, campaignId, offset, hour, text, sort++, nowMs);
      newStepIds.push({ id: sid, offset, hour });
    }
    // 編集前に送信予定時刻を過ぎているステップは、既存のアクティブ登録者に「送信済み(ok=0)」を刻む。
    // これをしないと、文面編集で新IDに送信記録が無くなり、過去分のリマインドが再送されてしまう。
    const enrolls = db.prepare("SELECT id, base_date FROM reminder_enrollments WHERE campaign_id = ? AND status = 'active'").all(campaignId);
    const markSkip = db.prepare('INSERT OR IGNORE INTO reminder_sends (id, enrollment_id, step_id, ok, sent_at) VALUES (?, ?, ?, 0, ?)');
    for (const en of enrolls) {
      const [y, m, dd] = String(en.base_date).split('-').map(Number);
      for (const st of newStepIds) {
        const due = new Date(y, m - 1, dd + st.offset, st.hour, 0, 0, 0).getTime();
        if (due <= nowMs) markSkip.run(newId('rmd'), en.id, st.id, nowMs);
      }
    }
  });
  tx();
  return getCampaign(db, tenantId, campaignId);
}

/**
 * 友だちをリマインダに登録（基準日=YYYY-MM-DD、任意で時刻=HH:MM）。
 * 同一友だち×キャンペーンは基準日を更新（送信済み記録をリセットして再スケジュール）。
 */
function enroll(db, tenantId, campaignId, lineUserId, baseDate, baseTime) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(baseDate || ''))) return { error: '基準日は YYYY-MM-DD 形式で指定してください' };
  const time = baseTime && /^\d{2}:\d{2}$/.test(String(baseTime)) ? String(baseTime) : null;
  const c = db.prepare('SELECT id FROM reminder_campaigns WHERE id = ? AND tenant_id = ?').get(campaignId, tenantId);
  if (!c) return { error: 'キャンペーンが見つかりません' };
  const existing = db.prepare(
    "SELECT id FROM reminder_enrollments WHERE campaign_id = ? AND line_user_id = ? AND status = 'active'"
  ).get(campaignId, lineUserId);
  if (existing) {
    // 基準日変更＝送信済み記録をリセットして再スケジュール
    db.prepare('DELETE FROM reminder_sends WHERE enrollment_id = ?').run(existing.id);
    db.prepare('UPDATE reminder_enrollments SET base_date = ?, base_time = ? WHERE id = ?').run(baseDate, time, existing.id);
    return { ok: true, id: existing.id, updated: true };
  }
  const id = newId('rme');
  db.prepare(
    `INSERT INTO reminder_enrollments (id, tenant_id, campaign_id, line_user_id, base_date, base_time, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(id, tenantId, campaignId, lineUserId, baseDate, time, Date.now());
  return { ok: true, id };
}

const QUICK_CAMPAIGN_NAME = '予約リマインド（自動）';

/**
 * 「日時を登録するだけで前日にリマインドが届く」ための既定キャンペーンを用意（無ければ作成）。
 * 前日18時に {name}/{date}/{time} 差し込みの1通を送る。文面はリマインダ配信画面で編集可能。
 */
function ensureQuickCampaign(db, tenantId) {
  let c = db.prepare('SELECT * FROM reminder_campaigns WHERE tenant_id = ? AND name = ?').get(tenantId, QUICK_CAMPAIGN_NAME);
  if (!c) {
    c = createCampaign(db, tenantId, { name: QUICK_CAMPAIGN_NAME, active: true });
    setSteps(db, tenantId, c.id, [{
      offset_days: -1, send_hour: 18,
      text: '{name}さん、明日{time}からのご予約をいただいております😊\nお気をつけてお越しください。\nご都合が悪くなった場合は、このLINEにご連絡ください。',
    }]);
    c = getCampaign(db, tenantId, c.id);
  }
  return c;
}

/** {date}/{time} の差し込み値を整形（例: 7月20日 / 15時・15時30分）。 */
function formatBase(baseDate, baseTime) {
  const [y, m, d] = String(baseDate || '').split('-').map(Number);
  const date = (m && d) ? `${m}月${d}日` : '';
  let time = '';
  if (baseTime) {
    const [hh, mm] = String(baseTime).split(':').map(Number);
    time = mm ? `${hh}時${mm}分` : `${hh}時`;
  }
  return { date, time };
}

function stopEnrollment(db, tenantId, enrollmentId) {
  return db.prepare("UPDATE reminder_enrollments SET status='stopped' WHERE id = ? AND tenant_id = ?")
    .run(enrollmentId, tenantId).changes;
}

/** ブロック/解除時に全リマインダを停止。 */
function stopAllForUser(db, tenantId, lineUserId) {
  db.prepare("UPDATE reminder_enrollments SET status='stopped' WHERE tenant_id = ? AND line_user_id = ? AND status = 'active'")
    .run(tenantId, lineUserId);
}

function listEnrollments(db, tenantId, campaignId) {
  return db.prepare(
    `SELECT e.*, f.display_name FROM reminder_enrollments e
     LEFT JOIN friends f ON f.tenant_id = e.tenant_id AND f.line_user_id = e.line_user_id
     WHERE e.tenant_id = ? AND e.campaign_id = ? ORDER BY e.created_at DESC LIMIT 500`
  ).all(tenantId, campaignId);
}

/**
 * 期限が来たリマインダを送信（毎分スケジューラから呼ぶ）。
 * @param {object} [opts] {now:Date, sender:(token,userId,text)=>Promise} テスト用フック
 */
async function processDueReminders(db, opts = {}) {
  const now = opts.now || new Date();
  const sender = opts.sender || line.pushMessage;
  // 期限が到来した(=対象日が今日以前の)未送信ステップだけを、対象日の早い順に取得する。
  // 期限フィルタ・並び順が無いと、未来分がLIMIT枠を占有して期限到来分が押し出され送信漏れする。
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rows = db.prepare(
    `SELECT e.id AS enrollment_id, e.tenant_id, e.line_user_id, e.base_date, e.base_time, s.id AS step_id, s.offset_days, s.send_hour, s.text
     FROM reminder_enrollments e
     JOIN reminder_campaigns c ON c.id = e.campaign_id AND c.active = 1
     JOIN reminder_steps s ON s.campaign_id = e.campaign_id
     WHERE e.status = 'active'
       AND date(e.base_date, printf('%+d days', s.offset_days)) <= date(?)
       AND NOT EXISTS (SELECT 1 FROM reminder_sends rs WHERE rs.enrollment_id = e.id AND rs.step_id = s.id)
     ORDER BY date(e.base_date, printf('%+d days', s.offset_days)) ASC
     LIMIT 500`
  ).all(todayStr);

  for (const r of rows) {
    const [y, m, d] = r.base_date.split('-').map(Number);
    const due = new Date(y, m - 1, d + r.offset_days, r.send_hour, 0, 0, 0);
    if (now < due) continue;
    // 期限を1日以上過ぎたステップは送らない（基準日を過去日で登録した場合の誤爆防止）
    if (now.getTime() - due.getTime() > 24 * 3600 * 1000) {
      db.prepare('INSERT OR IGNORE INTO reminder_sends (id, enrollment_id, step_id, ok, sent_at) VALUES (?, ?, ?, 0, ?)')
        .run(newId('rmd'), r.enrollment_id, r.step_id, Date.now());
      continue;
    }
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(r.tenant_id);
    if (!tenant || tenant.status === 'suspended') continue;
    const token = resolveSettings(tenant).line.channelAccessToken;
    const friend = db.prepare('SELECT display_name FROM friends WHERE tenant_id = ? AND line_user_id = ?').get(r.tenant_id, r.line_user_id);
    const fb = formatBase(r.base_date, r.base_time);
    const withDt = String(r.text).replace(/\{date\}/g, fb.date).replace(/\{time\}/g, fb.time);
    const text = renderMessage(withDt, { tenantId: r.tenant_id, lineUserId: r.line_user_id, displayName: friend && friend.display_name });
    const sent = await sender(token, r.line_user_id, text);
    db.prepare('INSERT OR IGNORE INTO reminder_sends (id, enrollment_id, step_id, ok, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId('rmd'), r.enrollment_id, r.step_id, sent.ok ? 1 : 0, Date.now());
    if (!sent.ok) logger.warn('reminder send failed', { enrollment: r.enrollment_id, http_status: sent.http_status });
  }

  // 全ステップ送信済みのenrollmentをdoneに。
  // 送信記録は「現行ステップ」に属するものだけを数える（編集で削除された旧ステップの記録が
  // 混じると、実際は未送信の未来ステップが残っていても早期にdone化してしまうため）。
  db.prepare(
    `UPDATE reminder_enrollments SET status = 'done'
     WHERE status = 'active'
       AND (SELECT COUNT(*) FROM reminder_steps s WHERE s.campaign_id = reminder_enrollments.campaign_id) > 0
       AND (SELECT COUNT(*) FROM reminder_sends rs
              WHERE rs.enrollment_id = reminder_enrollments.id
                AND rs.step_id IN (SELECT id FROM reminder_steps s WHERE s.campaign_id = reminder_enrollments.campaign_id))
         >= (SELECT COUNT(*) FROM reminder_steps s WHERE s.campaign_id = reminder_enrollments.campaign_id)`
  ).run();
}

module.exports = {
  listCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
  setSteps, enroll, stopEnrollment, stopAllForUser, listEnrollments, processDueReminders,
  ensureQuickCampaign, formatBase, QUICK_CAMPAIGN_NAME,
};
