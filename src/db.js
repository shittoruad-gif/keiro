'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
-- テナント（院オーナー）と運営(operator)を同じテーブルで管理
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,                          -- 院名/表示名
  role          TEXT NOT NULL DEFAULT 'tenant', -- tenant / operator
  status        TEXT NOT NULL DEFAULT 'active', -- active / suspended
  webhook_token TEXT UNIQUE,                    -- /webhook/<token> 用の非推測トークン

  -- 院ごとの連携設定（機微情報は暗号化して保存）
  line_channel_secret       TEXT,
  line_channel_access_token TEXT,
  line_oa_add_url           TEXT,
  line_destination          TEXT,               -- LINE bot userId（任意, 突合補助）
  meta_pixel_id             TEXT,
  meta_capi_token           TEXT,
  meta_test_event_code      TEXT,
  tiktok_pixel_id           TEXT,
  tiktok_access_token       TEXT,
  google_enabled            INTEGER NOT NULL DEFAULT 0,
  match_window_sec          INTEGER,            -- 院別の上書き（NULLならグローバル既定）

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  amount     INTEGER NOT NULL,        -- 月額(円)
  interval   TEXT NOT NULL DEFAULT 'month',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  plan_id                  TEXT,
  univapay_subscription_id TEXT,
  status                   TEXT NOT NULL,  -- trialing/active/past_due/canceled/unpaid
  current_period_end       INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  subscription_id   TEXT,
  univapay_charge_id TEXT,
  amount            INTEGER,
  status            TEXT,
  raw               TEXT,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS links (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  name        TEXT NOT NULL,
  oa_add_url  TEXT NOT NULL,
  media       TEXT,
  campaign    TEXT,
  creative    TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS clicks (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  link_id      TEXT NOT NULL,
  fp           TEXT,
  ip           TEXT,
  ua           TEXT,
  fbclid       TEXT,
  gclid        TEXT,
  ttclid       TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  params_json  TEXT,
  matched      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (link_id) REFERENCES links(id)
);

CREATE TABLE IF NOT EXISTS follows (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  line_user_id TEXT NOT NULL,
  fp           TEXT,
  click_id     TEXT,
  match_method TEXT,
  status       TEXT NOT NULL,   -- pending / matched / unmatched
  created_at   INTEGER NOT NULL,
  matched_at   INTEGER,
  FOREIGN KEY (click_id) REFERENCES clicks(id)
);

CREATE TABLE IF NOT EXISTS postbacks (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  follow_id     TEXT NOT NULL,
  platform      TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  http_status   INTEGER,
  response      TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  done          INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  ctx_json      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  FOREIGN KEY (follow_id) REFERENCES follows(id)
);

-- ステップ配信（LINE友だち追加後の自動シナリオ配信）
CREATE TABLE IF NOT EXISTS step_campaigns (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  media      TEXT,                          -- 空=全友だち、値あり=その流入経路(媒体)の友だちのみ
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS step_messages (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL,
  position      INTEGER NOT NULL,           -- 1,2,3…
  delay_minutes INTEGER NOT NULL DEFAULT 0, -- 直前ステップ（pos1は登録時点）からの待ち時間(分)
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES step_campaigns(id)
);

CREATE TABLE IF NOT EXISTS step_enrollments (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  line_user_id  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active', -- active / done / stopped
  next_position INTEGER NOT NULL DEFAULT 1,
  next_send_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  FOREIGN KEY (campaign_id) REFERENCES step_campaigns(id)
);

CREATE TABLE IF NOT EXISTS step_sends (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  position      INTEGER,
  ok            INTEGER NOT NULL,
  http_status   INTEGER,
  response      TEXT,
  created_at    INTEGER NOT NULL
);
`;

// インデックスはマイグレーション(tenant_id追加)後に作成する。
// 既存の旧スキーマDBでは tenant_id 列が後付けのため、CREATE TABLE 内に置くと失敗する。
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_links_tenant ON links(tenant_id);
CREATE INDEX IF NOT EXISTS idx_clicks_match ON clicks(tenant_id, ip, matched, created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_time ON clicks(tenant_id, matched, created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id);
CREATE INDEX IF NOT EXISTS idx_follows_tenant ON follows(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_postbacks_follow ON postbacks(follow_id);
CREATE INDEX IF NOT EXISTS idx_postbacks_retry ON postbacks(done, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_step_campaigns_tenant ON step_campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_step_messages_campaign ON step_messages(campaign_id, position);
CREATE INDEX IF NOT EXISTS idx_step_enr_due ON step_enrollments(status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_step_enr_tenant ON step_enrollments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_step_enr_dedup ON step_enrollments(campaign_id, line_user_id, status);
CREATE INDEX IF NOT EXISTS idx_step_sends_enr ON step_sends(enrollment_id);
`;

// 既存DBへの後方互換マイグレーション（カラム追加）。
function migrate(db) {
  const hasCol = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const addCol = (table, col, ddl) => {
    if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };

  // 旧シングルテナント版からの移行（tenant_id 追加）
  for (const t of ['links', 'clicks', 'follows', 'postbacks']) {
    addCol(t, 'tenant_id', 'tenant_id TEXT');
  }
  // postbacks のリトライ系（v1→v2移行ぶんも担保）
  addCol('postbacks', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 1');
  addCol('postbacks', 'done', 'done INTEGER NOT NULL DEFAULT 1');
  addCol('postbacks', 'next_retry_at', 'next_retry_at INTEGER');
  addCol('postbacks', 'ctx_json', 'ctx_json TEXT');
  addCol('postbacks', 'updated_at', 'updated_at INTEGER');
}

/**
 * DBを開いてスキーマ適用＋マイグレーション。
 * @param {string} dbPath  ':memory:' または ファイルパス
 */
function openDb(dbPath) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);     // 既存テーブルへ tenant_id 等を追加
  db.exec(INDEXES); // 列が揃ってからインデックス作成
  return db;
}

module.exports = { openDb, SCHEMA };
