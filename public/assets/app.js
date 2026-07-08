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
  document.getElementById('set-ls').textContent = s.line_channel_secret_set ? '設定済み' : '';
  document.getElementById('set-lat').textContent = s.line_channel_access_token_set ? '設定済み' : '';
  document.getElementById('set-mt').textContent = s.meta_capi_token_set ? '設定済み' : '';
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
    tr.appendChild(el('td', { text: c.audience_tag ? ('🏷 ' + c.audience_tag) : (c.media ? c.media : '全員') }));
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
  if (!data.friends.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '8', text: '該当なし' })])); return; }
  const stLabel = { active: '有効', blocked: 'ブロック' };
  for (const f of data.friends) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: f.display_name || '（未取得）' }));
    tr.appendChild(el('td', { class: 'mono', text: f.line_user_id_short || '–' }));
    tr.appendChild(el('td', { text: f.source_media || '–' }));
    tr.appendChild(el('td', { text: f.tags || '–' }));
    // 誕生日（クリックで編集）
    const bdCell = el('td');
    const bdBtn = el('button', { class: 'ghost', type: 'button', text: f.birthday || '未設定', style: 'font-size:12px' });
    bdBtn.addEventListener('click', () => {
      const val = prompt('誕生日をMM-DD形式で入力（例: 03-15）。空欄で削除:', f.birthday || '');
      if (val === null) return;
      const bd = val.trim() || null;
      api('/friends/' + f.id + '/birthday', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ birthday: bd }) })
        .then(() => loadFriends()).catch((e) => alert('エラー: ' + e.message));
    });
    bdCell.appendChild(bdBtn);
    tr.appendChild(bdCell);
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + (f.status === 'active' ? 'active' : 'none') }), el('span', { text: stLabel[f.status] || f.status })])]));
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(f.created_at) }));
    // 操作ボタン
    const actTd = el('td');
    const msgBtn = el('button', { class: 'ghost', type: 'button', text: '送信', style: 'font-size:12px' });
    msgBtn.addEventListener('click', () => openChatModal(f));
    const stampBtn = el('button', { class: 'ghost', type: 'button', text: 'スタンプ', style: 'font-size:12px;margin-left:4px' });
    stampBtn.addEventListener('click', () => openStampModal(f));
    actTd.appendChild(msgBtn); actTd.appendChild(stampBtn);
    tr.appendChild(actTd);
    body.appendChild(tr);
  }
}

// ---- LINE配信数（無料枠の残数表示） ----
async function loadLineQuota() {
  const p = document.getElementById('line-quota');
  if (!p) return;
  try {
    const q = await api('/line/quota');
    if (!q.available) { p.textContent = ''; return; }
    if (q.limit == null) {
      p.textContent = `📊 今月の配信数: ${fmtInt(q.used)}通（従量プラン）`;
    } else {
      p.textContent = `📊 今月の配信数: ${fmtInt(q.used)} / ${fmtInt(q.limit)}通（残り${fmtInt(q.remaining)}通）`;
      if (q.remaining <= Math.ceil(q.limit * 0.1)) {
        p.style.color = '#c0392b';
        p.textContent += ' ⚠️ 無料枠の上限が近づいています';
      }
    }
  } catch { p.textContent = ''; }
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
  try { await Promise.all([loadStats(), loadLinks(), loadFollows(), loadCamps(), loadFriends(), loadBcasts(), loadArps(), loadRms(), loadLineQuota()]); } catch (e) { console.error(e); }
}

