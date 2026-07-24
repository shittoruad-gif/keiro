'use strict';

function getSummary(db, tenantId) {
  const n = (sql, ...a) => db.prepare(sql).get(tenantId, ...a).n;

  const totalFriends  = n('SELECT COUNT(*) n FROM friends WHERE tenant_id = ?');
  const blocked       = n("SELECT COUNT(*) n FROM friends WHERE tenant_id = ? AND status = 'blocked'");
  const activeFriends = n("SELECT COUNT(*) n FROM friends WHERE tenant_id = ? AND status = 'active'");
  const blockRate     = totalFriends > 0 ? blocked / totalFriends : 0;

  const bcastSent  = n("SELECT COUNT(*) n FROM broadcasts WHERE tenant_id = ? AND status = 'sent'");
  const bcastReach = db.prepare("SELECT COALESCE(SUM(sent_count),0) n FROM broadcasts WHERE tenant_id = ? AND status = 'sent'").get(tenantId).n;

  const conversions = n("SELECT COUNT(*) n FROM follows WHERE tenant_id = ? AND status = 'matched'");
  const clicks      = n('SELECT COUNT(*) n FROM clicks WHERE tenant_id = ?');
  const stepSends   = db.prepare(
    'SELECT COUNT(*) n FROM step_sends ss JOIN step_enrollments se ON ss.enrollment_id = se.id WHERE se.tenant_id = ? AND ss.ok = 1'
  ).get(tenantId).n;

  return {
    friends: { total: totalFriends, active: activeFriends, blocked, block_rate: blockRate },
    broadcasts: { sent: bcastSent, reach: bcastReach },
    conversions,
    clicks,
    step_sends: stepSends,
    cvr: totalFriends > 0 ? conversions / totalFriends : 0,
  };
}

function getFriendsTrend(db, tenantId, days) {
  days = days || 30;
  const since = Date.now() - days * 86400000;
  return db.prepare(
    `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day,
            COUNT(*) AS added,
            SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
     FROM friends WHERE tenant_id = ? AND created_at >= ?
     GROUP BY day ORDER BY day`
  ).all(tenantId, since);
}

function getSourceBreakdown(db, tenantId) {
  return db.prepare(
    `SELECT COALESCE(source_media, '（不明）') AS media,
            COUNT(*) AS friends,
            SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
     FROM friends WHERE tenant_id = ?
     GROUP BY source_media ORDER BY friends DESC`
  ).all(tenantId);
}

function getBroadcastStats(db, tenantId) {
  return db.prepare(
    `SELECT id, name, text, sent_count, fail_count, audience_type, audience_value,
            scheduled_at, created_at, updated_at
     FROM broadcasts WHERE tenant_id = ? AND status = 'sent'
     ORDER BY created_at DESC LIMIT 30`
  ).all(tenantId);
}

/**
 * コンバージョンファネル（直近days日）。
 * 広告クリック→友だち追加→広告と紐づけ→フォーム回答→CV送信 の段階数を返す。
 * フォーム回答とCV送信は人数ベース（同一人物の重複を除外）。
 */
function getFunnel(db, tenantId, days) {
  const since = Date.now() - (days || 30) * 86400000;
  const n = (sql) => db.prepare(sql).get(tenantId, since).n;
  return {
    days: days || 30,
    stages: [
      { key: 'clicks',  label: '広告クリック',    value: n('SELECT COUNT(*) n FROM clicks WHERE tenant_id = ? AND created_at >= ?') },
      { key: 'follows', label: '友だち追加',      value: n('SELECT COUNT(*) n FROM follows WHERE tenant_id = ? AND created_at >= ?') },
      { key: 'matched', label: '広告と紐づけ',    value: n("SELECT COUNT(*) n FROM follows WHERE tenant_id = ? AND created_at >= ? AND status = 'matched'") },
      { key: 'forms',   label: 'フォーム回答',    value: n('SELECT COUNT(DISTINCT COALESCE(line_user_id, id)) n FROM form_answers WHERE tenant_id = ? AND created_at >= ?') },
      { key: 'cv',      label: 'CV送信（媒体通知）', value: n('SELECT COUNT(DISTINCT follow_id) n FROM postbacks WHERE tenant_id = ? AND created_at >= ? AND ok = 1') },
    ],
  };
}

function getKpiTargets(db, tenantId) {
  const row = db.prepare("SELECT kpi_targets FROM tenants WHERE id = ?").get(tenantId);
  try { return JSON.parse(row && row.kpi_targets) || {}; } catch { return {}; }
}

function setKpiTargets(db, tenantId, targets) {
  db.prepare("UPDATE tenants SET kpi_targets = ? WHERE id = ?")
    .run(JSON.stringify(targets || {}), tenantId);
}

module.exports = { getSummary, getFriendsTrend, getSourceBreakdown, getBroadcastStats, getFunnel, getKpiTargets, setKpiTargets };
