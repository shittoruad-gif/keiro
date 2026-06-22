'use strict';

// デモデータを投入する。実機なしで管理画面の見え方を確認する用途。
//   node scripts/seed.js

const config = require('../src/config');
const { openDb } = require('../src/db');
const { newId } = require('../src/sign');

const db = openDb(config.dbPath);

const now = Date.now();
const minutes = (m) => now - m * 60 * 1000;

function addLink({ name, media, campaign, creative }) {
  const id = newId('lnk');
  db.prepare(
    `INSERT INTO links (id, name, oa_add_url, media, campaign, creative, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, 'https://lin.ee/demoLINEoa', media || null, campaign || null, creative || null, minutes(60));
  return id;
}

function addClick(linkId, { ip, ua, fbclid, ttclid, gclid, at }) {
  const id = newId('clk');
  db.prepare(
    `INSERT INTO clicks (id, link_id, fp, ip, ua, fbclid, gclid, ttclid,
       utm_source, utm_medium, utm_campaign, utm_content, params_json, matched, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, linkId, ip || null, ua || null, fbclid || null, gclid || null, ttclid || null,
    'meta', 'cpc', 'demo', 'a', JSON.stringify({ fbclid, ttclid, gclid }), at || now);
  return id;
}

function addFollow({ clickId, method, status, at }) {
  const id = newId('flw');
  db.prepare(
    `INSERT INTO follows (id, line_user_id, fp, click_id, match_method, status, created_at, matched_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
  ).run(id, 'U' + newId().slice(0, 24), clickId || null, method || null, status,
    at || now, status === 'matched' ? at || now : null);
  if (clickId) db.prepare('UPDATE clicks SET matched = 1 WHERE id = ?').run(clickId);
  return id;
}

console.log('デモデータを投入します…');

const metaLink = addLink({ name: '6月Meta_動画A', media: 'meta', campaign: 'summer', creative: 'video_a' });
const ttLink = addLink({ name: '6月TikTok_UGC', media: 'tiktok', campaign: 'summer', creative: 'ugc_1' });
const allLink = addLink({ name: '汎用_全媒体', media: '', campaign: 'always', creative: 'banner' });

// Metaリンク: 5クリック、3紐づけ
for (let i = 0; i < 5; i++) {
  const c = addClick(metaLink, { ip: '203.0.113.' + (10 + i), fbclid: 'fbcl_' + i, at: minutes(40 - i) });
  if (i < 3) addFollow({ clickId: c, method: i === 0 ? 'claim' : 'ip', status: 'matched', at: minutes(38 - i) });
}
// TikTokリンク: 3クリック、1紐づけ + 1保留
for (let i = 0; i < 3; i++) {
  const c = addClick(ttLink, { ip: '198.51.100.' + (20 + i), ttclid: 'ttcl_' + i, at: minutes(30 - i) });
  if (i === 0) addFollow({ clickId: c, method: 'ip', status: 'matched', at: minutes(28) });
}
addFollow({ status: 'pending', at: minutes(5) });
addFollow({ status: 'unmatched', at: minutes(50) });

// 汎用リンク: 2クリック
addClick(allLink, { ip: '192.0.2.5', fbclid: 'fbcl_x', ttclid: 'ttcl_x', at: minutes(15) });
addClick(allLink, { ip: '192.0.2.6', gclid: 'gcl_y', at: minutes(12) });

// ポストバックのデモ
const matchedFollows = db.prepare("SELECT id FROM follows WHERE status='matched'").all();
for (const f of matchedFollows) {
  db.prepare(
    `INSERT INTO postbacks (id, follow_id, platform, ok, http_status, response, created_at)
     VALUES (?, ?, 'meta', 1, 200, '{"events_received":1}', ?)`
  ).run(newId('pb'), f.id, now);
}

const stats = {
  links: db.prepare('SELECT COUNT(*) n FROM links').get().n,
  clicks: db.prepare('SELECT COUNT(*) n FROM clicks').get().n,
  follows: db.prepare('SELECT COUNT(*) n FROM follows').get().n,
  postbacks: db.prepare('SELECT COUNT(*) n FROM postbacks').get().n,
};
console.log('完了:', stats);
console.log('管理画面で確認してください:', `${config.baseUrl}/admin`);
db.close();
