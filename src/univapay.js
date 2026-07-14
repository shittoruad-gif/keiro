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
  enabled, getSubscription, cancelSubscription, verifyWebhook,
};
