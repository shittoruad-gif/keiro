'use strict';

async function api(path, opts) {
  const res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin' }, opts));
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (res.status === 403) {
    const e = await res.json().catch(() => ({}));
    // プラン制限などの403はエラーメッセージとして表示（アカウント停止の403とは区別する）
    if (e && e.error && e.error !== 'suspended') throw new Error(e.error);
    showSuspended(); throw new Error('suspended');
  }
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
let ME = null;

// プラン機能の有無（ME.limits は loadMe でセットされる）
function hasFeature(k) { return !!(ME && ME.limits && ME.limits[k]); }

// ライトプランのとき、プロ限定セクションにバナーを出して操作を無効化する
function applyPlanLocks() {
  if (!ME || !ME.limits || ME.limits.key !== 'light') return;
  const banner = () => el('div', { class: 'banner trial', style: 'margin:8px 0 14px', text: '🔒 プロプラン限定機能です。画面はご覧いただけますが、ご利用にはプロプランへの変更が必要です（変更は運営までご連絡ください）。' });
  const lock = (id) => {
    const s = document.getElementById(id);
    if (!s) return;
    const h = s.querySelector('h2, strong');
    s.insertBefore(banner(), (h && h.parentNode === s) ? h.nextSibling : s.firstChild);
    s.querySelectorAll('input, select, textarea, button').forEach((x) => { x.disabled = true; });
  };
  if (!hasFeature('inbox')) lock('sec-inbox');
  if (!hasFeature('reminders')) lock('sec-reminders');
  if (!hasFeature('forms')) lock('sec-forms');
  if (!hasFeature('roiDashboard')) { lock('sec-turl'); lock('roi-block'); }
  if (!hasFeature('bot')) lock('sec-bot');
  if (!hasFeature('csvExport')) { const b = document.getElementById('frd-csv'); if (b) b.disabled = true; }
  if (!hasFeature('richmenuByTag')) {
    const inp = document.querySelector('#rm-form [name=audience_tag]');
    if (inp) { inp.disabled = true; inp.setAttribute('placeholder', 'プロプラン限定'); }
  }
}

// 画像添付ウィジェット（アップロードしてURLを保持。配信・ステップ配信で使用）
function createImageAttach(initialUrl) {
  const wrap = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' });
  const note = el('span', { class: 'muted', style: 'font-size:12px', text: '画像を付ける（任意・PNG/JPEG・5MBまで）:' });
  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg', style: 'font-size:12px' });
  const prev = el('img', { style: 'height:44px;border:1px solid var(--line);border-radius:6px;display:none' });
  const rm = el('button', { class: 'ghost', type: 'button', text: '画像を外す', style: 'font-size:12px;display:none' });
  let url = initialUrl || '';
  function sync() {
    if (url) { prev.src = url; prev.style.display = ''; rm.style.display = ''; }
    else { prev.removeAttribute('src'); prev.style.display = 'none'; rm.style.display = 'none'; }
  }
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { alert('画像は5MB以下にしてください'); file.value = ''; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await api('/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_base64: reader.result }) });
        url = r.url; sync();
      } catch (e) { alert('画像のアップロードに失敗: ' + e.message); file.value = ''; }
    };
    reader.readAsDataURL(f);
  });
  rm.addEventListener('click', () => { url = ''; file.value = ''; sync(); });
  wrap.appendChild(note); wrap.appendChild(file); wrap.appendChild(prev); wrap.appendChild(rm);
  sync();
  return { el: wrap, getUrl: () => url, clear: () => { url = ''; file.value = ''; sync(); } };
}

async function loadMe() {
  const me = await api('/me');
  ME = me;
  document.getElementById('who').textContent = me.name || me.email;
  loadStores().catch(() => {});
}

// ---- マルチ店舗: ヘッダーの店舗切替（2店舗目以降のアップセル導線を兼ねる） ----
async function loadStores() {
  const sel = document.getElementById('store-switch');
  if (!sel || (ME && ME.role === 'operator')) return;
  const stores = await api('/my-stores');
  sel.textContent = '';
  for (const s of stores) {
    const o = el('option', { value: s.id, text: `🏠 ${s.name || '（名称未設定）'}` });
    if (s.current) o.selected = true;
    sel.appendChild(o);
  }
  sel.appendChild(el('option', { value: '__add', text: '＋ 新しい店舗を追加…' }));
  sel.style.display = '';
  const who = document.getElementById('who');
  if (who) who.style.display = 'none'; // スイッチャに店名が出るため重複表示を隠す
  sel.onchange = async () => {
    if (sel.value === '__add') {
      const name = prompt('新しい店舗の名前を入力してください（例: ◯◯整体院 △△店）\n\n※店舗ごとに別のLINE公式アカウントを接続し、料金プランも店舗ごとの契約になります。');
      if (!name || !name.trim()) { await loadStores(); return; }
      try {
        const r = await api('/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
        await api('/switch-store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_id: r.id }) });
        location.reload();
      } catch (e) { alert(e.message || '店舗を追加できませんでした'); await loadStores(); }
      return;
    }
    if (stores.some((s) => s.id === sel.value && !s.current)) {
      try {
        await api('/switch-store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_id: sel.value }) });
        location.reload();
      } catch (e) { alert(e.message || '切り替えに失敗しました'); await loadStores(); }
    }
  };
}

async function loadBilling() {
  const b = await api('/billing/status');
  BILLING = b;
  const box = document.getElementById('billing-banner');
  box.textContent = '';
  const planName = (b.plan && b.plan.name) ? b.plan.name : 'プロプラン';
  if (b.status === 'active') {
    box.appendChild(el('div', { class: 'banner ok', text: `ご契約中（${planName} ${fmtYen(b.plan.amount)}/月）` }));
  } else if (b.in_trial && b.permanent) {
    box.appendChild(el('div', { class: 'banner ok', text: `✓ 永年無料プラン（${planName}）でご利用中です。お支払い方法のご登録は不要です。` }));
  } else if (b.in_trial) {
    const days = Math.max(0, Math.ceil((b.trial_ends_at - Date.now()) / 86400000));
    if (!b.card_registered) {
      // カード先行登録ステップ（無料期間中は請求されない繰り延べリンク）
      const stepWrap = el('div', { style: 'margin:0 0 10px;padding:16px 18px;border:2px solid #e7a128;border-radius:12px;background:#fff9ee' });
      stepWrap.appendChild(el('div', { style: 'font-weight:800;font-size:15px;color:#8a5a00;margin-bottom:4px', text: '💳 はじめに：お支払い方法をご登録ください（無料期間中は請求されません）' }));
      stepWrap.appendChild(el('div', { style: 'font-size:13px;color:#5d6e69;margin-bottom:10px', text: `無料期間（${fmtDate(b.trial_ends_at)}まで・あと${days}日）の終了後に、${planName} ${fmtYen(b.plan.amount)}/月 の自動課金が始まります。無料期間内に解約すれば費用は一切かかりません。` }));
      const payBtn = el('button', { class: 'btn accent', type: 'button', text: 'カードを登録して無料トライアルを確定する' });
      payBtn.addEventListener('click', () => startSubscribe(b));
      stepWrap.appendChild(payBtn);
      stepWrap.appendChild(el('div', { style: 'font-size:12px;color:#8a958f;margin-top:8px', text: '※ ご登録の際は、このアカウントと同じメールアドレスをご入力ください（契約の自動照合に使用します）' }));
      box.appendChild(stepWrap);
    } else {
      box.appendChild(el('div', { class: 'banner trial', text: `✓ お支払い方法 登録済み｜無料トライアル中（${planName}）：あと${days}日（${fmtDate(b.trial_ends_at)}まで）。満了後に自動で継続されます。` }));
    }
  } else {
    const wrap = el('div', { class: 'banner warn' }, [
      el('span', { text: 'トライアル終了、または未契約のため計測が停止しています。お申し込みで再開します。' }),
    ]);
    wrap.appendChild(subscribeButton(b));
    box.appendChild(wrap);
  }
  // パスコード導線: プロプランを30日間無料で開始（未適用のときだけ促す）
  if (!b.code_redeemed) box.appendChild(redeemBox());
}

function redeemBox() {
  const input = el('input', { type: 'text', placeholder: 'パスコード（例: KEIRO-XXXX-XXXX）',
    style: 'flex:1;min-width:200px;padding:9px 11px;border:1px solid #cfe0da;border-radius:8px;font-size:14px' });
  const btn = el('button', { class: 'btn accent', type: 'button', text: 'プロプランを30日間無料で始める' });
  const msg = el('div', { style: 'margin-top:8px;font-size:13px' });
  btn.addEventListener('click', async () => {
    const code = input.value.trim();
    if (!code) { msg.textContent = 'パスコードを入力してください。'; msg.style.color = '#b3402c'; return; }
    btn.disabled = true; msg.textContent = '確認中…'; msg.style.color = '#6b7785';
    try {
      const r = await api('/redeem-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      msg.textContent = `適用しました。${r.plan_name}を${fmtDate(r.trial_ends_at)}まで無料でご利用いただけます。`;
      msg.style.color = '#0f7a6b';
      await loadBilling();
    } catch (e) {
      msg.textContent = (e && e.message) ? e.message : 'パスコードを適用できませんでした。';
      msg.style.color = '#b3402c'; btn.disabled = false;
    }
  });
  return el('div', { style: 'margin:10px 0;padding:14px 16px;border:1px solid #0f7a6b;border-radius:12px;background:#f2faf8' }, [
    el('div', { style: 'font-weight:800;color:#0b5a4f;margin-bottom:4px', text: '🎁 公式LINE制作をお申し込みの方へ' }),
    el('div', { style: 'font-size:13px;color:#42505e;margin-bottom:10px', text: 'お渡ししたパスコードを入力すると、プロプラン（月9,800円・税込）を30日間無料で開始できます。無料期間内はいつでも無償で解除できます。' }),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [input, btn]),
    msg,
  ]);
}

function subscribeButton(b) {
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:4px' });
  const btn = el('button', { class: 'btn accent', type: 'button', text: `申し込む（${fmtYen(b.plan.amount)}/月）` });
  btn.addEventListener('click', () => startSubscribe(b));
  wrap.appendChild(btn);
  if (b.univapay && b.univapay.checkout_enabled) {
    const email = ME && ME.email;
    wrap.appendChild(el('div', {
      style: 'font-size:12px;color:#6b7785',
      text: email ? `お手続きの際は、このアプリの登録メールアドレス（${email}）を決済画面でも入力してください。` : 'お手続きの際は、このアプリの登録メールアドレスを決済画面でも入力してください。',
    }));
  }
  return wrap;
}

function startSubscribe(b) {
  if (!b.univapay || !b.univapay.checkout_enabled || !b.univapay.link_url) {
    alert('決済の準備中です。運営にお問い合わせください。');
    return;
  }
  window.open(b.univapay.link_url, '_blank', 'noopener');
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
  const bh = document.getElementById('booking-hook-url');
  if (bh && s.booking_hook_url) {
    bh.value = s.booking_hook_url;
    const bc = document.getElementById('booking-hook-copy');
    if (bc) bc.onclick = () => { navigator.clipboard.writeText(s.booking_hook_url).catch(() => {}); bc.textContent = 'コピーしました'; setTimeout(() => { bc.textContent = 'コピー'; }, 1500); };
  }
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
    const qr = el('button', { class: 'ghost', type: 'button', text: 'QR' });
    qr.addEventListener('click', () => openQrModal(r));
    const poster = el('button', { class: 'ghost', type: 'button', text: 'ポスター', title: 'A4印刷用の店頭ポスターを作成' });
    poster.addEventListener('click', () => window.open('/poster?link=' + encodeURIComponent(r.id), '_blank'));
    const del = el('button', { class: 'del', type: 'button', text: '削除' });
    del.addEventListener('click', async () => { if (!confirm(`「${r.name}」を削除しますか？`)) return; await api('/links/' + encodeURIComponent(r.id), { method: 'DELETE' }); refresh(); });
    tr.appendChild(el('td', null, [qr, el('span', { text: ' ' }), poster, el('span', { text: ' ' }), del]));
    body.appendChild(tr);
  }
}

// 計測リンクのQRコード表示（その場で発行・保存できる）
function openQrModal(link) {
  const url = '/api/links/' + encodeURIComponent(link.id) + '/qr.png';
  document.getElementById('qr-modal-title').textContent = `「${link.name}」のQRコード`;
  document.getElementById('qr-modal-img').src = url + '?size=520';
  const dl = document.getElementById('qr-modal-dl');
  dl.href = url + '?size=1200';
  dl.setAttribute('download', `QR_${link.name || 'link'}.png`);
  document.getElementById('qr-modal').style.display = 'flex';
}
(function initQrModal() {
  const close = document.getElementById('qr-modal-close');
  if (close) close.addEventListener('click', () => { document.getElementById('qr-modal').style.display = 'none'; });
})();

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
  // 画像添付（任意）
  wrap._img = createImageAttach(msg ? msg.image_url : '');
  const imgRow = el('div', { style: 'margin-top:6px' });
  imgRow.appendChild(wrap._img.el);
  wrap.appendChild(imgRow);
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
  panel.appendChild(el('p', { class: 'hint', text: '※ 本文に {name} と書くと友だちの名前に自動で置き換わります。' }));
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
      if (text) steps.push({ delay_minutes: n * u, text, image_url: (row._img && row._img.getUrl()) || undefined });
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
  // スコア列はプロ限定（ライトでは列ごと非表示）
  const showScore = hasFeature('scoring');
  const scoreTh = document.getElementById('frd-score-th');
  if (scoreTh) scoreTh.style.display = showScore ? '' : 'none';
  const scoreHint = document.getElementById('frd-score-hint');
  if (scoreHint) scoreHint.style.display = showScore ? '' : 'none';
  if (!data.friends.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '9', text: '該当なし' })])); return; }
  const stLabel = { active: '有効', blocked: 'ブロック' };
  for (const f of data.friends) {
    const tr = el('tr');
    // メモがある友だちは名前の横に📝（マウスを乗せると内容を表示）
    const nameTd = el('td', { text: (f.display_name || '（未取得）') + (f.memo ? ' 📝' : '') });
    if (f.memo) nameTd.setAttribute('title', f.memo);
    tr.appendChild(nameTd);
    tr.appendChild(el('td', { class: 'mono', text: f.line_user_id_short || '–' }));
    tr.appendChild(el('td', { text: f.source_media || '–' }));
    tr.appendChild(el('td', { text: f.tags || '–' }));
    if (showScore) tr.appendChild(el('td', { class: 'num', text: fmtInt(f.score || 0) }));
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
    const tagBtn = el('button', { class: 'ghost', type: 'button', text: 'タグ', style: 'font-size:12px;margin-left:4px' });
    tagBtn.addEventListener('click', () => {
      const val = prompt('タグをカンマ区切りで入力（例: 新規,来院済）。空欄ですべて削除:', f.tags || '');
      if (val === null) return;
      api('/friends/' + f.id + '/tags', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: val.trim() }) })
        .then(() => loadFriends()).catch((e) => alert('エラー: ' + e.message));
    });
    const memoBtn = el('button', { class: 'ghost', type: 'button', text: 'メモ', style: 'font-size:12px;margin-left:4px' });
    memoBtn.addEventListener('click', () => {
      const val = prompt('この友だちのメモ（空欄で削除）:', f.memo || '');
      if (val === null) return;
      api('/friends/' + f.id + '/memo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memo: val.trim() || null }) })
        .then(() => loadFriends()).catch((e) => alert('エラー: ' + e.message));
    });
    const remBtn = el('button', { class: 'ghost', type: 'button', text: 'リマインダ', style: 'font-size:12px;margin-left:4px' });
    if (!hasFeature('reminders')) { remBtn.disabled = true; remBtn.setAttribute('title', 'プロプラン限定'); }
    remBtn.addEventListener('click', () => openRemModal(f));
    actTd.appendChild(msgBtn); actTd.appendChild(stampBtn); actTd.appendChild(tagBtn); actTd.appendChild(memoBtn); actTd.appendChild(remBtn);
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
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだありません' })])); return; }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: r.keyword }));
    tr.appendChild(el('td', { text: r.match_type === 'exact' ? '完全一致' : '含む' }));
    tr.appendChild(el('td', { text: r.audience_tag || '全員' }));
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
let RM_BG = null; // AI生成した背景画像（Imageオブジェクト）。文字はCanvasで重ねる

function renderRmCanvas() {
  const tpl = rmTemplate(); if (!tpl) return;
  const canvas = document.getElementById('rm-canvas');
  canvas.width = tpl.size.width; canvas.height = tpl.size.height;
  const ctx = canvas.getContext('2d');
  const theme = RM_THEMES[document.getElementById('rm-theme').value] || RM_THEMES.green;
  const cells = collectRmCells();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (RM_BG) {
    // 背景画像を cover でフィット（はみ出す方向を中央トリミング）
    const sc = Math.max(canvas.width / RM_BG.width, canvas.height / RM_BG.height);
    const dw = RM_BG.width * sc, dh = RM_BG.height * sc;
    ctx.drawImage(RM_BG, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }

  tpl.cells.forEach((c, i) => {
    if (RM_BG) {
      // 背景の上では、文字を読みやすくする薄いスクリム＋白枠
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6;
      ctx.strokeRect(c.x + 3, c.y + 3, c.w - 6, c.h - 6);
    } else {
      ctx.fillStyle = theme.bg[i % 2];
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.strokeStyle = theme.border; ctx.lineWidth = 6;
      ctx.strokeRect(c.x + 3, c.y + 3, c.w - 6, c.h - 6);
    }
    const label = (cells[i] && cells[i].label) || '';
    if (label) {
      const fs = Math.floor(Math.min(c.h * 0.3, c.w * 0.16, 110));
      ctx.font = 'bold ' + fs + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (RM_BG) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4; }
      ctx.fillStyle = RM_BG ? '#ffffff' : theme.text;
      ctx.fillText(label, c.x + c.w / 2, c.y + c.h / 2, c.w * 0.9);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    }
  });
}

// ---- リッチメニュー: AI壁打ち＆背景画像生成 ----
let RM_CHAT = []; // {role:'user'|'model', text}

function rmChatBubble(role, text, menu) {
  const mine = role === 'user';
  const row = el('div', { style: 'display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start') });
  const bubble = el('div', { style: 'max-width:85%;padding:8px 10px;border-radius:10px;font-size:13px;white-space:pre-wrap;background:' + (mine ? '#d7f3dc' : '#fff') + ';border:1px solid ' + (mine ? '#bfe3db' : '#e4e2dc') });
  bubble.appendChild(el('div', { text }));
  if (menu) {
    const summary = (menu.cells || []).filter((c) => c.label).map((c) => c.label).join(' / ');
    bubble.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px', text: `提案: ${menu.template}・${summary}` }));
    const btn = el('button', { type: 'button', class: 'btn accent', style: 'margin-top:6px;font-size:12px;padding:6px 12px', text: 'この案を反映する' });
    btn.addEventListener('click', () => {
      applyRmPreset({
        template: menu.template, theme: menu.theme, chat_bar_text: menu.chat_bar_text,
        cells: (menu.cells || []).map((c) => ({ label: c.label, action_type: c.type, action_value: c.value })),
      });
      if (menu.image_prompt) document.getElementById('rm-bg-prompt').value = menu.image_prompt;
      const m = document.getElementById('rm-chat-msg');
      m.className = 'msg ok'; m.textContent = 'プレビューに反映しました。下の「背景画像をAIで生成」も試せます。';
    });
    bubble.appendChild(btn);
  }
  row.appendChild(bubble);
  return row;
}

