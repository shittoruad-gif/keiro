'use strict';

async function api(path, opts) {
  const res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin' }, opts));
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (res.status === 403) { showSuspended(); throw new Error('suspended'); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || ('API ' + path + ' ' + res.status)); }
  return res.status === 204 ? null : res.json();
}

let suspendedShown = false;
function showSuspended() {
  if (suspendedShown) return; suspendedShown = true;
  document.body.innerHTML =
    '<div class="center"><div class="card">' +
    '<h1>アカウントが停止中です</h1>' +
    '<p class="lead">無料トライアルの終了、または管理者による停止のため、現在ご利用いただけません。' +
    'ご利用の再開・お支払いについてはお問い合わせください。</p>' +
    '<button onclick="fetch(\'/auth/logout\',{method:\'POST\',credentials:\'same-origin\'}).then(()=>location.href=\'/login\')">ログアウト</button>' +
    '</div></div>';
}

const fmtInt = (n) => (n == null ? '–' : Number(n).toLocaleString('ja-JP'));
const fmtPct = (r) => (r == null ? '–' : (r * 100).toFixed(1) + '%');
const fmtYen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
function fmtDate(ms) {
  if (!ms) return '–';
  const d = new Date(ms), p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
  if (children) for (const c of children) e.appendChild(c);
  return e;
}
function copyEl(url) {
  const b = el('button', { class: 'copy', type: 'button', title: url, text: url });
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); const o = b.textContent; b.textContent = 'コピーしました'; b.classList.add('copied'); setTimeout(() => { b.textContent = o; b.classList.remove('copied'); }, 1200); }
    catch { window.prompt('コピーしてください', url); }
  });
  return b;
}

let BILLING = null;

async function loadMe() {
  const me = await api('/me');
  document.getElementById('who').textContent = me.name || me.email;
}

async function loadBilling() {
  const b = await api('/billing/status');
  BILLING = b;
  const box = document.getElementById('billing-banner');
  box.textContent = '';
  if (b.status === 'active') {
    box.appendChild(el('div', { class: 'banner ok', text: `ご契約中（${b.plan.name} ${fmtYen(b.plan.amount)}/月）` }));
    return;
  }
  if (b.in_trial) {
    const days = Math.max(0, Math.ceil((b.trial_ends_at - Date.now()) / 86400000));
    const wrap = el('div', { class: 'banner trial' }, [
      el('span', { text: `無料トライアル中：あと${days}日（${fmtDate(b.trial_ends_at)}まで）。継続利用にはお申し込みください。` }),
    ]);
    wrap.appendChild(subscribeButton(b));
    box.appendChild(wrap);
    return;
  }
  // 失効/未契約
  const wrap = el('div', { class: 'banner warn' }, [
    el('span', { text: 'トライアル終了、または未契約のため計測が停止しています。お申し込みで再開します。' }),
  ]);
  wrap.appendChild(subscribeButton(b));
  box.appendChild(wrap);
}

function subscribeButton(b) {
  const btn = el('button', { class: 'btn accent', type: 'button', text: `申し込む（${fmtYen(b.plan.amount)}/月）` });
  btn.addEventListener('click', () => startSubscribe(b));
  return btn;
}

function startSubscribe(b) {
  if (!b.univapay || !b.univapay.enabled || !b.univapay.app_jwt) {
    alert('決済の準備中です。運営にお問い合わせください。');
    return;
  }
  if (typeof UnivapayCheckout === 'undefined') { alert('決済モジュールの読み込みに失敗しました。時間をおいて再度お試しください。'); return; }
  const checkout = UnivapayCheckout.create({
    appId: b.univapay.app_jwt,
    checkout: 'token',
    tokenType: 'subscription',
    amount: b.plan.amount,
    currency: b.plan.currency || 'jpy',
    onSuccess: (res) => finishSubscribe(res),
    onTokenCreated: (res) => finishSubscribe(res),
  });
  checkout.open();
}

