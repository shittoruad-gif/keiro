'use strict';

// UnivaPay 定期課金（サブスク）連携。
// 認証: Authorization: Bearer {App Token JWT}（バックエンド・フロント共通の単一トークン）。
// ※ 「Bearer {secret}.{jwt}」という2値連結は誤り。Threads Studioの本番実装（server/univapay.ts）で
//   GET/PATCH/DELETEいずれも単一JWTのみで疎通済みと確認済み（2026-07-12検証）。
// App Token JWTはドメイン単位で発行され、JWTペイロードに domains:[...] としてエンコードされる
// （例: threads-studio.com用トークンは他ドメインでは使えない）。Keiro用は別途 keiro.s-toru.com を
// 許可ドメインとするApp TokenをUnivaPay管理画面（同一ストア）で新規発行する必要がある。
//
// エンドポイントはストア配下（/stores/{storeId}/subscriptions/{id}）。
// フロントの checkout widget でカードをトークン化 → transaction_token_id を取得し、
// それを使ってサーバ側でサブスクを作成する（この作成フローの実挙動は未検証。
// Threads Studioは「リンクフォーム＋Webhook」方式を採用しており widget→POST /subscriptions は
// 実地未確認。本番投入前にUnivaPayテスト環境での検証を推奨）。
const config = require('./config');
const logger = require('./logger');
const { hmac, timingSafeEq } = require('./sign');

function authHeader() {
  return `Bearer ${config.univapay.appJwt}`;
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

/** 定期課金を作成。transactionTokenId はフロントのwidgetで取得したトークン。 */
async function createSubscription({ transactionTokenId, amount, metadata }) {
  return call('POST', storePath('/subscriptions'), {
    transaction_token_id: transactionTokenId,
    amount,
    currency: config.univapay.currency,
    period: config.univapay.period,
    metadata: metadata || {},
  });
}

async function getSubscription(id) {
  return call('GET', storePath(`/subscriptions/${encodeURIComponent(id)}`));
}

/** 解約（停止）。UnivaPay公式APIはDELETEで解約。 */
async function cancelSubscription(id) {
  return call('DELETE', storePath(`/subscriptions/${encodeURIComponent(id)}`));
}

/**
 * UnivaPayのサブスクstatusを内部statusへ正規化。
 * UnivaPay: unverified / current / suspended / unpaid / canceled / completed
 */
function normalizeStatus(s) {
  switch (String(s || '').toLowerCase()) {
    case 'current': return 'active';
    case 'unverified': return 'trialing';
    case 'suspended': return 'past_due';
    case 'unpaid': return 'past_due';
    case 'canceled': return 'canceled';
    case 'completed': return 'canceled';
    default: return 'unpaid';
  }
}

// UnivaPayの署名ヘッダー名は環境により差があるため複数候補を見る
// （Threads Studio本番実装 server/_core/index.ts で確認済みの候補一覧）。
const WEBHOOK_SIGNATURE_HEADERS = ['x-univapay-signature', 'x-univapay-webhook-signature', 'univapay-signature'];

/**
 * Webhook署名検証。UnivaPayは生ボディのHMAC-SHA256(hex)を署名ヘッダーで送る。
 * hmac()/timingSafeEq() は src/sign.js の既存ヘルパー（LINE Webhook検証と同じ仕組み）を再利用。
 * @param {string} rawBody 生のリクエストボディ（JSONパース前の文字列）
 * @param {object} headers req.headers（小文字キー）
 */
function verifyWebhook(rawBody, headers) {
  const secret = config.univapay.webhookSecret;
  if (!secret) return false; // 未設定なら拒否（安全側）
  const sig = (headers && WEBHOOK_SIGNATURE_HEADERS.map((h) => headers[h]).find(Boolean)) || '';
  if (!sig) return false;
  const expected = hmac(secret, rawBody || '').toString('hex');
  return timingSafeEq(String(sig), expected);
}

module.exports = {
  enabled, createSubscription, getSubscription, cancelSubscription,
  normalizeStatus, verifyWebhook,
};
