'use strict';

// 実機（LINE/広告API）なしで紐づけロジックを検証する。
// すべての検証に通れば PASS を出力して exit 0、失敗があれば exit 1。
//   node scripts/selftest.js

const assert = require('assert');
const { openDb } = require('../src/db');
const { findMatch, applyMatch } = require('../src/match');
const { signToken, verifyToken, verifyLineSignature } = require('../src/sign');
const { purgeOldData } = require('../src/retention');
const { dispatchPostbacks, retryDuePostbacks } = require('../src/postback');
const { deleteLinkCascade } = require('../src/links');
const cryptobox = require('../src/cryptobox');
const authmod = require('../src/auth');
const univapay = require('../src/univapay');
const billing = require('../src/billing');
const steps = require('../src/steps');
const friends = require('../src/friends');
const broadcast = require('../src/broadcast');
const autoreply = require('../src/autoreply');
const crypto = require('crypto');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.error('  ✗ ' + name + '\n      ' + (e && e.message));
  }
}

const WINDOW = 1800; // 秒
const NOW = 1_700_000_000_000; // 固定時刻(ms)
const TENANT = 'tnt_test';

function freshDb() {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO tenants (id, email, password_hash, name, role, status, webhook_token, created_at)
     VALUES (?, 'a@test.example', 'x', 'テスト院', 'tenant', 'active', 'whtok_test', ?)`
  ).run(TENANT, NOW - 20_000_000);
  db.prepare(
    `INSERT INTO links (id, tenant_id, name, oa_add_url, media, created_at)
     VALUES ('lnk_test', ?, 'テスト', 'https://lin.ee/x', 'meta', ?)`
  ).run(TENANT, NOW - 10_000_000);
  return db;
}

function addClick(db, { id, ip, atMsAgo, matched, tenant }) {
  db.prepare(
    `INSERT INTO clicks (id, tenant_id, link_id, ip, ua, fbclid, matched, created_at)
     VALUES (?, ?, 'lnk_test', ?, 'UA-click', 'fbcl_1', ?, ?)`
  ).run(id, tenant || TENANT, ip || null, matched ? 1 : 0, NOW - (atMsAgo || 0));
}

function addFollow(db, id, tenant) {
  db.prepare(
    `INSERT INTO follows (id, tenant_id, line_user_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(id, tenant || TENANT, 'U' + id, NOW);
  return db.prepare('SELECT * FROM follows WHERE id = ?').get(id);
}

async function main() {
console.log('Keiro selftest');
console.log('— 紐づけ優先順位 —');

// 1) claim: Cookieのクリックが未紐づけなら最優先（PC同一ブラウザ）
  await check('claim優先: Cookieのclick_idで紐づく (method=claim)', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_cookie', ip: '10.0.0.1', atMsAgo: 60_000 });
  const f = addFollow(db, 'flw1');
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: 'clk_cookie', ip: '10.0.0.1', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.method, 'claim');
  assert.strictEqual(r.clickId, 'clk_cookie');
  const row = db.prepare('SELECT * FROM follows WHERE id=?').get('flw1');
  assert.strictEqual(row.status, 'matched');
  assert.strictEqual(row.match_method, 'claim');
});

// 2) ip: Cookieなし、同一IPの直近クリック（スマホ主力経路）
  await check('ip優先: Cookieなしで同一IPの最新クリックに紐づく (method=ip)', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_old', ip: '10.0.0.2', atMsAgo: 600_000 });
  addClick(db, { id: 'clk_new', ip: '10.0.0.2', atMsAgo: 120_000 });
  const f = addFollow(db, 'flw2');
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: null, ip: '10.0.0.2', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.method, 'ip');
  assert.strictEqual(r.clickId, 'clk_new', '同一IPでは最新クリックを選ぶ');
});

// 3) time: IPが取れない場合のみ時間窓で紐づけ
  await check('time最終手段: IPなしのとき時間窓の最新クリックに紐づく (method=time)', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_t1', ip: '10.0.0.3', atMsAgo: 300_000 });
  addClick(db, { id: 'clk_t2', ip: '10.0.0.4', atMsAgo: 100_000 });
  const f = addFollow(db, 'flw3');
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: null, ip: null, nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.method, 'time');
  assert.strictEqual(r.clickId, 'clk_t2', '時間窓では最新クリックを選ぶ');
});