let subscribing = false;
async function finishSubscribe(res) {
  if (subscribing) return; subscribing = true;
  const tokenId = res && (res.id || res.transactionTokenId || (res.token && res.token.id));
  try {
    await api('/billing/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_token_id: tokenId }) });
    alert('お申し込みありがとうございます。ご利用を開始できます。');
    await loadBilling();
  } catch (e) { alert('お申し込みに失敗しました: ' + e.message); }
  finally { subscribing = false; }
}

async function loadStats() {
  const s = await api('/stats');
  document.getElementById('kpi-clicks').textContent = fmtInt(s.clicks);
  document.getElementById('kpi-follows').textContent = fmtInt(s.follows);
  document.getElementById('kpi-rate').textContent = fmtPct(s.match_rate);
  document.getElementById('kpi-pb').textContent = `${fmtInt(s.postbacks_ok)} / ${fmtInt(s.postbacks_total)}`;
}

async function loadSettings() {
  const s = await api('/settings');
  const f = document.getElementById('settings-form');
  document.getElementById('webhook-url').textContent = s.webhook_url;
  document.getElementById('webhook-url').onclick = () => navigator.clipboard.writeText(s.webhook_url).catch(() => {});
  f.line_oa_add_url.value = s.line_oa_add_url || '';
  f.meta_pixel_id.value = s.meta_pixel_id || '';
  f.tiktok_pixel_id.value = s.tiktok_pixel_id || '';
  document.getElementById('set-ls').textContent = s.line_channel_secret_set ? '設定済み' : '';
  document.getElementById('set-lat').textContent = s.line_channel_access_token_set ? '設定済み' : '';
  document.getElementById('set-mt').textContent = s.meta_capi_token_set ? '設定済み' : '';
  document.getElementById('set-tt').textContent = s.tiktok_access_token_set ? '設定済み' : '';
}

async function loadLinks() {
  const rows = await api('/links');
  const body = document.getElementById('links-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだありません' })])); return; }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, [el('div', { text: r.name }), el('div', { class: 'muted', text: [r.campaign, r.creative].filter(Boolean).join(' / ') || '' })]));
    tr.appendChild(el('td', null, [copyEl(r.track_url)]));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(r.clicks) }));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(r.follows) }));
    tr.appendChild(el('td', { class: 'num', text: fmtPct(r.cvr) }));
    const del = el('button', { class: 'del', type: 'button', text: '削除' });
    del.addEventListener('click', async () => { if (!confirm(`「${r.name}」を削除しますか？`)) return; await api('/links/' + encodeURIComponent(r.id), { method: 'DELETE' }); refresh(); });
    tr.appendChild(el('td', null, [del]));
    body.appendChild(tr);
  }
}

async function loadFollows() {
  const rows = await api('/follows?limit=50');
  const body = document.getElementById('follows-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'まだありません' })])); return; }
  const labels = { matched: '紐づけ済', pending: '保留', unmatched: '未紐づけ' };
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + r.status }), el('span', { text: labels[r.status] || r.status })])]));
    tr.appendChild(el('td', { class: 'mono', text: r.line_user_id_short || '–' }));
    tr.appendChild(el('td', null, [el('span', { class: 'method', text: r.match_method || '–' })]));
    tr.appendChild(el('td', { text: r.link_name || '–' }));
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(r.created_at) }));
    body.appendChild(tr);
  }
}

// ---- ステップ配信 ----
function fmtDelay(min) {
  if (!min) return '即時';
  if (min % 1440 === 0) return (min / 1440) + '日後';
  if (min % 60 === 0) return (min / 60) + '時間後';
  return min + '分後';
}

async function loadCamps() {
  const rows = await api('/steps');
  const body = document.getElementById('camps-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだシナリオがありません' })])); return; }
  for (const c of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: c.name }));
    tr.appendChild(el('td', { text: c.media ? c.media : '全員' }));
    tr.appendChild(el('td', { class: 'num', text: String(c.steps) }));
    tr.appendChild(el('td', { class: 'num', text: String(c.active_enrolled) }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [
      el('span', { class: 'dot ' + (c.active ? 'active' : 'none') }),
      el('span', { text: c.active ? '有効' : '停止' }),
    ])]));
    const actions = el('td');
    const edit = el('button', { class: 'ghost', type: 'button', text: '編集' });
    edit.addEventListener('click', () => openEditor(c.id));
    const tog = el('button', { class: 'ghost', type: 'button', text: c.active ? '停止' : '有効化' });
    tog.style.marginLeft = '6px';
    tog.addEventListener('click', async () => { await api('/steps/' + c.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) }); loadCamps(); });
    const del = el('button', { class: 'del', type: 'button', text: '削除' });
    del.style.marginLeft = '6px';
    del.addEventListener('click', async () => { if (!confirm(`「${c.name}」を削除しますか？`)) return; await api('/steps/' + c.id, { method: 'DELETE' }); document.getElementById('camp-editor').textContent = ''; loadCamps(); });
    actions.appendChild(edit); actions.appendChild(tog); actions.appendChild(del);
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

