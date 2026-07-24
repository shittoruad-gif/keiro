'use strict';

const config = require('./config');
const logger = require('./logger');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { retryDuePostbacks } = require('./postback');
const { runRetention } = require('./retention');
const { processDueSteps } = require('./steps');
const { processScheduledBroadcasts } = require('./broadcast');
const { processDueReminders } = require('./reminders');
const { processReasks } = require('./identify');
const { processTrialNotices } = require('./trialnotice');
const billing = require('./billing');
const univapay = require('./univapay');
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
  if (!config.univapay.enabled) {
    warns.push('UNIVAPAY_ENABLED=false（課金は無効。トライアルのみ稼働）');
  } else if (!univapay.enabled()) {
    warns.push('UNIVAPAY_ENABLED=true ですが UNIVAPAY_JWT_TOKEN / UNIVAPAY_STORE_ID が未設定です（課金は実質無効のまま）');
  }

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

// 起動時リカバリ: 配信途中でクラッシュ/再起動して 'sending' のまま固まった一斉配信を復旧する。
// 部分送信済みのため安全に再送できない → 'sent' に確定して操作不能状態を解消（ログに残す）。
try {
  const stuck = db.prepare("UPDATE broadcasts SET status='sent', updated_at=? WHERE status='sending'").run(Date.now());
  if (stuck.changes) logger.warn('recovered stuck broadcasts', { count: stuck.changes });
} catch (e) { logger.error('broadcast recovery error', { err: String((e && e.message) || e) }); }

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
// 前回の実行が終わるまで次を走らせない再入防止つきスケジューラ。
// 送信が周期より長引いた場合に次ティックが同じ対象を二重送信するのを防ぐ。
function guardedInterval(name, fn, ms) {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    Promise.resolve(fn(db)).catch((e) => logger.error(name + ' scheduler error', { err: String((e && e.message) || e) }))
      .finally(() => { busy = false; });
  }, ms);
  if (timer.unref) timer.unref();
  return timer;
}

// ポストバック再送（CAPI）・ステップ配信・予約配信・リマインダ（すべて再入防止）
const retryTimer = guardedInterval('postback', retryDuePostbacks, config.postbackRetrySec * 1000);
const stepTimer = guardedInterval('step', processDueSteps, 60 * 1000);
const bcastTimer = guardedInterval('broadcast', processScheduledBroadcasts, 60 * 1000);
const reminderTimer = guardedInterval('reminder', processDueReminders, 60 * 1000);
const vacancyTimer = guardedInterval('vacancy', require('./vacancy').processVacancy, 10 * 60 * 1000); // 10分ごとに時刻判定

// 会話ボット 自己申告の再質問（見逃し救済・毎時）
const reaskTimer = setInterval(() => {
  Promise.resolve(processReasks(db)).catch((e) =>
    logger.error('identify reask scheduler error', { err: String((e && e.message) || e) }));
}, 3600 * 1000);
if (reaskTimer.unref) reaskTimer.unref();

// データ保持（個人情報の自動削除）
function retentionTick() {
  try { runRetention(db); }
  catch (e) { logger.error('retention job error', { err: String((e && e.message) || e) }); }
}
retentionTick(); // 起動時に1回
const retentionTimer = setInterval(retentionTick, config.retentionIntervalSec * 1000);
if (retentionTimer.unref) retentionTimer.unref();

// 無料期間満了の事前通知メール（契約書 第8条1項の自動履行・6時間ごと＝1日以内に確実に拾う）
function trialNoticeTick() {
  Promise.resolve(processTrialNotices(db)).catch((e) =>
    logger.error('trial notice job error', { err: String((e && e.message) || e) }));
}
trialNoticeTick(); // 起動時に1回
const trialTimer = setInterval(trialNoticeTick, 6 * 3600 * 1000);
if (trialTimer.unref) trialTimer.unref();

function shutdown(sig) {
  logger.info('shutting down', { signal: sig });
  clearInterval(retryTimer);
  clearInterval(retentionTimer);
  clearInterval(stepTimer);
  clearInterval(bcastTimer);
  clearInterval(reminderTimer);
  clearInterval(reaskTimer);
  clearInterval(trialTimer);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  // 念のため猶予後に強制終了
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
