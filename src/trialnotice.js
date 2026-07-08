'use strict';

// 無料利用期間の満了が近づいたテナントへ、事前通知メールを自動送信する。
// 契約書 第8条1項（満了7日前までの事前通知＝有償の継続利用・月額発生のご案内）の自動履行。
// 重複送信は tenants.trial_notice_at で防止（実際に送信できたときのみ記録）。
const config = require('./config');
const logger = require('./logger');
const billing = require('./billing');
const mailer = require('./mailer');

function noticeText(tenant, trialEndsAt) {
  const dateStr = new Date(trialEndsAt).toLocaleDateString('ja-JP');
  return (
    `${tenant.name || 'ご担当者'} 様\n\n` +
    `いつもKeiroをご利用いただきありがとうございます。\n` +
    `本システム（Keiro）の無料利用期間が ${dateStr} に終了します。\n\n` +
    `終了日の翌日より、ご選択のプランでの有償の継続利用へ自動的に移行し、月額利用料が発生します。\n` +
    `　・ライトプラン：月額 4,980円（税込）\n` +
    `　・プロプラン　：月額 9,800円（税込）\n\n` +
    `継続をご希望でない場合は、無料利用期間内にダッシュボードまたはご連絡（LINE・メール）にて解約手続きをお願いします。\n` +
    `解約後も、作成した公式LINEアカウントはそのまま乙のものとしてご利用いただけます。\n\n` +
    `ダッシュボード：${config.baseUrl}/app\n\n` +
    `──────────\n` +
    `株式会社しっとる（Keiro）`
  );
}

/**
 * 無料期間の満了が noticeDaysBefore 日以内に迫ったテナントへ事前通知を送る。
 * @param {object} [opts] { now }
 * @returns {Promise<{checked:number, sent:number}>}
 */
async function processTrialNotices(db, opts = {}) {
  const now = opts.now || Date.now();
  const before = (config.mail.noticeDaysBefore || 7) * 24 * 3600 * 1000;
  const tenants = db.prepare(
    "SELECT * FROM tenants WHERE role = 'tenant' AND status = 'active' AND trial_notice_at IS NULL AND email IS NOT NULL AND email <> ''"
  ).all();

  let sent = 0;
  for (const t of tenants) {
    const st = billing.subscriptionState(db, t);
    if (st.subscription && st.subscription.status === 'active') continue; // 既に有償契約
    if (!st.inTrial) continue;                                            // トライアル外
    const remain = st.trialEndsAt - now;
    if (remain > before || remain <= 0) continue;                         // 満了7日前〜満了前のみ

    const r = await mailer.sendMail({
      to: t.email,
      subject: '【Keiro】無料期間の終了と月額利用開始のお知らせ',
      text: noticeText(t, st.trialEndsAt),
    });
    if (r.ok) {
      db.prepare('UPDATE tenants SET trial_notice_at = ? WHERE id = ?').run(now, t.id);
      sent++;
    } else {
      // 未送信（メール未設定/失敗）は記録せず、次回以降に再試行（アプリ内バナーで併せて告知）。
      logger.warn('trial notice not sent', { tenant_id: t.id, reason: r.reason || r.http_status });
    }
  }
  if (sent) logger.info('trial notices sent', { sent, checked: tenants.length });
  return { checked: tenants.length, sent };
}

module.exports = { processTrialNotices, noticeText };
