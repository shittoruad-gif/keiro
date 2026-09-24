'use strict';

// LINE公式アカウントの「今月の無料メッセージ通数」が残り少なくなった院へ、事前にお知らせする。
//
// なぜ要るか（2026-09-17 モンテローザ様で実際に起きたこと）:
//   ステップ配信（好み別のご案内・6種×3通・すべて画像つき）が順調に動いた結果、
//   友だち37名の登録だけで無料枠200通を使い切る直前（197/200）まで進んでいた。
//   お客様は「自動応答が通数を使っている」と誤解されていたが、自動応答は replyToken 方式で
//   **1通も消費しない**。消費するのは push（ステップ配信・一斉配信・クーポン・リマインダー等）だけ。
//   使い切ると、これらの配信が LINE 側で送れなくなる＝作り込んだ仕組みが止まる。
//   気づくのが「止まってから」では遅いので、8割・9割5分の時点で先にお伝えする。
//
// ⚠️ このお知らせ自体も、LINEで送れば1通を消費する。
//    残り0通のときはLINE送信が失敗するので、メールだけにする（メールは必ず送る）。

const config = require('./config');
const logger = require('./logger');
const line = require('./line');
const mailer = require('./mailer');

// お知らせを出す段階。使用率がこの値を超えたら、その段階のお知らせを1回だけ送る。
const LEVELS = [
  { level: 1, ratio: 0.80 },
  { level: 2, ratio: 0.95 },
  { level: 3, ratio: 1.00 }, // 使い切り＝配信が止まっている状態。運営にも必ず知らせる
];