console.log('— 誤紐づけ防止 / 境界 —');

// 4) IPはあるが該当クリックが無い → 未紐づけ（timeにフォールバックしない）
  await check('IPありで候補なし: timeにフォールバックせず unmatched', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_other', ip: '10.9.9.9', atMsAgo: 60_000 });
  const f = addFollow(db, 'flw4');
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: null, ip: '10.0.0.99', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, false);
  const row = db.prepare('SELECT * FROM follows WHERE id=?').get('flw4');
  assert.strictEqual(row.status, 'unmatched');
  // 別IPのクリックは消費されない
  assert.strictEqual(db.prepare('SELECT matched FROM clicks WHERE id=?').get('clk_other').matched, 0);
});

// 5) 時間窓の外 → 紐づかない
  await check('時間窓の外: 同一IPでも窓外なら unmatched', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_stale', ip: '10.0.0.5', atMsAgo: (WINDOW + 60) * 1000 });
  const f = addFollow(db, 'flw5');
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: null, ip: '10.0.0.5', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, false);
});

// 6) Cookieのクリックが既に紐づけ済 → claimは使えずipにフォールバック
  await check('Cookieのclickが消費済: claim不可→ip候補にフォールバック', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_used', ip: '10.0.0.6', atMsAgo: 60_000, matched: true });
  addClick(db, { id: 'clk_free', ip: '10.0.0.6', atMsAgo: 90_000 });
  const f = addFollow(db, 'flw6');
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: 'clk_used', ip: '10.0.0.6', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.method, 'ip');
  assert.strictEqual(r.clickId, 'clk_free');
});

// 7) UAが違っても紐づく（デバイス指紋に依存しない）
  await check('UA非依存: クリックとclaimでUAが違っても同一IPで紐づく', () => {
  const db = freshDb();
  // クリックのUAは 'UA-click' 固定。claim側UAは渡さない（=判定に使わない）
  addClick(db, { id: 'clk_ua', ip: '10.0.0.7', atMsAgo: 60_000 });
  const f = addFollow(db, 'flw7');
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: null, ip: '10.0.0.7', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.method, 'ip');
});

// 8) 二重紐づけ防止: 1つのクリックを2つのfollowが奪い合っても1件のみ
  await check('二重紐づけ防止: 同一クリックは1followのみ消費', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_one', ip: '10.0.0.8', atMsAgo: 60_000 });
  const fa = addFollow(db, 'flwA');
  const fb = addFollow(db, 'flwB');
  const ra = applyMatch(db, fa, { tenantId: TENANT, cookieClickId: null, ip: '10.0.0.8', nowMs: NOW, windowSec: WINDOW });
  const rb = applyMatch(db, fb, { tenantId: TENANT, cookieClickId: null, ip: '10.0.0.8', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(ra.matched, true);
  assert.strictEqual(rb.matched, false, '2件目は同一クリックを使えない');
});

// 9) follow時点では推定しない: pendingのままで紐づけは発生しない
  await check('follow時点では推定紐づけしない（pendingのまま）', () => {
  const db = freshDb();
  addClick(db, { id: 'clk_p', ip: '10.0.0.9', atMsAgo: 60_000 });
  addFollow(db, 'flwP'); // applyMatchを呼ばない=Webhookのfollow処理に相当
  const row = db.prepare('SELECT * FROM follows WHERE id=?').get('flwP');
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.click_id, null);
  assert.strictEqual(db.prepare('SELECT matched FROM clicks WHERE id=?').get('clk_p').matched, 0);
});

console.log('— データ保持 / ポストバック —');

const DAY = 24 * 3600 * 1000;