function initRmAi() {
  const send = document.getElementById('rm-chat-send');
  if (!send) return;
  const log = document.getElementById('rm-chat-log');
  const input = document.getElementById('rm-chat-input');
  const msg = document.getElementById('rm-chat-msg');

  async function sendChat() {
    const text = input.value.trim();
    if (!text) return;
    RM_CHAT.push({ role: 'user', text });
    log.appendChild(rmChatBubble('user', text));
    log.scrollTop = log.scrollHeight;
    input.value = ''; send.disabled = true;
    msg.className = 'msg'; msg.textContent = 'AIが考えています…';
    try {
      const cur = { template: document.getElementById('rm-template').value, cells: collectRmCells() };
      const r = await api('/richmenu/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: RM_CHAT, current_menu: cur }) });
      RM_CHAT.push({ role: 'model', text: r.reply });
      log.appendChild(rmChatBubble('model', r.reply, r.menu));
      log.scrollTop = log.scrollHeight;
      msg.textContent = '';
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = e.message || 'AIとの通信に失敗しました';
      RM_CHAT.pop();
    } finally { send.disabled = false; }
  }
  send.addEventListener('click', sendChat);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); sendChat(); } });

  // 背景画像生成
  const gen = document.getElementById('rm-bg-gen');
  const clear = document.getElementById('rm-bg-clear');
  const bmsg = document.getElementById('rm-bg-msg');
  gen.addEventListener('click', async () => {
    const prompt = document.getElementById('rm-bg-prompt').value.trim();
    gen.disabled = true; bmsg.className = 'msg'; bmsg.textContent = '背景画像を生成しています…（20秒ほど）';
    try {
      const r = await api('/richmenu/ai-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, template: document.getElementById('rm-template').value }) });
      const img = new Image();
      img.onload = () => {
        RM_BG = img;
        renderRmCanvas();
        clear.style.display = '';
        bmsg.className = 'msg ok'; bmsg.textContent = '背景を反映しました。気に入らなければ、表現を変えてもう一度生成できます。';
      };
      img.src = r.image;
    } catch (e) {
      bmsg.className = 'msg err'; bmsg.textContent = e.message || '生成に失敗しました';
    } finally { gen.disabled = false; }
  });
  clear.addEventListener('click', () => {
    RM_BG = null; renderRmCanvas(); clear.style.display = 'none';
    bmsg.className = 'msg'; bmsg.textContent = '背景を削除しました（配色テーマの塗りに戻ります）。';
  });
}
// プリセットのリッチメニュー構成をビルダーに反映
// ---- AI初期構築（ホームページ/LPから自動生成） ----
let AI_PLAN = null;

let AI_ENABLED = false;
async function loadAiSetup() {
  try {
    const st = await api('/ai-setup/status');
    AI_ENABLED = !!st.enabled;
    if (st.enabled) document.getElementById('sec-aisetup').style.display = '';
    const sug = document.getElementById('inbox-ai-suggest');
    if (sug && st.enabled) sug.style.display = '';
    if (st.enabled) {
      const rmAi = document.getElementById('rm-ai-box');
      if (rmAi) rmAi.style.display = '';
      const rmBg = document.getElementById('rm-bg-box');
      if (rmBg) rmBg.style.display = '';
    }
  } catch { /* 未対応環境では非表示のまま */ }
}

// AI提案を「編集できるフォーム」として描画する。値はDOMから collectAiPlan() で回収。
const AI_DELAY_OPTIONS = [[0, '追加直後'], [1440, '1日後'], [4320, '3日後'], [7200, '5日後'], [10080, '7日後'], [20160, '14日後'], [43200, '30日後']];

