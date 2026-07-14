'use strict';

// 運営が管理画面から設定するアプリ全体の機微設定（UnivaPay認証情報など）。
// 値は cryptobox で暗号化してDBに保存し、起動時/保存時に config へ上書き適用する。
// これにより SSH や Coolify の環境変数編集なしで、運営画面から決済設定を完結できる。
// （環境変数が設定されている場合、DB値が優先される）
const config = require('./config');
const logger = require('./logger');
const { encrypt, decrypt } = require('./cryptobox');

const KEYS = ['univapay_jwt', 'univapay_app_secret', 'univapay_store_id', 'univapay_webhook_secret'];

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL
  );`);
}

function getRaw(db, key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? decrypt(row.value) : null;
}

/** DBに保存された値を config.univapay に反映する（未設定キーは環境変数のまま）。 */
function applyToConfig(db) {
  const jwt = getRaw(db, 'univapay_jwt');
  const appSecret = getRaw(db, 'univapay_app_secret');
  const storeId = getRaw(db, 'univapay_store_id');
  const secret = getRaw(db, 'univapay_webhook_secret');
  if (jwt) config.univapay.appJwt = jwt;
  if (appSecret) config.univapay.appSecret = appSecret;
  if (storeId) config.univapay.storeId = storeId;
  if (secret) config.univapay.webhookSecret = secret;
  // JWT＋ストアIDが揃っていれば課金連携を有効化（UNIVAPAY_ENABLED不要に）
  if (config.univapay.appJwt && config.univapay.storeId) config.univapay.enabled = true;
}

function init(db) {
  ensureTable(db);
  applyToConfig(db);
  logger.info('appsettings loaded', { univapay: status(db) });
}

/** 保存（空文字/未指定のキーは変更しない）。保存後すぐconfigへ反映。 */
function saveUnivapay(db, { jwt, app_secret, store_id, webhook_secret } = {}) {
  ensureTable(db);
  const up = db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  const now = Date.now();
  if (jwt && String(jwt).trim()) up.run('univapay_jwt', encrypt(String(jwt).trim()), now);
  if (app_secret && String(app_secret).trim()) up.run('univapay_app_secret', encrypt(String(app_secret).trim()), now);
  if (store_id && String(store_id).trim()) up.run('univapay_store_id', encrypt(String(store_id).trim()), now);
  if (webhook_secret && String(webhook_secret).trim()) up.run('univapay_webhook_secret', encrypt(String(webhook_secret).trim()), now);
  applyToConfig(db);
  return status(db);
}

/** 設定状況（値そのものは絶対に返さない）。 */
function status(db) {
  ensureTable(db);
  return {
    jwt_set: !!(getRaw(db, 'univapay_jwt') || process.env.UNIVAPAY_JWT_TOKEN),
    app_secret_set: !!(getRaw(db, 'univapay_app_secret') || process.env.UNIVAPAY_APP_SECRET),
    store_id_set: !!(getRaw(db, 'univapay_store_id') || process.env.UNIVAPAY_STORE_ID),
    webhook_secret_set: !!(getRaw(db, 'univapay_webhook_secret') || process.env.UNIVAPAY_WEBHOOK_SECRET),
    enabled: !!(config.univapay.appJwt && config.univapay.storeId),
  };
}

module.exports = { init, saveUnivapay, status };
