'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
-- テナント（院オーナー）と運営(operator)を同じテーブルで管理
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,             -- マルチ店舗のため非ユニーク（同一オーナーが店舗ごとにアカウントを持てる）
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

-- 友だち管理（CRM）。line_user_id 単位で1件。
CREATE TABLE IF NOT EXISTS friends (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  line_user_id   TEXT NOT NULL,
  display_name   TEXT,
  source_media   TEXT,                 -- 流入経路（媒体）。claim一致で設定
  source_link_id TEXT,
  tags           TEXT,                 -- カンマ区切りタグ
  status         TEXT NOT NULL DEFAULT 'active', -- active / blocked
  created_at     INTEGER NOT NULL,
  last_event_at  INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  name          TEXT,
  text          TEXT NOT NULL,
  audience_type TEXT NOT NULL DEFAULT 'all', -- all / media / matched / tag
  audience_value TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft / scheduled / sending / sent / failed
  scheduled_at  INTEGER,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS autoreplies (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  keyword    TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains', -- contains / exact
  reply_text TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- リッチメニュー（LINEチャット下部のメニュー）
CREATE TABLE IF NOT EXISTS rich_menus (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  name              TEXT,
  template          TEXT,                 -- テンプレキー
  chat_bar_text     TEXT,
  line_rich_menu_id TEXT,                 -- LINE側のID
  config_json       TEXT,                 -- 再編集用（セル/アクション）
  status            TEXT NOT NULL DEFAULT 'inactive', -- active / inactive
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- クーポン
CREATE TABLE IF NOT EXISTS coupons (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  title          TEXT NOT NULL,           -- クーポン名
  description    TEXT,                    -- 詳細説明
  discount_text  TEXT,                    -- 割引内容の文言（例: 初回20%OFF）
  expires_at     INTEGER,                 -- 有効期限（NULL=無期限）
  audience_type  TEXT NOT NULL DEFAULT 'all', -- all / media / tag
  audience_value TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- クーポン送信履歴
CREATE TABLE IF NOT EXISTS coupon_uses (
  id          TEXT PRIMARY KEY,
  coupon_id   TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  friend_id   TEXT,                       -- friendsテーブルのID
  line_user_id TEXT,
  sent_at     INTEGER,                    -- 送信日時
  used_at     INTEGER,                    -- 使用済み報告日時（スタッフが手動マーク）
  FOREIGN KEY (coupon_id) REFERENCES coupons(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 誕生日配信キャンペーン
CREATE TABLE IF NOT EXISTS birthday_campaigns (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  text       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- スタンプカード
CREATE TABLE IF NOT EXISTS stamp_cards (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  required_stamps INTEGER NOT NULL DEFAULT 10,
  reward_text     TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- スタンプ記録（カード×友だちごと）
CREATE TABLE IF NOT EXISTS stamp_records (
  id            TEXT PRIMARY KEY,
  card_id       TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  friend_id     TEXT NOT NULL,
  stamps        INTEGER NOT NULL DEFAULT 0,
  completed     INTEGER NOT NULL DEFAULT 0,
  last_stamp_at INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE(card_id, friend_id),
  FOREIGN KEY (card_id) REFERENCES stamp_cards(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);

-- 会話ボット（自己申告→タグ→分岐）。Phase1は「1問＋選択肢」の自己申告フロー。
CREATE TABLE IF NOT EXISTS bot_flows (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  name            TEXT,
  trigger_type    TEXT NOT NULL DEFAULT 'follow', -- follow / keyword
  trigger_keyword TEXT,
  question_text   TEXT NOT NULL,                   -- 例: あてはまる方を選んでください
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS bot_choices (
  id          TEXT PRIMARY KEY,
  flow_id     TEXT NOT NULL,
  label       TEXT NOT NULL,        -- ボタン表示（例: 🔰初めて）
  tag         TEXT,                 -- 付与タグ（例: 新規）
  campaign_id TEXT,                 -- 登録先ステップ配信（任意。無ければtagのaudience_tagで解決）
  reply_text  TEXT,                 -- タップ後の返信（任意）
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (flow_id) REFERENCES bot_flows(id)
);
`;

// インデックスはマイグレーション(tenant_id追加)後に作成する。
// 既存の旧スキーマDBでは tenant_id 列が後付けのため、CREATE TABLE 内に置くと失敗する。
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email);
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_unique ON friends(tenant_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_friends_seg ON friends(tenant_id, status, source_media);
CREATE INDEX IF NOT EXISTS idx_broadcasts_tenant ON broadcasts(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_broadcasts_sched ON broadcasts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_autoreplies_tenant ON autoreplies(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_richmenus_tenant ON rich_menus(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_coupons_tenant ON coupons(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_coupon_uses_coupon ON coupon_uses(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_uses_tenant ON coupon_uses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_birthday_campaigns_tenant ON birthday_campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stamp_cards_tenant ON stamp_cards(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stamp_records_card ON stamp_records(card_id);
CREATE INDEX IF NOT EXISTS idx_stamp_records_friend ON stamp_records(friend_id);
CREATE INDEX IF NOT EXISTS idx_friends_birthday ON friends(tenant_id, birthday);
CREATE INDEX IF NOT EXISTS idx_bot_flows_tenant ON bot_flows(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_bot_choices_flow ON bot_choices(flow_id, sort);
CREATE INDEX IF NOT EXISTS idx_step_campaigns_tag ON step_campaigns(tenant_id, audience_tag);
`;

// 既存DBへの後方互換マイグレーション（カラム追加）。
function migrate(db) {
  // マルチ店舗対応: tenants.email の UNIQUE 制約を撤廃（既存DBはテーブル再構築で移行）。
  // sqlite_master の CREATE 文に "email TEXT UNIQUE" が残っている場合のみ1回実行される。
  const tdef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tenants'").get();
  if (tdef && /email\s+TEXT\s+UNIQUE/i.test(tdef.sql)) {
    const newSql = tdef.sql.replace(/email(\s+)TEXT\s+UNIQUE\s+NOT\s+NULL/i, 'email$1TEXT NOT NULL');
    if (newSql !== tdef.sql) {
      db.pragma('foreign_keys = OFF');
      const tx = db.transaction(() => {
        db.exec('ALTER TABLE tenants RENAME TO tenants_migrating_old');
        db.exec(newSql); // 追加済みカラムも sqlite_master の sql に反映されているのでそのまま使える
        db.exec('INSERT INTO tenants SELECT * FROM tenants_migrating_old');
        db.exec('DROP TABLE tenants_migrating_old');
      });
      tx();
      db.pragma('foreign_keys = ON');
    }
  }

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
  // KPI目標値（テナント設定）
  addCol('tenants', 'kpi_targets', 'kpi_targets TEXT');
  // 誕生日（MM-DD形式）
  addCol('friends', 'birthday', 'birthday TEXT');
  // 会話ボット統合: ステップ配信をタグでも対象化（新規/既存の分岐用）
  addCol('step_campaigns', 'audience_tag', 'audience_tag TEXT');
  // LINE連携ウィザード: Webhook最終受信時刻（接続確認用）
  addCol('tenants', 'webhook_last_at', 'webhook_last_at INTEGER');
  // 無料期間満了の事前通知メール送信済み時刻（重複送信防止）
  addCol('tenants', 'trial_notice_at', 'trial_notice_at INTEGER');
  // 利用プラン（'pro' / 'light'。未設定は 'pro' 相当として扱う）
  addCol('tenants', 'plan', 'plan TEXT');
  // 無料期間の明示的な終了時刻（パスコード適用時に設定。NULLなら created_at + TRIAL_DAYS）
  addCol('tenants', 'trial_ends_at', 'trial_ends_at INTEGER');
  // 適用済みアクセスコード（パスコード）とその適用時刻
  addCol('tenants', 'code_redeemed', 'code_redeemed TEXT');
  addCol('tenants', 'code_redeemed_at', 'code_redeemed_at INTEGER');
  // アクセスコード（パスコード）: 入力で無料期間＋プランを付与
  db.exec(`CREATE TABLE IF NOT EXISTS access_codes (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    trial_days  INTEGER NOT NULL DEFAULT 30,
    plan        TEXT NOT NULL DEFAULT 'pro',
    max_uses    INTEGER NOT NULL DEFAULT 1,
    used_count  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER
  );`);

  // 会話ボット拡張（Lステップ相当）: ボタンテンプレ/カルーセル/リンクボタン/多段分岐
  addCol('bot_flows', 'message_type', "message_type TEXT NOT NULL DEFAULT 'quick'"); // quick | buttons | carousel
  addCol('bot_flows', 'alt_text', 'alt_text TEXT');       // 通知・非対応端末用の代替テキスト
  addCol('bot_flows', 'image_url', 'image_url TEXT');     // buttons型のヘッダー画像
  addCol('bot_choices', 'action_type', "action_type TEXT NOT NULL DEFAULT 'postback'"); // postback | uri
  addCol('bot_choices', 'uri', 'uri TEXT');               // action_type=uri のリンク先
  addCol('bot_choices', 'next_flow_id', 'next_flow_id TEXT'); // タップで次のフローへ（多段分岐）
  addCol('bot_choices', 'column_id', 'column_id TEXT');   // carousel: 所属カラム（quick/buttonsはNULL）
  // カルーセルのカラム（1フローに複数カード）
  db.exec(`CREATE TABLE IF NOT EXISTS bot_columns (
    id         TEXT PRIMARY KEY,
    flow_id    TEXT NOT NULL,
    title      TEXT,
    text       TEXT,
    image_url  TEXT,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );`);

  // ================= Lステップ相当機能（プロプラン） =================

  // 友だち: メモ・カスタム項目(JSON)・スコア（行動量の目安）
  addCol('friends', 'memo', 'memo TEXT');
  addCol('friends', 'fields_json', 'fields_json TEXT');
  addCol('friends', 'score', 'score INTEGER NOT NULL DEFAULT 0');
  // 自動応答のタグ別出し分け（例: クーポン→新規は初回特典/既存は会員特典）
  addCol('autoreplies', 'audience_tag', 'audience_tag TEXT');
  // 会話ボット 自己申告の見逃し救済（再質問の管理）
  addCol('friends', 'identified_at', 'identified_at INTEGER');            // 回答済み時刻
  addCol('friends', 'identify_asked_at', 'identify_asked_at INTEGER');    // 最終質問時刻
  addCol('friends', 'identify_ask_count', 'identify_ask_count INTEGER NOT NULL DEFAULT 0'); // 質問回数

  // 1:1チャット受信箱（受信・送信の会話ログ）
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_messages (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    direction    TEXT NOT NULL,            -- in / out
    text         TEXT NOT NULL,
    read         INTEGER NOT NULL DEFAULT 0, -- in のみ使用（未読管理）
    created_at   INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_tenant_user ON inbox_messages (tenant_id, line_user_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_inbox_unread ON inbox_messages (tenant_id, read, created_at)');

  // リマインダ配信（基準日からの逆算/経過で自動配信。例: 予約日の7日前・前日・当日朝）
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_campaigns (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_steps (
    id          TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    offset_days INTEGER NOT NULL DEFAULT 0, -- 負=基準日の前 / 0=当日 / 正=後
    send_hour   INTEGER NOT NULL DEFAULT 9, -- 送信時刻（0-23時台）
    text        TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_enrollments (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    campaign_id  TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    base_date    TEXT NOT NULL,             -- YYYY-MM-DD（予約日等の基準日）
    status       TEXT NOT NULL DEFAULT 'active', -- active / done / stopped
    created_at   INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS reminder_sends (
    id            TEXT PRIMARY KEY,
    enrollment_id TEXT NOT NULL,
    step_id       TEXT NOT NULL,
    ok            INTEGER NOT NULL DEFAULT 0,
    sent_at       INTEGER NOT NULL,
    UNIQUE(enrollment_id, step_id)
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_rem_enroll ON reminder_enrollments (tenant_id, status)');

  // 回答フォーム（アンケート/事前問診等。公開ページ /f/:id で回答→タグ付与）
  db.exec(`CREATE TABLE IF NOT EXISTS forms (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    title       TEXT,
    description TEXT,
    fields_json TEXT NOT NULL,              -- [{label, type(text|textarea|select|radio), options[], required}]
    tag         TEXT,                        -- 回答時に友だちへ付与するタグ
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS form_answers (
    id           TEXT PRIMARY KEY,
    form_id      TEXT NOT NULL,
    tenant_id    TEXT NOT NULL,
    line_user_id TEXT,                       -- 署名付きURL経由なら友だち特定済み
    answers_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_form_answers ON form_answers (tenant_id, form_id, created_at)');

  // 配信内リンクのタップ計測（短縮URL /r/:id。友だち別クリックも記録）
  db.exec(`CREATE TABLE IF NOT EXISTS tracked_urls (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    dest_url   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS url_clicks (
    id           TEXT PRIMARY KEY,
    url_id       TEXT NOT NULL,
    tenant_id    TEXT NOT NULL,
    line_user_id TEXT,                       -- 署名付きURL経由なら友だち特定済み
    created_at   INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_url_clicks ON url_clicks (tenant_id, url_id, created_at)');

  // メッセージテンプレート（定型文）
  db.exec(`CREATE TABLE IF NOT EXISTS message_templates (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);

  // 画像ホスティング（配信・カルーセル用。LINEはhttpsの画像URL必須のため自前配信）
  db.exec(`CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );`);

  // 広告費の手入力（ROIダッシュボード: CPA算出用。媒体×月）
  db.exec(`CREATE TABLE IF NOT EXISTS ad_costs (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    media      TEXT NOT NULL,               -- meta / tiktok / google / other（linksのmediaと対応）
    month      TEXT NOT NULL,               -- YYYY-MM
    amount     INTEGER NOT NULL,            -- 円
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    UNIQUE(tenant_id, media, month)
  );`);

  // 配信の画像添付（テキスト+画像1枚）
  addCol('broadcasts', 'image_url', 'image_url TEXT');
  addCol('step_messages', 'image_url', 'image_url TEXT');

  // リッチメニューのタグ別出し分け（audience_tag=NULLなら全員デフォルト）
  addCol('rich_menus', 'audience_tag', 'audience_tag TEXT');

  // リマインダ: 基準日の時刻（HH:MM）。予約の「◯時から」を本文に差し込むために保持
  addCol('reminder_enrollments', 'base_time', 'base_time TEXT');

  // 誕生日配信の二重送信防止（プロセス再起動・複数回起動でも年1回だけ送る）
  db.exec(`CREATE TABLE IF NOT EXISTS birthday_sends (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    campaign_id  TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    year         INTEGER NOT NULL,
    sent_at      INTEGER NOT NULL,
    UNIQUE(campaign_id, line_user_id, year)
  );`);
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