/** 「2026-09」のような月の鍵。LINEの無料通数は月初にリセットされるので、お知らせも月ごとにやり直す。 */
function monthKey(now) {
  const d = new Date(now);
  // LINEの集計はJSTの月替わりで動くため、JSTに寄せてから年月を取る。
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 今月、上限（429）で届かなかった配信の本数を数える。
 * 通数APIの集計は遅れることがあるため、「実際に落ちた」こちらを優先して使う。
 */
function countDroppedThisMonth(db, tenantId, now) {
  const jst = new Date(now + 9 * 3600 * 1000);
  const startJst = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - 9 * 3600 * 1000;
  try {
    return db.prepare(
      'SELECT COUNT(*) n FROM step_sends WHERE tenant_id = ? AND http_status = 429 AND created_at >= ?'
    ).get(tenantId, startJst).n;
  } catch (e) { return 0; }
}

/**
 * その院に今送るべきお知らせの段階を返す。送る必要が無ければ 0。
 * @param {{used:number, limit:number}} quota
 * @param {string|null} sentKey  tenants.quota_notice_key（"2026-09:2" の形）
 * @param {number} [dropped] 今月、上限で実際に届かなかった本数
 */
function levelToSend(quota, sentKey, now, dropped = 0) {
  if (!quota || quota.limit === null || !(quota.limit > 0)) return 0; // 無制限プランは対象外
  const ratio = quota.used / quota.limit;
  let want = 0;
  for (const l of LEVELS) if (ratio >= l.ratio) want = l.level;
  // 通数APIが追いつく前でも、実際に落ちていれば「使い切り」として扱う。
  if (dropped > 0) want = 3;
  if (!want) return 0;

  const mk = monthKey(now);
  const [sentMonth, sentLevel] = String(sentKey || '').split(':');
  if (sentMonth === mk && Number(sentLevel) >= want) return 0; // 今月そこまでは送信済み
  return want;
}

/** お知らせの本文。コードを書かない方が読んで、その場で判断できる言葉にする。 */
function buildMessage(tenant, quota, level, dropped = 0) {
  const remain = Math.max(0, quota.limit - quota.used);
  const name = tenant.name || 'ご担当者';
  const head = level >= 3
    ? `LINEの今月の無料メッセージ（${quota.limit} 通）を使い切りました。`
      + `\nお店から送るご案内は、いま止まっています。`
      + (dropped > 0 ? `\nこれまでに ${dropped} 通が、お客様に届かないままになっています。` : '')
    : level >= 2
      ? `LINEの今月の無料メッセージが、残り ${remain} 通になりました。`
      : `LINEの今月の無料メッセージを、${quota.used} 通／${quota.limit} 通 お使いになりました。`;

  return (
    `${name} 様\n\n`
    + `${head}\n\n`
    + `■ 自動応答は通数を使っていません\n`
    + `お客様からのご質問に自動でお返事する機能は、何通お返事してもLINEの無料通数を消費しません。\n\n`
    + `■ 通数を使うのは「お店から送る配信」です\n`
    + `ステップ配信・一斉配信・クーポン配布・リマインダーが対象です。\n`
    + `画像を添えたメッセージは、文章と画像で2通と数えられます。\n`
    + `お友だちが増えるほど、1回の配信で使う通数も増えます。\n\n`
    + (level >= 3
      ? `■ いま起きていること\n`
        + `お店から送るご案内が、LINE側で送れない状態です。\n`
        + `毎月1日に通数がリセットされるので、何もしなくても翌月には再開します。\n`
        + `届かなかった分は自動では送り直されませんが、弊社でまとめてお送りできます。\n`
        + `（お客様からのご質問への自動応答は、いまも止まらず動いています）\n\n`
      : `■ このままだとどうなるか\n`
        + `残りを使い切ると、上記の配信がLINE側で送れなくなります。\n`
        + `ご用意いただいた自動のご案内が、途中で止まった状態になります。\n`
        + `（お客様からのご質問への自動応答は、使い切った後も止まりません）\n\n`)
    + `■ 続けてお使いになる場合\n`
    + `LINE公式アカウントの料金プランを「ライトプラン」へ変更してください。\n`
    + `月額 5,000円（税別）で、月 5,000通までお送りいただけます。\n`
    + `LINE公式アカウントの管理画面 → 設定 → 利用と請求 から、月単位で変更できます。\n\n`
    + `■ 変更されない場合\n`
    + `恐れ入りますが、配信の本数を減らすか、自動のご案内を止めていただく必要があります。\n`
    + `どれを残すとよいかのご相談も承ります。\n\n`
    + `Keiroの画面：${config.baseUrl}/app\n\n`
    + `──────────\n`
    + `株式会社しっとる（Keiro）`
  );
}

/** LINEで送る短い版（長文はトーク画面で読みにくいため、要点＋メールを見ていただく導線）。 */
function buildLineText(quota, level, dropped = 0) {
  const remain = Math.max(0, quota.limit - quota.used);
  if (level >= 3) {
    return (
      `LINEの今月の無料メッセージ（${quota.limit}通）を使い切りました。`
      + `\nお店から送るご案内は、いま止まっています。`
      + (dropped > 0 ? `\nこれまでに${dropped}通がお客様に届いていません。` : '')
      + `\n\n毎月1日にリセットされるので、翌月には自動で再開します。`
      + `\n届かなかった分は、弊社でまとめてお送りできます。`
      + `\n\n続けてお使いになる場合は、LINEの料金プランを「ライトプラン」（月額5,000円・税別／5,000通）へ変更してください。`
      + `\n\n詳しくはメールをお送りしています。ご相談はこのままお返事ください。`
    );
  }
  return (
    (level >= 2
      ? `LINEの今月の無料メッセージが残り ${remain} 通です。`
      : `LINEの今月の無料メッセージを ${quota.used}／${quota.limit} 通お使いです。`)
    + `\n\n使い切ると、ステップ配信や一斉配信などお店から送るご案内が送れなくなります。`
    + `\nお客様のご質問への自動応答は、使い切っても止まりません（通数を使っていないため）。`
    + `\n\n続けてお使いになる場合は、LINEの料金プランを「ライトプラン」（月額5,000円・税別／5,000通）へ変更してください。`
    + `\n\n詳しくはメールをお送りしています。ご相談はこのままお返事ください。`
  );
}

/**
 * 全テナントの通数を見て、しきい値を超えた院へお知らせする。
 * @param {object} db
 * @param {object} [opts] { now, getQuota, sendMail, pushMessage }
 * @returns {Promise<{checked:number, notified:Array, skipped:number}>}
 */
async function processQuotaNotices(db, opts = {}) {
  const now = opts.now || Date.now();
  const getQuota = opts.getQuota || line.getMessageQuota;
  const sendMail = opts.sendMail || mailer.sendMail;
  const pushMessage = opts.pushMessage || line.pushMessage;
  const decrypt = opts.decrypt || ((v) => { try { return require('./cryptobox').decrypt(v) || v; } catch { return v; } });

  const result = { checked: 0, notified: [], skipped: 0 };
  const tenants = db.prepare(
    "SELECT * FROM tenants WHERE role = 'tenant' AND status = 'active'"
  ).all();

  for (const t of tenants) {
    if (!t.line_channel_access_token) { result.skipped++; continue; }
    const token = decrypt(t.line_channel_access_token);
    let quota = null;
    try { quota = await getQuota(token); } catch (e) {
      logger.warn('quota notice: 通数を取得できませんでした', { tenant_id: t.id });
    }
    if (!quota) { result.skipped++; continue; }
    result.checked++;

    const dropped = countDroppedThisMonth(db, t.id, now);
    const level = levelToSend(quota, t.quota_notice_key, now, dropped);
    if (!level) continue;

    let mailed = false;
    if (t.email) {
      const r = await sendMail({
        to: t.email,
        subject: level >= 3
          ? '【Keiro】LINEの今月の無料メッセージを使い切りました（配信が止まっています）'
          : level >= 2
            ? '【Keiro】LINEの今月の無料メッセージが残りわずかです'
            : '【Keiro】LINEの今月の無料メッセージが8割に達しました',
        text: buildMessage(t, quota, level, dropped),
      }).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));
      mailed = !!(r && r.ok);
      if (!mailed) logger.warn('quota notice mail failed', { tenant_id: t.id, reason: (r && r.reason) || null });
    }

    // ⚠️ LINEのお知らせ自体が1通を使う。残り0通のときは送らない（失敗するため）。
    let lined = false;
    if (t.owner_line_user_id && quota.limit - quota.used > 0) {
      const r = await pushMessage(token, t.owner_line_user_id, buildLineText(quota, level, dropped))
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      lined = !!(r && r.ok !== false);
    }

    // 運営（しっとる）にも知らせる。
    // ⚠️ ここが無かったため、2026年9月にモンテローザ様が上限に達しても運営側は気づけず、
    //    33通が届かないまま6日間放置された。院だけに知らせる作りにしない。
    if (level >= 2 && config.operator.email) {
      await sendMail({
        to: config.operator.email,
        subject: level >= 3
          ? `[Keiro運営] ${t.name || t.id} の配信が止まっています（無料通数を使い切り）`
          : `[Keiro運営] ${t.name || t.id} のLINE無料通数が残りわずかです`,
        text: `${t.name || t.id}（${t.email || 'メール未登録'}）\n\n`
          + `今月の通数: ${quota.used} / ${quota.limit} 通\n`
          + (dropped > 0 ? `上限で届かなかった配信: ${dropped} 通\n` : '')
          + (level >= 3
            ? `\n配信は止まっています。ライトプランへの変更をご案内するか、翌月1日の再開を待つ判断が要ります。\n`
              + `届かなかった分は自動では送り直されないため、タグ別の配信で拾い直してください。\n`
            : `\n使い切る前にご案内してください。\n`)
          + `\n院の画面: ${config.baseUrl}/app\n`,
      }).catch((e) => logger.warn('quota notice ops mail failed', { tenant_id: t.id, reason: String((e && e.message) || e) }));
    }

    // メールもLINEも届かなかったときは記録しない（次回に再試行する）。
    if (!mailed && !lined) {
      logger.warn('quota notice: 届けられませんでした', { tenant_id: t.id });
      continue;
    }
    db.prepare('UPDATE tenants SET quota_notice_key = ?, updated_at = ? WHERE id = ?')
      .run(`${monthKey(now)}:${level}`, now, t.id);
    result.notified.push({
      tenantId: t.id, tenantName: t.name, level,
      used: quota.used, limit: quota.limit, mailed, lined, dropped,
    });
    // ⚠️ フィールド名に level を使うと logger 自身の level を上書きしてしまうので notice_level にする。
    logger.info('quota notice sent', { tenant_id: t.id, notice_level: level, used: quota.used, limit: quota.limit, mailed, lined });
  }
  return result;
}

module.exports = { processQuotaNotices, levelToSend, monthKey, buildMessage, buildLineText, countDroppedThisMonth, LEVELS };