document.getElementById('settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('settings-msg');
  const payload = { line_oa_add_url: f.line_oa_add_url.value.trim(), meta_pixel_id: f.meta_pixel_id.value.trim()};
  // 秘密情報は入力があったときだけ送る（空なら現状維持）
  for (const k of ['line_channel_secret', 'line_channel_access_token', 'meta_capi_token']) {
    if (f[k].value.trim()) payload[k] = f[k].value.trim();
  }
  msg.className = 'msg'; msg.textContent = '保存中…';
  try { await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); msg.className = 'msg ok'; msg.textContent = '保存しました'; f.line_channel_secret.value = ''; f.line_channel_access_token.value = ''; f.meta_capi_token.value = ''; loadSettings(); }
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
    const c = await api('/steps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.value.trim(), media: f.media.value.trim(), audience_tag: (f.audience_tag && f.audience_tag.value.trim()) || undefined, active: true }) });
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

// =====================================================================
// KPI分析ダッシュボード
// =====================================================================
const BLOCK_RATE_OK = 0.20; // 20%以下が目標（書籍推奨: 店舗10-20%）

async function loadAnalytics() {
  const days = parseInt(document.getElementById('ana-days').value, 10) || 30;
  try {
    const [sum, trend, sources, bcasts] = await Promise.all([
      api('/analytics/summary'),
      api('/analytics/trend?days=' + days),
      api('/analytics/sources'),
      api('/analytics/broadcasts'),
    ]);

    // サマリーカード
    document.getElementById('ana-total').textContent    = fmtInt(sum.friends.total);
    document.getElementById('ana-active').textContent   = fmtInt(sum.friends.active);
    const br = sum.friends.block_rate;
    const brEl = document.getElementById('ana-blockrate');
    brEl.textContent = fmtPct(br);
    brEl.style.color = br > BLOCK_RATE_OK ? 'var(--warn, #d0021b)' : 'var(--ok, #3b8c3b)';
    const noteEl = document.getElementById('ana-blockrate-note');
    noteEl.textContent = br > BLOCK_RATE_OK ? '目安20%超：配信内容を見直しましょう' : '目安範囲内（〜20%）';
    noteEl.style.color = br > BLOCK_RATE_OK ? 'var(--warn, #d0021b)' : '#666';
    document.getElementById('ana-conv').textContent     = fmtInt(sum.conversions);
    document.getElementById('ana-bcast').textContent    = fmtInt(sum.broadcasts.sent);
    document.getElementById('ana-step').textContent     = fmtInt(sum.step_sends);

    // 友だち推移グラフ（Canvas棒グラフ）
    renderTrendChart(trend);

    // 媒体別流入
    const sb = document.getElementById('ana-sources');
    if (!sources.length) { sb.innerHTML = '<tr><td colspan="4" class="empty">データなし</td></tr>'; }
    else {
      sb.innerHTML = '';
      for (const s of sources) {
        const br2 = s.friends > 0 ? s.blocked / s.friends : 0;
        const tr = sb.insertRow();
        tr.insertCell().textContent = s.media;
        tr.insertCell().className = 'num'; tr.cells[1].textContent = fmtInt(s.friends);
        tr.insertCell().className = 'num'; tr.cells[2].textContent = fmtInt(s.blocked);
        tr.insertCell().className = 'num'; tr.cells[3].textContent = fmtPct(br2);
        if (br2 > BLOCK_RATE_OK) tr.cells[3].style.color = 'var(--warn, #d0021b)';
      }
    }

    // 配信パフォーマンス
    const bb = document.getElementById('ana-bcasts');
    if (!bcasts.length) { bb.innerHTML = '<tr><td colspan="4" class="empty">まだ送信した配信がありません</td></tr>'; }
    else {
      bb.innerHTML = '';
      const audLabel = { all:'全員', matched:'広告経由', media:'媒体', tag:'タグ' };
      for (const b of bcasts) {
        const tr = bb.insertRow();
        tr.insertCell().textContent = b.name || b.text.slice(0, 20) + (b.text.length > 20 ? '…' : '');
        const aud = (audLabel[b.audience_type] || b.audience_type) + (b.audience_value ? ':' + b.audience_value : '');
        tr.insertCell().textContent = aud;
        tr.insertCell().className = 'num'; tr.cells[2].textContent = fmtInt(b.sent_count);
        tr.insertCell().textContent = fmtDate(b.created_at);
      }
    }
  } catch (e) { console.warn('analytics load error', e); }
}

function renderTrendChart(trend) {
  const canvas = document.getElementById('ana-chart');
  if (!canvas) return;
  const W = canvas.offsetWidth || 600, H = 120;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!trend || !trend.length) {
    ctx.fillStyle = '#999'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('この期間のデータがありません', W / 2, H / 2); return;
  }
  const maxVal = Math.max(...trend.map((d) => d.added), 1);
  const barW = Math.max(2, Math.floor((W - 40) / trend.length) - 2);
  const pad = { left: 30, right: 10, top: 10, bottom: 24 };
  const chartH = H - pad.top - pad.bottom;
  const chartW = W - pad.left - pad.right;

  // Y軸ラベル
  ctx.fillStyle = '#888'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  ctx.fillText(maxVal, pad.left - 4, pad.top + 8);
  ctx.fillText('0', pad.left - 4, H - pad.bottom);

  // バー
  trend.forEach((d, i) => {
    const x = pad.left + Math.floor(i * chartW / trend.length);
    const barH = maxVal > 0 ? Math.max(1, Math.floor(d.added / maxVal * chartH)) : 0;
    ctx.fillStyle = '#3b8c3b';
    ctx.fillRect(x, H - pad.bottom - barH, barW, barH);
  });

  // X軸ラベル（最初と最後）
  ctx.fillStyle = '#888'; ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
  if (trend.length > 0) ctx.fillText(trend[0].day.slice(5), pad.left, H - 4);
  if (trend.length > 1) {
    ctx.textAlign = 'right';
    ctx.fillText(trend[trend.length - 1].day.slice(5), W - pad.right, H - 4);
  }
}