function buildAiPlanEditor(plan) {
  const box = el('div');
  const section = (title, hint) => {
    box.appendChild(el('div', { style: 'font-weight:800;margin:12px 0 2px', text: title }));
    if (hint) box.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px', text: hint }));
  };

  // 追加後の自動メッセージ
  section('💬 追加後の自動メッセージ', '文章は自由に書き換えられます。空にしたメッセージは作成されません。');
  const stepsBox = el('div', { id: 'aiedit-steps' });
  (plan.steps || []).forEach((st) => {
    const row = el('div', { class: 'aiedit-step', style: 'display:flex;gap:8px;margin-bottom:6px;align-items:flex-start' });
    const sel = el('select', { class: 'aiedit-delay', style: 'flex:none;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
    for (const [v, t] of AI_DELAY_OPTIONS) sel.appendChild(el('option', { value: String(v), text: t }));
    // 既定オプションに無い値は最も近いものへ
    const nearest = AI_DELAY_OPTIONS.reduce((a, b) => Math.abs(b[0] - st.delay_minutes) < Math.abs(a[0] - st.delay_minutes) ? b : a);
    sel.value = String(nearest[0]);
    const ta = el('textarea', { class: 'aiedit-text', rows: '3', style: 'flex:1;padding:8px 10px;border:1px solid #cfe0da;border-radius:8px;font-family:inherit;font-size:13px' });
    ta.value = st.text || '';
    row.appendChild(sel); row.appendChild(ta);
    stepsBox.appendChild(row);
  });
  box.appendChild(stepsBox);

  // キーワード自動返信
  section('🗨 キーワード自動返信', '「この言葉が届いたら→この返事」。キーワードを空にした行は作成されません。');
  const arpBox = el('div', { id: 'aiedit-arps' });
  (plan.autoreplies || []).forEach((a) => {
    const row = el('div', { class: 'aiedit-arp', style: 'display:flex;gap:8px;margin-bottom:6px;align-items:flex-start' });
    const kw = el('input', { class: 'aiedit-kw', placeholder: 'キーワード', style: 'flex:none;width:110px;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
    kw.value = a.keyword || '';
    const ta = el('textarea', { class: 'aiedit-reply', rows: '2', style: 'flex:1;padding:8px 10px;border:1px solid #cfe0da;border-radius:8px;font-family:inherit;font-size:13px' });
    ta.value = a.reply_text || '';
    row.appendChild(kw); row.appendChild(ta);
    arpBox.appendChild(row);
  });
  box.appendChild(arpBox);

  // メニューボタン構成
  section('📱 メニューボタン構成', 'リッチメニュー作成欄に反映される内容です。文言を空にしたボタンは無効になります。');
  const rmBox = el('div', { id: 'aiedit-rm' });
  ((plan.richmenu || {}).cells || []).forEach((c) => {
    const row = el('div', { class: 'aiedit-cell', style: 'display:flex;gap:8px;margin-bottom:6px' });
    const lab = el('input', { class: 'aiedit-label', placeholder: 'ボタン文言', style: 'flex:none;width:110px;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
    lab.value = c.label || '';
    const typ = el('select', { class: 'aiedit-type', style: 'flex:none;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
    typ.appendChild(el('option', { value: 'uri', text: 'リンク' }));
    typ.appendChild(el('option', { value: 'message', text: 'メッセージ送信' }));
    typ.value = c.type === 'message' ? 'message' : 'uri';
    const val = el('input', { class: 'aiedit-value', placeholder: 'URL または 送信テキスト', style: 'flex:1;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
    val.value = c.value || '';
    row.appendChild(lab); row.appendChild(typ); row.appendChild(val);
    rmBox.appendChild(row);
  });
  box.appendChild(rmBox);

  // 会話ボット
  if (plan.bot && plan.bot.question_text) {
    section('🤖 友だち追加時の質問（自動振り分け）', '選択肢を選んだ友だちに、タグが付いて返信が届きます。');
    const q = el('input', { id: 'aiedit-bot-q', style: 'width:100%;padding:8px;border:1px solid #cfe0da;border-radius:8px;margin-bottom:6px' });
    q.value = plan.bot.question_text;
    box.appendChild(q);
    const botBox = el('div', { id: 'aiedit-bot-choices' });
    (plan.bot.choices || []).forEach((c) => {
      const row = el('div', { class: 'aiedit-choice', style: 'display:flex;gap:8px;margin-bottom:6px' });
      const lab = el('input', { class: 'aiedit-clabel', placeholder: '選択肢', style: 'flex:none;width:130px;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
      lab.value = c.label || '';
      const tag = el('input', { class: 'aiedit-ctag', placeholder: '付けるタグ', style: 'flex:none;width:90px;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
      tag.value = c.tag || '';
      const rep = el('input', { class: 'aiedit-creply', placeholder: '選択後の返信文', style: 'flex:1;padding:8px;border:1px solid #cfe0da;border-radius:8px' });
      rep.value = c.reply_text || '';
      row.appendChild(lab); row.appendChild(tag); row.appendChild(rep);
      botBox.appendChild(row);
    });
    box.appendChild(botBox);
  }
  return box;
}

/** 編集フォームの現在値から plan を組み立て直す。 */
function collectAiPlan(base) {
  const plan = JSON.parse(JSON.stringify(base || {}));
  plan.steps = Array.from(document.querySelectorAll('#aiedit-steps .aiedit-step')).map((r) => ({
    delay_minutes: parseInt(r.querySelector('.aiedit-delay').value, 10) || 0,
    text: r.querySelector('.aiedit-text').value.trim(),
  })).filter((s) => s.text);
  plan.autoreplies = Array.from(document.querySelectorAll('#aiedit-arps .aiedit-arp')).map((r) => ({
    keyword: r.querySelector('.aiedit-kw').value.trim(),
    match_type: 'contains',
    reply_text: r.querySelector('.aiedit-reply').value.trim(),
  })).filter((a) => a.keyword && a.reply_text);
  if (plan.richmenu) {
    plan.richmenu.cells = Array.from(document.querySelectorAll('#aiedit-rm .aiedit-cell')).map((r) => ({
      label: r.querySelector('.aiedit-label').value.trim(),
      type: r.querySelector('.aiedit-type').value,
      value: r.querySelector('.aiedit-value').value.trim(),
    }));
  }
  const q = document.getElementById('aiedit-bot-q');
  if (q && plan.bot) {
    plan.bot.question_text = q.value.trim();
    plan.bot.choices = Array.from(document.querySelectorAll('#aiedit-bot-choices .aiedit-choice')).map((r) => ({
      label: r.querySelector('.aiedit-clabel').value.trim(),
      tag: r.querySelector('.aiedit-ctag').value.trim(),
      reply_text: r.querySelector('.aiedit-creply').value.trim(),
    })).filter((c) => c.label);
  }
  return plan;
}

function initAiSetup() {
  const btn = document.getElementById('ai-analyze');
  if (!btn) return;
  const msg = document.getElementById('ai-msg');
  btn.addEventListener('click', async () => {
    const url = document.getElementById('ai-url').value.trim();
    if (!url) { msg.className = 'msg err'; msg.textContent = 'URLを入力してください。'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = 'AIがページを読み取っています…（30秒ほどかかります）';
    document.getElementById('ai-preview').style.display = 'none';
    try {
      const r = await api('/ai-setup/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, text: (document.getElementById('ai-text') || { value: '' }).value.trim() }) });
      AI_PLAN = r.plan;
      msg.textContent = '';
      document.getElementById('ai-shop').textContent = `🏠 ${r.plan.shop_name || r.site_title || 'お店'}`;
      document.getElementById('ai-summary').textContent = r.plan.summary || '';
      const detail = document.getElementById('ai-detail');
      detail.textContent = '';
      detail.appendChild(buildAiPlanEditor(r.plan));
      document.getElementById('ai-preview').style.display = '';
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = e.message || '解析に失敗しました。';
    } finally { btn.disabled = false; }
  });

  document.getElementById('ai-cancel').addEventListener('click', () => {
    AI_PLAN = null;
    document.getElementById('ai-preview').style.display = 'none';
  });

  document.getElementById('ai-apply').addEventListener('click', async () => {
    if (!AI_PLAN) return;
    const am = document.getElementById('ai-apply-msg');
    am.className = 'msg'; am.textContent = '作成中…';
    try {
      const edited = collectAiPlan(AI_PLAN); // 画面で編集した内容を反映
      const r = await api('/ai-setup/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: edited }) });
      am.className = 'msg ok';
      am.textContent = `作成しました（自動メッセージ${r.created.steps}通・自動返信${r.created.autoreplies}件${r.created.bot ? '・振り分けボット' : ''}${r.created.form ? '・事前アンケート' : ''}）。メニューボタンはリッチメニュー欄に反映済み — 内容を確認して「作成してLINEに反映」を押してください。`;
      // リッチメニュービルダーへ反映（presetsと同じ仕組み）
      if (r.richmenu && r.richmenu.cells && r.richmenu.cells.length) {
        applyRmPreset({
          template: 'full-6', theme: 'green',
          chat_bar_text: r.richmenu.chat_bar_text,
          cells: r.richmenu.cells.map((c) => ({ label: c.label, action_type: c.type === 'message' ? 'message' : 'uri', action_value: c.value })),
        });
      }
      if (typeof loadCamps === 'function') loadCamps();
      if (typeof loadArps === 'function') loadArps();
      if (typeof loadBotFlows === 'function') loadBotFlows();
      if (typeof loadForms === 'function') loadForms();
      if (typeof loadReminders === 'function') loadReminders();
    } catch (e) {
      am.className = 'msg err'; am.textContent = e.message || '作成に失敗しました。';
    }
  });

  // ---- 🪄 おまかせで全部つくる（解析→適用→リッチメニュー画像生成まで一括） ----
  document.getElementById('ai-omakase').addEventListener('click', async () => {
    const url = document.getElementById('ai-url').value.trim();
    const rawText = (document.getElementById('ai-text') || { value: '' }).value.trim();
    const msg = document.getElementById('ai-msg');
    if (!url && rawText.length < 30) {
      msg.className = 'msg err'; msg.textContent = 'ホームページのURLを入れるか、「紹介文を貼り付け」にお店の説明（30文字以上）を書いてください。';
      return;
    }
    const btn = document.getElementById('ai-omakase');
    const step = (t) => { msg.className = 'msg'; msg.textContent = t; };
    btn.disabled = true;
    document.getElementById('ai-preview').style.display = 'none';
    try {
      step('①/④ AIがお店の内容を読み取っています…（30秒ほど）');
      const r = await api('/ai-setup/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, text: rawText }) });

      step('②/④ メッセージ・自動返信・アンケートを作成しています…');
      const ap = await api('/ai-setup/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: r.plan }) });
      if (ap.richmenu && ap.richmenu.cells && ap.richmenu.cells.length) {
        applyRmPreset({
          template: 'full-6', theme: 'green',
          chat_bar_text: ap.richmenu.chat_bar_text,
          cells: ap.richmenu.cells.map((c) => ({ label: c.label, action_type: c.type === 'message' ? 'message' : 'uri', action_value: c.value })),
        });
      }

      step('③/④ メニューの背景画像をAIが描いています…（20秒ほど）');
      let bgOk = false;
      try {
        const promptText = `${r.plan.shop_name || 'お店'}のLINEメニュー背景。${(r.plan.summary || '').slice(0, 120)} 清潔感があり温かい雰囲気`;
        const bgInput = document.getElementById('rm-bg-prompt');
        if (bgInput) bgInput.value = promptText;
        const im = await api('/richmenu/ai-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: promptText, template: 'full-6' }) });
        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => { RM_BG = img; renderRmCanvas(); const c = document.getElementById('rm-bg-clear'); if (c) c.style.display = ''; resolve(); };
          img.onerror = reject;
          img.src = im.image;
        });
        bgOk = true;
      } catch (e) { /* 画像は失敗しても全体は成功扱い（配色テーマの塗りで代替） */ }

      step('④/④ 仕上げ中…');
      if (typeof loadCamps === 'function') loadCamps();
      if (typeof loadArps === 'function') loadArps();
      if (typeof loadBotFlows === 'function') loadBotFlows();
      if (typeof loadForms === 'function') loadForms();
      if (typeof loadReminders === 'function') loadReminders();

      msg.className = 'msg ok';
      msg.innerHTML = `🎉 <b>おまかせ構築が完了しました！</b><br>
        ✅ 追加後の自動メッセージ ${ap.created.steps}通<br>
        ✅ キーワード自動返信 ${ap.created.autoreplies}件<br>
        ${ap.created.bot ? '✅ 友だち追加時の振り分けボット<br>' : ''}
        ${ap.created.form ? '✅ 来店前アンケート（回答フォーム欄）<br>' : ''}
        ✅ 前日リマインドの受け皿（リマインダ欄）<br>
        ${bgOk ? '✅ メニューボタン＋AI背景画像（リッチメニュー欄）<br>' : '✅ メニューボタン構成（リッチメニュー欄・背景は配色テーマ）<br>'}
        <b>残りはあと1つ：</b>リッチメニュー欄で仕上がりを確認して「作成してLINEに反映」を押してください。各内容はそれぞれの欄でいつでも直せます。`;
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = e.message || 'おまかせ構築に失敗しました。もう一度お試しください。';
    } finally { btn.disabled = false; }
  });
}

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
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだありません' })])); return; }
  for (const m of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: m.name || '–' }));
    tr.appendChild(el('td', { text: m.template || '–' }));
    tr.appendChild(el('td', { text: m.audience_tag ? ('🏷 ' + m.audience_tag) : '全員' }));
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
  loadRmTaps().catch(() => {});
}

// ボタン別タップ数（直近30日・表示中メニューのみ）
async function loadRmTaps() {
  const box = document.getElementById('rm-taps');
  const body = document.getElementById('rm-taps-body');
  if (!box || !body) return;
  const menus = await api('/richmenu/taps');
  if (!menus.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  body.textContent = '';
  for (const m of menus) {
    if (menus.length > 1) body.appendChild(el('div', { style: 'font-size:12px;font-weight:700;margin:6px 0 2px', text: m.name || 'メニュー' }));
    const max = Math.max(1, ...m.cells.map((c) => c.taps || 0));
    for (const c of m.cells) {
      const row = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:4px' });
      row.appendChild(el('span', { style: 'width:130px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: `${c.type === 'message' ? '💬' : '🔗'} ${c.label}` }));
      const barWrap = el('div', { style: 'flex:1;height:10px;background:#eef2f0;border-radius:5px;overflow:hidden' });
      barWrap.appendChild(el('div', { style: `width:${c.taps == null ? 0 : Math.round((c.taps / max) * 100)}%;height:100%;background:#0f7a6b` }));
      row.appendChild(barWrap);
      row.appendChild(el('span', { style: 'width:70px;text-align:right;font-size:12px;font-weight:700', text: c.taps == null ? '計測対象外' : `${c.taps}回` }));
      body.appendChild(row);
    }
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

// パスワード変更
document.getElementById('pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('pw-msg');
  if (f.new_password.value !== f.new_password2.value) { msg.className = 'msg err'; msg.textContent = '確認用パスワードが一致しません'; return; }
  msg.className = 'msg'; msg.textContent = '変更中…';
  try {
    await api('/me/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_password: f.current_password.value, new_password: f.new_password.value }) });
    msg.className = 'msg ok'; msg.textContent = 'パスワードを変更しました';
    f.reset();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '変更に失敗: ' + e.message; }
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
document.getElementById('frd-csv').addEventListener('click', () => { location.href = '/api/friends/export.csv'; });

document.getElementById('bcast-count').addEventListener('click', async () => {
  const f = document.getElementById('bcast-form'), msg = document.getElementById('bcast-msg');
  const p = new URLSearchParams({ type: f.audience_type.value, value: f.audience_value.value.trim() });
  try { const r = await api('/audience?' + p); msg.className = 'msg'; msg.textContent = `対象件数: ${r.count} 人`; }
  catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});

// 一斉配信の画像添付（任意）
const BCAST_IMG = createImageAttach('');
document.getElementById('bcast-img').appendChild(BCAST_IMG.el);

document.getElementById('bcast-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('bcast-msg');
  const payload = { text: f.text.value.trim(), audience_type: f.audience_type.value, audience_value: f.audience_value.value.trim() };
  if (f.scheduled_at.value) payload.scheduled_at = new Date(f.scheduled_at.value).getTime();
  if (BCAST_IMG.getUrl()) payload.image_url = BCAST_IMG.getUrl();
  msg.className = 'msg'; msg.textContent = '処理中…';
  try {
    const b = await api('/broadcasts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (b.status === 'scheduled') { msg.className = 'msg ok'; msg.textContent = '予約しました（指定日時に自動配信）'; }
    else { const r = await api('/broadcasts/' + b.id + '/send', { method: 'POST' }); msg.className = 'msg ok'; msg.textContent = `送信しました（${r.sent}人 / 失敗${r.fail}）`; }
    f.reset(); BCAST_IMG.clear(); loadBcasts();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '失敗: ' + e.message; }
});

document.getElementById('arp-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('arp-msg');
  try {
    await api('/autoreplies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: f.keyword.value.trim(), match_type: f.match_type.value, reply_text: f.reply_text.value.trim(), audience_tag: f.audience_tag.value.trim() }) });
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
      audience_tag: f.audience_tag.value.trim() || undefined,
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
  // ROIサマリー・推移はプロ限定（403になり得る）。媒体別流入・配信実績は全プランで表示するため、
  // 呼び出しを分離して、プロ限定部分が403でも他が巻き添えで消えないようにする。
  try {
    const sum = await api('/analytics/summary');
    const trend = await api('/analytics/trend?days=' + days);
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
    renderTrendChart(trend);
  } catch (e) {
    // プロ限定（roiDashboard）でライトプランは403。サマリーカードに案内を出すだけで、下の表は続行。
    for (const id of ['ana-total','ana-active','ana-blockrate','ana-conv','ana-bcast','ana-step']) {
      const elx = document.getElementById(id); if (elx) elx.textContent = '—';
    }
    const noteEl = document.getElementById('ana-blockrate-note');
    if (noteEl) { noteEl.textContent = 'この一覧はプロプランでご利用いただけます'; noteEl.style.color = '#8a958f'; }
    console.warn('analytics summary (pro only)', e && e.message);
  }

  try {
    const [sources, bcasts] = await Promise.all([
      api('/analytics/sources'),
      api('/analytics/broadcasts'),
    ]);
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
    const usesBtn = el('button', { class: 'ghost', type: 'button', text: '利用状況' });
    usesBtn.style.fontSize = '12px'; usesBtn.style.marginLeft = '4px';
    usesBtn.addEventListener('click', () => toggleCouponUses(c, tr));
    const delBtn = el('button', { class: 'ghost', type: 'button', text: '削除' });
    delBtn.style.fontSize = '12px'; delBtn.style.marginLeft = '4px';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`「${c.title}」を削除しますか？`)) return;
      await api('/coupons/' + c.id, { method: 'DELETE' }); loadCoupons();
    });
    td.appendChild(sendBtn); td.appendChild(usesBtn); td.appendChild(delBtn);
  }
}

// クーポンの配信先一覧を開閉し、店頭で使われた人を「使用済み」にできるようにする。
async function toggleCouponUses(c, rowEl) {
  const existing = rowEl.nextSibling;
  if (existing && existing.dataset && existing.dataset.usesFor === c.id) { existing.remove(); return; }
  if (existing && existing.dataset && existing.dataset.usesRow) existing.remove();
  const tr = document.createElement('tr');
  tr.dataset.usesFor = c.id; tr.dataset.usesRow = '1';
  const td = document.createElement('td'); td.colSpan = 6; td.style.background = '#f7fbfa'; td.style.padding = '10px 14px';
  tr.appendChild(td);
  rowEl.after(tr);
  td.textContent = '読み込み中…';
  let uses;
  try { uses = await api('/coupons/' + c.id + '/uses'); }
  catch (e) { td.textContent = '取得に失敗しました: ' + e.message; return; }
  td.textContent = '';
  if (!uses.length) { td.textContent = 'まだ配信していません。'; return; }
  const head = el('div', { style: 'font-weight:700;font-size:13px;margin-bottom:6px', text: `「${c.title}」の配信先（${uses.length}名）— 店頭で使われたら「使用済み」を押してください` });
  td.appendChild(head);
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto' });
  for (const u of uses) {
    const rowd = el('div', { style: 'display:flex;align-items:center;gap:8px;font-size:13px' });
    rowd.appendChild(el('span', { style: 'flex:1', text: (u.name || '（名前未取得）') }));
    if (u.used_at) {
      rowd.appendChild(el('span', { style: 'color:#0f7a6b;font-weight:700', text: '✅ 使用済み ' + fmtDate(u.used_at) }));
    } else {
      const b = el('button', { class: 'ghost', type: 'button', text: '使用済みにする', style: 'font-size:12px' });
      b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = '…';
        try {
          await api('/coupons/' + c.id + '/mark-used', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ use_id: u.id }) });
          // この行だけ「使用済み」表示に差し替え（テーブル全体は作り直さない）
          rowd.removeChild(b);
          rowd.appendChild(el('span', { style: 'color:#0f7a6b;font-weight:700', text: '✅ 使用済み' }));
        } catch (e) { alert('エラー: ' + e.message); b.disabled = false; b.textContent = '使用済みにする'; }
      });
      rowd.appendChild(b);
    }
    list.appendChild(rowd);
  }
  td.appendChild(list);
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

// ---- 会話ボット（ボタン選択・多段分岐・カルーセル：Lステップ相当） ----
let BOT_FLOWS = [], BOT_CAMPS = [], BOT_EDIT = null;

function botTypeLabel(t) { return t === 'buttons' ? 'ボタンカード' : t === 'carousel' ? 'カルーセル' : 'クイックリプライ'; }
function botTrigLabel(f) { return f.trigger_type === 'keyword' ? ('キーワード「' + (f.trigger_keyword || '') + '」') : '友だち追加時'; }

async function loadBotFlows() {
  const body = document.getElementById('bot-body');
  if (!body) return;
  try { [BOT_FLOWS, BOT_CAMPS] = await Promise.all([api('/bot-flows'), api('/steps').catch(() => [])]); }
  catch (e) { body.textContent = ''; body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: '読み込みに失敗しました' })])); return; }
  body.textContent = '';
  if (!BOT_FLOWS.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'まだフローがありません。上のボタンから作成できます。' })])); return; }
  for (const f of BOT_FLOWS) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: f.question_text || f.name || '（無題）' }));
    tr.appendChild(el('td', { text: botTypeLabel(f.message_type) + ' ／ ' + botTrigLabel(f) }));
    tr.appendChild(el('td', { class: 'num', text: String((f.choices || []).length) }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + (f.active ? 'active' : 'none') }), el('span', { text: f.active ? '有効' : '停止' })])]));
    const actions = el('td');
    const ed = el('button', { class: 'ghost', type: 'button', text: '編集' });
    ed.addEventListener('click', () => openFlowEditor(f.id));
    const tog = el('button', { class: 'ghost', type: 'button', text: f.active ? '停止' : '有効化' }); tog.style.marginLeft = '6px';
    tog.addEventListener('click', async () => { await api('/bot-flows/' + f.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !f.active }) }); loadBotFlows(); });
    const del = el('button', { class: 'del', type: 'button', text: '削除' }); del.style.marginLeft = '6px';
    del.addEventListener('click', async () => { if (!confirm('このフローを削除しますか？')) return; await api('/bot-flows/' + f.id, { method: 'DELETE' }); const b = document.getElementById('bot-editor'); if (b) b.textContent = ''; loadBotFlows(); });
    actions.appendChild(ed); actions.appendChild(tog); actions.appendChild(del);
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

