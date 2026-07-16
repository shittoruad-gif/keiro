'use strict';

// 回答フォーム（Lステップの「回答フォーム」相当）。
// 公開ページ /f/:id で回答を受け付け、署名付きURL（{form:ID}差し込み）経由なら
// 回答者の友だちを自動特定してタグ付与＋スコア加点する。
const config = require('./config');
const { newId, verifyToken } = require('./sign');
const { escapeHtml } = require('./util');
const friends = require('./friends');

const FIELD_TYPES = new Set(['text', 'textarea', 'select', 'radio', 'checkbox', 'birthday']);
const MAX_FIELDS = 20;

function normalizeFields(fields) {
  const out = [];
  for (const f of (Array.isArray(fields) ? fields : []).slice(0, MAX_FIELDS)) {
    const label = (f.label || '').toString().trim().slice(0, 100);
    if (!label) continue;
    const type = FIELD_TYPES.has(f.type) ? f.type : 'text';
    const options = (type === 'select' || type === 'radio' || type === 'checkbox')
      ? (Array.isArray(f.options) ? f.options : String(f.options || '').split(','))
          .map((o) => String(o).trim()).filter(Boolean).slice(0, 20)
      : [];
    out.push({ label, type, options, required: !!f.required });
  }
  return out;
}

function listForms(db, tenantId) {
  return db.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM form_answers a WHERE a.form_id = f.id) AS answer_count
     FROM forms f WHERE f.tenant_id = ? ORDER BY f.created_at DESC`
  ).all(tenantId).map((f) => ({ ...f, fields: JSON.parse(f.fields_json || '[]'), public_url: `${config.baseUrl}/f/${f.id}` }));
}

function getForm(db, tenantId, id) {
  const f = db.prepare('SELECT * FROM forms WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!f) return null;
  return { ...f, fields: JSON.parse(f.fields_json || '[]'), public_url: `${config.baseUrl}/f/${f.id}` };
}

function createForm(db, tenantId, { name, title, description, fields, tag, active }) {
  const norm = normalizeFields(fields);
  if (!norm.length) return { error: '質問を1つ以上設定してください' };
  const id = newId('frm');
  db.prepare(
    `INSERT INTO forms (id, tenant_id, name, title, description, fields_json, tag, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, String(name || 'フォーム'), title ? String(title).slice(0, 200) : null,
    description ? String(description).slice(0, 2000) : null, JSON.stringify(norm),
    tag ? String(tag).trim() : null, active === false ? 0 : 1, Date.now(), Date.now());
  return getForm(db, tenantId, id);
}

