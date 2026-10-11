'use strict';

/**
 * 予約の一覧表と前払い（代済／代未）の管理。スタッフがスマホで使う画面。
 *
 * なぜ要るか（2026-10-09 モンテローザ様のご質問）:
 *   クリスマスケーキを「現金前払い制（ポイント2倍）」にしたい。
 *   ・ケーキの種類／日にち／来店時間ごとの表がほしい
 *   ・「代済」「代未」を区別したい
 *   ・お支払い締め切り（12/20）までに「代未」の方へお知らせしたい
 *   ショップカードのQRを読み取った瞬間に代済へ切り替える案もいただいたが、
 *   LINEのショップカードはポイント付与を外部へ知らせる仕組みが無い（APIなし）ため不可。
 *   お会計のときにスタッフがこの画面で「代済にする」を押す形にする。
 *
 * 画面の入口: /staff/<tenants.staff_token>/forms/<formId>
 *   お客様向けの public_token（クーポンページ等で配っている）とは別の鍵にする。
 *   同じ鍵だと、クーポンのURLを知るお客様が全員の名前と電話番号を見られてしまうため。
 */
const crypto = require('crypto');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function receiptNo(answerId) {
  return String(answerId || '').replace(/^fa_/, '').slice(-6).toUpperCase();
}

/** スタッフ用URLの鍵。無ければ作る。 */
function ensureStaffToken(db, tenantId) {
  const t = db.prepare('SELECT staff_token FROM tenants WHERE id = ?').get(tenantId);
  if (t && t.staff_token) return t.staff_token;
  const tok = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE tenants SET staff_token = ? WHERE id = ?').run(tok, tenantId);
  return tok;
}

/** 回答の中から、受け取り日・時間帯・商品の項目を見つける（ラベルの言葉で判定）。 */
function pickKeys(fields) {
  const labels = (fields || []).map((f) => f.label);
  const find = (re) => labels.find((l) => re.test(l)) || null;
  return {
    name: find(/お名前|氏名/),
    phone: find(/電話/),
    date: find(/受け取り日|受取日|お日にち|日にち/),
    time: find(/時間/),
    item: find(/ケーキ|商品|ご希望/),
  };
}

/** フォームの回答を、一覧で使う形にして返す。受け取り日・時間の順に並べる。 */
function listForForm(db, tenantId, formId) {
  const f = db.prepare('SELECT * FROM forms WHERE id = ? AND tenant_id = ?').get(formId, tenantId);
  if (!f) return null;
  const fields = JSON.parse(f.fields_json || '[]');
  const keys = pickKeys(fields);
  const rows = db.prepare('SELECT * FROM form_answers WHERE form_id = ? AND tenant_id = ? ORDER BY created_at').all(formId, tenantId)
    .map((a) => {
      let ans = {};
      try { ans = JSON.parse(a.answers_json || '{}'); } catch { ans = {}; }
      return {
        id: a.id, no: receiptNo(a.id), lineUserId: a.line_user_id, createdAt: a.created_at, paidAt: a.paid_at || null,
        name: keys.name ? ans[keys.name] || '' : '', phone: keys.phone ? ans[keys.phone] || '' : '',
        date: keys.date ? ans[keys.date] || '' : '', time: keys.time ? ans[keys.time] || '' : '',
        item: keys.item ? ans[keys.item] || '' : '', answers: ans,
      };
    });
  const changed = {};
  try { for (const c of db.prepare('SELECT answer_id, MAX(changed_at) t FROM form_answer_changes WHERE form_id = ? GROUP BY answer_id').all(formId)) changed[c.answer_id] = c.t; } catch { /* 古いDB */ }
  for (const r of rows) r.changedAt = changed[r.id] || null;
  const sent = require('./payreminder').sentDatesByAnswer(db, formId);
  for (const r of rows) r.remindedDates = sent[r.id] || [];
  rows.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time, 'ja') || x.createdAt - y.createdAt);
  return { form: { ...f, fields }, keys, rows };
}

