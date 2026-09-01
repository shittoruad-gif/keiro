'use strict';

// 月次成果レポート: 毎月1日に前月の成果を各院へ自動メール。
// 「使っている実感」を毎月届けて解約を防ぐのが目的。
// 毎時スケジューラから呼ばれ、毎月1〜3日の9時台以降に未送信ぶんを送る（サーバ停止時の取りこぼし救済つき）。
const config = require('./config');
const logger = require('./logger');
const mailer = require('./mailer');
const notifyhub = require('./notifyhub');
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

/**
 * 新しい友だちを流入経路（媒体）ごとに数える。
 * Keiroは「どこから友だちが来たか」を見るための道具なので、
 * レポートにこの内訳が無いと、いちばん知りたいことが載っていないことになる。
 *
 * clicks/follows は保存期間を過ぎると消えるが（src/retention.js）、
 * friends は消えないので、こちらを数えるほうが取りこぼしがない。
 */
function buildSourceBreakdown(db, tenantId, start, end) {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(source_media, ''), '不明') AS media, COUNT(*) AS n
         FROM friends
        WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
        GROUP BY media
        ORDER BY n DESC`
    )
    .all(tenantId, start, end);
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

/**
 * 経路の表示名。
 * Keiroの画面が用意している選択肢だけを日本語にする。
 * それ以外は院がご自身で付けた名前（例「chirashi」）なので、そのまま出す。
 */
const MEDIA_LABELS = {
  meta: 'Meta広告（Instagram・Facebook）',
  tiktok: 'TikTok広告',
  google: 'Google広告',
  yahoo: 'Yahoo!広告',
  line: 'LINE広告',
  other: 'その他',
};
const mediaLabel = (m) => MEDIA_LABELS[String(m).toLowerCase()] || m;

/**
 * LINE版の本文。メール版と数字は同じだが、次の点が違う。
 *   ・絵文字を使わない（成果物には絵文字を入れない方針のため）
 *   ・スマホのトークで読める長さに削る。細かい内訳はダッシュボードへ誘導する
 *   ・0件の項目は出さない。何も起きていない行が並ぶと「使えていない」印象になるため
 */
function composeReportLine(tenant, ym, s, sources = []) {
  const [y, m] = ym.split('-').map(Number);
  const jp = (n) => Number(n || 0).toLocaleString();
  const lines = [];
  lines.push(`${tenant.name || ''} 様`);
  lines.push('');
  lines.push(`${y}年${m}月の成果をお知らせします。`);
  lines.push('');
  lines.push(`新しい友だち ${jp(s.friends_added)}人（累計 ${jp(s.friends_total)}人）`);
  if (s.matched > 0) lines.push(`うち広告経由と分かった方 ${jp(s.matched)}人`);
  if (s.clicks > 0) lines.push(`計測リンクのクリック ${jp(s.clicks)}回`);

  // 経路別の内訳。全員が「不明」のときは出さない（読む価値がないため）
  if (sources.some((r) => r.media !== '不明')) {
    lines.push('');
    lines.push('【どこから来たか】');
    for (const r of sources) lines.push(`・${mediaLabel(r.media)}　${jp(r.n)}人`);
  }

  const delivered = Number(s.broadcast_msgs || 0) + Number(s.step_sends || 0);
  if (delivered > 0) {
    lines.push('');
    lines.push(`自動でお送りしたメッセージ ${jp(delivered)}通`);
    if (s.broadcasts > 0) lines.push(`　一斉配信 ${jp(s.broadcasts)}回`);
    if (s.step_sends > 0) lines.push(`　ステップ配信 ${jp(s.step_sends)}通`);
    if (s.url_clicks > 0) lines.push(`　メッセージ内リンクのタップ ${jp(s.url_clicks)}回`);
  }

  const reactions = [];
  if (s.form_answers > 0) reactions.push(`フォーム回答 ${jp(s.form_answers)}件`);
  if (s.inbox_in > 0) reactions.push(`お客さまからのメッセージ ${jp(s.inbox_in)}件`);
  if (reactions.length) {
    lines.push('');
    for (const r of reactions) lines.push(r);
  }

  lines.push('');
  lines.push(`くわしい内訳はダッシュボードでご覧いただけます。`);
  lines.push(`${config.baseUrl}/app`);
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
    // LINEにも同じ内容を届ける（しっとる通知ハブ経由）。
    // メールは開かれないことが多いため、LINEを主、メールを控えの位置づけにしている。
    // ハブ側で同じ月は二度送らないよう弾かれるので、ここでは重ねて記録しない。
    // ここが失敗してもメールの送信済み記録には影響させない（LINEはあくまで追加の経路）。
    if (notifyhub.enabled()) {
      try {
        const fresh = db.prepare('SELECT * FROM tenants WHERE id=?').get(t.id);
        if (!fresh.notify_code) await notifyhub.ensureRecipient(db, fresh);
        const target = db.prepare('SELECT * FROM tenants WHERE id=?').get(t.id);
        const sources = buildSourceBreakdown(db, t.id, start, end);
        const r = await notifyhub.notify(target, composeReportLine(target, ym, stats, sources), `keiro:${ym}`);
        if (r.sent) logger.info('monthly report pushed to LINE', { tenant_id: t.id, month: ym });
      } catch (e) {
        logger.warn('monthly report LINE push error', { tenant_id: t.id, err: String((e && e.message) || e) });
      }
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

module.exports = {
  processMonthlyReports,
  buildMonthlyStats,
  buildSourceBreakdown,
  composeReportText,
  composeReportLine,
  prevMonthRange,
};
