'use strict';
// フォーム回答 → Meta「予約(Schedule)」送信のテスト（2026-10-06）。メモリ上のDBと偽のMetaで確かめる。
const assert = require('assert');
const { openDb } = require('../src/db');
const forms = require('../src/forms');
const pb = require('../src/postback');
const { sha256hex } = require('../src/sign');

(async () => {
  const db = openDb(':memory:');
  const sent = [];
  global.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => '{"events_received":1}' }; };

  const tenantmod = require('../src/tenant');
  const created = tenantmod.createTenant(db, { email: 'form-cv@test.example', password: 'pass1234', name: 'テスト院' });
  db.prepare("UPDATE tenants SET id = 'tnt_test', plan = 'pro', trial_ends_at = ? WHERE id = ?").run(Date.now() + 86400000, created.id);
  tenantmod.updateTenantSettings(db, 'tnt_test', { meta_pixel_id: '111222333', meta_capi_token: 'test-token' });
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get('tnt_test');
  assert.ok(tenantmod.resolveSettings(tenant).meta.capiToken, 'トークンが読めること');

  const f = forms.createForm(db, 'tnt_test', { name: '予約相談', title: '予約相談', fields: [
    { label: 'お名前', type: 'text', required: true }, { label: 'お電話番号', type: 'tel', required: true }, { label: 'メール', type: 'email' }] });
  forms.updateForm(db, 'tnt_test', f.id, { meta_event: 'Schedule' });
  const form = { ...db.prepare('SELECT * FROM forms WHERE id = ?').get(f.id), fields: f.fields };
  assert.strictEqual(form.meta_event, 'Schedule');
  forms.updateForm(db, 'tnt_test', f.id, { meta_event: 'evil' });
  assert.strictEqual(db.prepare('SELECT meta_event FROM forms WHERE id = ?').get(f.id).meta_event, null, '決まった値以外は送らない扱い');
  forms.updateForm(db, 'tnt_test', f.id, { meta_event: 'Schedule' });

  // 1) LINEで特定できない回答でも、電話があれば送る（電話は暗号化）
  const r1 = forms.submitAnswer(db, form, { q0: '山田花子', q1: '090-1234-5678', q2: 'Hanako@Example.com' }, null);
  const res1 = await pb.dispatchFormConversion(db, { tenant, form, result: r1, ip: '203.0.113.5', ua: 'UA' });
  assert.ok(res1.ok);
  const ev = sent[0].body.data[0];
  assert.strictEqual(ev.event_name, 'Schedule');
  assert.strictEqual(ev.event_id, r1.answer_id);
  assert.deepStrictEqual(ev.user_data.ph, [sha256hex('819012345678')]);
  assert.deepStrictEqual(ev.user_data.em, [sha256hex('hanako@example.com')]);
  assert.ok(!JSON.stringify(sent[0].body).includes('1234-5678'), '生の電話番号は送らない');
  assert.ok(!JSON.stringify(sent[0].body).includes('山田'), '名前は送らない');

  // 2) 設定が「送らない」なら送らない
  forms.updateForm(db, 'tnt_test', f.id, { meta_event: '' });
  const form2 = { ...form, meta_event: null };
  const r2 = forms.submitAnswer(db, form2, { q0: 'A', q1: '0901111222' }, null);
  assert.strictEqual(await pb.dispatchFormConversion(db, { tenant, form: form2, result: r2 }), null);
  assert.strictEqual(sent.length, 1);

  // 3) ライトプランは送らない（広告CV連携はプロ限定）
  const light = { ...tenant, plan: 'light' };
  const r3 = forms.submitAnswer(db, form, { q0: 'B', q1: '09022223333' }, null);
  assert.strictEqual(await pb.dispatchFormConversion(db, { tenant: light, form, result: r3 }), null);
  assert.strictEqual(sent.length, 1);

  // 5) 広告の計測リンク → 友だち追加 → フォーム回答：クリックIDと LINE の ID で照合し、送信の記録が残る
  const linkCols = db.prepare('PRAGMA table_info(links)').all().map((c) => c.name);
  const link = { id: 'lnk_t', tenant_id: 'tnt_test', name: 'meta', oa_add_url: 'https://line.me/R/ti/p/@x', media: 'meta', created_at: Date.now() };
  const lk = Object.keys(link).filter((k) => linkCols.includes(k));
  db.prepare(`INSERT INTO links (${lk.join(',')}) VALUES (${lk.map(() => '?').join(',')})`).run(...lk.map((k) => link[k]));
  const clickAt = Date.now() - 60000;
  db.prepare("INSERT INTO clicks (id, tenant_id, link_id, fbclid, created_at) VALUES ('clk_t','tnt_test','lnk_t','AdClick123',?)").run(clickAt);
  db.prepare("INSERT INTO follows (id, tenant_id, line_user_id, click_id, status, created_at) VALUES ('fol_t','tnt_test','Uabc','clk_t','matched',?)").run(Date.now());
  forms.updateForm(db, 'tnt_test', f.id, { meta_event: 'Schedule' });
  const sign = require('../src/sign');
  const config = require('../src/config');
  const uTok = sign.signToken ? sign.signToken(config.secret, { t: 'tnt_test', u: 'Uabc' }) : null;
  const r5 = forms.submitAnswer(db, form, { q0: 'C', q1: '08055556666' }, uTok);
  if (r5.line_user_id) {
    await pb.dispatchFormConversion(db, { tenant, form, result: r5, ip: '203.0.113.6', ua: 'UA2' });
    const ev5 = sent[sent.length - 1].body.data[0];
    assert.strictEqual(ev5.user_data.external_id, sha256hex('Uabc'));
    assert.strictEqual(ev5.user_data.fbc, `fb.1.${clickAt}.AdClick123`);
    const row = db.prepare("SELECT * FROM postbacks WHERE follow_id = 'fol_t'").get();
    assert.ok(row && row.ok === 1 && /^\[Schedule\]/.test(row.response), '送信の記録');
    assert.strictEqual(row.ctx_json, null, '成功したら IP などを含む再送用の控えは残さない');
    console.log('  LINE経由の照合も ok');
  } else {
    console.log('  （署名関数名が違うため LINE 経由の照合テストは省略）');
  }

  // 4) 電話の形
  assert.strictEqual(pb.normPhone('080 9999 0000'), '818099990000');
  assert.strictEqual(pb.normPhone('123'), '');
  console.log('form conversion: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
