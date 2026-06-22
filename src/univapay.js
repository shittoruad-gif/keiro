'use strict';

// UnivaPay 定期課金（サブスク）連携。
// 認証: Authorization: Bearer {secret}.{jwt}（バックエンド）。
// フロントの checkout widget でカードをトークン化 → transaction_token_id を取得し、
// それを使ってサーバ側でサブスクを作成する。
const config = require('./config');
const logger = require('./logger');

function authHeader() {
  return `Bearer ${config.univapay.secret}.${config.univapay.appJwt}`;
}

function enabled() {
  return !!(config.univapay.enabled && config.univapay.appJwt && config.univapay.secret);
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
  return call('POST', '/subscriptions', {
    transaction_token_id: transactionTokenId,
    amount,
    currency: config.univapay.currency,
    period: config.univapay.period,
    metadata: metadata || {},
  });
}

async function getSubscription(id) {
  return call('GET', `/subscriptions/${encodeURIComponent(id)}`);
}

/** 解約（停止）。 */
async function cancelSubscription(id) {
  return call('PATCH', `/subscriptions/${encodeURIComponent(id)}`, { status: 'canceled' });
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

/**
 * Webhook検証。UnivaPayのWebhookは作成時に設定した Authorization 値を送ってくるので、
 * それと一致するか確認する（UNIVAPAY_WEBHOOK_TOKEN）。
 */
function verifyWebhook(req) {
  const expected = config.univapay.webhookToken;
  if (!expected) return false; // 未設定なら拒否（安全側）
  const got = req.headers['authorization'] || req.headers['x-univapay-webhook'] || '';
  return got === expected || got === `Bearer ${expected}`;
}

module.exports = {
  enabled, createSubscription, getSubscription, cancelSubscription,
  normalizeStatus, verifyWebhook,
};
