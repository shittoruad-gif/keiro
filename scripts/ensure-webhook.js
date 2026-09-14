'use strict';

// UnivaPayの「通知の送り先（Webhook）」に、このKeiroを登録する。何度実行してもよい（冪等）。
//
//   node scripts/ensure-webhook.js            … いまの登録状況を見るだけ（変更しない）
//   node scripts/ensure-webhook.js --apply    … 未登録なら登録する
//
// なぜ要るか:
//   2026-07に決済リンク・鍵の設定までは済んでいたが、通知の送り先の登録だけが抜けていた。
//   そのためKeiroは一度も決済通知を受け取れておらず（payments 0件）、初の外部有料契約
//   （モンテローザ様・月9,800円・初回課金2026-10-13）がDBに存在しない状態になっていた。
//
// ⚠️ UnivaPayのストアは全事業で共用（Threads Studio・交通事故・Instagram広告・Keiro）。
//    通知の送り先はストア単位でしか設定できないため、登録すると**他事業の決済通知もここへ届く**。
//    受け側（src/app.js の /webhook/univapay）は、テナントのメールに一致しないものを
//    黙って200で受け流すように直してある。この対応が入ったものを本番へ反映してから登録すること。
//
// 認証情報は運営画面で保存された app_settings（暗号化）から読む。値は一切表示しない。

const config = require('../src/config');
const { openDb } = require('../src/db');
const appsettings = require('../src/appsettings');
const univapay = require('../src/univapay');

const APPLY = process.argv.includes('--apply');

function webhookUrl() {
  return `${String(config.baseUrl || '').replace(/\/$/, '')}/webhook/univapay`;
}

async function main() {
  const db = openDb(config.dbPath);
  appsettings.init(db); // app_settings を復号して config へ反映

  if (!univapay.enabled()) {
    console.error('中止: UnivaPayの認証情報が未設定です（運営画面で保存してください）');
    process.exit(1);
  }
  if (!config.univapay.webhookSecret) {
    console.error('中止: 通知の合言葉（webhook secret）が未設定です（運営画面で保存してください）');
    process.exit(1);
  }
  const url = webhookUrl();
  if (!/^https:\/\//.test(url)) {
    console.error(`中止: 通知の送り先がhttpsではありません: ${url}`);
    process.exit(1);
  }

  const listed = await univapay.listWebhooks();
  if (!listed.ok) {
    console.error(`中止: 通知の送り先の一覧を取得できません（HTTP ${listed.status}）`);
    process.exit(1);
  }
  const items = (listed.json && listed.json.items) || [];
  console.log(`いま登録されている通知の送り先: ${items.length}件`);
  for (const w of items) console.log(`  - ${w.url}`);

  const mine = items.find((w) => String(w.url || '').replace(/\/$/, '') === url);
  if (mine) {
    console.log(`\n登録済みです: ${url}`);
    console.log('（合言葉が合っているかは、実際の通知を受けるまで分かりません。'
      + 'ログに "univapay webhook received" が出るかで確認してください）');
    db.close();
    return;
  }

  console.log(`\n未登録です: ${url}`);
  if (!APPLY) {
    console.log('登録するには --apply を付けて実行してください。');
    db.close();
    return;
  }

  const res = await univapay.createWebhook({
    url,
    authToken: config.univapay.webhookSecret,
    triggers: univapay.DEFAULT_WEBHOOK_TRIGGERS,
  });
  if (!res.ok) {
    console.error(`登録に失敗しました（HTTP ${res.status}）: ${String(res.text || '').slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`登録しました。id=${res.json && res.json.id}`);

  const after = await univapay.listWebhooks();
  const nowItems = (after.json && after.json.items) || [];
  console.log(`確認: 通知の送り先は ${nowItems.length}件になりました`);
  for (const w of nowItems) console.log(`  - ${w.url}`);
  db.close();
}

main().catch((e) => {
  console.error('失敗:', String((e && e.message) || e));
  process.exit(1);
});