async function openFlowEditor(id) {
  const f = await api('/bot-flows/' + id);
  let n = 0;
  const cols = (f.columns || []).map((c) => ({ cid: 'c' + (n++), title: c.title || '', text: c.text || '', image_url: c.image_url || '' }));
  const sidToCid = {}; (f.columns || []).forEach((c, i) => { sidToCid[c.id] = cols[i].cid; });
  BOT_EDIT = {
    id: f.id, name: f.name || '', trigger_type: f.trigger_type || 'follow', trigger_keyword: f.trigger_keyword || '',
    message_type: f.message_type || 'quick', question_text: f.question_text || '', image_url: f.image_url || '', alt_text: f.alt_text || '',
    columns: cols,
    choices: (f.choices || []).map((c) => ({ label: c.label || '', action_type: c.action_type || 'postback', tag: c.tag || '', campaign_id: c.campaign_id || '', reply_text: c.reply_text || '', uri: c.uri || '', next_flow_id: c.next_flow_id || '', cid: sidToCid[c.column_id] || '' })),
  };
  renderBotEditor();
}

function botInput(label, val, on, opt) {
  opt = opt || {};
  const wrap = el('div', { class: 'field' });
  if (label) wrap.appendChild(el('label', { text: label }));
  const inp = opt.textarea ? el('textarea', {}) : el('input', { type: 'text' });
  inp.value = val || ''; if (opt.placeholder) inp.setAttribute('placeholder', opt.placeholder);
  if (opt.width) inp.style.width = opt.width;
  inp.addEventListener('input', () => on(inp.value));
  wrap.appendChild(inp); return wrap;
}
function botSelect(label, val, options, on) {
  const wrap = el('div', { class: 'field' });
  if (label) wrap.appendChild(el('label', { text: label }));
  const s = el('select', {});
  for (const o of options) { const op = el('option', { value: o.v, text: o.t }); s.appendChild(op); }
  s.value = val; s.addEventListener('change', () => on(s.value));
  wrap.appendChild(s); return wrap;
}

function renderChoiceRow(c) {
  const E = BOT_EDIT;
  const box = el('div', { style: 'border:1px solid #e4ece9;border-radius:8px;padding:8px;margin:6px 0;background:#fff' });
  const r1 = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end' });
  r1.appendChild(botInput('ボタン文字（20字まで）', c.label, (v) => c.label = v, { placeholder: '例）予約する', width: '150px' }));
  r1.appendChild(botSelect('動作', c.action_type, [{ v: 'postback', t: 'タグ付け・分岐' }, { v: 'uri', t: 'リンクを開く' }], (v) => { c.action_type = v; renderBotEditor(); }));
  const del = el('button', { class: 'del', type: 'button', text: '削除' });
  del.addEventListener('click', () => { E.choices = E.choices.filter((x) => x !== c); renderBotEditor(); });
  const dw = el('div', { class: 'field' }); dw.appendChild(el('label', { text: ' ' })); dw.appendChild(del); r1.appendChild(dw);
  box.appendChild(r1);
  if (c.action_type === 'uri') {
    box.appendChild(botInput('リンク先URL', c.uri, (v) => c.uri = v, { placeholder: '例）tel:0725333262 ／ https://...' }));
  } else {
    const r2 = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
    r2.appendChild(botInput('付けるタグ', c.tag, (v) => c.tag = v, { placeholder: '例）新規 / 交通事故', width: '130px' }));
    const campOpts = [{ v: '', t: '（分岐先の配信なし）' }].concat(BOT_CAMPS.map((x) => ({ v: x.id, t: x.name })));
    r2.appendChild(botSelect('分岐先ステップ配信', c.campaign_id, campOpts, (v) => c.campaign_id = v));
    const flowOpts = [{ v: '', t: '（次のフローなし）' }].concat(BOT_FLOWS.filter((x) => x.id !== E.id).map((x) => ({ v: x.id, t: x.name || x.question_text || x.id })));
    r2.appendChild(botSelect('次のフローへ（多段分岐）', c.next_flow_id, flowOpts, (v) => c.next_flow_id = v));
    box.appendChild(r2);
    box.appendChild(botInput('選択時の返信メッセージ（任意）', c.reply_text, (v) => c.reply_text = v, { placeholder: '例）ご予約ありがとうございます' }));
  }
  return box;
}

function renderChoices(cid) {
  const E = BOT_EDIT;
  const list = E.choices.filter((c) => (cid ? c.cid === cid : !c.cid));
  const wrap = el('div', { style: 'margin-top:6px' });
  wrap.appendChild(el('div', { style: 'font-size:13px;font-weight:700;color:#42505e', text: 'ボタン（選択肢）' }));
  list.forEach((c) => wrap.appendChild(renderChoiceRow(c)));
  const maxB = E.message_type === 'carousel' ? 3 : (E.message_type === 'buttons' ? 4 : 13);
  if (list.length < maxB) {
    const add = el('button', { class: 'ghost', type: 'button', text: '＋ ボタンを追加' });
    add.addEventListener('click', () => { E.choices.push({ label: '', action_type: 'postback', tag: '', campaign_id: '', reply_text: '', uri: '', next_flow_id: '', cid: cid || '' }); renderBotEditor(); });
    wrap.appendChild(add);
  }
  return wrap;
}

function renderColumns() {
  const E = BOT_EDIT;
  const wrap = el('div', { style: 'margin-top:6px' });
  wrap.appendChild(el('div', { style: 'font-size:13px;font-weight:700;color:#42505e;margin-bottom:4px', text: 'カード（横スワイプ・最大10枚／各カード最大3ボタン）' }));
  E.columns.forEach((col, idx) => {
    const cb = el('div', { style: 'border:1px solid #cfe0da;border-radius:10px;padding:10px;margin-bottom:8px;background:#fff' });
    cb.appendChild(el('div', { style: 'font-weight:700;font-size:13px;margin-bottom:4px', text: 'カード ' + (idx + 1) }));
    const r = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
    r.appendChild(botInput('タイトル', col.title, (v) => col.title = v, { width: '150px' }));
    r.appendChild(botInput('本文', col.text, (v) => col.text = v, { width: '210px' }));
    r.appendChild(botInput('画像URL（任意）', col.image_url, (v) => col.image_url = v, { placeholder: 'https://...' }));
    cb.appendChild(r);
    cb.appendChild(renderChoices(col.cid));
    const del = el('button', { class: 'del', type: 'button', text: 'このカードを削除' }); del.style.marginTop = '6px';
    del.addEventListener('click', () => { E.columns = E.columns.filter((x) => x !== col); E.choices = E.choices.filter((x) => x.cid !== col.cid); renderBotEditor(); });
    cb.appendChild(del);
    wrap.appendChild(cb);
  });
  if (E.columns.length < 10) {
    const add = el('button', { class: 'ghost', type: 'button', text: '＋ カードを追加' });
    add.addEventListener('click', () => { E.columns.push({ cid: 'c' + Date.now() + Math.floor(Math.random() * 999), title: '', text: '', image_url: '' }); renderBotEditor(); });
    wrap.appendChild(add);
  }
  return wrap;
}