document.getElementById('ana-days').addEventListener('change', loadAnalytics);
document.getElementById('ana-refresh').addEventListener('click', loadAnalytics);

// =====================================================================
// クーポン
// =====================================================================
async function loadCoupons() {
  const cpns = await api('/coupons');
  const tbody = document.getElementById('cpns-body');
  tbody.innerHTML = '';
  if (!cpns.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">クーポンがありません。上のフォームで作成してください。</td></tr>'; return;
  }
  for (const c of cpns) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = c.title;
    tr.insertCell().textContent = c.discount_text || '–';
    tr.insertCell().textContent = c.expires_at ? new Date(c.expires_at).toLocaleDateString('ja-JP') : '無期限';
    tr.insertCell().className = 'num'; tr.cells[3].textContent = fmtInt(c.sent_count);
    tr.insertCell().className = 'num'; tr.cells[4].textContent = fmtInt(c.used_count);
    const td = tr.insertCell();
    const sendBtn = el('button', { class: 'ghost', type: 'button', text: '配信' });
    sendBtn.style.fontSize = '12px';
    sendBtn.addEventListener('click', async () => {
      if (!confirm(`「${c.title}」を対象の友だちに配信しますか？`)) return;
      sendBtn.textContent = '送信中…'; sendBtn.disabled = true;
      try {
        const r = await api('/coupons/' + c.id + '/send', { method: 'POST' });
        alert(`配信完了（${r.sent}件）`); loadCoupons();
      } catch (e) { alert('エラー: ' + e.message); sendBtn.textContent = '配信'; sendBtn.disabled = false; }
    });
    const delBtn = el('button', { class: 'ghost', type: 'button', text: '削除' });
    delBtn.style.fontSize = '12px'; delBtn.style.marginLeft = '4px';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`「${c.title}」を削除しますか？`)) return;
      await api('/coupons/' + c.id, { method: 'DELETE' }); loadCoupons();
    });
    td.appendChild(sendBtn); td.appendChild(delBtn);
  }
}

