'use strict';

require('dotenv').config();

const path = require('path');

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',

  port: int(process.env.PORT, 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),

  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin',

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Basic認証のrealm。/admin と /api で同一にしてブラウザが資格情報を再利用できるようにする。
  authRealm: 'Keiro Admin',

  secret: process.env.SECRET || 'dev-insecure-secret-change-me',

  matchWindowSec: int(process.env.MATCH_WINDOW_SEC, 1800),

  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
  },

  meta: {
    pixelId: process.env.META_PIXEL_ID || '',
    capiToken: process.env.META_CAPI_TOKEN || '',
    testEventCode: process.env.META_TEST_EVENT_CODE || '',
    graphVersion: 'v20.0',
  },

  tiktok: {
    pixelId: process.env.TIKTOK_PIXEL_ID || '',
    accessToken: process.env.TIKTOK_ACCESS_TOKEN || '',
  },

  google: {
    enabled: bool(process.env.GOOGLE_ENABLED, false),
  },

  // 運営(operator)アカウントの初期作成用
  operator: {
    email: (process.env.OPERATOR_EMAIL || '').toLowerCase(),
    password: process.env.OPERATOR_PASSWORD || '',
  },

  // サブスク（トライアル日数・既定プラン）
  // trialDays: 制作を伴わない自己申込の既定（14日）。パスコード適用で個別に30日等へ上書き。
  trialDays: int(process.env.TRIAL_DAYS, 14),
  defaultPlan: {
    name: process.env.PLAN_NAME || 'スタンダード',
    amount: int(process.env.PLAN_AMOUNT, 4980), // 月額(円)
  },
  // 2プラン（プロ標準 / ライト）の月額（税込・円）
  planAmounts: {
    pro: int(process.env.PLAN_AMOUNT_PRO, 9800),
    light: int(process.env.PLAN_AMOUNT_LIGHT, 4980),
  },
  // パスコード（アクセスコード）既定の無料日数
  codeTrialDays: int(process.env.CODE_TRIAL_DAYS, 30),

  // 課金の日次照合（src/reconcile.js）
  billing: {
    // 無料期間が満了し有効な契約が無い院を、自動で停止扱いにするか。
    // 既定は false（運営へ通知するだけ）。お客様の計測をこちらの判断で止めないため。
    autoSuspend: bool(process.env.BILLING_AUTO_SUSPEND, false),
    // 照合の実行間隔（時間）。
    reconcileIntervalHours: int(process.env.BILLING_RECONCILE_INTERVAL_HOURS, 24),
  },

  // メール送信（Resend）。無料期間満了の事前通知等に使用。未設定なら送信スキップ。
  mail: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: process.env.MAIL_FROM || 'Keiro <no-reply@keiro.s-toru.com>',
    noticeDaysBefore: int(process.env.TRIAL_NOTICE_DAYS_BEFORE, 7), // 満了の何日前に通知するか
  },

  // UnivaPay 定期課金。
  // 認証は Bearer {secret}.{jwt}（サーバー側は App Token のシークレットが必須）。
  // JWTペイロードの domains:[...] はブラウザからの利用時に効く制限で、
  // サーバー間の呼び出し（Originを送らない）では別ドメイン発行のトークンでも通る
  // ＝ threads-studio.com 用のApp Tokenを keiro からそのまま使える（2026-08-31 実測）。
  // store_id は同一ストア（同一UnivaPayマーチャント）内なら他プロダクトと共有可。
  univapay: {
    enabled: bool(process.env.UNIVAPAY_ENABLED, false),
    apiBase: process.env.UNIVAPAY_API_BASE || 'https://api.univapay.com',
    appJwt: process.env.UNIVAPAY_JWT_TOKEN || '',
    // App Tokenのシークレット（Bearer {secret}.{jwt}・バックエンド必須）。
    // Threads Studio 側は UNIVAPAY_SECRET という名前で同じ値を持つため、両方を受け付ける。
    appSecret: process.env.UNIVAPAY_APP_SECRET || process.env.UNIVAPAY_SECRET || '',
    storeId: process.env.UNIVAPAY_STORE_ID || '',
    webhookSecret: process.env.UNIVAPAY_WEBHOOK_SECRET || '', // Webhook署名(HMAC-SHA256)の検証鍵
    currency: (process.env.UNIVAPAY_CURRENCY || 'jpy').toLowerCase(),
    period: process.env.UNIVAPAY_PERIOD || 'monthly',
    // 固定の決済リンク（UnivaPay管理画面で手動作成、プランごとに1本）。
    // Threads Studio方式: widgetでのカード直接トークン化はやめ、この固定URLへ誘導する。
    linkUrlLight: process.env.UNIVAPAY_LINK_URL_LIGHT || '',           // ライト（初回14日後課金・試用中の先行登録用）
    linkUrlLightNow: process.env.UNIVAPAY_LINK_URL_LIGHT_NOW || '',    // ライト（当日課金・期限切れ後の申込/プラン変更用）
    linkUrlPro: process.env.UNIVAPAY_LINK_URL_PRO || '',               // プロ（初回14日後課金・試用中の先行登録用）
    linkUrlProNow: process.env.UNIVAPAY_LINK_URL_PRO_NOW || '',        // プロ（当日課金・期限切れ後の申込用）
    linkUrlPro30: process.env.UNIVAPAY_LINK_URL_PRO_30D || '',         // プロ LINE構築客用（初回30日後課金）
  },

  // AI初期構築（ホームページ/LPから自動生成）。キー未設定なら機能は無効表示。
  ai: {
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_SETUP_MODEL || 'claude-sonnet-5',
    geminiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    imageModel: process.env.AI_IMAGE_MODEL || 'gemini-2.5-flash-image',
  },

  // ポストバックのリトライ
  postbackMaxAttempts: int(process.env.POSTBACK_MAX_ATTEMPTS, 5),
  postbackRetrySec: int(process.env.POSTBACK_RETRY_SEC, 60), // リトライworkerの実行間隔

  // データ保持（個人情報の自動削除）。0以下で無効。
  retentionDays: int(process.env.RETENTION_DAYS, 90),
  retentionIntervalSec: int(process.env.RETENTION_INTERVAL_SEC, 6 * 3600),

  // バックアップ
  backupDir: process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(__dirname, '..', 'data', 'backups'),
  backupKeep: int(process.env.BACKUP_KEEP, 14),

  // レート制限（公開エンドポイント。固定ウィンドウ）
  rateLimit: {
    windowSec: int(process.env.RATE_LIMIT_WINDOW_SEC, 60),
    max: int(process.env.RATE_LIMIT_MAX, 120),
  },

  dbPath: process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'keiro.db'),
};

module.exports = config;