function renderBotEditor() {
  const box = document.getElementById('bot-editor');
  if (!box || !BOT_EDIT) return;
  const E = BOT_EDIT;
  box.textContent = '';
  const panel = el('div', { class: 'panel', style: 'border:1px solid #d7e5e0;background:#fafcfb' });
  panel.appendChild(el('h3', { text: '会話ボットの編集' }));
  const row1 = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
  row1.appendChild(botInput('フロー名', E.name, (v) => E.name = v, { placeholder: '例）交通事故メニュー', width: '170px' }));
  row1.appendChild(botSelect('起動のきっかけ', E.trigger_type, [{ v: 'follow', t: '友だち追加時' }, { v: 'keyword', t: 'キーワード' }], (v) => { E.trigger_type = v; renderBotEditor(); }));
  if (E.trigger_type === 'keyword') row1.appendChild(botInput('キーワード（完全一致）', E.trigger_keyword, (v) => E.trigger_keyword = v, { placeholder: '例）交通事故', width: '140px' }));
  row1.appendChild(botSelect('メッセージ形式', E.message_type, [{ v: 'quick', t: 'クイックリプライ' }, { v: 'buttons', t: 'ボタンカード' }, { v: 'carousel', t: 'カルーセル' }], (v) => { E.message_type = v; renderBotEditor(); }));
  panel.appendChild(row1);
  if (E.message_type !== 'carousel') {
    panel.appendChild(botInput('質問文（メッセージ本文）', E.question_text, (v) => E.question_text = v, { textarea: true, placeholder: 'あてはまるものを選んでください' }));
    if (E.message_type === 'buttons') panel.appendChild(botInput('ヘッダー画像URL（任意・https）', E.image_url, (v) => E.image_url = v, { placeholder: 'https://.../image.png' }));
    panel.appendChild(renderChoices(null));
  } else {
    panel.appendChild(renderColumns());
  }
  const bar = el('div', { class: 'field actions', style: 'margin-top:10px' });
  const save = el('button', { class: 'primary', type: 'button', text: 'このフローを保存' });
  save.addEventListener('click', () => saveBotFlow(save));
  bar.appendChild(save);
  const close = el('button', { class: 'ghost', type: 'button', text: '閉じる' }); close.style.marginLeft = '8px';
  close.addEventListener('click', () => { box.textContent = ''; });
  bar.appendChild(close);
  panel.appendChild(bar);
  panel.appendChild(el('p', { class: 'msg', id: 'bot-edit-msg' }));
  box.appendChild(panel);
}

async function saveBotFlow(btn) {
  const E = BOT_EDIT; const msg = document.getElementById('bot-edit-msg'); btn.disabled = true;
  try {
    await api('/bot-flows/' + E.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name: E.name, trigger_type: E.trigger_type, trigger_keyword: E.trigger_keyword,
      message_type: E.message_type, question_text: E.question_text, image_url: E.image_url, alt_text: E.alt_text,
    }) });
    let cidToSid = {};
    if (E.message_type === 'carousel') {
      const cols = E.columns.map((c) => ({ id: c.cid, title: c.title, text: c.text, imageUrl: c.image_url }));
      const r = await api('/bot-flows/' + E.id + '/columns', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ columns: cols }) });
      cidToSid = (r && r.id_map) || {};
    } else {
      await api('/bot-flows/' + E.id + '/columns', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ columns: [] }) });
    }
    const choices = E.choices.filter((c) => c.label && c.label.trim()).map((c) => ({
      label: c.label, actionType: c.action_type, tag: c.tag, campaignId: c.campaign_id, replyText: c.reply_text,
      uri: c.uri, nextFlowId: c.next_flow_id,
      columnId: E.message_type === 'carousel' ? (cidToSid[c.cid] || null) : null,
    }));
    await api('/bot-flows/' + E.id + '/choices', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choices }) });
    if (msg) { msg.className = 'msg ok'; msg.textContent = '保存しました。LINEでテスト送信して動きをご確認ください。'; }
    await loadBotFlows();
    await openFlowEditor(E.id);
  } catch (e) { if (msg) { msg.className = 'msg err'; msg.textContent = '保存に失敗: ' + (e.message || e); } btn.disabled = false; }
}

(function initBot() {
  const seed = document.getElementById('bot-seed');
  const neu = document.getElementById('bot-new');
  if (neu) neu.addEventListener('click', async () => {
    const msg = document.getElementById('bot-msg');
    try {
      const f = await api('/bot-flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '新しいフロー', trigger_type: 'keyword', question_text: 'あてはまるものを選んでください', message_type: 'buttons', active: false }) });
      if (msg) { msg.className = 'msg ok'; msg.textContent = '新しいフローを作成しました。下の編集で内容を作り、保存したら「有効化」してください。'; }
      await loadBotFlows();
      openFlowEditor(f.id);
    } catch (e) { if (msg) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + (e.message || e); } }
  });
  if (seed) seed.addEventListener('click', async () => {
    const msg = document.getElementById('bot-msg');
    seed.disabled = true;
    try {
      await api('/bot-flows/seed-seitai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (msg) { msg.className = 'msg ok'; msg.textContent = '「初めて/通院中」フローを作成しました。上のステップ配信の「対象タグ」を 新規／既存 にすると、それぞれに自動で配信されます。'; }
      await loadBotFlows();
    } catch (e) { if (msg) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + e.message; } }
    finally { seed.disabled = false; }
  });
})();

// =====================================================================
// 受信箱（1:1チャット）
// =====================================================================
let INBOX_SEL = null;