document.getElementById('cpn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, msg = document.getElementById('cpn-msg');
  const expiresInput = f.expires_at.value;
  const expiresAt = expiresInput ? new Date(expiresInput + 'T23:59:59').getTime() : null;
  msg.className = 'msg'; msg.textContent = '作成中…';
  try {
    await api('/coupons', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: f.title.value.trim(),
        discount_text: f.discount_text.value.trim() || null,
        description: f.description.value.trim() || null,
        expires_at: expiresAt,
        audience_type: f.audience_type.value,
        audience_value: f.audience_value.value.trim() || null,
      }),
    });
    msg.className = 'msg ok'; msg.textContent = 'クーポンを作成しました';
    f.reset(); loadCoupons();
  } catch (e2) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e2.message; }
});

// =====================================================================
// 1対1メッセージ送信モーダル
// =====================================================================
let chatFriend = null;
function openChatModal(f) {
  chatFriend = f;
  document.getElementById('chat-modal-title').textContent = `${f.display_name || '友だち'} へメッセージを送る`;
  document.getElementById('chat-modal-text').value = '';
  document.getElementById('chat-modal-msg').textContent = '';
  const modal = document.getElementById('chat-modal');
  modal.style.display = 'flex';
  document.getElementById('chat-modal-text').focus();
}
document.getElementById('chat-modal-close').addEventListener('click', () => {
  document.getElementById('chat-modal').style.display = 'none';
});
document.getElementById('chat-modal-send').addEventListener('click', async () => {
  if (!chatFriend) return;
  const text = document.getElementById('chat-modal-text').value.trim();
  const msg = document.getElementById('chat-modal-msg');
  if (!text) { msg.className = 'msg err'; msg.textContent = 'メッセージを入力してください'; return; }
  const btn = document.getElementById('chat-modal-send');
  btn.disabled = true; btn.textContent = '送信中…';
  try {
    await api('/friends/' + chatFriend.id + '/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    msg.className = 'msg ok'; msg.textContent = '送信しました✓';
    setTimeout(() => { document.getElementById('chat-modal').style.display = 'none'; }, 1200);
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = 'エラー: ' + e.message;
  } finally { btn.disabled = false; btn.textContent = '送信'; }
});

// =====================================================================
// スタンプカード付与モーダル
// =====================================================================
let stampFriend = null;
let stampCards = [];
async function openStampModal(f) {
  stampFriend = f;
  document.getElementById('stamp-modal-title').textContent = `${f.display_name || '友だち'} にスタンプを押す`;
  document.getElementById('stamp-modal-info').textContent = '付与するカードを選んでください';
  const list = document.getElementById('stamp-cards-list');
  list.textContent = '';
  if (!stampCards.length) {
    list.appendChild(el('p', { text: 'スタンプカードがまだありません。下の「スタンプカード」セクションで作成してください。' }));
  } else {
    for (const card of stampCards) {
      const btn = el('button', { type: 'button', text: `${card.name}（${card.required_stamps}スタンプで${card.reward_text.slice(0, 20)}…）`, style: 'width:100%;margin-bottom:8px;text-align:left' });
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '押している…';
        try {
          const r = await api('/stamp-cards/' + card.id + '/stamp/' + f.id, { method: 'POST' });
          document.getElementById('stamp-modal-info').textContent = r.completed
            ? `🎉 ${card.required_stamps}スタンプ達成！報酬メッセージを送信しました。`
            : `スタンプ付与完了（${r.stamps}/${r.required}）`;
          setTimeout(() => { document.getElementById('stamp-modal').style.display = 'none'; loadStampCards(); }, 1800);
        } catch (e) {
          document.getElementById('stamp-modal-info').textContent = 'エラー: ' + e.message;
          btn.disabled = false; btn.textContent = `${card.name}`;
        }
      });
      list.appendChild(btn);
    }
  }
  document.getElementById('stamp-modal').style.display = 'flex';
}
document.getElementById('stamp-modal-close').addEventListener('click', () => {
  document.getElementById('stamp-modal').style.display = 'none';
});

