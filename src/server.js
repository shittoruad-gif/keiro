'use strict';

const config = require('./config');
const logger = require('./logger');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { retryDuePostbacks } = require('./postback');
const { runRetention } = require('./retention');

/** 本番環境では危険な初期値・必須未設定を検出して起動を止める。 */
function validateEnv() {
  const errors = [];
  const warns = [];

  if (config.secret === 'dev-insecure-secret-change-me' || config.secret.length < 16) {
    (config.isProd ? errors : warns).push('SECRET が未設定/短すぎます（openssl rand -hex 32 で生成）');
  }
  if (!config.adminPass || config.adminPass === 'admin' || config.adminPass === 'change-me') {
    (config.isProd ? errors : warns).push('ADMIN_PASS が初期値/未設定です');
  }
  if (config.isProd && !/^https:\/\//.test(config.baseUrl)) {
    errors.push('本番では BASE_URL を https にしてください（LINE Webhookは HTTPS 必須）');
  }
  if (!config.line.channelSecret) warns.push('LINE_CHANNEL_SECRET 未設定（Webhook署名検証ができません）');
  if (!config.line.channelAccessToken) warns.push('LINE_CHANNEL_ACCESS_TOKEN 未設定（挨拶返信ができません）');

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
const app = createApp(db);

const server = app.listen(config.port, () => {
  logger.info('Keiro started', {
    env: config.env,
    port: config.port,
    base_url: config.baseUrl,
    admin_url: `${config.baseUrl}/admin`,
    webhook_url: `${config.baseUrl}/webhook`,
    db: config.dbPath,
    match_window_sec: config.matchWindowSec,
    retention_days: config.retentionDays,
  });
  // 人間向けにも要点を出す
  console.log(`Keiro 起動: ${config.baseUrl}  (管理画面: ${config.baseUrl}/admin)`);
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