function updateForm(db, tenantId, id, fields) {
  const f = db.prepare('SELECT id FROM forms WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!f) return null;
  const sets = []; const vals = [];
  if ('name' in fields) { sets.push('name = ?'); vals.push(String(fields.name || '')); }
  if ('title' in fields) { sets.push('title = ?'); vals.push(fields.title ? String(fields.title).slice(0, 200) : null); }
  if ('description' in fields) { sets.push('description = ?'); vals.push(fields.description ? String(fields.description).slice(0, 2000) : null); }
  if ('fields' in fields) {
    const norm = normalizeFields(fields.fields);
    if (!norm.length) return { error: '質問を1つ以上設定してください' };
    sets.push('fields_json = ?'); vals.push(JSON.stringify(norm));
  }
  if ('tag' in fields) { sets.push('tag = ?'); vals.push(fields.tag ? String(fields.tag).trim() : null); }
  if ('active' in fields) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(Date.now(), id);
    db.prepare(`UPDATE forms SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getForm(db, tenantId, id);
}

function deleteForm(db, tenantId, id) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM form_answers WHERE form_id = ? AND tenant_id = ?').run(id, tenantId);
    db.prepare('DELETE FROM forms WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  });
  tx();
  return { ok: true };
}

function listAnswers(db, tenantId, formId, limit = 500) {
  return db.prepare(
    `SELECT a.*, f2.display_name FROM form_answers a
     LEFT JOIN friends f2 ON f2.tenant_id = a.tenant_id AND f2.line_user_id = a.line_user_id
     WHERE a.tenant_id = ? AND a.form_id = ? ORDER BY a.created_at DESC LIMIT ?`
  ).all(tenantId, formId, limit).map((a) => ({ ...a, answers: JSON.parse(a.answers_json || '{}'), line_user_id: undefined }));
}

/** 公開フォームページのHTML。 */
function renderPublicPage(form, tenantName) {
  const fields = form.fields.map((f, i) => {
    const req = f.required ? ' required' : '';
    const label = `<label class="q">${escapeHtml(f.label)}${f.required ? ' <span class="req">必須</span>' : ''}</label>`;
    if (f.type === 'textarea') return `${label}<textarea name="q${i}"${req} rows="4"></textarea>`;
    if (f.type === 'select') {
      const opts = ['<option value="">選択してください</option>']
        .concat(f.options.map((o) => `<option>${escapeHtml(o)}</option>`)).join('');
      return `${label}<select name="q${i}"${req}>${opts}</select>`;
    }
    if (f.type === 'radio') {
      const opts = f.options.map((o, j) =>
        `<label class="radio"><input type="radio" name="q${i}" value="${escapeHtml(o)}"${j === 0 && f.required ? ' required' : ''}> ${escapeHtml(o)}</label>`).join('');
      return `${label}<div class="radios">${opts}</div>`;
    }
    if (f.type === 'birthday') {
      const year = new Date().getFullYear();
      const ys = ['<option value="">年</option>'];
      for (let y = year; y >= year - 100; y--) ys.push(`<option>${y}</option>`);
      const ms = ['<option value="">月</option>'];
      for (let m = 1; m <= 12; m++) ms.push(`<option>${m}</option>`);
      const ds = ['<option value="">日</option>'];
      for (let d = 1; d <= 31; d++) ds.push(`<option>${d}</option>`);
      return `${label}<div class="bday"><select name="q${i}y"${req}>${ys.join('')}</select><select name="q${i}m"${req}>${ms.join('')}</select><select name="q${i}d"${req}>${ds.join('')}</select></div>`;
    }
    if (f.type === 'checkbox') {
      // 複数選択可（必須チェックはサーバー側で「1つ以上」を検証）
      const opts = f.options.map((o) =>
        `<label class="radio"><input type="checkbox" name="q${i}" value="${escapeHtml(o)}"> ${escapeHtml(o)}</label>`).join('');
      return `${label}<div class="radios">${opts}<div class="multi-hint">※ 複数選択できます</div></div>`;
    }
    return `${label}<input type="text" name="q${i}"${req}>`;
  }).join('');
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(form.title || form.name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#333;padding:16px;max-width:560px;margin:0 auto}
h1{font-size:20px;padding:20px 0 6px;color:#0f7a6b}
.desc{color:#555;font-size:14px;line-height:1.7;margin-bottom:18px;white-space:pre-wrap}
form{background:#fff;border-radius:16px;padding:22px 18px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.q{display:block;font-weight:700;font-size:14px;margin:16px 0 6px}
.q:first-child{margin-top:0}
.req{color:#b3402c;font-size:11px;font-weight:700}
input[type=text],textarea,select{width:100%;padding:10px;border:1px solid #cfd8e3;border-radius:8px;font-size:15px}
.radios{display:flex;flex-direction:column;gap:6px}
.bday{display:flex;gap:8px}
.bday select{flex:1}
.radio{font-size:14px}
.multi-hint{font-size:11px;color:#8a949e;margin-top:2px}
button{display:block;width:100%;margin-top:22px;background:#0f7a6b;color:#fff;border:none;border-radius:10px;padding:13px;font-size:16px;font-weight:700;cursor:pointer}
.done{background:#fff;border-radius:16px;padding:40px 18px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.done h2{color:#0f7a6b;margin-bottom:8px}
.foot{text-align:center;color:#999;font-size:12px;margin:16px 0}
</style></head><body>
<h1>${escapeHtml(form.title || form.name)}</h1>
${form.description ? `<p class="desc">${escapeHtml(form.description)}</p>` : ''}
<form method="POST">
${fields}
<button type="submit">送信する</button>
</form>
<p class="foot">${escapeHtml(tenantName || '')}</p>
</body></html>`;
}

function renderDonePage(form) {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>送信完了</title>
<style>body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f4f8;color:#333;padding:40px 16px;text-align:center}
.card{background:#fff;border-radius:16px;padding:40px 18px;max-width:480px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.08)}
h2{color:#0f7a6b;margin-bottom:10px}</style></head><body>
<div class="card"><h2>✅ 送信しました</h2><p>ご回答ありがとうございました。<br>このページは閉じていただいて構いません。</p></div>
</body></html>`;
}

/**
 * 回答を保存。uトークン（{form:ID}差し込みURL）があれば友だちを特定してタグ付与＋スコア加点。
 * @returns {{ok:true}|{error:string}}
 */
function submitAnswer(db, form, body, uToken) {
  const answers = {};
  let birthdayMMDD = null; // 生年月日項目があれば MM-DD を控えて友だちに自動登録
  form.fields.forEach((f, i) => {
    if (f.type === 'birthday') {
      const y = parseInt(body[`q${i}y`], 10);
      const m = parseInt(body[`q${i}m`], 10);
      const d = parseInt(body[`q${i}d`], 10);
      const okDate = y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
      if (f.required && !okDate) throw Object.assign(new Error(`「${f.label}」は必須です`), { statusCode: 400 });
      if (okDate) {
        answers[f.label] = `${y}年${m}月${d}日`;
        birthdayMMDD = String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      } else {
        answers[f.label] = '';
      }
      return;
    }
    let raw = body[`q${i}`];
    // checkbox（複数選択）は同名キーが配列で届く。回答は「、」区切りで1つの文字列に
    if (Array.isArray(raw)) raw = raw.map((x) => String(x)).filter(Boolean).join('、');
    const v = (raw || '').toString().slice(0, 2000);
    if (f.required && !v.trim()) throw Object.assign(new Error(`「${f.label}」は必須です`), { statusCode: 400 });
    answers[f.label] = v;
  });
  let lineUserId = null;
  if (uToken) {
    // 友だち自動特定トークンは有効期限を設ける（配布リンクの永久有効化を避ける）。約1年。
    const payload = verifyToken(config.secret, uToken, 365 * 24 * 3600);
    if (payload && payload.t === form.tenant_id && payload.u) lineUserId = payload.u;
  }
  db.prepare(
    `INSERT INTO form_answers (id, form_id, tenant_id, line_user_id, answers_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId('fa'), form.id, form.tenant_id, lineUserId, JSON.stringify(answers), Date.now());
  if (lineUserId) {
    friends.addScore(db, form.tenant_id, lineUserId, 5);
    if (birthdayMMDD) {
      // 誕生日配信（birthday_campaigns）の照合対象。回答者を特定できた場合のみ自動登録
      db.prepare('UPDATE friends SET birthday = ? WHERE tenant_id = ? AND line_user_id = ?')
        .run(birthdayMMDD, form.tenant_id, lineUserId);
    }
    if (form.tag) {
      const friend = db.prepare('SELECT id, tags FROM friends WHERE tenant_id = ? AND line_user_id = ?').get(form.tenant_id, lineUserId);
      if (friend) {
        const tags = new Set((friend.tags || '').split(',').map((s) => s.trim()).filter(Boolean));
        tags.add(form.tag);
        friends.setTags(db, form.tenant_id, friend.id, [...tags]);
      }
    }
  }
  return { ok: true, line_user_id: lineUserId };
}

module.exports = {
  listForms, getForm, createForm, updateForm, deleteForm, listAnswers,
  renderPublicPage, renderDonePage, submitAnswer,
};
