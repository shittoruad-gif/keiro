'use strict';

// UnivaPay 定期課金（サブスク）連携。
// 認証: Authorization: Bearer {secret}.{jwt}（公式 docs.univapay.com/docs/api/general/authentication/ で確認・2026-07-14）。
// バックエンドからの呼び出しはアプリトークンの「シークレット」が必須（ブラウザ利用時のみ不要）。
// ※ 旧コメント「単一JWTで疎通済み」は誤りだった（実際は401。Threads Studio本番も同様で要修正）。
// App Token JWTはドメイン単位で発行され、JWTペイロードに domains:[...] としてエンコードされる
// （例: threads-studio.com用トークンは他ドメインでは使えない）。Keiro用は別途 keiro.s-toru.com を
// 許可ドメインとするApp TokenをUnivaPay管理画面（同一ストア）で新規発行する必要がある。
//
// エンドポイントはストア配下（/stores/{storeId}/subscriptions/{id}）。
// サブスクの作成は、Threads Studio方式（同社の稼働中プロダクト）に合わせ、
// プランごとに手動作成した固定の決済リンク（UNIVAPAY_LINK_URL_LIGHT/PRO）へ誘導し、
// Webhook受信時にメールアドレス・金額で照合する方式を採る（widgetでのカード直接トークン化は行わない）。
const config = require('./config');
const logger = require('./logger');
const { hmac, timingSafeEq } = require('./sign');

function authHeader() {
  const sec = config.univapay.appSecret;
  return `Bearer ${sec ? sec + '.' : ''}${config.univapay.appJwt}`;
}

function enabled() {
  return !!(config.univapay.enabled && config.univapay.appJwt && config.univapay.storeId);
}

function storePath(suffix) {
  return `/stores/${encodeURIComponent(config.univapay.storeId)}${suffix}`;
}

