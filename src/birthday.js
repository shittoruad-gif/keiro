'use strict';

// 誕生日配信。毎時スケジューラが当日(MM-DD)の友だちへアクティブなキャンペーンを配信。
const { newId } = require('./sign');
const { resolveSettings } = require('./tenant');
const line = require('./line');
const logger = require('./logger');

function getById(db, tenantId, id) {
  return db.prepare('SELECT * FROM birthday_campaigns WHERE id=? AND tenant_id=?').get(id, tenantId);
}

function listCampaigns(db, tenantId) {
  return db.prepare('SELECT * FROM birthday_campaigns WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId);
}

function createCampaign(db, tenantId, { name, text, days_before }) {
  if (!name || !text) return { error: 'name と text は必須です' };
  const id = newId('bdc');
  const now = Date.now();
  const before = Math.max(0, Math.min(90, parseInt(days_before, 10) || 0));
  db.prepare('INSERT INTO birthday_campaigns (id, tenant_id, name, text, days_before, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, tenantId, name.slice(0, 100), text, before, now);
  return getById(db, tenantId, id);
}

function updateCampaign(db, tenantId, id, data) {
  const sets = []; const args = [];
  if (data.name !== undefined) { sets.push('name=?'); args.push(String(data.name).slice(0, 100)); }
  if (data.text !== undefined) { sets.push('text=?'); args.push(data.text); }
  if (data.active !== undefined) { sets.push('active=?'); args.push(data.active ? 1 : 0); }
  if (data.days_before !== undefined) { sets.push('days_before=?'); args.push(Math.max(0, Math.min(90, parseInt(data.days_before, 10) || 0))); }
  if (!sets.length) return getById(db, tenantId, id);
  sets.push('updated_at=?'); args.push(Date.now());
  args.push(id, tenantId);
  db.prepare(`UPDATE birthday_campaigns SET ${sets.join(',')} WHERE id=? AND tenant_id=?`).run(...args);
  return getById(db, tenantId, id);
}

function deleteCampaign(db, tenantId, id) {
  return { deleted: db.prepare('DELETE FROM birthday_campaigns WHERE id=? AND tenant_id=?').run(id, tenantId).changes };
}

/** 友だちの誕生日(MM-DD)をセット。 */
function setBirthday(db, tenantId, friendId, birthday) {
  if (birthday && !/^\d{2}-\d{2}$/.test(birthday)) return { error: '誕生日はMM-DD形式で指定してください（例: 01-15）' };
  const n = db.prepare('UPDATE friends SET birthday=? WHERE id=? AND tenant_id=?')
    .run(birthday || null, friendId, tenantId).changes;
  if (!n) return { error: 'not found' };
  return { ok: true };
}

/** 基準日から days 日後の MM-DD（誕生日のN日前に送る＝「今日＋N日」が誕生日の人）。 */
function targetMmdd(base, days) {
  const t = new Date(base.getTime() + (days || 0) * 86400000);
  return String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

/** 誕生日（または days_before 日前）の友だちに配信。毎時 app.js から呼び出す。 */
async function processBirthdays(db, opts = {}) {
  const d = opts.now ? new Date(opts.now) : new Date();
  // 朝8時以降に送信（毎時呼ばれ、当年送信済みは birthday_sends で除外＝二重送信しない）。
  // 「0時台のみ」だと深夜の再デプロイでその日の枠を逃すと丸ごと飛ぶため、8時以降の最初の
  // ティックで送る方式にして取りこぼしを無くす（8〜23時のどれかのティックで必ず送られる）。
  if (d.getHours() < 8) return;

  const tenants = db.prepare("SELECT * FROM tenants WHERE status='active' AND role='tenant'").all();
  for (const tenant of tenants) {
    try {
      const campaigns = db.prepare('SELECT * FROM birthday_campaigns WHERE tenant_id=? AND active=1').all(tenant.id);
      if (!campaigns.length) continue;
      const token = resolveSettings(tenant).line.channelAccessToken;
      if (!token) continue;
      const year = d.getFullYear();
      for (const cmp of campaigns) {
        const mmdd = targetMmdd(d, cmp.days_before || 0);
        const bdays = db.prepare("SELECT line_user_id, display_name FROM friends WHERE tenant_id=? AND status='active' AND birthday=?").all(tenant.id, mmdd);
        if (!bdays.length) continue;
        // 今年すでに送信済みの友だちを除外（プロセス再起動しても二重送信しない）
        const ids = bdays.map((f) => f.line_user_id).filter((uid) =>
          !db.prepare('SELECT 1 FROM birthday_sends WHERE campaign_id=? AND line_user_id=? AND year=?').get(cmp.id, uid, year));
        if (!ids.length) continue;
        // 送信に成功したバッチの宛先だけを「送信済み」に記録する。
        // 失敗（トークン失効/無料枠超過/一時5xx）した分は記録せず、次のティックで再試行する。
        const mark = db.prepare('INSERT OR IGNORE INTO birthday_sends (id, tenant_id, campaign_id, line_user_id, year, sent_at) VALUES (?, ?, ?, ?, ?, ?)');
        let done = 0, failed = 0;
        const templating = require('./templating');
        if (templating.hasPersonalization(cmp.text)) {
          // {name}/{coupon}/{form:ID} 入りは友だち別に差し込んで個別push
          const sender = opts.pushSender || line.pushMessage;
          for (const uid of ids) {
            const fr = bdays.find((b) => b.line_user_id === uid);
            const text = templating.renderMessage(cmp.text, { tenantId: tenant.id, lineUserId: uid, displayName: fr && fr.display_name, db });
            const r = await sender(token, uid, text);
            if (r && r.ok) { mark.run(newId('bds'), tenant.id, cmp.id, uid, year, Date.now()); done++; } else failed++;
          }
        } else {
          const mc = opts.multicast || line.multicast;
          for (let i = 0; i < ids.length; i += 500) {
            const batch = ids.slice(i, i + 500);
            const r = await mc(token, batch, [{ type: 'text', text: cmp.text }]);
            if (r && r.ok) { for (const uid of batch) mark.run(newId('bds'), tenant.id, cmp.id, uid, year, Date.now()); done += batch.length; }
            else { failed += batch.length; }
          }
        }
        if (failed) logger.warn('birthday partial fail', { tenant_id: tenant.id, campaign_id: cmp.id, sent: done, failed, mmdd });
        else logger.info('birthday sent', { tenant_id: tenant.id, campaign_id: cmp.id, count: done, mmdd });
      }
    } catch (e) {
      logger.error('birthday error', { tenant_id: tenant.id, err: String(e && e.message || e) });
    }
  }
}

module.exports = {
  targetMmdd, listCampaigns, createCampaign, updateCampaign, deleteCampaign, setBirthday, processBirthdays };