function stepRow(index, msg) {
  const wrap = el('div', { class: 'panel', style: 'margin:10px 0; padding:14px 16px' });
  const head = el('div', { style: 'display:flex; align-items:center; gap:8px; margin-bottom:8px' });
  head.appendChild(el('strong', { text: (index + 1) + '通目' }));
  head.appendChild(el('span', { class: 'muted', text: index === 0 ? '（友だち追加から）' : '（前のメッセージから）' }));
  const num = el('input', { type: 'number', min: '0', value: String(msg ? unitVal(msg.delay_minutes).n : (index === 0 ? 0 : 1)), style: 'width:80px' });
  num.className = 'step-num';
  const unit = el('select', { class: 'step-unit', style: 'width:90px' });
  for (const [label, v] of [['分', 1], ['時間', 60], ['日', 1440]]) {
    const o = el('option', { value: String(v), text: label });
    if (msg ? unitVal(msg.delay_minutes).u === v : (index === 0 ? v === 1 : v === 1440)) o.setAttribute('selected', 'selected');
    unit.appendChild(o);
  }
  const after = el('span', { class: 'muted', text: '後に送信' });
  head.appendChild(num); head.appendChild(unit); head.appendChild(after);
  const rm = el('button', { class: 'del', type: 'button', text: 'この通を削除' });
  rm.style.marginLeft = 'auto';
  rm.addEventListener('click', () => wrap.remove());
  head.appendChild(rm);
  const ta = el('textarea', { class: 'step-text', rows: '3', style: 'width:100%; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-family:inherit; font-size:14px' });
  ta.value = msg ? msg.text : '';
  ta.placeholder = 'メッセージ本文（例：ご登録ありがとうございます！初回限定クーポンはこちら→ …）';
  wrap.appendChild(head); wrap.appendChild(ta);
  return wrap;
}
function unitVal(min) {
  if (min && min % 1440 === 0) return { n: min / 1440, u: 1440 };
  if (min && min % 60 === 0) return { n: min / 60, u: 60 };
  return { n: min || 0, u: 1 };
}

async function openEditor(id) {
  const c = await api('/steps/' + id);
  const box = document.getElementById('camp-editor');
  box.textContent = '';
  const panel = el('div', { class: 'panel', style: 'border:2px solid var(--ink); margin-top:12px' });
  panel.appendChild(el('h2', { text: 'シナリオ編集：' + c.name }));
  panel.appendChild(el('p', { class: 'hint', text: '対象：' + (c.media || '全員') + '（メッセージの順番と間隔を設定して保存してください）' }));
  const list = el('div');
  (c.messages.length ? c.messages : [null]).forEach((m, i) => list.appendChild(stepRow(i, m)));
  panel.appendChild(list);

  const addBtn = el('button', { class: 'ghost', type: 'button', text: '＋ ステップを追加' });
  addBtn.addEventListener('click', () => list.appendChild(stepRow(list.children.length, null)));
  const saveBtn = el('button', { type: 'button', text: '保存' }); saveBtn.style.marginLeft = '8px';
  const closeBtn = el('button', { class: 'ghost', type: 'button', text: '閉じる' }); closeBtn.style.marginLeft = '8px';
  const msg = el('span', { class: 'msg' }); msg.style.marginLeft = '8px';
  closeBtn.addEventListener('click', () => { box.textContent = ''; });
  saveBtn.addEventListener('click', async () => {
    const steps = [];
    for (const row of list.children) {
      const n = parseInt(row.querySelector('.step-num').value, 10) || 0;
      const u = parseInt(row.querySelector('.step-unit').value, 10) || 1;
      const text = row.querySelector('.step-text').value.trim();
      if (text) steps.push({ delay_minutes: n * u, text });
    }
    msg.className = 'msg'; msg.textContent = '保存中…';
    try { await api('/steps/' + id + '/messages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps }) }); msg.className = 'msg ok'; msg.textContent = '保存しました'; loadCamps(); }
    catch (e) { msg.className = 'msg err'; msg.textContent = '保存に失敗: ' + e.message; }
  });
  const bar = el('div', { style: 'margin-top:8px' }, [addBtn, saveBtn, closeBtn, msg]);
  panel.appendChild(bar);
  box.appendChild(panel);
}

// ---- 友だち管理 ----
async function loadFriends() {
  const params = new URLSearchParams();
  const st = document.getElementById('frd-status').value; if (st) params.set('status', st);
  const md = document.getElementById('frd-media').value.trim(); if (md) params.set('media', md);
  const tg = document.getElementById('frd-tag').value.trim(); if (tg) params.set('tag', tg);
  const data = await api('/friends' + (params.toString() ? '?' + params : ''));
  const c = data.counts;
  document.getElementById('friends-counts').textContent =
    `友だち合計 ${fmtInt(c.total)}　/　有効 ${fmtInt(c.active)}　/　ブロック ${fmtInt(c.blocked)}　/　広告経由 ${fmtInt(c.attributed)}`;
  const body = document.getElementById('friends-body');
  body.textContent = '';
  if (!data.friends.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: '該当なし' })])); return; }
  const stLabel = { active: '有効', blocked: 'ブロック' };
  for (const f of data.friends) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: f.display_name || '（未取得）' }));
    tr.appendChild(el('td', { class: 'mono', text: f.line_user_id_short || '–' }));
    tr.appendChild(el('td', { text: f.source_media || '–' }));
    tr.appendChild(el('td', { text: f.tags || '–' }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + (f.status === 'active' ? 'active' : 'none') }), el('span', { text: stLabel[f.status] || f.status })])]));
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(f.created_at) }));
    body.appendChild(tr);
  }
}

