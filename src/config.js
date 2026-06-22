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
