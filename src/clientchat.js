'use strict';

/**
 * お店とのLINEでのやり取り（しっとる通知ハブ経由）。
 *
 * なぜ要るか:
 *   Keiroの管理画面はパソコンで開くもので、店主の方は日常的には開かれない。
 *   実際、2026-09にモンテローザ様の通数が上限に達したときも、管理画面では誰も気づけなかった。
 *   一方でLINEは必ず見ていただける。そこで「お店が判断する場面」だけLINEに出す。
 *
 * ここで扱うのは次の2つだけ。設定そのもの（リッチメニュー・フォーム・ステップ配信の文面）は
 * 画面と弊社の代行に残す。表や画面で見るものをチャットで組み立てると、かえって手数が増えるため。
 *
 *   1. 修正のご依頼   … お店が書いた内容をそのまま受け、その月の何件目かを添えて運営へ回す
 *   2. 配信文面の承認 … 送る前の文面をお送りし、「送信OK」のお返事で送信できる状態にする
 *
 * 経路: お店のLINE →（しっとる通知ハブ @163zhsmk）→ Keiro の POST /api/hub/inbound → ここ
 *   ハブは薄い配達係に徹し、判断はKeiro側に置く。返す文面もKeiroが決める（opsは通知ハブを共用するため）。
 */
const logger = require('./logger');
const { newId } = require('./sign');

/** 「この文面で送ってよい」というお返事とみなす言葉。ゆらぎを広めに拾う。 */
const APPROVE_WORDS = ['送信ok', '送信OK', 'ok', 'OK', 'おk', '了解', 'これでお願いします', 'お願いします', '承認', '送ってください', 'いいです', '大丈夫です'];

/** 「2026-09」。修正依頼の月1回まとめの判定に使う（JSTの月替わり）。 */
function monthKey(now) {
  const jst = new Date(now + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/[！。、\s]/g, '');
}

function isApproval(text) {
  const n = normalize(text);
  if (!n) return false;
  return APPROVE_WORDS.some((w) => n === normalize(w));
}

/** 承認をお待ちしている配信のうち、いちばん古いもの。 */
function pendingBroadcast(db, tenantId) {
  return db.prepare(
    "SELECT * FROM broadcasts WHERE tenant_id = ? AND approval_state = 'pending' AND status IN ('draft','scheduled') ORDER BY approval_sent_at, created_at LIMIT 1"
  ).get(tenantId) || null;
}

/**
 * 配信文面を承認済みにする。送信そのものはここでは行わない
 * （送る操作は運営の画面から。誤送信を防ぐため、承認と送信は分けておく）。
 */