// ---- 一斉配信 ----
async function loadBcasts() {
  const rows = await api('/broadcasts');
  const body = document.getElementById('bcasts-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだありません' })])); return; }
  const audLabel = { all: '全員', matched: '広告経由', media: '媒体:', tag: 'タグ:' };
  const stLabel = { draft: '下書き', scheduled: '予約', sending: '送信中', sent: '送信済', failed: '失敗' };
  for (const b of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, [el('div', { text: (b.text || '').slice(0, 30) + ((b.text || '').length > 30 ? '…' : '') })]));
    tr.appendChild(el('td', { text: (audLabel[b.audience_type] || b.audience_type) + (b.audience_value || '') }));
    tr.appendChild(el('td', { text: stLabel[b.status] || b.status }));
    tr.appendChild(el('td', { class: 'num', text: b.status === 'sent' || b.status === 'failed' ? `${fmtInt(b.sent_count)}` : '–' }));
    tr.appendChild(el('td', { class: 'mono', text: b.status === 'scheduled' ? fmtDate(b.scheduled_at) : (b.status === 'sent' ? fmtDate(b.updated_at) : '–') }));
    const td = el('td');
    if (b.status === 'draft' || b.status === 'scheduled') {
      const send = el('button', { class: 'ghost', type: 'button', text: b.status === 'scheduled' ? '今すぐ送信' : '送信' });
      send.addEventListener('click', async () => { if (!confirm('送信しますか？')) return; await api('/broadcasts/' + b.id + '/send', { method: 'POST' }); loadBcasts(); });
      const del = el('button', { class: 'del', type: 'button', text: '削除' }); del.style.marginLeft = '6px';
      del.addEventListener('click', async () => { if (!confirm('削除しますか？')) return; await api('/broadcasts/' + b.id, { method: 'DELETE' }); loadBcasts(); });
      td.appendChild(send); td.appendChild(del);
    }
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

// ---- 自動応答 ----
async function loadArps() {
  const rows = await api('/autoreplies');
  const body = document.getElementById('arps-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'まだありません' })])); return; }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: r.keyword }));
    tr.appendChild(el('td', { text: r.match_type === 'exact' ? '完全一致' : '含む' }));
    tr.appendChild(el('td', { text: (r.reply_text || '').slice(0, 30) + ((r.reply_text || '').length > 30 ? '…' : '') }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + (r.active ? 'active' : 'none') }), el('span', { text: r.active ? '有効' : '停止' })])]));
    const td = el('td');
    const tog = el('button', { class: 'ghost', type: 'button', text: r.active ? '停止' : '有効化' });
    tog.addEventListener('click', async () => { await api('/autoreplies/' + r.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !r.active }) }); loadArps(); });
    const del = el('button', { class: 'del', type: 'button', text: '削除' }); del.style.marginLeft = '6px';
    del.addEventListener('click', async () => { if (!confirm('削除しますか？')) return; await api('/autoreplies/' + r.id, { method: 'DELETE' }); loadArps(); });
    td.appendChild(tog); td.appendChild(del);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

