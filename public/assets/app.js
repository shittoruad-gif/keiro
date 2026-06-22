'use strict';

async function api(path, opts) {
  const res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin' }, opts));
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || ('API ' + path + ' ' + res.status)); }
  return res.status === 204 ? null : res.json();
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

async function refresh() {
  try { await Promise.all([loadStats(), loadLinks(), loadFollows()]); } catch (e) { console.error(e); }
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

document.getElementById('logout').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login'; });

(async function init() {
  try { await loadMe(); } catch { return; }
  await Promise.all([loadBilling(), loadSettings(), refresh()]);
})();
