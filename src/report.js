'use strict';

// 月次成果レポート: 毎月1日に前月の成果を各院へ自動メール。
// 「使っている実感」を毎月届けて解約を防ぐのが目的。
// 毎時スケジューラから呼ばれ、毎月1〜3日の9時台以降に未送信ぶんを送る（サーバ停止時の取りこぼし救済つき）。
const config = require('./config');
const logger = require('./logger');
const mailer = require('./mailer');
const { newId } = require('./sign');

/** 前月の 'YYYY-MM' と開始/終了エポックms。 */
function prevMonthRange(now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const end = new Date(d.getFullYear(), d.getMonth(), 1);
  const ym = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  return { ym, start: start.getTime(), end: end.getTime() };
}

function buildMonthlyStats(db, tenantId, start, end) {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    friends_added: one('SELECT COUNT(*) n FROM friends WHERE tenant_id=? AND created_at>=? AND created_at<?', tenantId, start, end),
    clicks: one('SELECT COUNT(*) n FROM clicks WHERE tenant_id=? AND created_at>=? AND created_at<?', tenantId, start, end),
    matched: one("SELECT COUNT(*) n FROM follows WHERE tenant_id=? AND status='matched' AND created_at>=? AND created_at<?", tenantId, start, end),
    broadcasts: one("SELECT COUNT(*) n FROM broadcasts WHERE tenant_id=? AND status='sent' AND COALESCE(updated_at,created_at)>=? AND COALESCE(updated_at,created_at)<?", tenantId, start, end),
    broadcast_msgs: db.prepare("SELECT COALESCE(SUM(sent_count),0) s FROM broadcasts WHERE tenant_id=? AND status='sent' AND COALESCE(updated_at,created_at)>=? AND COALESCE(updated_at,created_at)<?").get(tenantId, start, end).s,
    step_sends: one('SELECT COUNT(*) n FROM step_sends WHERE tenant_id=? AND ok=1 AND created_at>=? AND created_at<?', tenantId, start, end),
    url_clicks: one('SELECT COUNT(*) n FROM url_clicks WHERE tenant_id=? AND created_at>=? AND created_at<?', tenantId, start, end),
    form_answers: one('SELECT COUNT(*) n FROM form_answers WHERE tenant_id=? AND created_at>=? AND created_at<?', tenantId, start, end),
    inbox_in: one("SELECT COUNT(*) n FROM inbox_messages WHERE tenant_id=? AND direction='in' AND created_at>=? AND created_at<?", tenantId, start, end),
    friends_total: one('SELECT COUNT(*) n FROM friends WHERE tenant_id=?', tenantId),
  };
}

function composeReportText(tenant, ym, s) {
  const [y, m] = ym.split('-').map(Number);
  const lines = [
    `${tenant.name || ''} 様`,
    '',
    `いつもKeiroをご利用いただきありがとうございます。`,
    `${y}年${m}月の成果をお知らせします📊`,
    '',
    `━━━ ${m}月の成果 ━━━`,
    `👥 新しい友だち：${s.friends_added}人（累計 ${s.friends_total}人）`,
    `🔗 計測リンクのクリック：${s.clicks}回`,
    `🎯 広告経由と特定できた友だち：${s.matched}人`,
    `📮 自動配信：${s.broadcast_msgs + s.step_sends}通（一斉配信${s.broadcasts}回・ステップ配信${s.step_sends}通）`,
    `👆 メッセージ内リンクのタップ：${s.url_clicks}回`,
    `📝 フォーム回答：${s.form_answers}件`,
    `💬 お客さまからのメッセージ：${s.inbox_in}件`,
    `━━━━━━━━━━━━`,
    '',
    `くわしい内訳はダッシュボードでご確認いただけます。`,
    `${config.baseUrl}/app`,
    '',
    `ご不明な点は、ダッシュボード内の「質問・サポート」からいつでもどうぞ。`,
    `Keiro（株式会社しっとる）`,
  ];
  return lines.join('\n');
}

/** 毎時呼ばれる。毎月1〜3日の9時以降に、前月レポート未送信のアクティブ院へ送信。 */
async function processMonthlyReports(db, opts = {}) {
  const now = opts.now || Date.now();
  const d = new Date(now);
  if (!opts.force && (d.getDate() > 3 || d.getHours() < 9)) return { sent: 0 };
  const { ym, start, end } = prevMonthRange(now);
  const tenants = db.prepare(
    "SELECT * FROM tenants WHERE role='tenant' AND status='active'"
  ).all();
  let sent = 0;
  for (const t of tenants) {
    if (t.created_at >= end) continue; // 前月時点で未登録の院はスキップ
    const done = db.prepare('SELECT 1 FROM monthly_reports WHERE tenant_id=? AND month=?').get(t.id, ym);
    if (done) continue;
    const stats = buildMonthlyStats(db, t.id, start, end);
    const [, m] = ym.split('-');
    const send = opts.sender || mailer.sendMail;
    // 送信の成否を確認してから「送信済み」を記録する。失敗（例外/skip/ok:false）なら記録せず、
    // 送信ウィンドウ（月初1〜3日）内の次ティックで再試行する。先に記録すると失敗時に永久未送信になる。
    let ok = false;
    try {
      const r = await send({
        to: t.email,
        subject: `[Keiro] ${Number(m)}月の成果レポート（${t.name || ''}）`,
        text: composeReportText(t, ym, stats),
      });
      ok = !r || (r.ok !== false && !r.skipped);
      if (!ok) logger.warn('monthly report send not ok', { tenant_id: t.id, month: ym, reason: (r && (r.reason || r.response)) || 'unknown' });
    } catch (e) {
      logger.error('monthly report mail error', { tenant_id: t.id, err: String((e && e.message) || e) });
    }
    if (ok) {
      db.prepare('INSERT OR IGNORE INTO monthly_reports (id, tenant_id, month, created_at) VALUES (?, ?, ?, ?)')
        .run(newId('mrp'), t.id, ym, now);
      sent++;
      logger.info('monthly report sent', { tenant_id: t.id, month: ym });
    }
  }
  return { sent, month: ym };
}

module.exports = { processMonthlyReports, buildMonthlyStats, composeReportText, prevMonthRange };