async function loadInbox() {
  const list = document.getElementById('inbox-threads');
  if (!list) return;
  if (!hasFeature('inbox')) {
    list.textContent = '';
    list.appendChild(el('p', { style: 'font-size:13px;color:#888;padding:8px', text: 'プロプランでご利用いただけます。' }));
    return;
  }
  let data;
  try { data = await api('/inbox/threads'); }
  catch (e) { list.textContent = ''; list.appendChild(el('p', { style: 'font-size:13px;color:#b3402c;padding:8px', text: '読み込みに失敗: ' + e.message })); return; }
  const badge = document.getElementById('inbox-badge');
  if (badge) { badge.textContent = String(data.unread || 0); badge.style.display = data.unread ? '' : 'none'; }
  list.textContent = '';
  if (!data.threads.length) {
    list.appendChild(el('p', { style: 'font-size:13px;color:#888;padding:8px', text: 'まだメッセージがありません。友だちからメッセージが届くとここに表示されます。' }));
    return;
  }
  for (const t of data.threads) {
    const item = el('div', { style: 'padding:8px;border-radius:8px;cursor:pointer;border-bottom:1px solid #f0efe9' + (INBOX_SEL === t.line_user_id ? ';background:#f2faf8' : '') });
    const head = el('div', { style: 'display:flex;align-items:center;gap:6px' });
    head.appendChild(el('strong', { style: 'font-size:13px', text: t.display_name || '（名前未取得）' }));
    if (t.unread) head.appendChild(el('span', { style: 'background:#d0021b;color:#fff;border-radius:10px;font-size:11px;padding:1px 7px;margin-left:auto', text: String(t.unread) }));
    item.appendChild(head);
    item.appendChild(el('div', { class: 'muted', style: 'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: t.last_text || '' }));
    item.appendChild(el('div', { class: 'muted', style: 'font-size:11px', text: fmtDate(t.last_at) }));
    item.addEventListener('click', () => openInboxThread(t.line_user_id));
    list.appendChild(item);
  }
}

async function openInboxThread(userId) {
  INBOX_SEL = userId;
  const box = document.getElementById('inbox-messages');
  box.textContent = '';
  box.appendChild(el('p', { style: 'color:#888;font-size:13px;margin:auto', text: '読み込み中…' }));
  let msgs;
  try { msgs = await api('/inbox/' + encodeURIComponent(userId) + '/messages'); }
  catch (e) { box.textContent = ''; box.appendChild(el('p', { style: 'color:#b3402c;font-size:13px;margin:auto', text: '読み込みに失敗: ' + e.message })); return; }
  box.textContent = '';
  if (!msgs.length) box.appendChild(el('p', { style: 'color:#888;font-size:13px;margin:auto', text: 'まだメッセージがありません' }));
  for (const m of msgs) {
    const mine = m.direction === 'out';
    const row = el('div', { style: 'display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start') });
    const bubble = el('div', { style: 'max-width:75%;padding:8px 10px;border-radius:12px;font-size:13px;white-space:pre-wrap;word-break:break-word;background:' + (mine ? '#d7f3dc' : '#f1f0ec') });
    bubble.appendChild(el('div', { text: m.text || '' }));
    bubble.appendChild(el('div', { class: 'muted', style: 'font-size:10px;margin-top:2px;text-align:right', text: fmtDate(m.created_at) }));
    row.appendChild(bubble);
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
  const send = document.getElementById('inbox-reply-send');
  if (send && hasFeature('inbox')) send.disabled = false;
  const sug = document.getElementById('inbox-ai-suggest');
  if (sug && hasFeature('inbox') && AI_ENABLED) sug.disabled = false;
  const aiBox = document.getElementById('inbox-ai-box');
  if (aiBox) aiBox.style.display = 'none';
  loadInbox(); // 既読になったので未読バッジを更新
}

(function initInbox() {
  const refresh = document.getElementById('inbox-refresh');
  if (refresh) refresh.addEventListener('click', () => loadInbox());
  const sug = document.getElementById('inbox-ai-suggest');
  if (sug) sug.addEventListener('click', async () => {
    if (!INBOX_SEL) return;
    const msg = document.getElementById('inbox-msg');
    const aiBox = document.getElementById('inbox-ai-box');
    const aiList = document.getElementById('inbox-ai-list');
    sug.disabled = true; msg.className = 'msg'; msg.textContent = 'AIが返信案を考えています…（10秒ほど）';
    try {
      const r = await api('/inbox/' + encodeURIComponent(INBOX_SEL) + '/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      msg.textContent = '';
      aiList.textContent = '';
      for (const t of r.suggestions) {
        const chip = el('button', { type: 'button', class: 'ghost', style: 'text-align:left;font-size:13px;line-height:1.6;padding:8px 10px;white-space:pre-wrap' });
        chip.textContent = t;
        chip.addEventListener('click', () => {
          document.getElementById('inbox-reply-text').value = t;
          aiBox.style.display = 'none';
          document.getElementById('inbox-reply-text').focus();
        });
        aiList.appendChild(chip);
      }
      aiBox.style.display = '';
    } catch (e) { msg.className = 'msg err'; msg.textContent = e.message || 'AIの生成に失敗しました'; }
    finally { sug.disabled = false; }
  });
  const send = document.getElementById('inbox-reply-send');
  if (send) send.addEventListener('click', async () => {
    if (!INBOX_SEL) return;
    const ta = document.getElementById('inbox-reply-text');
    const msg = document.getElementById('inbox-msg');
    const text = ta.value.trim();
    if (!text) { msg.className = 'msg err'; msg.textContent = '返信メッセージを入力してください'; return; }
    send.disabled = true; msg.className = 'msg'; msg.textContent = '送信中…';
    try {
      await api('/inbox/' + encodeURIComponent(INBOX_SEL) + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      ta.value = ''; msg.className = 'msg ok'; msg.textContent = '送信しました✓';
      await openInboxThread(INBOX_SEL);
    } catch (e) { msg.className = 'msg err'; msg.textContent = '送信に失敗: ' + e.message; }
    finally { send.disabled = false; }
  });
})();

// =====================================================================
// リマインダ配信（基準日を起点にした自動メッセージ）
// =====================================================================
let REM_LIST = [];

async function loadReminders() {
  const body = document.getElementById('rem-body');
  if (!body) return;
  if (!hasFeature('reminders')) {
    body.textContent = '';
    body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'プロプランでご利用いただけます' })]));
    return;
  }
  try { REM_LIST = await api('/reminders'); }
  catch { body.textContent = ''; body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: '読み込みに失敗しました' })])); return; }
  body.textContent = '';
  if (!REM_LIST.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'まだありません。上のフォームで作成してください。' })])); return; }
  for (const c of REM_LIST) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: c.name }));
    tr.appendChild(el('td', { class: 'num', text: String(c.step_count) }));
    tr.appendChild(el('td', { class: 'num', text: String(c.active_enrollments) }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + (c.active ? 'active' : 'none') }), el('span', { text: c.active ? '有効' : '停止' })])]));
    const td = el('td');
    const edit = el('button', { class: 'ghost', type: 'button', text: '配信内容を編集', style: 'font-size:12px' });
    edit.addEventListener('click', () => openRemEditor(c.id));
    const who = el('button', { class: 'ghost', type: 'button', text: '登録者', style: 'font-size:12px;margin-left:4px' });
    who.addEventListener('click', async () => {
      try {
        const rows = await api('/reminders/' + c.id + '/enrollments');
        if (!rows.length) { alert('まだ登録者がいません。「友だち管理」の各行の「リマインダ」ボタンから登録できます。'); return; }
        alert(rows.slice(0, 30).map((r) => `${r.display_name || '（名前未取得）'} — 基準日 ${r.base_date}（${r.status === 'active' ? '配信中' : '停止'}）`).join('\n'));
      } catch (e) { alert('エラー: ' + e.message); }
    });
    const tog = el('button', { class: 'ghost', type: 'button', text: c.active ? '停止' : '有効化', style: 'font-size:12px;margin-left:4px' });
    tog.addEventListener('click', async () => {
      try { await api('/reminders/' + c.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) }); loadReminders(); }
      catch (e) { alert('エラー: ' + e.message); }
    });
    const del = el('button', { class: 'del', type: 'button', text: '削除', style: 'font-size:12px;margin-left:4px' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${c.name}」を削除しますか？（登録中の友だちへの配信も止まります）`)) return;
      try { await api('/reminders/' + c.id, { method: 'DELETE' }); document.getElementById('rem-editor').textContent = ''; loadReminders(); }
      catch (e) { alert('エラー: ' + e.message); }
    });
    td.appendChild(edit); td.appendChild(who); td.appendChild(tog); td.appendChild(del);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

function remStepRow(s) {
  const wrap = el('div', { class: 'panel', style: 'margin:10px 0; padding:14px 16px' });
  const head = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap' });
  head.appendChild(el('span', { class: 'muted', text: '基準日の' }));
  const num = el('input', { class: 'rem-days', type: 'number', min: '0', value: String(s ? Math.abs(s.offset_days) : 1), style: 'width:70px' });
  const dir = el('select', { class: 'rem-dir', style: 'width:85px' });
  dir.appendChild(el('option', { value: 'before', text: '日前' }));
  dir.appendChild(el('option', { value: 'after', text: '日後' }));
  dir.value = s ? (s.offset_days >= 0 ? 'after' : 'before') : 'before';
  const hour = el('select', { class: 'rem-hour', style: 'width:85px' });
  for (let h = 0; h < 24; h++) hour.appendChild(el('option', { value: String(h), text: h + '時' }));
  hour.value = String(s ? s.send_hour : 10);
  head.appendChild(num); head.appendChild(dir);
  head.appendChild(el('span', { class: 'muted', text: 'の' }));
  head.appendChild(hour);
  head.appendChild(el('span', { class: 'muted', text: 'に送信（0日後＝当日）' }));
  const rm = el('button', { class: 'del', type: 'button', text: 'この通を削除' });
  rm.style.marginLeft = 'auto';
  rm.addEventListener('click', () => wrap.remove());
  head.appendChild(rm);
  const ta = el('textarea', { class: 'rem-text', rows: '3', style: 'width:100%;border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-family:inherit;font-size:14px' });
  ta.value = s ? s.text : '';
  ta.placeholder = '例）{name}様、ご予約日が近づいてまいりました。お気をつけてお越しください😊';
  wrap.appendChild(head); wrap.appendChild(ta);
  return wrap;
}

async function openRemEditor(id) {
  const c = await api('/reminders/' + id);
  const box = document.getElementById('rem-editor');
  box.textContent = '';
  const panel = el('div', { class: 'panel', style: 'border:2px solid var(--ink); margin-top:12px' });
  panel.appendChild(el('h2', { text: 'リマインダ編集：' + c.name }));
  panel.appendChild(el('p', { class: 'hint', text: '「基準日の何日前/後・何時」にどんなメッセージを送るかを設定して保存してください。※ 本文に {name} と書くと友だちの名前に自動で置き換わります。' }));
  const list = el('div');
  (c.steps && c.steps.length ? c.steps : [null]).forEach((s) => list.appendChild(remStepRow(s)));
  panel.appendChild(list);
  const addBtn = el('button', { class: 'ghost', type: 'button', text: '＋ 配信を追加' });
  addBtn.addEventListener('click', () => list.appendChild(remStepRow(null)));
  const saveBtn = el('button', { type: 'button', text: '保存' }); saveBtn.style.marginLeft = '8px';
  const closeBtn = el('button', { class: 'ghost', type: 'button', text: '閉じる' }); closeBtn.style.marginLeft = '8px';
  const msg = el('span', { class: 'msg' }); msg.style.marginLeft = '8px';
  closeBtn.addEventListener('click', () => { box.textContent = ''; });
  saveBtn.addEventListener('click', async () => {
    const steps = [];
    for (const row of list.children) {
      const n = parseInt(row.querySelector('.rem-days').value, 10) || 0;
      const d = row.querySelector('.rem-dir').value;
      const h = parseInt(row.querySelector('.rem-hour').value, 10) || 0;
      const text = row.querySelector('.rem-text').value.trim();
      if (text) steps.push({ offset_days: d === 'before' ? -n : n, send_hour: h, text });
    }
    msg.className = 'msg'; msg.textContent = '保存中…';
    try { await api('/reminders/' + id + '/steps', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps }) }); msg.className = 'msg ok'; msg.textContent = '保存しました'; loadReminders(); }
    catch (e) { msg.className = 'msg err'; msg.textContent = '保存に失敗: ' + e.message; }
  });
  panel.appendChild(el('div', { style: 'margin-top:8px' }, [addBtn, saveBtn, closeBtn, msg]));
  box.appendChild(panel);
}

document.getElementById('rem-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('rem-msg');
  try {
    const c = await api('/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.value.trim() }) });
    msg.className = 'msg ok'; msg.textContent = 'キャンペーンを作成しました。配信内容を設定してください。';
    f.reset(); await loadReminders(); openRemEditor(c.id);
  } catch (e) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + e.message; }
});

// 友だち管理の「リマインダ」ボタン → キャンペーン＋基準日を選んで登録
let remFriend = null;
function openRemModal(f) {
  remFriend = f;
  const sel = document.getElementById('rem-modal-camp');
  sel.textContent = '';
  // 既定=かんたん登録（前日18時に自動でお知らせ。キャンペーン未作成でも使える）
  sel.appendChild(el('option', { value: '__quick', text: 'かんたん：前日18時に自動でお知らせ（おすすめ）' }));
  for (const c of REM_LIST) sel.appendChild(el('option', { value: c.id, text: c.name }));
  document.getElementById('rem-modal-title').textContent = `${f.display_name || '友だち'} の予約リマインド`;
  document.getElementById('rem-modal-date').value = '';
  document.getElementById('rem-modal-time').value = '';
  document.getElementById('rem-modal-msg').textContent = '';
  document.getElementById('rem-modal').style.display = 'flex';
}
document.getElementById('rem-modal-close').addEventListener('click', () => {
  document.getElementById('rem-modal').style.display = 'none';
});
document.getElementById('rem-modal-ok').addEventListener('click', async () => {
  if (!remFriend) return;
  const msg = document.getElementById('rem-modal-msg');
  const campId = document.getElementById('rem-modal-camp').value;
  const date = document.getElementById('rem-modal-date').value;
  const time = document.getElementById('rem-modal-time').value;
  if (!campId || !date) { msg.className = 'msg err'; msg.textContent = '予約日を選んでください'; return; }
  const ok = document.getElementById('rem-modal-ok');
  ok.disabled = true; msg.className = 'msg'; msg.textContent = '登録中…';
  try {
    const payload = JSON.stringify({ friend_id: remFriend.id, base_date: date, base_time: time || null });
    if (campId === '__quick') {
      await api('/reminders/quick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    } else {
      await api('/reminders/' + campId + '/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    }
    msg.className = 'msg ok'; msg.textContent = time ? `登録しました✓ 前日に「${time}から」のリマインドが届きます` : '登録しました✓';
    loadReminders();
    setTimeout(() => { document.getElementById('rem-modal').style.display = 'none'; }, 1000);
  } catch (e) { msg.className = 'msg err'; msg.textContent = 'エラー: ' + e.message; }
  finally { ok.disabled = false; }
});

// =====================================================================
// 回答フォーム（アンケート・事前問診）
// =====================================================================
function formFieldRow(f) {
  const row = el('div', { class: 'form', style: 'grid-template-columns: 2fr 130px 2fr 60px 70px; margin-bottom:6px; align-items:end' });
  const lab = el('input', { class: 'ff-label', placeholder: '例）気になる症状は？' });
  row.appendChild(el('div', { class: 'field' }, [el('label', { text: '質問文' }), lab]));
  const typ = el('select', { class: 'ff-type' });
  for (const [v, t] of [['text', '1行の記入'], ['textarea', '長文の記入'], ['select', 'プルダウン選択'], ['radio', 'ボタン選択（1つ）'], ['checkbox', 'チェックボックス（複数選択可）'], ['birthday', '生年月日（回答者の誕生日に自動登録）']]) typ.appendChild(el('option', { value: v, text: t }));
  row.appendChild(el('div', { class: 'field' }, [el('label', { text: '答え方' }), typ]));
  const opts = el('input', { class: 'ff-opts', placeholder: '選択式のみ・カンマ区切り（例: 肩こり,腰痛,その他）' });
  row.appendChild(el('div', { class: 'field' }, [el('label', { text: '選択肢' }), opts]));
  const req = el('input', { class: 'ff-req', type: 'checkbox', style: 'width:auto' });
  row.appendChild(el('div', { class: 'field' }, [el('label', { text: '必須' }), req]));
  const del = el('button', { class: 'del', type: 'button', text: '削除' });
  del.addEventListener('click', () => row.remove());
  row.appendChild(el('div', { class: 'field' }, [el('label', { text: ' ' }), del]));
  if (f) { lab.value = f.label || ''; typ.value = f.type || 'text'; opts.value = (f.options || []).join(','); req.checked = !!f.required; }
  return row;
}

async function loadForms() {
  const body = document.getElementById('forms-body');
  if (!body) return;
  if (!hasFeature('forms')) {
    body.textContent = '';
    body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'プロプランでご利用いただけます' })]));
    return;
  }
  let rows;
  try { rows = await api('/forms'); }
  catch { body.textContent = ''; body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: '読み込みに失敗しました' })])); return; }
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'まだありません。上のフォームで作成してください。' })])); return; }
  for (const f of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, [el('div', { text: f.name }), el('div', { class: 'muted', text: f.tag ? ('回答時タグ: ' + f.tag) : '' })]));
    tr.appendChild(el('td', null, [copyEl(f.public_url)]));
    tr.appendChild(el('td', null, [copyEl('{form:' + f.id + '}')]));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(f.answer_count) }));
    const td = el('td');
    const ans = el('button', { class: 'ghost', type: 'button', text: '回答を見る', style: 'font-size:12px' });
    ans.addEventListener('click', () => showFormAnswers(f));
    const del = el('button', { class: 'del', type: 'button', text: '削除', style: 'font-size:12px;margin-left:4px' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${f.name}」と回答データを削除しますか？`)) return;
      try { await api('/forms/' + f.id, { method: 'DELETE' }); document.getElementById('form-answers').textContent = ''; loadForms(); }
      catch (e) { alert('エラー: ' + e.message); }
    });
    td.appendChild(ans); td.appendChild(del);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

async function showFormAnswers(f) {
  const box = document.getElementById('form-answers');
  box.textContent = '';
  let rows;
  try { rows = await api('/forms/' + f.id + '/answers'); }
  catch (e) { alert('エラー: ' + e.message); return; }
  const panel = el('div', { class: 'panel', style: 'border:2px solid var(--ink); margin-top:12px' });
  panel.appendChild(el('h2', { text: `回答一覧：${f.name}（${rows.length}件）` }));
  if (!rows.length) {
    panel.appendChild(el('p', { class: 'hint', text: 'まだ回答がありません。配信本文に {form:' + f.id + '} を貼って友だちに案内してみましょう。' }));
  } else {
    const table = el('table', { class: 'grid' });
    table.appendChild(el('thead', null, [el('tr', null, [el('th', { text: '回答者' }), el('th', { text: '回答内容' }), el('th', { text: '日時' })])]));
    const tbody = el('tbody');
    for (const a of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: a.display_name || '（未特定）' }));
      const ansTd = el('td');
      for (const [q, v] of Object.entries(a.answers || {})) ansTd.appendChild(el('div', { style: 'font-size:13px', text: `${q}：${v}` }));
      tr.appendChild(ansTd);
      tr.appendChild(el('td', { class: 'mono', text: fmtDate(a.created_at) }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }
  const close = el('button', { class: 'ghost', type: 'button', text: '閉じる', style: 'margin-top:10px' });
  close.addEventListener('click', () => { box.textContent = ''; });
  panel.appendChild(close);
  box.appendChild(panel);
}