// ---- リッチメニュー ----
let RM_TEMPLATES = [];
const RM_THEMES = {
  green: { bg: ['#06c755', '#05a648'], text: '#ffffff', border: 'rgba(255,255,255,0.6)' },
  ink: { bg: ['#1f2328', '#2d333b'], text: '#ffffff', border: 'rgba(255,255,255,0.25)' },
  warm: { bg: ['#ff7a59', '#ff9472'], text: '#ffffff', border: 'rgba(255,255,255,0.6)' },
};
function rmTemplate() { return RM_TEMPLATES.find((t) => t.key === document.getElementById('rm-template').value) || RM_TEMPLATES[0]; }

function renderRmCells() {
  const tpl = rmTemplate(); if (!tpl) return;
  const box = document.getElementById('rm-cells'); box.textContent = '';
  tpl.cells.forEach((c, i) => {
    const row = el('div', { class: 'form', style: 'grid-template-columns: 90px 1fr 130px 2fr; margin-bottom:6px; align-items:end' });
    row.appendChild(el('div', { class: 'field' }, [el('label', { text: 'ボタン' + (i + 1) }), el('div', { class: 'muted', text: '' })]));
    const lab = el('input', { class: 'rm-label', placeholder: '文言（例: ご予約）' });
    row.appendChild(el('div', { class: 'field' }, [el('label', { text: '表示文言' }), lab]));
    const typ = el('select', { class: 'rm-type' });
    typ.appendChild(el('option', { value: 'uri', text: 'リンク' }));
    typ.appendChild(el('option', { value: 'message', text: 'メッセージ送信' }));
    row.appendChild(el('div', { class: 'field' }, [el('label', { text: '動作' }), typ]));
    const val = el('input', { class: 'rm-value', placeholder: 'URL もしくは 送信テキスト（空=ボタン無効）' });
    row.appendChild(el('div', { class: 'field' }, [el('label', { text: 'リンク/テキスト' }), val]));
    lab.addEventListener('input', renderRmCanvas);
    box.appendChild(row);
  });
}
function collectRmCells() {
  const rows = document.getElementById('rm-cells').children;
  return Array.from(rows).map((r) => ({
    label: r.querySelector('.rm-label').value.trim(),
    action_type: r.querySelector('.rm-type').value,
    action_value: r.querySelector('.rm-value').value.trim(),
  }));
}
function renderRmCanvas() {
  const tpl = rmTemplate(); if (!tpl) return;
  const canvas = document.getElementById('rm-canvas');
  canvas.width = tpl.size.width; canvas.height = tpl.size.height;
  const ctx = canvas.getContext('2d');
  const theme = RM_THEMES[document.getElementById('rm-theme').value] || RM_THEMES.green;
  const cells = collectRmCells();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  tpl.cells.forEach((c, i) => {
    ctx.fillStyle = theme.bg[i % 2];
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = theme.border; ctx.lineWidth = 6;
    ctx.strokeRect(c.x + 3, c.y + 3, c.w - 6, c.h - 6);
    const label = (cells[i] && cells[i].label) || '';
    if (label) {
      ctx.fillStyle = theme.text;
      const fs = Math.floor(Math.min(c.h * 0.3, c.w * 0.16, 110));
      ctx.font = 'bold ' + fs + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.9);
    }
  });
}
// プリセットのリッチメニュー構成をビルダーに反映
function applyRmPreset(cfg) {
  if (!cfg) return;
  const sel = document.getElementById('rm-template');
  sel.value = cfg.template; if (sel.value !== cfg.template && RM_TEMPLATES[0]) sel.value = RM_TEMPLATES[0].key;
  document.getElementById('rm-theme').value = cfg.theme || 'green';
  document.querySelector('#rm-form [name=chat_bar_text]').value = cfg.chat_bar_text || 'メニュー';
  renderRmCells();
  const rows = document.getElementById('rm-cells').children;
  (cfg.cells || []).forEach((c, i) => {
    if (!rows[i]) return;
    rows[i].querySelector('.rm-label').value = c.label || '';
    rows[i].querySelector('.rm-type').value = c.action_type || 'uri';
    rows[i].querySelector('.rm-value').value = c.action_value || '';
  });
  renderRmCanvas();
  document.getElementById('rm-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadRmTemplates() {
  RM_TEMPLATES = await api('/richmenu/templates');
  const sel = document.getElementById('rm-template'); sel.textContent = '';
  for (const t of RM_TEMPLATES) sel.appendChild(el('option', { value: t.key, text: t.name }));
  sel.addEventListener('change', () => { renderRmCells(); renderRmCanvas(); });
  document.getElementById('rm-theme').addEventListener('change', renderRmCanvas);
  renderRmCells(); renderRmCanvas();
}
async function loadRms() {
  const rows = await api('/richmenus');
  const body = document.getElementById('rms-body'); body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'まだありません' })])); return; }
  for (const m of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: m.name || '–' }));
    tr.appendChild(el('td', { text: m.template || '–' }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + (m.status === 'active' ? 'active' : 'none') }), el('span', { text: m.status === 'active' ? '表示中' : '停止中' })])]));
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(m.created_at) }));
    const td = el('td');
    if (m.status !== 'active') {
      const act = el('button', { class: 'ghost', type: 'button', text: '表示する' });
      act.addEventListener('click', async () => { await api('/richmenus/' + m.id + '/activate', { method: 'POST' }); loadRms(); });
      td.appendChild(act);
    }
    const del = el('button', { class: 'del', type: 'button', text: '削除' }); del.style.marginLeft = '6px';
    del.addEventListener('click', async () => { if (!confirm('削除しますか？')) return; await api('/richmenus/' + m.id, { method: 'DELETE' }); loadRms(); });
    td.appendChild(del);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