function approveBroadcast(db, tenantId, broadcastId, now) {
  const info = db.prepare(
    "UPDATE broadcasts SET approval_state = 'approved', approved_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).run(now, now, broadcastId, tenantId);
  return info.changes > 0;
}

/** 承認のお願いを出したことを記録する（実際の送信は呼び出し側）。 */
function markApprovalSent(db, tenantId, broadcastId, now) {
  const info = db.prepare(
    "UPDATE broadcasts SET approval_state = 'pending', approval_sent_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).run(now, now, broadcastId, tenantId);
  return info.changes > 0;
}

/** お店へお送りする「承認のお願い」の文面。 */
function buildApprovalRequest(tenant, broadcast) {
  return (
    `${tenant.name || 'ご担当者'} 様\n\n`
    + `次の内容で、お友だち全員にお送りしてよろしいでしょうか。\n`
    + `${broadcast.name ? `（${broadcast.name}）\n` : ''}\n`
    + `──────────\n${String(broadcast.text || '').slice(0, 1500)}\n──────────\n\n`
    + `このままでよろしければ「送信OK」とお返事ください。\n`
    + `直したいところがあれば、その内容をそのままお書きください。`
  );
}

/** 修正のご依頼を記録する。その月の何件目かも返す。 */
function recordChangeRequest(db, tenantId, text, now) {
  const mk = monthKey(now);
  const seq = db.prepare('SELECT COUNT(*) n FROM change_requests WHERE tenant_id = ? AND month_key = ?').get(tenantId, mk).n + 1;
  const id = newId('chg');
  db.prepare(
    'INSERT INTO change_requests (id, tenant_id, month_key, seq, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, tenantId, mk, seq, String(text || '').slice(0, 2000), 'open', now);
  return { id, seq, monthKey: mk };
}

/** 修正のご依頼へのお返事。月1回まとめのお約束を、その場で分かるようにする。 */
function buildChangeReply(tenant, seq) {
  const head = `${tenant.name || 'ご担当者'} 様\n\nご依頼を承りました。`;
  if (seq <= 1) {
    return (
      `${head}\n\n`
      + `今月1回目のご依頼です。プロプランに含まれますので、追加の費用はかかりません。\n`
      + `内容を確認して、担当からご連絡いたします。\n\n`
      + `※ 同じ月に別の日にもう一度ご依頼いただくと、2回目以降は別途お見積りとなります。`
      + `思いつかれた分は、まとめてこのままお書き足しください。`
    );
  }
  return (
    `${head}\n\n`
    + `今月${seq}回目のご依頼です。1回目とは別の日のご依頼になりますので、`
    + `恐れ入りますが別途お見積りをお送りしてから着手いたします。\n`
    + `お急ぎでなければ、来月分としてまとめることもできます。どちらがよいか担当からご相談いたします。`
  );
}

/**
 * 「終売 〇〇」「再開 〇〇」「販売中の一覧」「新作 …」を受けて、その場で反映する。該当しなければ null。
 * 反映の中身は products.js。運営へは、何をしたかを知らせるだけ（手作業は要らない）。
 */
async function handleProductCommand(db, tenant, text, { now, notifyOps }) {
  const products = require('./products');
  const t = String(text || '').trim();
  const shop = tenant.name || tenant.id;
  let m = t.match(/^(?:終売|販売終了|休止)[\s　:：、]*([\s\S]+)$/);
  if (m) {
    const r = products.pause(db, tenant.id, m[1].split('\n')[0], now);
    if (!r.ok) return null;
    await notifyOps(`【終売】${shop}\n\n「${r.name}」を終売にしました（自動のご案内${r.steps}通を飛ばす・自動の返事${r.replies}件を書き換え）。`).catch(() => {});
    const hit = r.steps || r.replies;
    return {
      kind: 'product_paused',
      replyText: `「${r.name}」を終売にしました。\n`
        + (hit
          ? `・このパンを紹介する自動のご案内（${r.steps}通）は、これから送りません。\n・お客様が名前を送ったときの自動の返事（${r.replies}件）は「販売を終了しました」に変えました。\n`
          : `ただ、自動のご案内や返事に「${r.name}」は見つかりませんでした。ご案内と同じ名前で送ってください（「販売中の一覧」で確かめられます）。\n`)
        + `\nまた販売するときは「再開 ${r.name}」と送ってください。元の文面に戻します。`,
    };
  }
  m = t.match(/^(?:再開|販売再開)[\s　:：、]*([\s\S]+)$/);
  if (m) {
    const r = products.resume(db, tenant.id, m[1].split('\n')[0]);
    if (r.ok) await notifyOps(`【再開】${shop}\n\n「${r.name}」を販売中に戻しました（自動の返事${r.restored}件を元に戻した）。`).catch(() => {});
    return {
      kind: 'product_resumed',
      replyText: r.ok
        ? `「${r.name}」を販売中に戻しました。自動のご案内をまた送り、名前を送ったときの自動の返事も元の文面に戻しました。`
        : `「${r.name}」は終売の一覧にありませんでした。「販売中の一覧」と送ると、いま止めているパンが分かります。`,
    };
  }
  if (/^(?:販売中の一覧|終売の一覧|止めている一覧|一覧)$/.test(t)) {
    const rows = products.list(db, tenant.id);
    return {
      kind: 'product_list',
      replyText: rows.length
        ? `いま終売にしているもの\n\n${rows.map((r) => '・' + r.name).join('\n')}\n\nまた販売するときは「再開 〇〇」と送ってください。`
        : 'いま終売にしているものはありません。すべてのご案内を送っています。',
    };
  }
  if (/^新作/.test(t)) {
    const r = products.addNew(db, tenant.id, t, now);
    if (!r.ok) {
      return { kind: 'product_new', replyText: '新作のパンの名前が読み取れませんでした。\n「新作 パンの名前」の形で、1行目に名前を書いて送ってください。2行目からは説明を書けます。' };
    }
    await notifyOps(`【新作】${shop}\n\n「${r.displayName}」の自動の返事を${r.updated ? '更新' : '作成'}しました（${r.limited ? '限定' : '定番'}）。\n\n${r.reply.slice(0, 400)}`).catch(() => {});
    return {
      kind: 'product_new',
      replyText: `「${r.displayName}」の自動の返事を${r.updated ? '新しくしました' : '作りました'}。お客様が「${r.displayName}」と送ると、次の文が届きます。\n\n${r.reply}\n\n`
        + '写真があれば、このトークに続けて1枚送ってください。返事に写真が付きます（明るい場所でパンが大きく写っているもの・人の顔が写っていないもの）。\n'
        + '直したいときは、もう一度「新作 …」で送り直してください。',
    };
  }
  return null;
}

/** 通知ハブから届いた写真。直近の新作に付ける。 */
async function handleInboundImage(db, tenant, buf, contentType, opts = {}) {
  const now = opts.now || Date.now();
  const notifyOps = opts.notifyOps || ((t) => require('./opsnotify').notifyOps(t, { db }));
  const r = require('./products').attachImage(db, tenant.id, buf, contentType, now);
  const shop = tenant.name || tenant.id;
  if (!r.ok) {
    return { kind: 'image_rejected', replyText: '写真を受け取れませんでした。10MBより小さい写真（JPEGかPNG）で、もう一度お送りください。' };
  }
  if (!r.product) {
    await notifyOps(`【写真】${shop}\n\n新作の連絡なしで写真が届きました。\n${r.url}`).catch(() => {});
    return { kind: 'image_saved', replyText: '写真を受け取りました。どのパンの写真か分からなかったため、担当へお伝えしました。\n新作の写真でしたら、先に「新作 パンの名前」と送ってから、写真を送ってください。' };
  }
  if (!r.attached) {
    await notifyOps(`【写真】${shop}\n\n「${r.product}」の写真が1MBを超えていたため、返事に付けていません。小さくして付けてください。\n${r.url}`).catch(() => {});
    return { kind: 'image_saved', replyText: `「${r.product}」の写真を受け取りました。写真が大きいため、担当が大きさを整えてから返事に付けます。` };
  }
  await notifyOps(`【写真】${shop}\n\n「${r.product}」の自動の返事に写真を付けました。\n${r.url}`).catch(() => {});
  return { kind: 'image_attached', replyText: `「${r.product}」の写真を受け取りました。お客様が「${r.product}」と送ると、写真つきで返事が届きます。` };
}

/**
 * ハブから届いたお店のメッセージを処理する。
 * @param {object} db
 * @param {object} tenant 送信元のご契約
 * @param {string} text お店が書いた内容
 * @param {object} [opts] { now, notifyOps }
 * @returns {Promise<{kind:string, replyText:string}>} kind: approved / change_request
 */
async function handleInbound(db, tenant, text, opts = {}) {
  const now = opts.now || Date.now();
  const notifyOps = opts.notifyOps || ((t) => require('./opsnotify').notifyOps(t, { db }));

  // 商品の終売・再開・新作（修正のご依頼には数えない。2026-10 ツラジマベーカリー様の要望で追加）
  const prod = await handleProductCommand(db, tenant, text, { now, notifyOps });
  if (prod) return prod;

  if (isApproval(text)) {
    const b = pendingBroadcast(db, tenant.id);
    if (b) {
      approveBroadcast(db, tenant.id, b.id, now);
      await notifyOps(
        `【承認】${tenant.name || tenant.id} が配信文面を承認しました\n\n`
        + `配信: ${b.name || b.id}\n\n送信は運営の画面から行ってください。`
      ).catch(() => {});
      logger.info('client approved broadcast', { tenant_id: tenant.id, broadcast_id: b.id });
      return {
        kind: 'approved',
        replyText: `ありがとうございます。この内容で送信の準備をいたします。\n配信が済みましたら、改めてご連絡いたします。`,
      };
    }
    // 承認待ちが無いのに「OK」だけ届いた場合は、ご用件として扱う（宙に浮かせない）
  }

  const rec = recordChangeRequest(db, tenant.id, text, now);
  await notifyOps(
    `【修正依頼】${tenant.name || tenant.id}（今月${rec.seq}件目）\n\n`
    + `${String(text || '').slice(0, 600)}\n\n`
    + (rec.seq <= 1 ? 'プロプランに含まれる範囲です。' : '2回目以降のため、お見積りが必要です。')
  ).catch(() => {});
  logger.info('client change request', { tenant_id: tenant.id, seq: rec.seq });
  return { kind: 'change_request', replyText: buildChangeReply(tenant, rec.seq), seq: rec.seq };
}

module.exports = {
  handleInbound, handleProductCommand, handleInboundImage, isApproval, monthKey, recordChangeRequest, buildChangeReply,
  pendingBroadcast, approveBroadcast, markApprovalSent, buildApprovalRequest, APPROVE_WORDS,
};