// 14) 保持期間: 古い個人情報を削除し、新しいものは残す
  await check('retention: 保持期間超過のclick/follow/postbackを削除', () => {
  const db = freshDb();
  // 古い(100日前)と新しい(1日前)
  db.prepare(`INSERT INTO clicks (id, link_id, ip, matched, created_at) VALUES ('c_old','lnk_test','1.1.1.1',0,?)`).run(NOW - 100 * DAY);
  db.prepare(`INSERT INTO clicks (id, link_id, ip, matched, created_at) VALUES ('c_new','lnk_test','2.2.2.2',0,?)`).run(NOW - 1 * DAY);
  db.prepare(`INSERT INTO follows (id, line_user_id, status, created_at) VALUES ('f_old','Uold','unmatched',?)`).run(NOW - 100 * DAY);
  db.prepare(`INSERT INTO follows (id, line_user_id, status, created_at) VALUES ('f_new','Unew','pending',?)`).run(NOW - 1 * DAY);

  const r = purgeOldData(db, 90, NOW);
  assert.strictEqual(r.clicks, 1, '古いclickのみ削除');
  assert.strictEqual(r.follows, 1, '古いfollowのみ削除');
  assert.ok(db.prepare("SELECT 1 FROM clicks WHERE id='c_new'").get());
  assert.ok(!db.prepare("SELECT 1 FROM clicks WHERE id='c_old'").get());
  assert.ok(db.prepare("SELECT 1 FROM follows WHERE id='f_new'").get());
  assert.ok(!db.prepare("SELECT 1 FROM follows WHERE id='f_old'").get());
});

// 15) 保持期間: 新しいfollowが参照する古いclickはFK整合性のため保持
  await check('retention: 現存followが参照する古いclickは保持（FK整合）', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clicks (id, link_id, ip, matched, created_at) VALUES ('c_ref','lnk_test','3.3.3.3',1,?)`).run(NOW - 100 * DAY);
  // 新しいfollowが古いclickを紐づけ参照
  db.prepare(`INSERT INTO follows (id, line_user_id, click_id, match_method, status, created_at, matched_at)
              VALUES ('f_ref','Uref','c_ref','ip','matched',?,?)`).run(NOW - 1 * DAY, NOW - 1 * DAY);
  const r = purgeOldData(db, 90, NOW);
  assert.strictEqual(r.clicks, 0, '参照中のclickは削除しない');
  assert.ok(db.prepare("SELECT 1 FROM clicks WHERE id='c_ref'").get());
});

// 16) ポストバック: 未設定媒体はskip扱いで記録され、リトライ予約されない(done=1)
  await check('postback: 未設定媒体はdone=1で記録・リトライ予約なし', async () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clicks (id, link_id, ip, fbclid, matched, created_at)
              VALUES ('c_pb','lnk_test','4.4.4.4','fbX',1,?)`).run(NOW);
  const f = addFollow(db, 'f_pb');
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(TENANT);
  const click = db.prepare("SELECT * FROM clicks WHERE id='c_pb'").get();
  const link = db.prepare("SELECT * FROM links WHERE id='lnk_test'").get(); // media='meta'
  await dispatchPostbacks(db, { tenant, follow: f, click, link, ip: '4.4.4.4', ua: 'UA' });
  const rows = db.prepare("SELECT * FROM postbacks WHERE follow_id='f_pb'").all();
  assert.strictEqual(rows.length, 1, 'meta宛に1件記録');
  assert.strictEqual(rows[0].platform, 'meta');
  assert.strictEqual(rows[0].ok, 0);
  assert.strictEqual(rows[0].done, 1, 'スキップはリトライしない');
  assert.strictEqual(rows[0].next_retry_at, null);
  // リトライworkerは対象0件
  const rr = await retryDuePostbacks(db);
  assert.strictEqual(rr.retried, 0);
});

