'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS links (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  oa_add_url  TEXT NOT NULL,
  media       TEXT,            -- カンマ区切りの送信先媒体 (meta,tiktok,google)。空なら有効な全媒体
  campaign    TEXT,
  creative    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  id           TEXT PRIMARY KEY,
  link_id      TEXT NOT NULL,
  fp           TEXT,           -- 簡易フィンガープリント（参考値。紐づけ判定には使わない）
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
CREATE INDEX IF NOT EXISTS idx_clicks_ip_match ON clicks(ip, matched, created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_match_time ON clicks(matched, created_at);
CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id);

CREATE TABLE IF NOT EXISTS follows (
  id           TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  fp           TEXT,
  click_id     TEXT,
  match_method TEXT,            -- claim / ip / time
  status       TEXT NOT NULL,   -- pending / matched / unmatched
  created_at   INTEGER NOT NULL,
  matched_at   INTEGER,
  FOREIGN KEY (click_id) REFERENCES clicks(id)
);
CREATE INDEX IF NOT EXISTS idx_follows_status ON follows(status, created_at);

CREATE TABLE IF NOT EXISTS postbacks (
  id            TEXT PRIMARY KEY,
  follow_id     TEXT NOT NULL,
  platform      TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  http_status   INTEGER,
  response      TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  done          INTEGER NOT NULL DEFAULT 1,   -- 1=完了(成功/スキップ/上限到達), 0=リトライ待ち
  next_retry_at INTEGER,                       -- done=0 のとき次回リトライ予定(ms)
  ctx_json      TEXT,                          -- リトライ用の送信コンテキスト
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  FOREIGN KEY (follow_id) REFERENCES follows(id)
);
CREATE INDEX IF NOT EXISTS idx_postbacks_follow ON postbacks(follow_id);
CREATE INDEX IF NOT EXISTS idx_postbacks_retry ON postbacks(done, next_retry_at);
`;

// 既存DBに対する後方互換マイグレーション（カラム追加）。
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(postbacks)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE postbacks ADD COLUMN ${ddl}`);
  };
  add('attempts', 'attempts INTEGER NOT NULL DEFAULT 1');
  add('done', 'done INTEGER NOT NULL DEFAULT 1');
  add('next_retry_at', 'next_retry_at INTEGER');
  add('ctx_json', 'ctx_json TEXT');
  add('updated_at', 'updated_at INTEGER');
}

/**
 * DBを開いてスキーマを適用する。
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
  migrate(db);
  return db;
}

module.exports = { openDb, SCHEMA };
