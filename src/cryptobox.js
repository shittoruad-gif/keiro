'use strict';

// テナントの機微情報（LINE/Meta/TikTokのトークン等）を保存時に暗号化する。
// AES-256-GCM。鍵は SECRET から派生（scryptで32バイト）。
const crypto = require('crypto');
const config = require('./config');

let KEY = null;
function key() {
  if (!KEY) KEY = crypto.scryptSync(config.secret, 'keiro-secret-box-v1', 32);
  return KEY;
}

/** 平文→ "v1:<iv>:<tag>:<ciphertext>"(全てbase64)。空/nullはそのまま返す。 */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** 暗号文→平文。非暗号文(プレフィックスなし)はそのまま返す（後方互換）。 */
function decrypt(enc) {
  if (enc === null || enc === undefined || enc === '') return enc;
  if (typeof enc !== 'string' || !enc.startsWith('v1:')) return enc;
  const [, ivB, tagB, ctB] = enc.split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // 改ざん/鍵不一致
  }
}

/** 表示用に末尾4文字だけ見せる（例: ****abcd）。設定済みかの確認用。 */
function mask(plain) {
  if (!plain) return '';
  const s = String(plain);
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

module.exports = { encrypt, decrypt, mask };
