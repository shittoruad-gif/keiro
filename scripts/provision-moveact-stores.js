'use strict';
/**
 * Moveact 玉島店 / 金光店 を Keiro の「計測専用モード」テナントとして用意する。
 *
 * 背景（2026-09-03）:
 *   両店の公式LINEのWebhookは Moveactの予約システム（Supabase line-webhook）を
 *   向いており、そこでトーク内予約・グループ通知が動いている。LINEは1チャネルに
 *   Webhookを1つしか登録できないため、Keiroへ向け替えることはできない。
 *   そこで予約システム側から Keiro へイベントを転送する構成にした。
 *   Keiro 側は silent_mode=1（あいさつ・自動応答を一切送らない）で受ける。
 *
 * このスクリプトがすること（何度実行しても同じ結果になる）:
 *   1. テナント2件を作成（無ければ）。silent_mode=1・永年無料のプロ相当。
 *   2. 計測リンクを店舗ごとに3本（Threads自動投稿 / Meta広告 / チラシ）作成。
 *   3. Webhook URL と 友だち追加URL を表示する。
 *
 * このスクリプトが**やらないこと**:
 *   - LINEのChannel Secret / Access Token の登録。
 *     鍵の入力はオーナー（三上さん）が管理画面から行う。
 *   - ログインパスワードの設定。ログイン不能な値を入れてあるので、
 *     初回は「パスワードを忘れた場合」から本人が設定する。
 *
 * 使い方（本番コンテナ内）:
 *   docker exec <keiroコンテナ> node /app/scripts/provision-moveact-stores.js
 */
const crypto = require('crypto');
const { openDb } = require('../src/db');
const config = require('../src/config');
const { createTenant, updateTenantSettings } = require('../src/tenant');

const STORES = [
  {
    key: 'tamashima',
    name: 'Moveact 玉島店',
    email: 'shittoru.ad+moveact-tamashima@gmail.com',
    // 「マシンピラティスMoveact 玉島店」@877ivqpn の友だち追加URL。
    // 2026-09-03に LINE Official Account Manager から取得し、
    // https://line.me/R/ti/p/@877ivqpn へ転送されることを確認済み。
    oaAddUrl: 'https://lin.ee/PQ00Fls',
    links: [
      { id: 'lnk_ma_tama_threads', name: 'Threads_玉島_自動投稿', media: 'threads', campaign: '玉島Threads' },
      { id: 'lnk_ma_tama_meta', name: 'Meta広告_玉島', media: 'meta', campaign: '玉島Meta' },
      { id: 'lnk_ma_tama_flyer', name: 'チラシ・店頭QR_玉島', media: 'flyer', campaign: null },
    ],
  },
  {
    key: 'konko',
    name: 'Moveact 金光店',
    email: 'shittoru.ad+moveact-konko@gmail.com',
    // 「整体・美容鍼・ピラティス　Moveact」@jwc6488r の友だち追加URL。
    // 2026-09-03に LINE Official Account Manager から取得し、
    // https://line.me/R/ti/p/@jwc6488r へ転送されることを確認済み。
    oaAddUrl: 'https://lin.ee/wdLalgM',
    links: [
      { id: 'lnk_ma_konko_threads', name: 'Threads_金光_自動投稿', media: 'threads', campaign: '金光Threads' },
      { id: 'lnk_ma_konko_meta', name: 'Meta広告_金光', media: 'meta', campaign: '金光Meta' },
      { id: 'lnk_ma_konko_flyer', name: 'チラシ・店頭QR_金光', media: 'flyer', campaign: null },
    ],
  },
];

/** 友だち追加URLが未確定の店舗の仮値。オーナーが管理画面で本物に差し替える */
const PLACEHOLDER_OA_URL = 'https://line.me/R/ti/p/';

function main() {
  const db = openDb(config.dbPath);
  const now = Date.now();
  const out = [];

  for (const st of STORES) {
    let tenant = db.prepare('SELECT * FROM tenants WHERE email = ?').get(st.email);
    if (!tenant) {
      // ログインには使えないランダム値。オーナーが「パスワードを忘れた場合」から設定する
      tenant = createTenant(db, {
        email: st.email,
        password: crypto.randomBytes(24).toString('hex'),
        name: st.name,
      });
      console.log(`作成: ${st.name}`);
    } else {
      console.log(`既存: ${st.name}（作り直さない）`);
    }

    // 計測専用モード＋計測を止めないためのプラン設定。
    // 友だち追加URLが分かっている店舗はここで入れる（未確定なら触らない）。
    updateTenantSettings(db, tenant.id, Object.assign(
      { silent_mode: 1 },
      st.oaAddUrl ? { line_oa_add_url: st.oaAddUrl } : {},
    ));
    db.prepare("UPDATE tenants SET plan='pro', trial_ends_at=?, updated_at=? WHERE id=?")
      .run(now + 100 * 365 * 24 * 3600 * 1000, now, tenant.id);

    for (const l of st.links) {
      const exists = db.prepare('SELECT 1 FROM links WHERE id = ?').get(l.id);
      if (exists) continue;
      db.prepare(
        `INSERT INTO links (id, tenant_id, name, oa_add_url, media, campaign, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(l.id, tenant.id, l.name, st.oaAddUrl || PLACEHOLDER_OA_URL, l.media, l.campaign, now);
      console.log(`  計測リンク作成: ${l.name}`);
    }

    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id);
    out.push({
      店舗: st.name,
      テナントID: t.id,
      ログインID: t.email,
      'Webhook URL（予約システムの転送先に設定）': `${config.baseUrl}/webhook/${t.webhook_token}`,
      計測リンク: st.links.map((l) => `${l.name}: ${config.baseUrl}/c/${l.id}`),
      友だち追加URL: t.line_oa_add_url || '（未設定）',
      Secret登録済み: !!t.line_channel_secret,
      計測専用モード: !!t.silent_mode,
    });
  }

  console.log('\n===== 設定内容 =====');
  console.log(JSON.stringify(out, null, 2));
  console.log(`
残りの作業（オーナー）:
  1. ${config.baseUrl}/login で「パスワードを忘れた場合」から各店のパスワードを設定
  2. 連携設定に LINE Channel Secret を貼る（玉島=@877ivqpn / 金光=@jwc6488r）
     ※ Access Token は入れないこと（入れるとKeiroが返信してしまう）
  3. 友だち追加URLは両店とも設定済み
     （玉島 @877ivqpn = https://lin.ee/PQ00Fls / 金光 @jwc6488r = https://lin.ee/wdLalgM）
`);
}

main();