// 17) リンク削除: clickがあってもFKエラーにならずカスケード削除される
  await check('link削除: 依存click/follow/postbackごとカスケード削除（FKエラーなし）', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clicks (id, link_id, ip, fbclid, matched, created_at)
              VALUES ('c_del','lnk_test','5.5.5.5','fbD',1,?)`).run(NOW);
  db.prepare(`INSERT INTO follows (id, line_user_id, click_id, match_method, status, created_at, matched_at)
              VALUES ('f_del','Udel','c_del','ip','matched',?,?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO postbacks (id, follow_id, platform, ok, created_at) VALUES ('p_del','f_del','meta',1,?)`).run(NOW);
  const r = deleteLinkCascade(db, 'lnk_test');
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(r.clicks, 1);
  assert.ok(!db.prepare("SELECT 1 FROM links WHERE id='lnk_test'").get());
  assert.ok(!db.prepare("SELECT 1 FROM clicks WHERE id='c_del'").get());
  assert.ok(!db.prepare("SELECT 1 FROM follows WHERE id='f_del'").get());
  assert.ok(!db.prepare("SELECT 1 FROM postbacks WHERE id='p_del'").get());
});

console.log('— マルチテナント / 認証 / 課金 —');

// 18) テナント分離: 別院の同一IPクリックには紐づかない
  await check('テナント分離: 別院の同一IPクリックは紐づかない', () => {
  const db = freshDb();
  // 別院のクリックのみ（同一IP）。TENANTのfollowからは見えてはいけない
  db.prepare(`INSERT INTO tenants (id, email, password_hash, role, status, webhook_token, created_at)
              VALUES ('tnt_b','b@test.example','x','tenant','active','wh_b',?)`).run(NOW - 20 * DAY);
  db.prepare(`INSERT INTO links (id, tenant_id, name, oa_add_url, created_at) VALUES ('lnk_b','tnt_b','B','https://lin.ee/b',?)`).run(NOW - DAY);
  db.prepare(`INSERT INTO clicks (id, tenant_id, link_id, ip, matched, created_at) VALUES ('c_b','tnt_b','lnk_b','7.7.7.7',0,?)`).run(NOW - 60_000);
  const f = addFollow(db, 'f_a'); // TENANT
  const r = applyMatch(db, f, { tenantId: TENANT, cookieClickId: null, ip: '7.7.7.7', nowMs: NOW, windowSec: WINDOW });
  assert.strictEqual(r.matched, false, '別院のクリックは突合対象外');
  assert.strictEqual(db.prepare("SELECT matched FROM clicks WHERE id='c_b'").get().matched, 0, '別院のクリックは消費されない');
});

// 19) 暗号化: 往復で復元、改ざんはnull
  await check('cryptobox: 暗号化往復＆改ざん検出', () => {
  const enc = cryptobox.encrypt('LINE_SECRET_xyz');
  assert.ok(enc.startsWith('v1:'));
  assert.strictEqual(cryptobox.decrypt(enc), 'LINE_SECRET_xyz');
  assert.strictEqual(cryptobox.decrypt(enc.slice(0, -2) + 'AA'), null, '改ざんは復号失敗');
  assert.strictEqual(cryptobox.decrypt('plain-not-encrypted'), 'plain-not-encrypted', '非暗号文はそのまま');
});

// 20) パスワード: scryptハッシュ検証
  await check('auth: パスワードハッシュ検証（正/誤）', () => {
  const h = authmod.hashPassword('s3cretpass');
  assert.ok(h.startsWith('scrypt:'));
  assert.strictEqual(authmod.verifyPassword('s3cretpass', h), true);
  assert.strictEqual(authmod.verifyPassword('wrong', h), false);
});

// 21) JWT: 署名/検証/失効/改ざん
  await check('auth: JWT 署名・検証・失効・改ざん', () => {
  const t = authmod.signJwt({ sub: 'tnt_x', role: 'tenant' }, 60);
  const p = authmod.verifyJwt(t);
  assert.strictEqual(p.sub, 'tnt_x');
  assert.strictEqual(p.role, 'tenant');
  assert.strictEqual(authmod.verifyJwt(t.slice(0, -2) + 'xx'), null, '改ざんは無効');
  assert.strictEqual(authmod.verifyJwt(authmod.signJwt({ sub: 'a' }, -10)), null, '失効は無効');
});

// 22) UnivaPay: ステータス正規化
  await check('univapay: ステータス正規化', () => {
  assert.strictEqual(univapay.normalizeStatus('current'), 'active');
  assert.strictEqual(univapay.normalizeStatus('unverified'), 'trialing');
  assert.strictEqual(univapay.normalizeStatus('canceled'), 'canceled');
  assert.strictEqual(univapay.normalizeStatus('suspended'), 'past_due');
});

// 23) 課金状態: トライアル中はactive、終了かつ未契約は停止、契約中はactive
  await check('billing: トライアル/失効/契約 の課金状態', () => {
  const db = freshDb();
  // トライアル判定は実時間(Date.now)で行われるため、相対時刻はDate.now基準で作る
  const RN = Date.now();
  db.prepare("INSERT INTO tenants (id,email,password_hash,role,status,webhook_token,created_at) VALUES ('t_trial','t1@x','x','tenant','active','w1',?)").run(RN - 1 * DAY);
  db.prepare("INSERT INTO tenants (id,email,password_hash,role,status,webhook_token,created_at) VALUES ('t_exp','t2@x','x','tenant','active','w2',?)").run(RN - 100 * DAY);

  const tTrial = db.prepare("SELECT * FROM tenants WHERE id='t_trial'").get();
  const tExp = db.prepare("SELECT * FROM tenants WHERE id='t_exp'").get();
  assert.strictEqual(billing.subscriptionState(db, tTrial, ).active, true, 'トライアル中はactive');
  assert.strictEqual(billing.subscriptionState(db, tExp).active, false, 'トライアル終了・未契約は停止');

  // 契約を付与すると active
  billing.upsertSubscription(db, { tenantId: 't_exp', univapaySubId: 'us_1', status: 'active' });
  assert.strictEqual(billing.subscriptionState(db, tExp).active, true, '契約中はactive');
});

console.log('— ステップ配信 —');

function mkCampaign(db, { media, active, msgs }) {
  const c = steps.createCampaign(db, TENANT, { name: 'シナリオ', media: media || null, active: active !== false });
  steps.setSteps(db, TENANT, c.id, msgs || [{ delay_minutes: 0, text: 'hello' }]);
  return c;
}

// 24) enroll（全員向け）＋重複登録しない
  await check('step: 全員向けに登録、同一友だちは重複しない', () => {
  const db = freshDb();
  mkCampaign(db, { msgs: [{ delay_minutes: 0, text: 'A' }, { delay_minutes: 1440, text: 'B' }] });
  assert.strictEqual(steps.enrollFriend(db, { tenantId: TENANT, lineUserId: 'Ux', media: null }), 1);
  assert.strictEqual(steps.enrollFriend(db, { tenantId: TENANT, lineUserId: 'Ux', media: null }), 0, '重複登録しない');
  const enr = db.prepare("SELECT * FROM step_enrollments WHERE line_user_id='Ux'").get();
  assert.strictEqual(enr.status, 'active');
  assert.strictEqual(enr.next_position, 1);
});

// 25) 流入経路（媒体）別の出し分け
  await check('step: media空は全員、media指定は一致媒体のみ登録', () => {
  const db = freshDb();
  const all = mkCampaign(db, { media: null });
  const meta = mkCampaign(db, { media: 'meta' });
  // 友だち追加（media無し）→ allのみ
  steps.enrollFriend(db, { tenantId: TENANT, lineUserId: 'Uy', media: null });
  let rows = db.prepare("SELECT campaign_id FROM step_enrollments WHERE line_user_id='Uy'").all();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].campaign_id, all.id);
  // claim一致（media=meta）→ metaを追加
  steps.enrollFriend(db, { tenantId: TENANT, lineUserId: 'Uy', media: 'meta' });
  rows = db.prepare("SELECT campaign_id FROM step_enrollments WHERE line_user_id='Uy'").all();
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.some((r) => r.campaign_id === meta.id));
});

// 26) スケジューラ：順番に配信して完了する
  await check('step: due処理で順に配信し、最後はdoneになる', async () => {
  const db = freshDb();
  mkCampaign(db, { msgs: [{ delay_minutes: 0, text: '1通目' }, { delay_minutes: 60, text: '2通目' }] });
  steps.enrollFriend(db, { tenantId: TENANT, lineUserId: 'Uz', media: null });
  const sent = [];
  const sender = async (token, to, text) => { sent.push(text); return { ok: true, http_status: 200 }; };
  const future = Date.now() + 10 * 24 * 3600 * 1000;
  await steps.processDueSteps(db, { now: future, sender });
  await steps.processDueSteps(db, { now: future, sender });
  const r3 = await steps.processDueSteps(db, { now: future, sender });
  assert.deepStrictEqual(sent, ['1通目', '2通目']);
  assert.strictEqual(db.prepare("SELECT status FROM step_enrollments WHERE line_user_id='Uz'").get().status, 'done');
  assert.strictEqual(r3.due, 0, '完了後は配信対象なし');
});

// 27) 友だち解除で配信停止
  await check('step: stopEnrollmentsで停止し、以後配信されない', async () => {
  const db = freshDb();
  mkCampaign(db, { msgs: [{ delay_minutes: 0, text: 'x' }] });
  steps.enrollFriend(db, { tenantId: TENANT, lineUserId: 'Uw', media: null });
  assert.strictEqual(steps.stopEnrollments(db, TENANT, 'Uw'), 1);
  const sent = [];
  await steps.processDueSteps(db, { now: Date.now() + 86400000, sender: async (t, to, x) => { sent.push(x); return { ok: true }; } });
  assert.strictEqual(sent.length, 0, '停止後は送られない');
  assert.strictEqual(db.prepare("SELECT status FROM step_enrollments WHERE line_user_id='Uw'").get().status, 'stopped');
});

// 28) 無効キャンペーンには登録しない
  await check('step: 無効(active=0)キャンペーンには登録されない', () => {
  const db = freshDb();
  mkCampaign(db, { active: false });
  assert.strictEqual(steps.enrollFriend(db, { tenantId: TENANT, lineUserId: 'Uv', media: null }), 0);
});

console.log('— 友だち管理 / 配信 / 自動応答 —');

// 29) 友だち: 登録/重複なし/流入経路/ブロック/セグメント
  await check('friends: 登録・流入経路・ブロック・セグメント解決', () => {
  const db = freshDb();
  friends.upsertFollow(db, { tenantId: TENANT, lineUserId: 'F1' });
  friends.upsertFollow(db, { tenantId: TENANT, lineUserId: 'F1' }); // 再追加でも1件
  friends.setSource(db, { tenantId: TENANT, lineUserId: 'F1', media: 'meta', linkId: 'lnk_test' });
  friends.upsertFollow(db, { tenantId: TENANT, lineUserId: 'F2' });
  const f1 = db.prepare("SELECT id FROM friends WHERE line_user_id='F1'").get().id;
  friends.setTags(db, TENANT, f1, '来院済');

  assert.deepStrictEqual(friends.getRecipients(db, TENANT, 'all').sort(), ['F1', 'F2']);
  assert.deepStrictEqual(friends.getRecipients(db, TENANT, 'media', 'meta'), ['F1']);
  assert.deepStrictEqual(friends.getRecipients(db, TENANT, 'matched'), ['F1']);
  assert.deepStrictEqual(friends.getRecipients(db, TENANT, 'tag', '来院済'), ['F1']);

  friends.markBlocked(db, TENANT, 'F2');
  assert.deepStrictEqual(friends.getRecipients(db, TENANT, 'all'), ['F1'], 'ブロックは配信対象外');
  const c = friends.counts(db, TENANT);
  assert.strictEqual(c.total, 2); assert.strictEqual(c.active, 1); assert.strictEqual(c.blocked, 1); assert.strictEqual(c.attributed, 1);
});

// 30) 一斉配信: セグメント解決して件数どおり送る
  await check('broadcast: 媒体セグメントへ配信し件数を記録', async () => {
  const db = freshDb();
  friends.upsertFollow(db, { tenantId: TENANT, lineUserId: 'B1' }); friends.setSource(db, { tenantId: TENANT, lineUserId: 'B1', media: 'meta' });
  friends.upsertFollow(db, { tenantId: TENANT, lineUserId: 'B2' });
  const b = broadcast.createBroadcast(db, TENANT, { text: 'hi', audience_type: 'media', audience_value: 'meta' });
  assert.strictEqual(b.status, 'draft');
  const sent = [];
  const sender = async (t, ids, text) => { sent.push(...ids); return { ok: true, http_status: 200 }; };
  const r = await broadcast.sendBroadcast(db, TENANT, b.id, { sender });
  assert.strictEqual(r.recipients, 1); assert.strictEqual(r.sent, 1);
  assert.deepStrictEqual(sent, ['B1'], 'meta流入のB1のみ');
  assert.strictEqual(broadcast.getBroadcast(db, TENANT, b.id).status, 'sent');
});

// 31) 予約配信: 時刻が来たら送る
  await check('broadcast: 予約配信は時刻到達で送信', async () => {
  const db = freshDb();
  friends.upsertFollow(db, { tenantId: TENANT, lineUserId: 'S1' });
  const b = broadcast.createBroadcast(db, TENANT, { text: 'x', audience_type: 'all', scheduled_at: Date.now() + 3600000 });
  assert.strictEqual(b.status, 'scheduled');
  const sent = [];
  const sender = async (t, ids, x) => { sent.push(...ids); return { ok: true }; };
  let r = await broadcast.processScheduledBroadcasts(db, { now: Date.now(), sender });
  assert.strictEqual(r.processed, 0, 'まだ時刻前');
  r = await broadcast.processScheduledBroadcasts(db, { now: Date.now() + 2 * 3600000, sender });
  assert.strictEqual(r.processed, 1);
  assert.deepStrictEqual(sent, ['S1']);
  assert.strictEqual(broadcast.getBroadcast(db, TENANT, b.id).status, 'sent');
});

// 32) 自動応答: 含む/完全一致/無効
  await check('autoreply: キーワード一致で返信文を返す', () => {
  const db = freshDb();
  autoreply.createRule(db, TENANT, { keyword: '予約', match_type: 'contains', reply_text: '予約はこちら' });
  autoreply.createRule(db, TENANT, { keyword: '営業時間', match_type: 'exact', reply_text: '10-19時' });
  autoreply.createRule(db, TENANT, { keyword: 'クーポン', match_type: 'contains', reply_text: 'x', active: false });
  assert.strictEqual(autoreply.findReply(db, TENANT, '予約したいです'), '予約はこちら');
  assert.strictEqual(autoreply.findReply(db, TENANT, '営業時間'), '10-19時');
  assert.strictEqual(autoreply.findReply(db, TENANT, '営業時間は？'), null, '完全一致は部分では返さない');
  assert.strictEqual(autoreply.findReply(db, TENANT, 'クーポンください'), null, '無効ルールは返さない');
  assert.strictEqual(autoreply.findReply(db, TENANT, 'こんにちは'), null);
});

console.log('— 署名 / トークン —');

// 10) claimトークンの署名検証（往復）
  await check('claimトークン: 正しい署名は検証成功', () => {
  const secret = 'test-secret';
  const t = signToken(secret, { fid: 'flw_x', uid: 'U123', iat: NOW });
  const p = verifyToken(secret, t);
  assert.ok(p);
  assert.strictEqual(p.fid, 'flw_x');
});

// 11) 改ざんされたトークンは拒否
  await check('claimトークン: 改ざん/別シークレットは拒否', () => {
  const t = signToken('secretA', { fid: 'flw_x', iat: NOW });
  assert.strictEqual(verifyToken('secretB', t), null, '別シークレットでは検証失敗');
  const tampered = t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa');
  assert.strictEqual(verifyToken('secretA', tampered), null, '署名改ざんは検証失敗');
});

// 12) 失効トークン
  await check('claimトークン: maxAge超過で失効', () => {
  const secret = 's';
  const t = signToken(secret, { fid: 'f', iat: Date.now() - 10_000 * 1000 });
  assert.strictEqual(verifyToken(secret, t, 60), null);
});

// 13) LINE署名検証
  await check('LINE署名: 正しいHMAC-SHA256(base64)で検証成功、不一致は失敗', () => {
  const secret = 'line-channel-secret';
  const body = Buffer.from(JSON.stringify({ events: [{ type: 'follow' }] }), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.strictEqual(verifyLineSignature(secret, body, sig), true);
  assert.strictEqual(verifyLineSignature(secret, body, 'AAAA'), false);
  assert.strictEqual(verifyLineSignature(secret, Buffer.from('tampered'), sig), false);
});

console.log('');
console.log(`結果: ${pass} passed, ${fail} failed`);
if (fail === 0) {
  console.log('PASS');
  process.exit(0);
} else {
  console.log('FAIL');
  process.exit(1);
}
}

main().catch((e) => { console.error(e); process.exit(1); });
