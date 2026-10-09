'use strict';

/**
 * 終売・休止中の商品（お店がLINEで「終売 〇〇」と送って止めたもの）。
 *
 * なぜ要るか:
 *   好み別のステップ配信は、パンなどの商品を名前つきで紹介している。終売した商品の紹介が
 *   友だち追加から何日も後に届くと、お店が困る（2026-10 ツラジマベーカリー様）。
 *   商品名を登録しておくと、その名前を含むステップの通は送らずに次の通へ進む。
 *
 * 照合は「空白を除いた本文に、空白を除いた商品名が含まれるか」。文面そのものは書き換えない
 * （名前を送ったときの自動応答の直しは、運営が文面を確かめてから行う）。
 */
const { newId } = require('./sign');

function normName(s) {
  return String(s || '').replace(/[\s　]/g, '').trim();
}

function list(db, tenantId) {
  return db.prepare('SELECT name, created_at FROM paused_products WHERE tenant_id = ? ORDER BY created_at').all(tenantId);
}

function pause(db, tenantId, name, now = Date.now()) {
  const n = normName(name);
  if (!n) return { ok: false };
  const exists = db.prepare('SELECT id FROM paused_products WHERE tenant_id = ? AND name = ?').get(tenantId, n);
  if (!exists) db.prepare('INSERT INTO paused_products (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)').run(newId('pp'), tenantId, n, now);
  return { ok: true, name: n, already: !!exists };
}

function resume(db, tenantId, name) {
  const n = normName(name);
  const info = db.prepare('DELETE FROM paused_products WHERE tenant_id = ? AND name = ?').run(tenantId, n);
  return { ok: info.changes > 0, name: n };
}

/** この本文が、止めている商品のどれかを含むか（含んでいればその商品名を返す）。 */
function pausedIn(db, tenantId, text) {
  const body = normName(text);
  if (!body) return null;
  for (const p of list(db, tenantId)) if (p.name && body.includes(p.name)) return p.name;
  return null;
}

/** その商品名を含むステップの通がいくつあるか（お店へのお返事で「何通止めたか」を伝える）。 */
function countStepMentions(db, tenantId, name) {
  const n = normName(name);
  if (!n) return 0;
  const rows = db.prepare(
    `SELECT m.text FROM step_messages m JOIN step_campaigns c ON c.id = m.campaign_id WHERE c.tenant_id = ?`
  ).all(tenantId);
  return rows.filter((r) => normName(r.text).includes(n)).length;
}

module.exports = { normName, list, pause, resume, pausedIn, countStepMentions };
