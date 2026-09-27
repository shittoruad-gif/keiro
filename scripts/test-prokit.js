// プロ機能一式（src/prokit.js）の確認：空のDBで2回呼んで、1回目で全部そろい、2回目で増えないこと。
// 使い方: node scripts/test-prokit.js <一時DBのパス>
'use strict';
const assert = require('assert');
const { openDb } = require('../src/db');
const tenantmod = require('../src/tenant');
const prokit = require('../src/prokit');

const db = openDb(process.argv[2] || ':memory:');
const t0 = tenantmod.createTenant(db, { email: 'kit@example.com', password: 'x'.repeat(12), name: 'テスト店' });
db.prepare("UPDATE tenants SET line_oa_add_url = 'https://lin.ee/test', plan = 'light' WHERE id = ?").run(t0.id);
const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(t0.id);

const before = prokit.status(db, t);
assert.strictEqual(before.complete, false);

const r1 = prokit.ensure(db, t, { bookingUrl: 'https://example.com/yoyaku' });
const s1 = r1.status;
assert.ok(s1.ok.bot, 'bot'); assert.ok(s1.ok.form, 'form'); assert.ok(s1.ok.reminder, 'reminder');
assert.ok(s1.counts.steps >= 3, 'steps>=3'); assert.ok(s1.counts.links >= 4, 'links>=4'); assert.ok(s1.ok.trackedUrls, 'tracked');
assert.ok(r1.manual.some((m) => m.startsWith('タグ別リッチメニュー')));
assert.ok(r1.manual.some((m) => m.startsWith('広告の成果連携')));

const r2 = prokit.ensure(db, t, { bookingUrl: 'https://example.com/yoyaku' });
assert.strictEqual(r2.created.length, 0, '2回目は何も作らない');
assert.deepStrictEqual(r2.status.counts, s1.counts);

// 絵文字を入れていないこと（お客様に届く文面）
const texts = JSON.stringify([prokit.FOLLOW_BOT, prokit.FIRST_FORM, prokit.STEP_CAMPAIGNS]);
assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(texts), 'no emoji');

// LINE連携前は計測リンクを作らず、手作業として返す
const u0 = tenantmod.createTenant(db, { email: 'nolink@example.com', password: 'x'.repeat(12), name: '未連携店' });
const u = db.prepare('SELECT * FROM tenants WHERE id = ?').get(u0.id);
const r3 = prokit.ensure(db, u);
assert.strictEqual(r3.status.counts.links, 0);
assert.ok(r3.manual.some((m) => m.startsWith('計測リンク')));

console.log('prokit ok', s1.counts, 'created', r1.created.length);