async function refresh() {
  try { await Promise.all([loadStats(), loadLinks(), loadFollows(), loadCamps(), loadFriends(), loadBcasts(), loadArps(), loadRms()]); } catch (e) { console.error(e); }
}

document.getElementById('settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('settings-msg');
  const payload = { line_oa_add_url: f.line_oa_add_url.value.trim(), meta_pixel_id: f.meta_pixel_id.value.trim(), tiktok_pixel_id: f.tiktok_pixel_id.value.trim() };
  // 秘密情報は入力があったときだけ送る（空なら現状維持）
  for (const k of ['line_channel_secret', 'line_channel_access_token', 'meta_capi_token', 'tiktok_access_token']) {
    if (f[k].value.trim()) payload[k] = f[k].value.trim();
  }
  msg.className = 'msg'; msg.textContent = '保存中…';
  try { await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); msg.className = 'msg ok'; msg.textContent = '保存しました'; f.line_channel_secret.value = ''; f.line_channel_access_token.value = ''; f.meta_capi_token.value = ''; f.tiktok_access_token.value = ''; loadSettings(); }
  catch (e) { msg.className = 'msg err'; msg.textContent = '保存に失敗: ' + e.message; }
});

document.getElementById('link-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('link-msg');
  try {
    const r = await api('/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.value.trim(), oa_add_url: f.oa_add_url.value.trim(), media: f.media.value.trim(), campaign: f.campaign.value.trim() }) });
    msg.className = 'msg ok'; msg.textContent = '作成しました: ' + r.track_url; f.reset(); refresh();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + e.message; }
});

document.getElementById('camp-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('camp-msg');
  try {
    const c = await api('/steps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.value.trim(), media: f.media.value.trim(), active: true }) });
    msg.className = 'msg ok'; msg.textContent = 'シナリオを作成しました。メッセージを設定してください。';
    f.reset(); await loadCamps(); openEditor(c.id);
  } catch (e) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + e.message; }
});

document.getElementById('frd-filter').addEventListener('click', loadFriends);

document.getElementById('bcast-count').addEventListener('click', async () => {
  const f = document.getElementById('bcast-form'), msg = document.getElementById('bcast-msg');
  const p = new URLSearchParams({ type: f.audience_type.value, value: f.audience_value.value.trim() });
  try { const r = await api('/audience?' + p); msg.className = 'msg'; msg.textContent = `対象件数: ${r.count} 人`; }
  catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});

