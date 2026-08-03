'use strict';

// 集客スタートの支援。
// 納品して構築が終わっても、店頭でQRを掲示しなければ友だちは増えず、
// 「使っているのに成果が出ない → 解約」になってしまう。
// そこで「はじめの3ステップ」を可視化し、進んでいない院には通知して後押しする。
const config = require('./config');
const logger = require('./logger');
const mailer = require('./mailer');
const billing = require('./billing');

const STALL_DAYS = 5;              // 連携から何日たっても友だち0なら「停滞」とみなす
const REMIND_INTERVAL_MS = 7 * 24 * 3600 * 1000; // 同じ院への再通知は7日あける

/**
 * 院ごとの「はじめの3ステップ」進捗。
 * ①ポスターを印刷した ②お客様に案内した（QRがクリックされた）③友だちが増えた
 */
function getProgress(db, tenant) {
  const one = (sql, ...a) => db.prepare(sql).get(tenant.id, ...a);
  const printed = !!tenant.poster_printed_at;
  const clicks = one('SELECT COUNT(*) n FROM clicks WHERE tenant_id = ?').n;
  const friends = one("SELECT COUNT(*) n FROM friends WHERE tenant_id = ? AND status = 'active'").n;
  const lineConnected = !!tenant.line_channel_access_token;

  const steps = [
    { key: 'print', label: 'ポスター（QRコード）を印刷する', done: printed },
    { key: 'show', label: '店頭に掲示して、お客様にご案内する', done: clicks > 0 },
    { key: 'friend', label: '最初の友だち追加が入る', done: friends > 0 },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return {
    line_connected: lineConnected,
    steps,
    done_count: doneCount,
    total: steps.length,
    clicks,
    friends,
    // 全部終わったら表示しない（達成後は邪魔しない）
    show: lineConnected && doneCount < steps.length,
  };
}

/** ポスターを開いた（印刷導線に進んだ）ことを記録。 */
function markPosterPrinted(db, tenantId) {
  db.prepare('UPDATE tenants SET poster_printed_at = COALESCE(poster_printed_at, ?) WHERE id = ?')
    .run(Date.now(), tenantId);
  return { ok: true };
}

function remindText(tenant, p) {
  const url = `${config.baseUrl}/app#promo`;
  return (
    `${tenant.name || 'ご担当者'} 様\n\n` +
    `いつもKeiroをご利用いただきありがとうございます。\n` +
    `公式LINEの設定はすべて完了し、正常に動作しております。\n\n` +
    `ただ、現在まだ友だち登録が入っていない状況です。\n` +
    `お客様へのご案内（店頭でのQRコード掲示）がお済みでないかもしれません。\n\n` +
    `■ 5分で終わります\n` +
    `1. 管理画面の上のメニューから「🎁 集客・販促」を開く\n` +
    `2. 計測リンクの「店頭ポスター・チラシQR」の行にある「ポスター」ボタンを押す\n` +
    `3. A4のポスターが表示されるので印刷する\n` +
    `4. 会計カウンターなど、お客様の目に入る場所に置く\n\n` +
    `■ お会計のときのひとこと\n` +
    `「当院LINEをやっていまして、今ご登録いただくと初回特典がございます。\n` +
    `　そちらのQRコードを読み取るだけです。よかったらどうぞ」\n\n` +
    `これだけで、あとの案内はすべて自動で届きます。\n` +
    `ご不明な点は、このメールへの返信または管理画面の「質問・サポート」からお気軽にどうぞ。\n\n` +
    `管理画面：${url}\n\n` +
    `──────────\n` +
    `株式会社しっとる（Keiro）`
  );
}

/**
 * 連携済みなのに友だちが増えていない院へ、掲示のお願いを送る（院＋運営）。
 * 毎日1回スケジューラから呼ぶ。重複は launch_remind_at で防ぐ。
 */
async function processLaunchReminders(db, opts = {}) {
  const now = opts.now || Date.now();
  const send = opts.sender || mailer.sendMail;
  const tenants = db.prepare(
    "SELECT * FROM tenants WHERE role = 'tenant' AND status = 'active' AND line_channel_access_token IS NOT NULL AND email IS NOT NULL AND email <> ''"
  ).all();

  let sent = 0;
  for (const t of tenants) {
    // 課金が有効でない（＝失効済み）院には送らない
    if (!billing.isMeasurementActive(db, t)) continue;
    // 連携直後は猶予を置く
    const since = t.webhook_last_at || t.created_at || now;
    if (now - since < STALL_DAYS * 24 * 3600 * 1000) continue;
    // 直近に送っていれば見送る
    if (t.launch_remind_at && now - t.launch_remind_at < REMIND_INTERVAL_MS) continue;

    const p = getProgress(db, t);
    if (!p.show || p.friends > 0) continue; // 友だちが入ったら卒業

    const r = await send({
      to: t.email,
      subject: '【Keiro】お客様へのご案内（QRコード掲示）はお済みですか？',
      text: remindText(t, p),
    });
    if (r && r.ok) {
      db.prepare('UPDATE tenants SET launch_remind_at = ? WHERE id = ?').run(now, t.id);
      sent++;
      // 運営にも共有（フォローアップ用）
      if (config.operator.email) {
        send({
          to: config.operator.email,
          subject: `[Keiro] 集客未開始のお知らせ: ${t.name || t.email}`,
          text: `${t.name || ''}（${t.email}）\n連携済みですが、まだ友だちが0件です（クリック${p.clicks}回／ポスター印刷${p.steps[0].done ? '済' : '未'}）。\n院へ掲示のお願いメールを送信しました。必要に応じてフォローをお願いします。`,
        }).catch(() => {});
      }
    } else {
      logger.warn('launch remind not sent', { tenant_id: t.id, reason: (r && (r.reason || r.http_status)) || 'unknown' });
    }
  }
  if (sent) logger.info('launch reminders sent', { sent });
  return { checked: tenants.length, sent };
}

module.exports = { getProgress, markPosterPrinted, processLaunchReminders, remindText, STALL_DAYS };