// =====================================================================
// 誕生日配信
// =====================================================================
async function loadBirthdayCampaigns() {
  const rows = await api('/birthday-campaigns');
  const body = document.getElementById('bdc-body');
  body.textContent = '';
  if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="empty">まだありません</td></tr>'; return; }
  for (const c of rows) {
    const tr = body.insertRow();
    tr.insertCell().textContent = c.name;
    tr.insertCell().textContent = (c.text || '').slice(0, 30) + ((c.text || '').length > 30 ? '…' : '');
    tr.insertCell().appendChild(el('span', { class: 'status' }, [
      el('span', { class: 'dot ' + (c.active ? 'active' : 'none') }),
      el('span', { text: c.active ? '有効' : '停止' }),
    ]));
    const td = tr.insertCell();
    const tog = el('button', { class: 'ghost', type: 'button', text: c.active ? '停止' : '有効化', style: 'font-size:12px' });
    tog.addEventListener('click', async () => {
      await api('/birthday-campaigns/' + c.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) });
      loadBirthdayCampaigns();
    });
    const del = el('button', { class: 'del', type: 'button', text: '削除', style: 'font-size:12px;margin-left:6px' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${c.name}」を削除しますか？`)) return;
      await api('/birthday-campaigns/' + c.id, { method: 'DELETE' }); loadBirthdayCampaigns();
    });
    td.appendChild(tog); td.appendChild(del);
  }
}

document.getElementById('bdc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, msg = document.getElementById('bdc-msg');
  msg.className = 'msg'; msg.textContent = '作成中…';
  try {
    await api('/birthday-campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name.value.trim(), text: f.text.value.trim() }) });
    msg.className = 'msg ok'; msg.textContent = '作成しました';
    f.reset(); loadBirthdayCampaigns();
  } catch (e2) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e2.message; }
});

// =====================================================================
// スタンプカード
// =====================================================================
async function loadStampCards() {
  stampCards = await api('/stamp-cards');
  const body = document.getElementById('scd-body');
  body.textContent = '';
  if (!stampCards.length) { body.innerHTML = '<tr><td colspan="5" class="empty">まだありません</td></tr>'; return; }
  for (const c of stampCards) {
    const tr = body.insertRow();
    tr.insertCell().textContent = c.name;
    const numTd = tr.insertCell(); numTd.className = 'num'; numTd.textContent = c.required_stamps;
    tr.insertCell().textContent = (c.reward_text || '').slice(0, 30) + ((c.reward_text || '').length > 30 ? '…' : '');
    tr.insertCell().appendChild(el('span', { class: 'status' }, [
      el('span', { class: 'dot ' + (c.active ? 'active' : 'none') }),
      el('span', { text: c.active ? '有効' : '停止' }),
    ]));
    const td = tr.insertCell();
    const recBtn = el('button', { class: 'ghost', type: 'button', text: '記録', style: 'font-size:12px' });
    recBtn.addEventListener('click', async () => {
      const recs = await api('/stamp-cards/' + c.id + '/records');
      if (!recs.length) { alert('まだスタンプ記録がありません'); return; }
      const lines = recs.slice(0, 20).map((r) => `${r.display_name || r.friend_id} — ${r.stamps}/${c.required_stamps}スタンプ（達成${r.completed}回）`);
      alert(lines.join('\n'));
    });
    const tog = el('button', { class: 'ghost', type: 'button', text: c.active ? '停止' : '有効化', style: 'font-size:12px;margin-left:4px' });
    tog.addEventListener('click', async () => {
      await api('/stamp-cards/' + c.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) });
      loadStampCards();
    });
    const del = el('button', { class: 'del', type: 'button', text: '削除', style: 'font-size:12px;margin-left:4px' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${c.name}」とすべての記録を削除しますか？`)) return;
      await api('/stamp-cards/' + c.id, { method: 'DELETE' }); loadStampCards();
    });
    td.appendChild(recBtn); td.appendChild(tog); td.appendChild(del);
  }
}