document.getElementById('bcast-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('bcast-msg');
  const payload = { text: f.text.value.trim(), audience_type: f.audience_type.value, audience_value: f.audience_value.value.trim() };
  if (f.scheduled_at.value) payload.scheduled_at = new Date(f.scheduled_at.value).getTime();
  msg.className = 'msg'; msg.textContent = '処理中…';
  try {
    const b = await api('/broadcasts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (b.status === 'scheduled') { msg.className = 'msg ok'; msg.textContent = '予約しました（指定日時に自動配信）'; }
    else { const r = await api('/broadcasts/' + b.id + '/send', { method: 'POST' }); msg.className = 'msg ok'; msg.textContent = `送信しました（${r.sent}人 / 失敗${r.fail}）`; }
    f.reset(); loadBcasts();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e.message; }
});

document.getElementById('arp-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('arp-msg');
  try {
    await api('/autoreplies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: f.keyword.value.trim(), match_type: f.match_type.value, reply_text: f.reply_text.value.trim() }) });
    msg.className = 'msg ok'; msg.textContent = '追加しました'; f.reset(); loadArps();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e.message; }
});

// ---- 業種別プリセット ----
let PRESETS = [];
function currentPreset() { return PRESETS.find((p) => p.key === document.getElementById('preset-industry').value); }
function renderPresetDesc() {
  const p = currentPreset(); const box = document.getElementById('preset-desc');
  if (!p) { box.textContent = ''; return; }
  box.textContent = `${p.description}（ステップ配信「${p.stepCampaign.name}」${p.stepCampaign.messages.length}通／自動応答${p.autoreplies.length}件／リッチメニュー${p.richMenu.cells.length}ボタン）`;
}
async function loadPresets() {
  PRESETS = await api('/presets');
  const sel = document.getElementById('preset-industry'); sel.textContent = '';
  for (const p of PRESETS) sel.appendChild(el('option', { value: p.key, text: p.name }));
  sel.addEventListener('change', renderPresetDesc);
  renderPresetDesc();
}
document.getElementById('preset-apply').addEventListener('click', async () => {
  const p = currentPreset(); const msg = document.getElementById('preset-msg');
  if (!p) return;
  if (!confirm(`「${p.name}」のステップ配信と自動応答を作成します。よろしいですか？`)) return;
  msg.className = 'msg'; msg.textContent = '適用中…';
  try {
    const r = await api('/presets/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ industry: p.key }) });
    msg.className = 'msg ok'; msg.textContent = `適用しました（自動応答${r.autoreplies}件・ステップ配信1件）。下の各セクションで編集できます。`;
    loadCamps(); loadArps();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e.message; }
});
document.getElementById('preset-rm').addEventListener('click', () => {
  const p = currentPreset(); if (!p) return;
  applyRmPreset(p.richMenu);
  const msg = document.getElementById('preset-msg');
  msg.className = 'msg ok'; msg.textContent = 'リッチメニュー欄に反映しました。内容を確認して「作成してLINEに反映」を押してください。';
});

document.getElementById('rm-create').addEventListener('click', async () => {
  const f = document.getElementById('rm-form'), msg = document.getElementById('rm-msg');
  const cells = collectRmCells();
  if (!cells.some((c) => c.action_value)) { msg.className = 'msg err'; msg.textContent = 'ボタンを1つ以上設定してください'; return; }
  renderRmCanvas();
  const dataUrl = document.getElementById('rm-canvas').toDataURL('image/png');
  msg.className = 'msg'; msg.textContent = 'LINEに反映中…';
  try {
    await api('/richmenus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: f.name.value.trim(), chat_bar_text: f.chat_bar_text.value.trim(), template: document.getElementById('rm-template').value, cells, image_base64: dataUrl,
    }) });
    msg.className = 'msg ok'; msg.textContent = '作成しLINEに反映しました'; loadRms();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e.message; }
});

document.getElementById('logout').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login'; });

(async function init() {
  try { await loadMe(); } catch { return; }
  await Promise.all([loadBilling(), loadSettings(), loadRmTemplates(), loadPresets(), refresh()]);
})();
