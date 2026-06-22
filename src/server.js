'use strict';

const config = require('./config');
const logger = require('./logger');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { retryDuePostbacks } = require('./postback');
const { runRetention } = require('./retention');
const billing = require('./billing');
const { createTenant } = require('./tenant');

/** 本番環境では危険な初期値・必須未設定を検出して起動を止める。 */
function validateEnv() {
  const errors = [];
  const warns = [];

  if (config.secret === 'dev-insecure-secret-change-me' || config.secret.length < 16) {
    (config.isProd ? errors : warns).push('SECRET が未設定/短すぎます（openssl rand -hex 32 で生成）。テナントの暗号化鍵・JWT・claim署名に使用されるため本番必須');
  }
  if (!config.operator.email || !config.operator.password) {
    (config.isProd ? errors : warns).push('OPERATOR_EMAIL / OPERATOR_PASSWORD 未設定（運営ログインが作成できません）');
  } else if (config.operator.password.length < 8) {
    (config.isProd ? errors : warns).push('OPERATOR_PASSWORD が短すぎます（8文字以上）');
  }
  if (config.isProd && !/^https:\/\//.test(config.baseUrl)) {
    errors.push('本番では BASE_URL を https にしてください（LINE Webhook・Cookie secure に必要）');
  }
  if (!config.univapay.enabled) warns.push('UNIVAPAY_ENABLED=false（課金は無効。トライアルのみ稼働）');

  for (const w of warns) logger.warn('env check', { detail: w });
  if (errors.length) {
    for (const e of errors) logger.error('env check failed', { detail: e });
    if (config.isProd) {
      logger.error('本番環境のため起動を中止します');
      process.exit(1);
    }
  }
}

validateEnv();

const db = openDb(config.dbPath);

// 既定プラン＋運営アカウントの初期投入
billing.ensureDefaultPlan(db);
if (config.operator.email && config.operator.password) {
  const existing = db.prepare('SELECT id, role FROM tenants WHERE email = ?').get(config.operator.email);
  if (!existing) {
    createTenant(db, { email: config.operator.email, password: config.operator.password, name: '運営', role: 'operator' });
    logger.info('operator account created', { email: config.operator.email });
  }
}

const app = createApp(db);

const server = app.listen(config.port, () => {
  logger.info('Keiro started', {
    env: config.env,
    port: config.port,
    base_url: config.baseUrl,
    login_url: `${config.baseUrl}/login`,
    operator_url: `${config.baseUrl}/operator`,
    db: config.dbPath,
    match_window_sec: config.matchWindowSec,
    retention_days: config.retentionDays,
    univapay: config.univapay.enabled,
  });
  // 人間向けにも要点を出す
  console.log(`Keiro 起動: ${config.baseUrl}  (ログイン: ${config.baseUrl}/login / 運営: ${config.baseUrl}/operator)`);
});

// ---- バックグラウンドジョブ ----
// ポストバック再送
const retryTimer = setInterval(() => {
  Promise.resolve(retryDuePostbacks(db)).catch((e) =>
    logger.error('postback retry job error', { err: String((e && e.message) || e) }));
}, config.postbackRetrySec * 1000);
if (retryTimer.unref) retryTimer.unref();

// データ保持（個人情報の自動削除）
function retentionTick() {
  try { runRetention(db); }
  catch (e) { logger.error('retention job error', { err: String((e && e.message) || e) }); }
}
retentionTick(); // 起動時に1回
const retentionTimer = setInterval(retentionTick, config.retentionIntervalSec * 1000);
if (retentionTimer.unref) retentionTimer.unref();

function shutdown(sig) {
  logger.info('shutting down', { signal: sig });
  clearInterval(retryTimer);
  clearInterval(retentionTimer);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  // 念のため猶予後に強制終了
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
