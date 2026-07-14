'use strict';

const config = require('./config');
const { newId } = require('./sign');
const { hashPassword } = require('./auth');
const { encrypt, decrypt } = require('./cryptobox');
const crypto = require('crypto');

// 院ごとの連携情報のうち、暗号化して保存するフィールド
const SECRET_FIELDS = [
  'line_channel_secret',
  'line_channel_access_token',
  'meta_capi_token',
  'tiktok_access_token',
];

function newWebhookToken() {
  return crypto.randomBytes(18).toString('hex');
}

/** テナント作成。email重複はnullを返す。 */
function createTenant(db, { email, password, name, role = 'tenant', status = 'active' }) {
  const exists = db.prepare('SELECT 1 FROM tenants WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return null;
  const id = newId('tnt');
  const now = Date.now();
  db.prepare(
    `INSERT INTO tenants (id, email, password_hash, name, role, status, webhook_token, google_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(id, String(email).toLowerCase(), hashPassword(password), name || null, role, status, newWebhookToken(), now, now);
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

/**
 * マルチ店舗: ログイン済みオーナーの2店舗目以降を作成。
 * 同じメール・同じパスワードハッシュを共有し、それ以外（LINE連携・課金・データ）は完全に独立。
 * ※公開サインアップからは呼ばないこと（重複メール登録を外部に開放すると乗っ取りが可能になる）。
 */
function createStore(db, ownerTenant, name) {
  const id = newId('tnt');
  const now = Date.now();
  db.prepare(
    `INSERT INTO tenants (id, email, password_hash, name, role, status, webhook_token, google_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'tenant', 'active', ?, 0, ?, ?)`
  ).run(id, ownerTenant.email, ownerTenant.password_hash, name || null, newWebhookToken(), now, now);
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

/**
 * 同一メールの全店舗へパスワードハッシュを同期。
 * 店舗切替の認可は「email＋password_hash の一致」で判定するため、
 * パスワード変更・再設定時は必ずこれを呼んで全店舗を揃える。
 */
function syncPasswordHashFrom(db, tenantId) {
  const t = db.prepare('SELECT email, password_hash FROM tenants WHERE id = ?').get(tenantId);
  if (!t) return 0;
  return db.prepare('UPDATE tenants SET password_hash = ?, updated_at = ? WHERE email = ? AND id != ?')
    .run(t.password_hash, Date.now(), t.email, tenantId).changes;
}

/** 設定更新。SECRET_FIELDS は暗号化して保存。値が undefined のキーは変更しない。 */
function updateTenantSettings(db, id, fields) {
  const allowed = [
    'name', 'line_oa_add_url', 'line_destination', 'owner_line_user_id',
    'meta_pixel_id', 'meta_test_event_code', 'tiktok_pixel_id',
    'google_enabled', 'match_window_sec',
    ...SECRET_FIELDS,
  ];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (!(k in fields) || fields[k] === undefined) continue;
    let v = fields[k];
    if (SECRET_FIELDS.includes(k)) v = v ? encrypt(String(v)) : null;
    if (k === 'google_enabled') v = v ? 1 : 0;
    if (k === 'match_window_sec') v = v ? parseInt(v, 10) : null;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  vals.push(Date.now(), id);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/** 復号済みの実効設定を返す（postback/LINE処理が使う形）。 */
function resolveSettings(tenant) {
  return {
    line: {
      channelSecret: decrypt(tenant.line_channel_secret) || '',
      channelAccessToken: decrypt(tenant.line_channel_access_token) || '',
      oaAddUrl: tenant.line_oa_add_url || '',
      destination: tenant.line_destination || '',
    },
    meta: {
      pixelId: tenant.meta_pixel_id || '',
      capiToken: decrypt(tenant.meta_capi_token) || '',
      testEventCode: tenant.meta_test_event_code || '',
      graphVersion: 'v20.0',
    },
    tiktok: {
      pixelId: tenant.tiktok_pixel_id || '',
      accessToken: decrypt(tenant.tiktok_access_token) || '',
    },
    google: { enabled: !!tenant.google_enabled },
    matchWindowSec: tenant.match_window_sec || config.matchWindowSec,
  };
}

/** 管理画面向け：機微情報は設定済みかどうかだけ返す（値は返さない）。 */
function publicSettings(tenant) {
  return {
    name: tenant.name || '',
    webhook_token: tenant.webhook_token,
    line_oa_add_url: tenant.line_oa_add_url || '',
    line_channel_secret_set: !!tenant.line_channel_secret,
    line_channel_access_token_set: !!tenant.line_channel_access_token,
    meta_pixel_id: tenant.meta_pixel_id || '',
    meta_capi_token_set: !!tenant.meta_capi_token,
    meta_test_event_code: tenant.meta_test_event_code || '',
    tiktok_pixel_id: tenant.tiktok_pixel_id || '',
    tiktok_access_token_set: !!tenant.tiktok_access_token,
    google_enabled: !!tenant.google_enabled,
    match_window_sec: tenant.match_window_sec || null,
    owner_line_user_id: tenant.owner_line_user_id || null,
  };
}

module.exports = {
  createStore, syncPasswordHashFrom,
  SECRET_FIELDS, newWebhookToken,
  createTenant, updateTenantSettings, resolveSettings, publicSettings,
};