document.getElementById('scd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, msg = document.getElementById('scd-msg');
  msg.className = 'msg'; msg.textContent = '作成中…';
  try {
    await api('/stamp-cards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: f.name.value.trim(),
        required_stamps: parseInt(f.required_stamps.value, 10) || 10,
        reward_text: f.reward_text.value.trim(),
      }) });
    msg.className = 'msg ok'; msg.textContent = '作成しました';
    f.reset(); loadStampCards();
  } catch (e2) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e2.message; }
});

// ---- 会話ボット（自己申告→タグ→分岐） ----
async function loadBotFlows() {
  const body = document.getElementById('bot-body');
  if (!body) return;
  let rows = [];
  try { rows = await api('/bot-flows'); } catch (e) { body.textContent = ''; body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '4', text: '読み込みに失敗しました' })])); return; }
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '4', text: 'まだフローがありません。「初めて/通院中」フローを作成できます。' })])); return; }
  for (const f of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: f.question_text || '' }));
    const choices = (f.choices || []).map((c) => c.label + (c.tag ? ' → ' + c.tag : '')).join(' ／ ');
    tr.appendChild(el('td', { text: choices || '（選択肢なし）' }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [
      el('span', { class: 'dot ' + (f.active ? 'active' : 'none') }),
      el('span', { text: f.active ? '有効' : '停止' }),
    ])]));
    const actions = el('td');
    const tog = el('button', { class: 'ghost', type: 'button', text: f.active ? '停止' : '有効化' });
    tog.addEventListener('click', async () => { await api('/bot-flows/' + f.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !f.active }) }); loadBotFlows(); });
    const del = el('button', { class: 'del', type: 'button', text: '削除' });
    del.style.marginLeft = '6px';
    del.addEventListener('click', async () => { if (!confirm('このフローを削除しますか？')) return; await api('/bot-flows/' + f.id, { method: 'DELETE' }); loadBotFlows(); });
    actions.appendChild(tog); actions.appendChild(del);
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

(function initBot() {
  const seed = document.getElementById('bot-seed');
  if (!seed) return;
  seed.addEventListener('click', async () => {
    const msg = document.getElementById('bot-msg');
    seed.disabled = true;
    try {
      await api('/bot-flows/seed-seitai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      msg.className = 'msg ok'; msg.textContent = '「初めて/通院中」フローを作成しました。上のステップ配信で対象タグ（新規/既存）を設定すると自動で振り分けられます。';
      await loadBotFlows();
    } catch (e) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + e.message; }
    finally { seed.disabled = false; }
  });
})();