async function call(method, pathname, body) {
  const url = config.univapay.apiBase.replace(/\/$/, '') + pathname;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function getSubscription(id) {
  return call('GET', storePath(`/subscriptions/${encodeURIComponent(id)}`));
}

/**
 * ストア配下の定期課金を全件取得（カーソル送り）。
 * ⚠️ ストアは全事業で共用のため、Keiro以外（Threads Studio・交通事故・Instagram広告）の
 * 契約も混ざって返る。呼び出し側でメールアドレスを見て絞ること。
 * @returns {Promise<{ok:boolean, items:Array, status:number}>}
 */
async function listSubscriptions({ maxPages = 25 } = {}) {
  const items = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i += 1) {
    const q = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await call('GET', storePath(`/subscriptions${q}`));
    if (!res.ok || !res.json) return { ok: false, items, status: res.status };
    const page = res.json.items || [];
    items.push(...page);
    if (page.length < 100) break;
    cursor = page[page.length - 1].id;
  }
  return { ok: true, items, status: 200 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 「この決済はKeiroのものか」の判定
//
// ⚠️ ストアは全事業で共用のため、**メールアドレスの一致だけでは判定できない**。
//    実例（2026-09-14 本番データで確認）: でみず鍼灸整骨院の出水様は Keiro のテナントであり、
//    同時に交通事故（月16,500円・24回払い660,000円×3）のお客様でもある。メールだけで
//    照合すると、交通事故の入金でKeiroの契約が有効になり、停止済みのテナントが復活してしまう。
//
// 判定は決済リンクで行う（Keiroのプランは UNIVAPAY_LINK_URL_* の5本だけから作られる）。
// 短縮URL（univa.cc/xxxx）は checkout.gopay.jp/info/{linkId} へ転送されるので、
// 1度だけ解決して覚えておく。解決できなかったときは金額で代替する。
// ─────────────────────────────────────────────────────────────────────────────
let linkIdCache = null;

function configuredLinkUrls() {
  const u = config.univapay;
  return [u.linkUrlLight, u.linkUrlLightNow, u.linkUrlPro, u.linkUrlProNow, u.linkUrlPro30]
    .map((s) => String(s || '').trim()).filter(Boolean);
}

function linkIdFromCheckoutUrl(url) {
  const m = String(url || '').match(/checkout\.gopay\.jp\/info\/([0-9a-f-]{16,})/i);
  return m ? m[1].toLowerCase() : null;
}

/** 設定されている決済リンク5本を linkId の集合に解決する（1回だけ・以降はキャッシュ）。 */
async function resolveLinkIds() {
  if (linkIdCache) return linkIdCache;
  const ids = new Set();
  for (const url of configuredLinkUrls()) {
    const direct = linkIdFromCheckoutUrl(url);
    if (direct) { ids.add(direct); continue; }
    try {
      const res = await fetch(url, { redirect: 'manual' });
      const loc = res.headers.get('location') || '';
      const id = linkIdFromCheckoutUrl(loc);
      if (id) ids.add(id);
      else logger.warn('決済リンクのIDを解決できませんでした', { url, status: res.status });
    } catch (e) {
      logger.warn('決済リンクのIDを解決できませんでした', { url, err: String((e && e.message) || e) });
    }
  }
  if (ids.size) linkIdCache = ids;
  return ids;
}

/** ペイロード／契約オブジェクトから決済リンクIDを取り出す。 */
function linkIdOf(obj) {
  const m = (obj && obj.metadata) || {};
  const v = m['univapay-link-id'] || m.univapay_link_id || m.linkId || null;
  return v ? String(v).toLowerCase() : null;
}

/** 金額がKeiroの月額（ライト4,980／プロ9,800）と一致するか。 */
function isPlanAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return false;
  return n === Number(config.planAmounts.pro) || n === Number(config.planAmounts.light);
}

// 公式LINE構築代。1回きりの決済で、Keiroの月額契約ではない（契約システム側で扱う）。
const LINE_BUILD_FEE = 16500;

/**
 * この決済（契約・チャージ）がKeiroのものか。
 *
 * 三上様の決め（2026-09-16）:「9,800円と4,980円のものだとKeiroと判断する。
 * 16,500円の1回のみの決済は公式LINE構築代」。
 * 決済会社のストアは全事業（Threads Studio・交通事故・Instagram広告・Keiro）で共用なので、
 * 金額で見分ける。実測（2026-09-16）でも、ストアにある9,800円4件はすべてKeiroの決済リンク経由で、
 * 4,980円は0件、他事業は 2,980／3,300／4,480／6,980／8,800／11,000／14,300／16,500／19,800／49,500／660,000 と重ならない。
 *
 * @param {Set<string>} knownLinkIds resolveLinkIds() の結果（金額が分からないときだけ使う）
 * @param {string|null} linkId ペイロードのリンクID
 * @param {number|null} amount 金額
 */
function belongsToKeiro(knownLinkIds, linkId, amount) {
  const n = Number(amount);
  // 金額が分かるときは金額だけで決める（16,500円の公式LINE構築代はここで false になる）。
  if (Number.isFinite(n) && n > 0) return isPlanAmount(n);
  // 金額が取れないときに限り、決済リンクで見分ける。
  if (linkId && knownLinkIds && knownLinkIds.size) return knownLinkIds.has(linkId);
  return false;
}

/** 通知の送り先（Webhook）の一覧。 */
async function listWebhooks() {
  return call('GET', storePath('/webhooks?limit=100'));
}

/**
 * 通知の送り先を登録する。
 * UnivaPayは auth_token をそのまま Authorization ヘッダーに載せて送ってくる固定値方式
 * （verifyWebhook がこの値と突き合わせる）。
 */
async function createWebhook({ url, authToken, triggers }) {
  return call('POST', storePath('/webhooks'), {
    url,
    auth_token: authToken,
    triggers: triggers || DEFAULT_WEBHOOK_TRIGGERS,
  });
}

// Threads Studio の本番で実際に登録されている8種と同じ（2026-09-14 実測で確認）。
const DEFAULT_WEBHOOK_TRIGGERS = [
  'subscription_created', 'subscription_payment', 'subscription_failure', 'subscription_canceled',
  'charge_finished', 'charge_updated', 'cancel_finished', 'refund_finished',
];

/** 解約（停止）。UnivaPay公式APIはDELETEで解約。 */
async function cancelSubscription(id) {
  return call('DELETE', storePath(`/subscriptions/${encodeURIComponent(id)}`));
}

// UnivaPayのWebhook認証は「管理画面でウェブフック作成時に指定した6文字以上の任意値」が
// Authorizationヘッダーにそのまま載って届く固定値方式（公式 docs.univapay.com/docs/guide/detail/webhook/
// で確認・2026-07-15）。HMAC署名は送られない。※旧実装のHMAC照合は誤りで、実通知を全拒否していた。
// 互換のため旧署名ヘッダー（HMAC hex）も受け付ける。
const WEBHOOK_SIGNATURE_HEADERS = ['x-univapay-signature', 'x-univapay-webhook-signature', 'univapay-signature'];

/**
 * Webhook認証。Authorizationヘッダーの固定値一致（UnivaPay仕様）を主とし、
 * 旧HMAC署名ヘッダーが来た場合はそちらも検証する。
 * @param {string} rawBody 生のリクエストボディ（JSONパース前の文字列）
 * @param {object} headers req.headers（小文字キー）
 */
function verifyWebhook(rawBody, headers) {
  const secret = config.univapay.webhookSecret;
  if (!secret) return false; // 未設定なら拒否（安全側）
  const auth = String((headers && headers.authorization) || '').trim();
  if (auth) {
    const bare = auth.replace(/^Bearer\s+/i, '');
    if (timingSafeEq(auth, secret) || timingSafeEq(bare, secret)) return true;
  }
  const sig = (headers && WEBHOOK_SIGNATURE_HEADERS.map((h) => headers[h]).find(Boolean)) || '';
  if (sig) {
    const expected = hmac(secret, rawBody || '').toString('hex');
    return timingSafeEq(String(sig), expected);
  }
  return false;
}

module.exports = {
  enabled, getSubscription, listSubscriptions, cancelSubscription, verifyWebhook,
  listWebhooks, createWebhook, DEFAULT_WEBHOOK_TRIGGERS,
  resolveLinkIds, linkIdOf, isPlanAmount, belongsToKeiro, LINE_BUILD_FEE,
};
