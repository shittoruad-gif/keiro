'use strict';

// 運営向け: テナント（院）ごとの利用状況の集計と健全度スコア。
// 「どの院がちゃんと使えていて、どの院にフォローが必要か」を一目で分かる形に落とす。

const DAY = 86400000;

function count(db, sql, ...args) { return db.prepare(sql).get(...args).n; }

/** テナント1件ぶんの利用状況メトリクス。 */
function tenantUsage(db, t) {
  const now = Date.now();
  const d30 = now - 30 * DAY;
  const d7 = now - 7 * DAY;

  const friendsTotal = count(db, "SELECT COUNT(*) n FROM friends WHERE tenant_id=?", t.id);
  const friends30 = count(db, "SELECT COUNT(*) n FROM friends WHERE tenant_id=? AND created_at>=?", t.id, d30);
  const clicks30 = count(db, "SELECT COUNT(*) n FROM clicks WHERE tenant_id=? AND created_at>=?", t.id, d30);
  const broadcastSent30 = db.prepare(
    "SELECT COALESCE(SUM(sent_count),0) s FROM broadcasts WHERE tenant_id=? AND status='sent' AND COALESCE(updated_at, created_at)>=?"
  ).get(t.id, d30).s;
  const stepSends30 = count(db, "SELECT COUNT(*) n FROM step_sends WHERE tenant_id=? AND ok=1 AND created_at>=?", t.id, d30);
  const inboxIn7 = count(db, "SELECT COUNT(*) n FROM inbox_messages WHERE tenant_id=? AND direction='in' AND created_at>=?", t.id, d7);

  const features = {
    line_connected: !!t.line_channel_access_token,
    richmenu_active: count(db, "SELECT COUNT(*) n FROM rich_menus WHERE tenant_id=? AND status='active'", t.id) > 0,
    steps: count(db, "SELECT COUNT(*) n FROM step_campaigns WHERE tenant_id=? AND active=1", t.id) > 0,
    autoreplies: count(db, "SELECT COUNT(*) n FROM autoreplies WHERE tenant_id=? AND active=1", t.id) > 0,
    bot: count(db, "SELECT COUNT(*) n FROM bot_flows WHERE tenant_id=? AND active=1", t.id) > 0,
    forms: count(db, "SELECT COUNT(*) n FROM forms WHERE tenant_id=? AND active=1", t.id) > 0,
    reminders: count(db, "SELECT COUNT(*) n FROM reminder_enrollments WHERE tenant_id=? AND status='active'", t.id) > 0,
    broadcast_used: broadcastSent30 > 0,
  };

  const lastActivity = Math.max(t.webhook_last_at || 0, t.last_login_at || 0) || null;

  // 健全度スコア（0-100）: 接続30 + 初期設定30(メニュー/ステップ/自動応答 各10)
  //  + 直近30日の動き30(友だち増15/配信15) + 直近14日ログイン10
  let score = 0;
  if (features.line_connected) score += 30;
  if (features.richmenu_active) score += 10;
  if (features.steps) score += 10;
  if (features.autoreplies) score += 10;
  if (friends30 > 0) score += 15;
  if (broadcastSent30 > 0 || stepSends30 > 0) score += 15;
  if (t.last_login_at && t.last_login_at >= now - 14 * DAY) score += 10;

  const health = score < 30 ? 'follow' : score < 60 ? 'watch' : 'good'; // 要フォロー / 様子見 / 順調

  return {
    friends_total: friendsTotal, friends_30d: friends30, clicks_30d: clicks30,
    broadcast_sent_30d: broadcastSent30, step_sends_30d: stepSends30, inbox_in_7d: inboxIn7,
    features, last_login_at: t.last_login_at || null, last_activity: lastActivity,
    score, health,
  };
}

/** 全テナント合算の日次推移（クリック・友だち追加）。 */
function overviewTrend(db, days) {
  days = days || 30;
  const since = Date.now() - days * DAY;
  const clicks = db.prepare(
    `SELECT date(created_at/1000,'unixepoch','localtime') day, COUNT(*) n FROM clicks WHERE created_at>=? GROUP BY day`
  ).all(since);
  const friends = db.prepare(
    `SELECT date(created_at/1000,'unixepoch','localtime') day, COUNT(*) n FROM friends WHERE created_at>=? GROUP BY day`
  ).all(since);
  return mergeDays(days, { clicks, friends });
}

/** テナント個別の日次推移（クリック・友だち・配信成功）。 */
function tenantTrend(db, tenantId, days) {
  days = days || 30;
  const since = Date.now() - days * DAY;
  const clicks = db.prepare(
    `SELECT date(created_at/1000,'unixepoch','localtime') day, COUNT(*) n FROM clicks WHERE tenant_id=? AND created_at>=? GROUP BY day`
  ).all(tenantId, since);
  const friends = db.prepare(
    `SELECT date(created_at/1000,'unixepoch','localtime') day, COUNT(*) n FROM friends WHERE tenant_id=? AND created_at>=? GROUP BY day`
  ).all(tenantId, since);
  const sends = db.prepare(
    `SELECT date(created_at/1000,'unixepoch','localtime') day, COUNT(*) n FROM step_sends WHERE tenant_id=? AND ok=1 AND created_at>=? GROUP BY day`
  ).all(tenantId, since);
  return mergeDays(days, { clicks, friends, sends });
}

/** 直近days日を欠けなく並べ、各系列を0埋めでマージ。 */
function mergeDays(days, seriesMap) {
  const out = [];
  const maps = {};
  for (const k of Object.keys(seriesMap)) maps[k] = new Map(seriesMap[k].map((r) => [r.day, r.n]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = { day };
    for (const k of Object.keys(maps)) row[k] = maps[k].get(day) || 0;
    out.push(row);
  }
  return out;
}

module.exports = { tenantUsage, overviewTrend, tenantTrend };