// ---- LINE連携ウィザード（完全セルフのオンボーディング） ----
function wzStepDone(step, done) {
  const el = document.querySelector('#wizard .wz-step[data-step="' + step + '"]');
  if (el) el.classList.toggle('done', !!done);
}
async function loadWizardStatus() {
  const wiz = document.getElementById('wizard');
  if (!wiz) return;
  let s;
  try { s = await api('/line/status'); } catch { return; }
  const wh = document.getElementById('wz-webhook');
  if (wh && s.webhook_url) { wh.textContent = s.webhook_url; wh.onclick = () => navigator.clipboard.writeText(s.webhook_url).catch(() => {}); }
  wzStepDone(2, s.token_valid);
  wzStepDone(3, s.webhook_received);
  const conn = document.getElementById('wz-conn');
  if (conn && s.token_set) {
    if (s.token_valid) { conn.className = 'wz-result ok'; conn.textContent = '✓ 接続できました' + (s.bot_name ? '（' + s.bot_name + '）' : ''); }
    else { conn.className = 'wz-result err'; conn.textContent = '✗ 接続できません：' + (s.error || 'キーをご確認ください'); }
  }
  const whm = document.getElementById('wz-wh');
  if (whm && s.webhook_received && !whm.textContent) { whm.className = 'wz-result ok'; whm.textContent = '✓ Webhookの受信を確認しました'; }
  let setupDone = false;
  try { const flows = await api('/bot-flows'); setupDone = flows.some((f) => f.trigger_type === 'follow'); } catch {}
  wzStepDone(4, setupDone);
  if (setupDone) { const a = document.getElementById('wz-setup-msg'); if (a && !a.textContent) { a.className = 'wz-result ok'; a.textContent = '✓ 初期設定は適用済みです'; } }
  const complete = s.token_valid && s.webhook_received && setupDone;
  const bar = document.getElementById('wizard-done-bar');
  if (bar) bar.style.display = complete ? 'flex' : 'none';
  wiz.style.display = complete ? 'none' : '';
  const ad = document.getElementById('wz-alldone');
  if (ad) ad.style.display = (s.token_valid && s.webhook_received && setupDone) ? 'block' : 'none';
}
(function initWizard() {
  const save = document.getElementById('wz-save');
  if (save) save.addEventListener('click', async () => {
    const conn = document.getElementById('wz-conn');
    const secret = document.getElementById('wz-secret').value.trim();
    const token = document.getElementById('wz-token').value.trim();
    if (!secret && !token) { conn.className = 'wz-result err'; conn.textContent = 'Channel secret とアクセストークンを入力してください。'; return; }
    save.disabled = true; conn.className = 'wz-result'; conn.textContent = '保存して接続を確認しています…';
    const payload = {};
    if (secret) payload.line_channel_secret = secret;
    if (token) payload.line_channel_access_token = token;
    try {
      await api('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      document.getElementById('wz-secret').value = ''; document.getElementById('wz-token').value = '';
      await loadWizardStatus();
      if (typeof loadSettings === 'function') loadSettings();
    } catch (e) { conn.className = 'wz-result err'; conn.textContent = '保存に失敗: ' + e.message; }
    finally { save.disabled = false; }
  });
  const whcheck = document.getElementById('wz-webhook-check');
  if (whcheck) whcheck.addEventListener('click', async () => {
    const whm = document.getElementById('wz-wh'); whm.className = 'wz-result'; whm.textContent = '確認中…';
    await loadWizardStatus();
    const done = document.querySelector('#wizard .wz-step[data-step="3"]').classList.contains('done');
    if (!done) { whm.className = 'wz-result err'; whm.textContent = 'まだ受信が確認できません。LINE側でWebhook URLを保存し「検証」を押してから、もう一度お試しください。'; }
  });
  const setup = document.getElementById('wz-setup');
  if (setup) setup.addEventListener('click', async () => {
    const m = document.getElementById('wz-setup-msg');
    setup.disabled = true; m.className = 'wz-result'; m.textContent = '作成しています…';
    try {
      let presets = []; try { presets = await api('/presets'); } catch {}
      const pick = presets.find((p) => /seitai|整体|整骨|治療|鍼|接骨/.test((p.key || '') + (p.name || ''))) || presets[0];
      if (pick) { try { await api('/presets/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ industry: pick.key }) }); } catch {} }
      await api('/bot-flows/seed-seitai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      m.className = 'wz-result ok'; m.textContent = '✓ 初期設定を作成しました。下の各セクションで編集できます。';
      await loadWizardStatus();
      if (typeof loadCamps === 'function') loadCamps();
      if (typeof loadBotFlows === 'function') loadBotFlows();
    } catch (e) { m.className = 'wz-result err'; m.textContent = '作成に失敗: ' + e.message; }
    finally { setup.disabled = false; }
  });
  const reopen = document.getElementById('wizard-reopen');
  if (reopen) reopen.addEventListener('click', () => {
    document.getElementById('wizard').style.display = '';
    document.getElementById('wizard-done-bar').style.display = 'none';
  });
})();

(async function init() {
  try { await loadMe(); } catch { return; }
  await Promise.all([loadBilling(), loadSettings(), loadRmTemplates(), loadPresets(), loadAnalytics(), loadCoupons(), loadBirthdayCampaigns(), loadStampCards(), loadBotFlows(), loadWizardStatus(), refresh()]);
})();