(function initForms() {
  const ffBox = document.getElementById('form-fields');
  if (!ffBox) return;
  ffBox.appendChild(formFieldRow(null));
  document.getElementById('ff-add').addEventListener('click', () => ffBox.appendChild(formFieldRow(null)));
  const form = document.getElementById('form-create');
  form.addEventListener('submit', (ev) => ev.preventDefault());
  document.getElementById('form-create-btn').addEventListener('click', async () => {
    const msg = document.getElementById('form-msg');
    const fields = Array.from(ffBox.children).map((r) => ({
      label: r.querySelector('.ff-label').value.trim(),
      type: r.querySelector('.ff-type').value,
      options: r.querySelector('.ff-opts').value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean),
      required: r.querySelector('.ff-req').checked,
    })).filter((x) => x.label);
    if (!form.name.value.trim() || !form.title.value.trim()) { msg.className = 'msg err'; msg.textContent = 'フォーム名とタイトルを入力してください'; return; }
    if (!fields.length) { msg.className = 'msg err'; msg.textContent = '質問を1つ以上入力してください'; return; }
    msg.className = 'msg'; msg.textContent = '作成中…';
    try {
      await api('/forms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: form.name.value.trim(), title: form.title.value.trim(), description: form.description.value.trim(),
        tag: form.tag.value.trim(), fields,
      }) });
      msg.className = 'msg ok'; msg.textContent = '作成しました。一覧のURLを配信に貼ってご利用ください。';
      form.reset(); ffBox.textContent = ''; ffBox.appendChild(formFieldRow(null));
      loadForms();
    } catch (e) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + e.message; }
  });
})();

