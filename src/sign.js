'use strict';

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * claimトークンを発行する。改ざん不可（HMAC署名付き）。
 * payload(base64url JSON) + "." + sig(base64url)
 */
function signToken(secret, payloadObj) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = b64url(hmac(secret, payload));
  return `${payload}.${sig}`;
}

/**
 * claimトークンを検証する。
 * @returns {object|null} 改ざん/失効していれば null
 * @param {number} [maxAgeSec] 設定時、payload.iat からの経過で失効判定
 */
function verifyToken(secret, token, maxAgeSec) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.', 2);
  if (!payload || !sig) return null;
  const expected = b64url(hmac(secret, payload));
  if (!timingSafeEq(sig, expected)) return null;
  let obj;
  try {
    obj = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch {
    return null;
  }
  if (maxAgeSec && obj && typeof obj.iat === 'number') {
    const ageSec = (Date.now() - obj.iat) / 1000;
    if (ageSec > maxAgeSec) return null;
  }
  return obj;
}

/**
 * LINE Webhookの署名検証。
 * HMAC-SHA256(rawBody, channelSecret) を base64 して X-Line-Signature と一致確認。
 * @param {Buffer|string} rawBody  express.raw で取得した生のボディ
 */
function verifyLineSignature(channelSecret, rawBody, signatureHeader) {
  if (!channelSecret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', channelSecret)
    .update(rawBody).digest('base64');
  return timingSafeEq(signatureHeader, expected);
}

function sha256hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function newId(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(12).toString('hex');
}

module.exports = {
  signToken,
  verifyToken,
  verifyLineSignature,
  sha256hex,
  newId,
  b64url,
  b64urlDecode,
};
