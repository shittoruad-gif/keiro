'use strict';

// パスワード設定/再設定リンク（署名トークン方式・DB追加なし）。
// - 運営が「設定リンク」を発行して招待（初期パスワードの共有を不要にする）
// - ログイン画面の「パスワードを忘れた場合」からメールで再設定（RESEND設定時）
// トークンには password_hash の指紋を含め、パスワード変更後は自動で失効する（実質ワンタイム）。
const crypto = require('crypto');
const config = require('./config');
const { signToken, verifyToken } = require('./sign');
const { hashPassword } = require('./auth');

const RESET_MAX_AGE_SEC = 72 * 3600; // リンク有効期限 72時間

function fingerprint(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 16);
}

/** テナント用のパスワード設定リンク（URL）を発行する。 */
function makeResetUrl(tenant) {
  const token = signToken(config.secret, {
    purpose: 'pwreset', tid: tenant.id, fp: fingerprint(tenant.password_hash), iat: Date.now(),
  });
  return `${config.baseUrl}/reset?t=${encodeURIComponent(token)}`;
}

/** リセットトークンを検証してテナントを返す（無効/期限切れ/使用済みは null）。 */
function verifyResetToken(db, token) {
  const p = verifyToken(config.secret, token, RESET_MAX_AGE_SEC);
  if (!p || p.purpose !== 'pwreset' || !p.tid) return null;
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(p.tid);
  if (!t) return null;
  if (p.fp !== fingerprint(t.password_hash)) return null; // 変更済み＝失効
  return t;
}

/** 新しいパスワードを設定する。 */
function applyNewPassword(db, tenantId, plainPassword) {
  const pw = String(plainPassword || '');
  if (pw.length < 8) return { ok: false, error: 'パスワードは8文字以上にしてください。' };
  db.prepare('UPDATE tenants SET password_hash = ?, pw_set_at = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(pw), Date.now(), Date.now(), tenantId);
  return { ok: true };
}

/** 招待用: ログイン不能なランダムハッシュ（平文はどこにも存在しない）。 */
function unusablePasswordHash() {
  return hashPassword(crypto.randomBytes(32).toString('hex'));
}

module.exports = { makeResetUrl, verifyResetToken, applyNewPassword, unusablePasswordHash, RESET_MAX_AGE_SEC };
