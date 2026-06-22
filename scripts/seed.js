'use strict';

// デモデータを投入する（マルチテナント版）。
//   node scripts/seed.js
// 運営アカウント(OPERATOR_*)とデモ院1件＋計測データを作る。

const config = require('../src/config');
const { openDb } = require('../src/db');
const { newId } = require('../src/sign');
const { createTenant, updateTenantSettings } = require('../src/tenant');
const billing = require('../src/billing');

const db = openDb(config.dbPath);
billing.ensureDefaultPlan(db);

const now = Date.now();
const minutes = (m) => now - m * 60 * 1000;

// 運営アカウント
if (config.operator.email && config.operator.password && !db.prepare('SELECT 1 FROM tenants WHERE email=?').get(config.operator.email)) {
  createTenant(db, { email: config.operator.email, password: config.operator.password, name: '運営', role: 'operator' });
  console.log('運営アカウント作成:', config.operator.email);
}

// デモ院
let tenant = db.prepare("SELECT * FROM tenants WHERE email='demo@keiro.example'").get();
if (!tenant) {
  tenant = createTenant(db, { email: 'demo@keiro.example', password: 'demopass1234', name: 'デモ整体院' });
  updateTenantSettings(db, tenant.id, { line_oa_add_url: 'https://lin.ee/demoLINEoa', meta_pixel_id: '0000000000' });
  console.log('デモ院作成: demo@keiro.example / demopass1234');
}
const TID = tenant.id;

function addLink({ name, media, campaign }) {
  const id = newId('lnk');
  db.prepare(`INSERT INTO links (id, tenant_id, name, oa_add_url, media, campaign, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, TID, name, 'https://lin.ee/demoLINEoa', media || null, campaign || null, minutes(60));
  return id;
}
function addClick(linkId, { ip, fbclid, ttclid, at }) {
  const id = newId('clk');
  db.prepare(`INSERT INTO clicks (id, tenant_id, link_id, ip, ua, fbclid, ttclid, utm_source, params_json, matched, created_at)
              VALUES (?, ?, ?, ?, 'demo-UA', ?, ?, 'meta', ?, 0, ?)`)
    .run(id, TID, linkId, ip || null, fbclid || null, ttclid || null, JSON.stringify({ fbclid, ttclid }), at || now);
  return id;
}
function addFollow({ clickId, method, status, at }) {
  const id = newId('flw');
  db.prepare(`INSERT INTO follows (id, tenant_id, line_user_id, click_id, match_method, status, created_at, matched_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, TID, 'U' + newId().slice(0, 24), clickId || null, method || null, status, at || now, status === 'matched' ? at || now : null);
  if (clickId) db.prepare('UPDATE clicks SET matched=1 WHERE id=?').run(clickId);
  return id;
}

const metaLink = addLink({ name: '6月Meta_動画A', media: 'meta', campaign: 'summer' });
const ttLink = addLink({ name: '6月TikTok_UGC', media: 'tiktok', campaign: 'summer' });
addLink({ name: '汎用_全媒体', media: '', campaign: 'always' });

for (let i = 0; i < 5; i++) {
  const c = addClick(metaLink, { ip: '203.0.113.' + (10 + i), fbclid: 'fbcl_' + i, at: minutes(40 - i) });
  if (i < 3) addFollow({ clickId: c, method: i === 0 ? 'claim' : 'ip', status: 'matched', at: minutes(38 - i) });
}
for (let i = 0; i < 3; i++) {
  const c = addClick(ttLink, { ip: '198.51.100.' + (20 + i), ttclid: 'ttcl_' + i, at: minutes(30 - i) });
  if (i === 0) addFollow({ clickId: c, method: 'ip', status: 'matched', at: minutes(28) });
}
addFollow({ status: 'pending', at: minutes(5) });
addFollow({ status: 'unmatched', at: minutes(50) });

for (const f of db.prepare("SELECT id FROM follows WHERE tenant_id=? AND status='matched'").all(TID)) {
  db.prepare(`INSERT INTO postbacks (id, tenant_id, follow_id, platform, ok, http_status, response, created_at)
              VALUES (?, ?, ?, 'meta', 1, 200, '{"events_received":1}', ?)`).run(newId('pb'), TID, f.id, now);
}

console.log('完了:', {
  tenants: db.prepare('SELECT COUNT(*) n FROM tenants').get().n,
  links: db.prepare('SELECT COUNT(*) n FROM links').get().n,
  clicks: db.prepare('SELECT COUNT(*) n FROM clicks').get().n,
  follows: db.prepare('SELECT COUNT(*) n FROM follows').get().n,
});
console.log('ログイン:', `${config.baseUrl}/login`, '（デモ院 demo@keiro.example / demopass1234）');
db.close();
