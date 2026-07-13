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

function createCampaign(db, tenantId, { name, text }) {
  if (!name || !text) return { error: 'name と text は必須です' };
  const id = newId('bdc');
  const now = Date.now();
  db.prepare('INSERT INTO birthday_campaigns (id, tenant_id, name, text, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(id, tenantId, name.slice(0, 100), text, now);
  return getById(db, tenantId, id);
}

function updateCampaign(db, tenantId, id, data) {
  const sets = []; const args = [];
  if (data.name !== undefined) { sets.push('name=?'); args.push(String(data.name).slice(0, 100)); }
  if (data.text !== undefined) { sets.push('text=?'); args.push(data.text); }
  if (data.active !== undefined) { sets.push('active=?'); args.push(data.active ? 1 : 0); }
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

/** 当日(MM-DD)が誕生日の友だちに配信。毎時 app.js から呼び出す。 */
async function processBirthdays(db) {
  const d = new Date();
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  // 0時台のみ送信（毎時呼ばれるが当日1回だけ）
  if (d.getHours() !== 0) return;

  const tenants = db.prepare("SELECT * FROM tenants WHERE status='active' AND role='tenant'").all();
  for (const tenant of tenants) {
    try {
      const campaigns = db.prepare('SELECT * FROM birthday_campaigns WHERE tenant_id=? AND active=1').all(tenant.id);
      if (!campaigns.length) continue;
      const bdays = db.prepare("SELECT line_user_id FROM friends WHERE tenant_id=? AND status='active' AND birthday=?").all(tenant.id, mmdd);
      if (!bdays.length) continue;
      const token = resolveSettings(tenant).line.channelAccessToken;
      if (!token) continue;
      const year = d.getFullYear();
      for (const cmp of campaigns) {
        // 今年すでに送信済みの友だちを除外（プロセス再起動しても二重送信しない）
        const ids = bdays.map((f) => f.line_user_id).filter((uid) =>
          !db.prepare('SELECT 1 FROM birthday_sends WHERE campaign_id=? AND line_user_id=? AND year=?').get(cmp.id, uid, year));
        if (!ids.length) continue;
        for (let i = 0; i < ids.length; i += 500) {
          await line.multicast(token, ids.slice(i, i + 500), [{ type: 'text', text: cmp.text }]);
        }
        const mark = db.prepare('INSERT OR IGNORE INTO birthday_sends (id, tenant_id, campaign_id, line_user_id, year, sent_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (const uid of ids) mark.run(newId('bds'), tenant.id, cmp.id, uid, year, Date.now());
        logger.info('birthday sent', { tenant_id: tenant.id, campaign_id: cmp.id, count: ids.length, mmdd });
      }
    } catch (e) {
      logger.error('birthday error', { tenant_id: tenant.id, err: String(e && e.message || e) });
    }
  }
}

module.exports = { listCampaigns, createCampaign, updateCampaign, deleteCampaign, setBirthday, processBirthdays };
