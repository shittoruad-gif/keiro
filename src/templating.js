'use strict';

// 配信本文の差し込み変数（Lステップの「友だち情報の差し込み」相当）。
// 対応プレースホルダ:
//   {name}        … 友だちの表示名（未取得なら「お客様」）
//   {form:ID}     … 回答フォームの友だち別URL（回答者を自動特定できる署名付き）
//   {url:ID}      … クリック計測付きリンクの友だち別URL
// 差し込みを含む本文は multicast（全員同一文）では送れないため、
// 送信側は hasPersonalization() で判定して友だちごとの個別push に切り替える。
const config = require('./config');
const { signToken } = require('./sign');

const PLACEHOLDER_RE = /\{(name|form:[\w-]+|url:[\w-]+)\}/;

function hasPersonalization(text) {
  return PLACEHOLDER_RE.test(String(text || ''));
}

/** 友だち特定用トークン（フォーム回答・URLクリックの本人紐づけ用）。 */
function userToken(tenantId, lineUserId) {
  return signToken(config.secret, { t: tenantId, u: lineUserId, iat: Date.now() });
}

/**
 * 本文の差し込み変数を展開する。
 * @param {object} opts {tenantId, lineUserId, displayName}
 */
function renderMessage(text, { tenantId, lineUserId, displayName }) {
  let out = String(text || '');
  if (!PLACEHOLDER_RE.test(out)) return out;
  const token = encodeURIComponent(userToken(tenantId, lineUserId));
  out = out.replace(/\{name\}/g, displayName || 'お客様');
  out = out.replace(/\{form:([\w-]+)\}/g, (_, id) => `${config.baseUrl}/f/${id}?u=${token}`);
  out = out.replace(/\{url:([\w-]+)\}/g, (_, id) => `${config.baseUrl}/r/${id}?u=${token}`);
  return out;
}

module.exports = { hasPersonalization, renderMessage, userToken };