/** 日にち×時間帯×商品の台数。商品が自由記入の間は「件数」で数える。 */
function summarize(rows) {
  const dates = [...new Set(rows.map((r) => r.date).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const items = [...new Set(rows.map((r) => r.item).filter(Boolean))];
  const table = {};
  for (const r of rows) {
    const k = `${r.date}|${r.time}`;
    table[k] = table[k] || {};
    table[k][r.item] = (table[k][r.item] || 0) + 1;
  }
  return { dates, items, table };
}

function markPaid(db, tenantId, answerId, now) {
  const info = db.prepare('UPDATE form_answers SET paid_at = ? WHERE id = ? AND tenant_id = ? AND paid_at IS NULL').run(now, answerId, tenantId);
  return info.changes > 0;
}

/** 代済を取り消す（押し間違え用）。 */
function unmarkPaid(db, tenantId, answerId) {
  return db.prepare('UPDATE form_answers SET paid_at = NULL WHERE id = ? AND tenant_id = ?').run(answerId, tenantId).changes > 0;
}

/** 代済にしたとき、そのお客様にだけ送る文面。 */
function buildPaidText(row) {
  return (
    'お支払いを確認しました。ありがとうございます。\n\n'
    + `受付番号: ${row.no}\n`
    + (row.item ? `・${row.item}\n` : '')
    + (row.date || row.time ? `・${row.date}　${row.time}\n` : '')
    + '\n当日は、この画面をお見せください。ご来店をお待ちしております。'
  );
}

/** フォームが締め切り済みか。 */
function isClosed(form, now = Date.now()) {
  return Boolean(form && form.closes_at && now >= Number(form.closes_at));
}

function fmtTime(ms) {
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** スタッフ用の一覧画面（スマホ前提）。 */
function renderStaffPage({ tenantName, form, rows, actionBase, notice }) {
  const paid = rows.filter((r) => r.paidAt).length;
  const unpaid = rows.length - paid;
  const sum = summarize(rows);
  const hasItems = sum.items.length > 0;
  const sumRows = sum.dates.map((dt) => {
    const times = [...new Set(rows.filter((r) => r.date === dt).map((r) => r.time))].sort();
    return times.map((tm) => {
      const cell = sum.table[`${dt}|${tm}`] || {};
      const total = Object.values(cell).reduce((a, b) => a + b, 0);
      const detail = hasItems ? Object.entries(cell).map(([k, v]) => `${esc(k)}：${v}件`).join('<br>') : '';
      return `<tr><td class="nw">${esc(dt)}<br><span class="tm">${esc(tm)}</span></td><td class="n">${total}件</td>${hasItems ? `<td class="it">${detail}</td>` : ''}</tr>`;
    }).join('');
  }).join('');
  const cards = rows.map((r) => {
    const q = esc(`${r.no} ${r.name} ${r.phone} ${r.item} ${r.date} ${r.time}`.toLowerCase());
    const badge = r.paidAt ? `<span class="b paid">代済</span>` : `<span class="b unpaid">代未</span>`;
    const act = r.paidAt
      ? `<div class="paidline">${fmtTime(r.paidAt)} にお支払い確認
           <form method="POST" action="${actionBase}/answers/${esc(r.id)}/unpaid" onsubmit="return confirm('代未に戻します。よろしいですか？')"><button class="undo">戻す</button></form></div>`
      : `<form method="POST" action="${actionBase}/answers/${esc(r.id)}/paid" onsubmit="return confirm('${esc(r.name || r.no)} 様を代済にします。お客様に「お支払いを確認しました」とLINEが届きます。')"><button class="pay">代済にする</button></form>`;
    return `<div class="card" data-q="${q}" data-paid="${r.paidAt ? 1 : 0}">
      <div class="top"><span class="no">${esc(r.no)}</span><span class="nm">${esc(r.name || '（お名前なし）')} 様</span>${badge}</div>
      <div class="meta">${esc(r.item || '')}</div>
      <div class="meta">${esc(r.date)}　${esc(r.time)}</div>
      ${!r.paidAt && r.remindedDates && r.remindedDates.length ? `<div class="meta rem">お支払いのお知らせ済み：${r.remindedDates.map((d) => esc(d.slice(5).replace('-', '/'))).join('・')}</div>` : ''}
      ${r.phone ? `<div class="meta tel"><a href="tel:${esc(String(r.phone).replace(/[^0-9+]/g, ''))}">${esc(r.phone)}</a></div>` : ''}
      ${r.changedAt ? `<div class="meta chg">内容を変更しました（${fmtTime(r.changedAt)}）</div>` : ''}
      ${act}
      <a class="edit" href="${actionBase}/answers/${esc(r.id)}/edit">内容を変更</a></div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>予約一覧｜${esc(form.title || form.name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Hiragino Sans','Helvetica Neue',Arial,sans-serif;background:#f4f2ef;color:#3a342e;padding:14px;max-width:640px;margin:0 auto}
h1{font-size:17px;color:#6c6056;margin:4px 0 2px}.shop{font-size:12px;color:#8a8079}
.kpi{display:flex;gap:8px;margin:12px 0}.kpi div{flex:1;background:#fff;border-radius:10px;padding:10px;text-align:center;font-size:12px;color:#8a8079}
.kpi b{display:block;font-size:22px;color:#3a342e}.kpi .u b{color:#c0562f}.kpi .p b{color:#12a15a}
.notice{background:#eaf7ef;color:#12804a;border-radius:8px;padding:9px 12px;font-size:13px;margin-bottom:10px}
.tabs{display:flex;gap:6px;margin-bottom:8px}.tabs button{flex:1;border:1px solid #ddd6cf;background:#fff;border-radius:8px;padding:8px;font-size:13px}
.tabs button.on{background:#b08554;color:#fff;border-color:#b08554}
input.s{width:100%;border:1px solid #ddd6cf;border-radius:9px;padding:10px 12px;font-size:15px;margin-bottom:10px;background:#fff}
.card{background:#fff;border-radius:11px;padding:11px 12px;margin-bottom:9px}
.top{display:flex;align-items:center;gap:8px}.no{font-family:Menlo,monospace;font-size:13px;color:#8a8079}.nm{font-weight:bold;flex:1}
.b{font-size:12px;font-weight:bold;border-radius:10px;padding:2px 9px}.b.paid{background:#eaf7ef;color:#12a15a}.b.unpaid{background:#fdf0eb;color:#c0562f}
.meta{font-size:13.5px;margin-top:3px;line-height:1.5}.tel a{color:#2f5e9e}.rem{font-size:12px;color:#c0562f}.chg{font-size:12px;color:#2f5e9e}a.edit{display:block;text-align:center;margin-top:8px;font-size:13px;color:#6c6056;border:1px solid #ddd6cf;border-radius:8px;padding:7px;text-decoration:none;background:#fff}
button.pay{display:block;width:100%;margin-top:9px;border:0;background:#12a15a;color:#fff;font-size:15px;font-weight:bold;border-radius:8px;padding:10px}
.paidline{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:12.5px;color:#12a15a}
button.undo{border:1px solid #ddd6cf;background:#fff;color:#8a8079;border-radius:6px;padding:4px 10px;font-size:12px}
h2{font-size:14px;color:#6c6056;margin:16px 0 6px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid #eee7df;text-align:left;vertical-align:top}th{background:#fdfaf6;color:#6c6056}
td.n,th.n{text-align:right;white-space:nowrap}td.nw{white-space:nowrap}.tm{font-size:12px;color:#8a8079}td.it{font-size:12px;color:#6e655d}
.empty{text-align:center;color:#8a8079;padding:30px 0;font-size:14px}
@media print{.tabs,input.s,button,form,a.edit{display:none!important}body{background:#fff}}
</style></head><body>
<div class="shop">${esc(tenantName || '')}　スタッフ用</div>
<h1>${esc(form.title || form.name)}</h1>
<div class="kpi"><div>ご予約<b>${rows.length}</b></div><div class="p">代済<b>${paid}</b></div><div class="u">代未<b>${unpaid}</b></div></div>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
<div class="tabs"><button class="on" data-f="all">すべて</button><button data-f="0">代未だけ</button><button data-f="1">代済だけ</button></div>
<input class="s" type="search" placeholder="受付番号・お名前・電話番号でさがす" id="q">
<div id="list">${cards || '<div class="empty">まだご予約はありません</div>'}</div>
<h2>日にち・時間帯ごとの件数</h2>
<table><tr><th>日にち・時間帯</th><th class="n">件数</th>${hasItems ? '<th>内訳</th>' : ''}</tr>${sumRows || '<tr><td colspan="3" class="empty">—</td></tr>'}</table>
<script>
(function(){var f='all',q=document.getElementById('q');
function ap(){var v=(q.value||'').toLowerCase();document.querySelectorAll('.card').forEach(function(c){
var ok=(f==='all'||c.dataset.paid===f)&&(!v||c.dataset.q.indexOf(v)>=0);c.style.display=ok?'':'none';});}
q.addEventListener('input',ap);document.querySelectorAll('.tabs button').forEach(function(b){b.addEventListener('click',function(){
document.querySelectorAll('.tabs button').forEach(function(x){x.classList.remove('on')});b.classList.add('on');f=b.dataset.f;ap();});});})();
</script></body></html>`;
}

/** 締め切り後に予約フォームを開いた方へ出す画面。 */
function renderClosedPage(form, tenantName) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>受付は終了しました</title>
<style>body{font-family:'Hiragino Sans','Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#333;padding:40px 16px;text-align:center}
.card{background:#fff;border-radius:16px;padding:40px 18px;max-width:480px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.08)}h2{color:#6c6056;margin-bottom:12px}</style></head><body>
<div class="card"><h2>${esc(form.title || form.name)}</h2><p>受付は終了しました。<br>たくさんのご予約をありがとうございました。</p>
${tenantName ? `<p style="margin-top:14px;color:#888;font-size:13px">${esc(tenantName)}</p>` : ''}</div></body></html>`;
}

/** 予約内容の変更画面。今の内容を入れた状態で、フォームと同じ項目を出す。 */
function renderEditPage({ tenantName, form, row, actionBase, error }) {
  const fields = form.fields || [];
  const cur = row.answers || {};
  const items = fields.map((f, i) => {
    if (f.type === 'birthday') return '';
    const v = cur[f.label] == null ? '' : String(cur[f.label]);
    const label = `<label class="q">${esc(f.label)}</label>`;
    if (f.type === 'radio' || f.type === 'select') {
      const opts = (f.options || []).slice();
      if (v && !opts.includes(v)) opts.unshift(v); // 今の値が選択肢から消えていても残す
      return label + `<select name="q${i}">${f.required ? '' : '<option value="">（なし）</option>'}${opts.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    if (f.type === 'checkbox') {
      const sel = v.split(/[、,]\s*/).filter(Boolean);
      return label + `<div class="cb">${(f.options || []).map((o) => `<label><input type="checkbox" name="q${i}" value="${esc(o)}"${sel.includes(o) ? ' checked' : ''}> ${esc(o)}</label>`).join('')}</div>`;
    }
    if (f.type === 'textarea') return label + `<textarea name="q${i}" rows="3">${esc(v)}</textarea>`;
    return label + `<input type="text" name="q${i}" value="${esc(v)}">`;
  }).join('');
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ご予約内容の変更</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Hiragino Sans','Helvetica Neue',Arial,sans-serif;background:#f4f2ef;color:#3a342e;padding:14px;max-width:560px;margin:0 auto}
.shop{font-size:12px;color:#8a8079}h1{font-size:17px;color:#6c6056;margin:4px 0 10px}
.box{background:#fff;border-radius:12px;padding:14px}
.no{font-family:Menlo,monospace;font-size:13px;color:#8a8079;margin-bottom:6px}
.q{display:block;font-size:13px;font-weight:bold;margin:12px 0 5px;color:#6c6056}
input[type=text],select,textarea{width:100%;font-size:16px;border:1px solid #ddd6cf;border-radius:8px;padding:9px 10px;background:#fff}
.cb label{display:block;font-size:15px;margin:4px 0}
.notify{display:flex;gap:8px;align-items:flex-start;margin-top:16px;font-size:14px;line-height:1.5}
.notify input{margin-top:3px;width:18px;height:18px}
button{display:block;width:100%;margin-top:16px;border:0;background:#12a15a;color:#fff;font-size:16px;font-weight:bold;border-radius:9px;padding:12px}
a.back{display:block;text-align:center;margin-top:12px;font-size:14px;color:#6c6056}
.err{background:#fdf0eb;color:#c0562f;border-radius:8px;padding:9px 12px;font-size:13px;margin-bottom:10px}
</style></head><body>
<div class="shop">${esc(tenantName || '')}　スタッフ用</div>
<h1>ご予約内容の変更</h1>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="POST" action="${actionBase}/answers/${esc(row.id)}/edit" class="box">
<div class="no">受付番号 ${esc(row.no)}</div>
${items}
<label class="notify"><input type="checkbox" name="notify" value="1"${row.lineUserId ? ' checked' : ' disabled'}>
<span>${row.lineUserId ? 'お客様に、変更後の内容をLINEでお知らせする' : 'この方はLINEのお相手が分からないため、LINEでのお知らせはできません（お電話でお伝えください）'}</span></label>
<button>この内容で変更する</button>
</form>
<a class="back" href="${actionBase}">一覧に戻る</a>
</body></html>`;
}

/**
 * 予約内容を変更する。変更前の内容は form_answer_changes に残す（あとから確かめられるように）。
 * @returns {{ok:boolean, changed?:string[], row?:object, error?:string}}
 */
function applyEdit(db, tenantId, formId, answerId, body, now = Date.now()) {
  const data = listForForm(db, tenantId, formId);
  if (!data) return { ok: false, error: 'フォームが見つかりません' };
  const row = data.rows.find((r) => r.id === answerId);
  if (!row) return { ok: false, error: 'ご予約が見つかりません' };
  const before = { ...row.answers };
  const after = { ...row.answers };
  const changed = [];
  data.form.fields.forEach((f, i) => {
    if (f.type === 'birthday') return;
    const key = `q${i}`;
    let v;
    if (f.type === 'checkbox') {
      const raw = body[key];
      v = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x).trim()).filter(Boolean).join('、');
    } else {
      if (!(key in body)) return; // 画面に無い項目は変えない
      v = String(body[key] == null ? '' : body[key]).trim().slice(0, 1000);
    }
    if ((f.type === 'radio' || f.type === 'select') && v && !(f.options || []).includes(v) && v !== String(before[f.label] || '')) {
      throw Object.assign(new Error(`「${f.label}」の選択肢にない値です`), { statusCode: 400 });
    }
    if (f.required && !v) throw Object.assign(new Error(`「${f.label}」は空にできません`), { statusCode: 400 });
    if (String(before[f.label] == null ? '' : before[f.label]) !== v) {
      after[f.label] = v;
      changed.push(f.label);
    }
  });
  if (!changed.length) return { ok: true, changed: [], row };
  const tx = db.transaction(() => {
    db.prepare('UPDATE form_answers SET answers_json = ? WHERE id = ? AND tenant_id = ?').run(JSON.stringify(after), answerId, tenantId);
    db.prepare(`INSERT INTO form_answer_changes (id, tenant_id, form_id, answer_id, before_json, after_json, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`fac_${crypto.randomBytes(9).toString('hex')}`, tenantId, formId, answerId, JSON.stringify(before), JSON.stringify(after), now);
  });
  tx();
  const fresh = listForForm(db, tenantId, formId).rows.find((r) => r.id === answerId);
  return { ok: true, changed, row: fresh };
}

/** 変更後にお客様へ送る文面。 */
function buildChangedText(row) {
  return (
    'ご予約内容を変更いたしました。\n\n'
    + `受付番号: ${row.no}\n`
    + (row.item ? `・${row.item}\n` : '')
    + (row.date || row.time ? `・${row.date}　${row.time}\n` : '')
    + '\nお受け取りの際は、このメッセージをお見せください。\n'
    + '内容に誤りがございましたら、このLINEでお知らせください。'
  );
}

module.exports = {
  ensureStaffToken, listForForm, summarize, markPaid, unmarkPaid, buildPaidText, isClosed,
  renderStaffPage, renderClosedPage, pickKeys, receiptNo,
  renderEditPage, applyEdit, buildChangedText,
};