// =====================================================================
// リンククリック計測（配信に貼るリンク）
// =====================================================================
async function loadTrackedUrls() {
  const body = document.getElementById('turl-body');
  if (!body) return;
  if (!hasFeature('roiDashboard')) {
    body.textContent = '';
    body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'プロプランでご利用いただけます' })]));
    return;
  }
  let rows;
  try { rows = await api('/tracked-urls'); }
  catch { body.textContent = ''; body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: '読み込みに失敗しました' })])); return; }
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだありません。上のフォームで作成してください。' })])); return; }
  for (const u of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, [el('div', { text: u.name }), el('div', { class: 'muted', text: u.dest_url || '' })]));
    tr.appendChild(el('td', null, [copyEl(u.short_url)]));
    tr.appendChild(el('td', null, [copyEl(u.placeholder)]));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(u.clicks) }));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(u.unique_friends) }));
    const td = el('td');
    const clk = el('button', { class: 'ghost', type: 'button', text: '誰が押したか', style: 'font-size:12px' });
    clk.addEventListener('click', async () => {
      try {
        const clicks = await api('/tracked-urls/' + u.id + '/clicks');
        if (!clicks.length) { alert('まだタップされていません'); return; }
        alert(clicks.slice(0, 30).map((r) => `${r.identified ? (r.display_name || '（名前未取得）') : '（未特定の訪問）'} — ${fmtDate(r.created_at)}`).join('\n'));
      } catch (e) { alert('エラー: ' + e.message); }
    });
    const del = el('button', { class: 'del', type: 'button', text: '削除', style: 'font-size:12px;margin-left:4px' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${u.name}」を削除しますか？（配信済みの本文内のリンクは無効になります）`)) return;
      try { await api('/tracked-urls/' + u.id, { method: 'DELETE' }); loadTrackedUrls(); }
      catch (e) { alert('エラー: ' + e.message); }
    });
    td.appendChild(clk); td.appendChild(del);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

document.getElementById('turl-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target, msg = document.getElementById('turl-msg');
  try {
    const r = await api('/tracked-urls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.value.trim(), dest_url: f.dest_url.value.trim() }) });
    msg.className = 'msg ok'; msg.textContent = `作成しました。本文に ${r.placeholder} と書くと友だち別リンクに変換されます。`;
    f.reset(); loadTrackedUrls();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + e.message; }
});

// =====================================================================
// テンプレート（定型文）
// =====================================================================
let TPL_LIST = [];

async function loadTemplates() {
  const sel = document.getElementById('tpl-select');
  if (!sel) return;
  try { TPL_LIST = await api('/templates'); } catch { TPL_LIST = []; }
  sel.textContent = '';
  sel.appendChild(el('option', { value: '', text: '定型文を挿入▼' }));
  for (const t of TPL_LIST) sel.appendChild(el('option', { value: t.id, text: t.name }));
}

(function initTemplates() {
  const sel = document.getElementById('tpl-select');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const t = TPL_LIST.find((x) => x.id === sel.value);
    if (!t) return;
    const ta = document.querySelector('#bcast-form [name=text]');
    ta.value = ta.value.trim() ? (ta.value + '\n' + t.text) : t.text;
  });
  document.getElementById('tpl-save').addEventListener('click', async () => {
    const ta = document.querySelector('#bcast-form [name=text]');
    const text = ta.value.trim();
    if (!text) { alert('本文を入力してから保存してください'); return; }
    const name = prompt('定型文の名前を入力してください（例: 月初のご案内）');
    if (!name || !name.trim()) return;
    try { await api('/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), text }) }); await loadTemplates(); alert('定型文として保存しました'); }
    catch (e) { alert('保存に失敗: ' + e.message); }
  });
  document.getElementById('tpl-del').addEventListener('click', async () => {
    const t = TPL_LIST.find((x) => x.id === sel.value);
    if (!t) { alert('削除する定型文を上のプルダウンで選んでください'); return; }
    if (!confirm(`定型文「${t.name}」を削除しますか？`)) return;
    try { await api('/templates/' + t.id, { method: 'DELETE' }); await loadTemplates(); }
    catch (e) { alert('削除に失敗: ' + e.message); }
  });
})();

// =====================================================================
// 広告費入力＋ROI（CPA）表
// =====================================================================
async function loadRoi() {
  const body = document.getElementById('roi-body');
  if (!body) return;
  if (!hasFeature('roiDashboard')) {
    body.textContent = '';
    body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'プロプランでご利用いただけます' })]));
    return;
  }
  let rows, costs;
  try { [rows, costs] = await Promise.all([api('/analytics/roi'), api('/ad-costs')]); }
  catch { body.textContent = ''; body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: '読み込みに失敗しました' })])); return; }
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだデータがありません。広告費を入力するか、計測リンク経由の友だち追加があると表示されます。' })])); return; }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: r.month }));
    tr.appendChild(el('td', { text: r.media || '（媒体未設定）' }));
    tr.appendChild(el('td', { class: 'num', text: r.cost != null ? fmtYen(r.cost) : '—' }));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(r.friends) }));
    tr.appendChild(el('td', { class: 'num', text: r.cpa != null ? fmtYen(r.cpa) : '—' }));
    const td = el('td');
    const cost = costs.find((c) => c.media === r.media && c.month === r.month);
    if (cost) {
      const del = el('button', { class: 'del', type: 'button', text: '広告費を削除', style: 'font-size:12px' });
      del.addEventListener('click', async () => {
        if (!confirm(`${r.month} の ${r.media} の広告費入力を削除しますか？`)) return;
        try { await api('/ad-costs/' + cost.id, { method: 'DELETE' }); loadRoi(); }
        catch (e) { alert('エラー: ' + e.message); }
      });
      td.appendChild(del);
    }
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

(function initAdCosts() {
  const btn = document.getElementById('adc-save');
  if (!btn) return;
  const now = new Date();
  document.getElementById('adc-month').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  btn.addEventListener('click', async () => {
    const msg = document.getElementById('adc-msg');
    const month = document.getElementById('adc-month').value;
    const amount = document.getElementById('adc-amount').value;
    if (!month || amount === '') { msg.className = 'msg err'; msg.textContent = '月と金額を入力してください'; return; }
    msg.className = 'msg'; msg.textContent = '保存中…';
    try {
      await api('/ad-costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        media: document.getElementById('adc-media').value, month, amount: parseInt(amount, 10),
      }) });
      msg.className = 'msg ok'; msg.textContent = '保存しました';
      document.getElementById('adc-amount').value = '';
      loadRoi();
    } catch (e) { msg.className = 'msg err'; msg.textContent = '保存に失敗: ' + e.message; }
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

// =====================================================================
// 通知先LINE（自分）ピッカー＋一斉配信テスト送信
// =====================================================================
let OWNER_LINE_ID = null;

async function refreshOwnerLine() {
  try {
    const s = await api('/settings');
    OWNER_LINE_ID = s.owner_line_user_id || null;
    const st = document.getElementById('notify-line-status');
    const btn = document.getElementById('notify-line-set');
    if (st) st.textContent = OWNER_LINE_ID ? '自分のLINE ✓（届かない場合はメール）' : 'メール';
    if (btn) btn.textContent = OWNER_LINE_ID ? '通知先を変更する' : '自分のLINEで受け取る（おすすめ）';
  } catch (e) { console.error(e); }
}

/** 友だち一覧から「自分」を選んで通知先・テスト送信先に設定するモーダル。 */
async function pickOwnerFriend() {
  const r = await api('/friends?limit=200');
  const list = (r.friends || []).filter((f) => f.status === 'active');
  return new Promise((resolve) => {
    const overlay = el('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px' });
    const box = el('div', { style: 'background:#fff;border-radius:12px;max-width:420px;width:100%;max-height:80vh;display:flex;flex-direction:column;padding:16px' });
    box.appendChild(el('div', { style: 'font-weight:800;margin-bottom:4px', text: '友だち一覧から「自分」を選んでください' }));
    box.appendChild(el('div', { class: 'hint', style: 'margin-bottom:8px', text: 'まだ一覧に自分がいない場合は、先に自分のスマホでこの店の公式LINEを友だち追加してください（追加すると数秒でここに表示されます）。' }));
    const search = el('input', { placeholder: '名前で検索…', style: 'padding:8px 10px;border:1px solid #cfe0da;border-radius:8px;margin-bottom:8px' });
    box.appendChild(search);
    const listBox = el('div', { style: 'overflow-y:auto;flex:1;border:1px solid #eef2f0;border-radius:8px' });
    const renderList = () => {
      const q = search.value.trim();
      listBox.textContent = '';
      const hits = list.filter((f) => !q || (f.display_name || '').includes(q));
      if (!hits.length) { listBox.appendChild(el('div', { class: 'empty', style: 'padding:14px', text: '該当する友だちがいません' })); return; }
      for (const f of hits.slice(0, 50)) {
        const item = el('div', { style: 'padding:10px 12px;border-bottom:1px solid #f0f4f2;cursor:pointer' });
        item.appendChild(el('span', { style: 'font-weight:700', text: f.display_name || '（名前未取得）' }));
        item.appendChild(el('span', { style: 'font-size:11px;color:#8a94a0;margin-left:8px', text: fmtDate(f.created_at) + ' 追加' }));
        item.addEventListener('mouseenter', () => { item.style.background = '#f2faf8'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
        item.addEventListener('click', async () => {
          try {
            await api('/settings/owner-line', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friend_id: f.id }) });
            document.body.removeChild(overlay);
            await refreshOwnerLine();
            resolve(f.id);
          } catch (e) { alert(e.message || '設定に失敗しました'); }
        });
        listBox.appendChild(item);
      }
    };
    search.addEventListener('input', renderList);
    renderList();
    box.appendChild(listBox);
    const cancel = el('button', { type: 'button', class: 'ghost', style: 'margin-top:10px', text: 'キャンセル' });
    cancel.addEventListener('click', () => { document.body.removeChild(overlay); resolve(null); });
    box.appendChild(cancel);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

function initOwnerLine() {
  const setBtn = document.getElementById('notify-line-set');
  if (setBtn) setBtn.addEventListener('click', () => pickOwnerFriend());

  const testBtn = document.getElementById('bcast-test');
  if (testBtn) testBtn.addEventListener('click', async () => {
    const f = document.getElementById('bcast-form');
    const msg = document.getElementById('bcast-msg');
    const text = f.text.value.trim();
    if (!text) { msg.className = 'msg err'; msg.textContent = '先に本文を入力してください'; return; }
    if (!OWNER_LINE_ID) {
      msg.className = 'msg'; msg.textContent = 'はじめに「自分」を友だち一覧から選んでください（1回だけの設定です）';
      const picked = await pickOwnerFriend();
      if (!picked) return;
    }
    testBtn.disabled = true; msg.className = 'msg'; msg.textContent = '自分のLINEへ送信中…';
    try {
      const payload = { text };
      if (typeof BCAST_IMG !== 'undefined' && BCAST_IMG.getUrl()) payload.image_url = BCAST_IMG.getUrl();
      await api('/broadcasts/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      msg.className = 'msg ok'; msg.textContent = '🧪 自分のLINEに送りました。見え方を確認してから本番送信してください。';
    } catch (e) {
      if (String(e.message).includes('owner_not_set')) { const p = await pickOwnerFriend(); if (p) testBtn.click(); return; }
      msg.className = 'msg err'; msg.textContent = e.message || 'テスト送信に失敗しました';
    } finally { testBtn.disabled = false; }
  });

  refreshOwnerLine();
}

// =====================================================================
// お客さま体験プレビュー（新規のお客さまにどう見えるか）
// =====================================================================
let PV = null;          // /api/preview/experience の結果
let PV_MEDIA = null;    // 選択中の流入経路（null=経路なし/全員）
let PV_AT = 0;          // 選択中の時点（分）

function pvBubble(side, text, opts = {}) {
  const wrap = el('div', { style: `display:flex;justify-content:${side === 'right' ? 'flex-end' : 'flex-start'};margin-bottom:8px` });
  const b = el('div', {
    style: `max-width:80%;padding:8px 10px;border-radius:14px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;` +
      (side === 'right' ? 'background:#06c755;color:#fff;border-bottom-right-radius:4px' : 'background:#fff;color:#111;border-bottom-left-radius:4px'),
  });
  if (opts.sender) b.appendChild(el('div', { style: 'font-size:10px;color:#8a94a0;margin-bottom:2px', text: opts.sender }));
  b.appendChild(document.createTextNode(text));
  wrap.appendChild(b);
  return wrap;
}

function pvDivider(label) {
  return el('div', { style: 'text-align:center;margin:10px 0' }, [
    el('span', { style: 'background:rgba(0,0,0,.18);color:#fff;font-size:10px;padding:2px 10px;border-radius:10px', text: label }),
  ]);
}

function pvNote(text) {
  return el('div', { style: 'text-align:center;margin:6px 0' }, [
    el('span', { style: 'background:#fff8e1;color:#8a6d1a;font-size:10px;padding:3px 10px;border-radius:8px;border:1px dashed #e6d494', text }),
  ]);
}

function pvDelayLabel(min) {
  if (min <= 0) return '登録直後';
  if (min < 60) return `${min}分後`;
  if (min < 1440) return `${Math.round(min / 60)}時間後`;
  return `${Math.round(min / 1440)}日後`;
}

/** 選択中の経路に該当するステップメッセージ（経路なしキャンペーン＋選択経路のもの）。 */
function pvStepMessages() {
  const out = [];
  for (const c of (PV.steps || [])) {
    if (c.audience_tag) continue; // タグ限定はボット選択後に登録されるため既定表示から除外
    // 経路なし（全員向け）は常に届く。経路指定は選択中の経路のみ。
    if (c.media && c.media !== PV_MEDIA) continue;
    for (const m of c.messages) out.push({ ...m, campaign: c.campaign });
  }
  return out.sort((a, b) => a.delay_minutes - b.delay_minutes);
}

function pvRender() {
  if (!PV) return;
  document.getElementById('pv-header').textContent = `＜ ${PV.shop_name}`;
  const chat = document.getElementById('pv-chat');
  chat.textContent = '';

  chat.appendChild(pvDivider('友だち追加'));
  chat.appendChild(pvBubble('left', PV.greeting, { sender: PV.shop_name }));

  if (PV.bot && PV.bot.question) {
    chat.appendChild(pvBubble('left', PV.bot.question, { sender: PV.shop_name }));
    const row = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:8px' });
    for (const c of PV.bot.choices) {
      const btn = el('button', { type: 'button', style: 'border:1px solid #06c755;background:#fff;color:#06c755;border-radius:16px;padding:5px 12px;font-size:12px;cursor:pointer', text: c.label });
      btn.addEventListener('click', () => {
        chat.appendChild(pvBubble('right', c.label));
        if (c.reply_text) chat.appendChild(pvBubble('left', c.reply_text, { sender: PV.shop_name }));
        if (c.tag) chat.appendChild(pvNote(`🏷 この方に「${c.tag}」タグが自動で付きます`));
        chat.scrollTop = chat.scrollHeight;
      });
      row.appendChild(btn);
    }
    chat.appendChild(row);
  }

  // ステップ配信（選択時点まで）
  let lastLabel = null;
  for (const m of pvStepMessages()) {
    if (m.delay_minutes > PV_AT) break;
    const label = pvDelayLabel(m.delay_minutes);
    if (m.delay_minutes > 0 && label !== lastLabel) { chat.appendChild(pvDivider(label)); lastLabel = label; }
    chat.appendChild(pvBubble('left', m.text, { sender: PV.shop_name }));
    if (m.image_url) chat.appendChild(pvNote('🖼 画像が一緒に届きます'));
  }

  // 予約リマインド（専用チップ選択時）
  if (PV_AT === -1 && PV.reminder) {
    for (const r of PV.reminder) {
      chat.appendChild(pvDivider(`ご予約の${r.when}`));
      chat.appendChild(pvBubble('left', r.text, { sender: PV.shop_name }));
    }
    if (!PV.reminder.length) chat.appendChild(pvNote('リマインドは未設定です'));
  }

  chat.scrollTop = chat.scrollHeight;

  // リッチメニュー
  const rmBox = document.getElementById('pv-richmenu');
  rmBox.textContent = '';
  if (PV.richmenu && PV.richmenu.cells.length) {
    rmBox.style.display = '';
    rmBox.appendChild(el('div', { style: 'text-align:center;font-size:10px;color:#667;padding:3px 0;border-bottom:1px solid #eee', text: `▾ ${PV.richmenu.chat_bar_text}` }));
    const cols = PV.richmenu.cells.length >= 4 ? 3 : PV.richmenu.cells.length;
    const grid = el('div', { style: `display:grid;grid-template-columns:repeat(${Math.max(1, cols)},1fr)` });
    for (const c of PV.richmenu.cells) {
      const cell = el('button', { type: 'button', style: 'border:1px solid #e3e8ee;background:#f7f9fb;padding:10px 4px;font-size:11px;font-weight:700;cursor:pointer;color:#234', text: c.label || '（無題）' });
      cell.addEventListener('click', async () => {
        const chat2 = document.getElementById('pv-chat');
        if (c.type === 'message') {
          chat2.appendChild(pvBubble('right', c.value));
          await pvSendKeyword(c.value, true);
        } else {
          chat2.appendChild(pvNote(`🔗 「${c.label}」→ ${String(c.value || '').slice(0, 60)} が開きます`));
        }
        chat2.scrollTop = chat2.scrollHeight;
      });
      grid.appendChild(cell);
    }
    rmBox.appendChild(grid);
  } else {
    rmBox.style.display = 'none';
  }
}

function pvControls() {
  const box = document.getElementById('pv-controls');
  box.textContent = '';
  const chip = (label, active, onClick) => {
    const b = el('button', { type: 'button', style: `border-radius:16px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid ${active ? '#0f7a6b' : '#cfe0da'};background:${active ? '#0f7a6b' : '#fff'};color:${active ? '#fff' : '#41505e'}`, text: label });
    b.addEventListener('click', onClick);
    return b;
  };
  // 時点チップ（実際に設定されている間隔から生成）
  const delays = [...new Set(pvStepMessages().map((m) => m.delay_minutes).filter((d) => d > 0))].sort((a, b) => a - b);
  box.appendChild(chip('登録直後', PV_AT === 0, () => { PV_AT = 0; pvControls(); pvRender(); }));
  for (const d of delays) {
    box.appendChild(chip(pvDelayLabel(d), PV_AT === d, () => { PV_AT = d; pvControls(); pvRender(); }));
  }
  if (PV.reminder) box.appendChild(chip('📅 予約の前日', PV_AT === -1, () => { PV_AT = -1; pvControls(); pvRender(); }));
  // 流入経路チップ（経路別キャンペーンがある場合のみ）
  if (PV.medias && PV.medias.length) {
    box.appendChild(el('span', { style: 'align-self:center;font-size:11px;color:#8a94a0;margin-left:8px', text: '流入経路:' }));
    box.appendChild(chip('経路なし', PV_MEDIA === null, () => { PV_MEDIA = null; pvControls(); pvRender(); }));
    for (const md of PV.medias) {
      box.appendChild(chip(md, PV_MEDIA === md, () => { PV_MEDIA = md; pvControls(); pvRender(); }));
    }
  }
}

async function pvSendKeyword(text, skipRightBubble) {
  const chat = document.getElementById('pv-chat');
  if (!skipRightBubble) chat.appendChild(pvBubble('right', text));
  try {
    const r = await api('/preview/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (r.type === 'text') chat.appendChild(pvBubble('left', r.text, { sender: PV.shop_name }));
    else if (r.type === 'bot') {
      chat.appendChild(pvBubble('left', r.question, { sender: PV.shop_name }));
      chat.appendChild(pvNote(`選択肢: ${r.choices.map((c) => c.label).join(' / ')}`));
    } else chat.appendChild(pvNote(r.text));
  } catch (e) {
    chat.appendChild(pvNote(e.message || 'エラーが発生しました'));
  }
  chat.scrollTop = chat.scrollHeight;
}

async function loadPreview() {
  const secEl = document.getElementById('sec-preview');
  if (!secEl) return;
  try {
    PV = await api('/preview/experience');
    PV_MEDIA = null; PV_AT = 0;
    pvControls();
    pvRender();
  } catch (e) { console.error(e); }
}

function initPreview() {
  const send = document.getElementById('pv-send');
  const input = document.getElementById('pv-input');
  if (!send) return;
  send.addEventListener('click', () => { const t = input.value.trim(); if (!t) return; input.value = ''; pvSendKeyword(t); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); send.click(); } });
}

// =====================================================================
// 質問・サポート（AIチャット→運営エスカレーション）
// =====================================================================
const SUP_STYLE = {
  tenant: ['あなた', 'background:#e7f5f1;border:1px solid #b7e0d6', 'flex-end'],
  ai: ['AIサポート', 'background:#eef2ff;border:1px solid #c7d2fe', 'flex-start'],
  operator: ['運営スタッフ', 'background:#fff7ed;border:1px solid #fdba74', 'flex-start'],
  system: ['お知らせ', 'background:#f8fafc;border:1px dashed #cbd5e1;color:#64748b', 'flex-start'],
};

function supportBubble(m) {
  const [label, style, justify] = SUP_STYLE[m.sender] || SUP_STYLE.system;
  const wrap = el('div', { style: `display:flex;justify-content:${justify};margin-bottom:8px` });
  const d = new Date(m.created_at), p = (x) => String(x).padStart(2, '0');
  const b = el('div', { style: `max-width:88%;padding:8px 10px;border-radius:10px;font-size:13px;white-space:pre-wrap;line-height:1.6;${style}` });
  b.appendChild(el('div', { style: 'font-size:10px;color:#94a3b8;margin-bottom:2px', text: `${label} ${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}` }));
  b.appendChild(document.createTextNode(m.text));
  wrap.appendChild(b);
  return wrap;
}

function supportAppend(msgs) {
  const log = document.getElementById('support-log');
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  for (const m of msgs) log.appendChild(supportBubble(m));
  log.scrollTop = log.scrollHeight;
}

async function loadSupport() {
  const box = document.getElementById('support-log');
  if (!box) return;
  try {
    const r = await api('/support');
    box.textContent = '';
    if (!r.messages.length) {
      box.appendChild(el('div', { class: 'empty', text: 'まだ質問はありません。何でも聞いてください😊（例:「友だち追加しても挨拶が届きません」）' }));
    } else {
      supportAppend(r.messages);
      // 運営からの返信が未読ならバッジ表示（このロード自体で既読になる）
      const hasNewOp = r.messages.slice(-3).some((m) => m.sender === 'operator');
      if (hasNewOp) {
        const badge = document.getElementById('support-badge');
        if (badge) { badge.style.display = ''; setTimeout(() => { badge.style.display = 'none'; }, 8000); }
      }
    }
  } catch (e) { console.error(e); }
}

function initCancelRequest() {
  const link = document.getElementById('cancel-request-link');
  if (!link) return;
  link.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const reason = prompt('解約をご希望とのこと、承知しました。\nよろしければ理由をお聞かせください（空欄のままでも送信できます）。\n\n送信後、担当者から手続きのご案内をお送りします。');
    if (reason === null) return; // キャンセル
    try {
      await api('/cancel-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      alert('解約のお申し出を受け付けました。\n担当者からのご案内を「質問・サポート」欄とメールにお送りします。');
      if (typeof loadSupport === 'function') loadSupport();
    } catch (e) { alert(e.message || '送信に失敗しました'); }
  });
}

function initSupport() {
  const send = document.getElementById('support-send');
  const input = document.getElementById('support-input');
  const esc = document.getElementById('support-escalate');
  const msg = document.getElementById('support-msg');
  if (!send) return;

  send.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true; msg.className = 'msg'; msg.textContent = 'AIが回答を考えています…';
    supportAppend([{ sender: 'tenant', text, created_at: Date.now() }]);
    input.value = '';
    try {
      const r = await api('/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      supportAppend(r.messages.filter((m) => m.sender !== 'tenant')); // 自分の発言は先に表示済み
      msg.textContent = '';
      const hint = document.getElementById('support-escalate-hint');
      if (r.confident === false && hint) {
        hint.innerHTML = '<b style="color:#b45309">← AIで解決しない内容のようです。こちらからどうぞ</b>';
        setTimeout(() => { hint.textContent = ''; }, 15000);
      }
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = e.message || '送信に失敗しました';
    } finally { send.disabled = false; }
  });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send.click(); } });

  esc.addEventListener('click', async () => {
    const extra = input.value.trim(); // 入力欄に書きかけの内容があれば一緒に送る
    esc.disabled = true; msg.className = 'msg'; msg.textContent = '運営に送信しています…';
    try {
      const r = await api('/support/escalate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: extra }) });
      supportAppend(r.messages);
      input.value = '';
      msg.className = 'msg ok'; msg.textContent = '運営に届きました。返信をお待ちください。';
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = e.message || '送信に失敗しました';
    } finally { esc.disabled = false; }
  });
}

(async function init() {
  try { await loadMe(); } catch { return; }
  initAiSetup(); initRmAi(); loadAiSetup();
  applyPlanLocks();
  await Promise.all([loadBilling(), loadSettings(), loadRmTemplates(), loadPresets(), loadAnalytics(), loadCoupons(), loadBirthdayCampaigns(), loadStampCards(), loadBotFlows(), loadWizardStatus(), loadInbox(), loadReminders(), loadForms(), loadTrackedUrls(), loadTemplates(), loadRoi(), loadSupport(), refresh()]);
  initSupport();
  initCancelRequest();
  initPreview();
  loadPreview();
  initOwnerLine();
})();
