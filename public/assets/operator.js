'use strict';

async function api(path, opts) {
  const res = await fetch('/api/admin' + path, Object.assign({ credentials: 'same-origin' }, opts));
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  if (res.status === 403) { document.body.innerHTML = '<div class="center"><div class="card"><h1>権限がありません</h1><p class="lead">運営アカウントでログインしてください。</p><a class="btn" href="/login">ログイン</a></div></div>'; throw new Error('forbidden'); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || ('API ' + res.status)); }
  return res.status === 204 ? null : res.json();
}

const fmtInt = (n) => (n == null ? '–' : Number(n).toLocaleString('ja-JP'));
function fmtDate(ms) { if (!ms) return '–'; const d = new Date(ms), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`; }
function el(tag, attrs, children) { const e = document.createElement(tag); if (attrs) for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); } if (children) for (const c of children) e.appendChild(c); return e; }

const BILLING_LABEL = { active: '契約中', trialing: 'トライアル', past_due: '支払い遅延', canceled: '解約', none: '未契約', suspended: '停止' };

async function loadStats() {
  const s = await api('/stats');
  document.getElementById('kpi-tenants').textContent = fmtInt(s.tenants);
  document.getElementById('kpi-active').textContent = fmtInt(s.active);
  document.getElementById('kpi-subs').textContent = fmtInt(s.subscriptions_active);
  document.getElementById('kpi-follows').textContent = fmtInt(s.follows_matched);
}

async function loadTenants() {
  const rows = await api('/tenants');
  const body = document.getElementById('tenants-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '7', text: 'まだ院がありません' })])); return; }
  for (const t of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: t.name || '（未設定）' }));
    tr.appendChild(el('td', { class: 'mono', text: t.email }));
    tr.appendChild(el('td', null, [el('span', { class: 'status' }, [el('span', { class: 'dot ' + (t.billing_status || 'none') }), el('span', { text: BILLING_LABEL[t.billing_status] || t.billing_status })])]));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(t.clicks) }));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(t.follows) }));
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(t.created_at) }));
    const isSusp = t.status === 'suspended';
    const btn = el('button', { class: isSusp ? 'btn' : 'del', type: 'button', text: isSusp ? '再開' : '停止' });
    btn.addEventListener('click', async () => {
      const action = isSusp ? 'activate' : 'suspend';
      if (!confirm(`${t.name || t.email} を${isSusp ? '再開' : '停止'}しますか？`)) return;
      await api(`/tenants/${encodeURIComponent(t.id)}/${action}`, { method: 'POST' });
      refresh();
    });
    const rl = el('button', { class: 'ghost', type: 'button', text: 'PW設定リンク' });
    rl.style.marginRight = '6px';
    rl.addEventListener('click', async () => {
      const r = await api(`/tenants/${encodeURIComponent(t.id)}/reset-link`, { method: 'POST' });
      if (navigator.clipboard) { try { await navigator.clipboard.writeText(r.reset_url); } catch {} }
      prompt('パスワード設定リンク（コピーしてお渡しください・72時間有効）', r.reset_url);
    });
    const ac = el('button', { class: 'ghost', type: 'button', text: 'コード適用' });
    ac.style.marginRight = '6px';
    ac.addEventListener('click', async () => {
      const code = prompt(`${t.name || t.email} にパスコードを適用します。\nコードを入力してください（例: KEIRO-XXXX-XXXX）`);
      if (!code || !code.trim()) return;
      try {
        const r = await api(`/tenants/${encodeURIComponent(t.id)}/apply-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) });
        alert(`適用しました：${r.plan_name}／無料期限 ${fmtDate(r.trial_ends_at)}`);
        refresh(); loadCodes();
      } catch (e) { alert('適用に失敗: ' + (e.message || e)); }
    });
    tr.appendChild(el('td', null, [ac, rl, btn]));
    body.appendChild(tr);
  }
}

const PLAN_LABEL = { pro: 'プロ', light: 'ライト' };

async function loadCodes() {
  const rows = await api('/codes');
  const body = document.getElementById('codes-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '7', text: 'まだパスコードがありません' })])); return; }
  for (const c of rows) {
    const tr = el('tr');
    if (!c.active) tr.setAttribute('style', 'opacity:.5');
    const codeCell = el('td', { class: 'mono' }, [el('span', { text: c.code })]);
    const copy = el('button', { class: 'ghost', type: 'button', text: 'コピー', style: 'margin-left:8px;font-size:11px' });
    copy.addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(c.code); copy.textContent = 'コピー済'; setTimeout(() => (copy.textContent = 'コピー'), 1200); });
    codeCell.appendChild(copy);
    tr.appendChild(codeCell);
    tr.appendChild(el('td', { text: PLAN_LABEL[c.plan] || c.plan }));
    tr.appendChild(el('td', { class: 'num', text: `${c.trial_days}日` }));
    tr.appendChild(el('td', { class: 'num', text: `${c.used_count}/${c.max_uses}` }));
    tr.appendChild(el('td', { text: c.note || '–' }));
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(c.created_at) }));
    const btn = el('button', { class: c.active ? 'del' : 'btn', type: 'button', text: c.active ? '無効化' : '有効化' });
    btn.addEventListener('click', async () => {
      await api(`/codes/${encodeURIComponent(c.id)}/${c.active ? 'deactivate' : 'activate'}`, { method: 'POST' });
      loadCodes();
    });
    tr.appendChild(el('td', null, [btn]));
    body.appendChild(tr);
  }
}

document.getElementById('code-create').addEventListener('click', async () => {
  const body = {
    plan: document.getElementById('code-plan').value,
    trial_days: Number(document.getElementById('code-days').value) || 30,
    max_uses: Number(document.getElementById('code-uses').value) || 1,
    note: document.getElementById('code-note').value.trim(),
  };
  try {
    const c = await api('/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('code-note').value = '';
    await loadCodes();
    alert(`パスコードを発行しました：\n${c.code}\n（${PLAN_LABEL[c.plan] || c.plan}・${c.trial_days}日無料）`);
  } catch (e) { alert(e.message || 'パスコードの発行に失敗しました'); }
});

// 決済設定（UnivaPay）
async function loadBillingSettings() {
  try {
    const st = await api('/billing-settings');
    document.getElementById('bs-jwt').textContent = st.jwt_set ? '設定済み' : '未設定';
    const bsAppsec = document.getElementById('bs-appsec');
    if (bsAppsec) bsAppsec.textContent = st.app_secret_set ? '設定済み' : '未設定';
    document.getElementById('bs-store').textContent = st.store_id_set ? '設定済み' : '未設定';
    document.getElementById('bs-secret').textContent = st.webhook_secret_set ? '設定済み' : '未設定';
  } catch (e) { console.error(e); }
}
document.getElementById('bs-save').addEventListener('click', async () => {
  const msg = document.getElementById('bs-msg');
  const body = {
    jwt: document.getElementById('bs-jwt-in').value.trim(),
    app_secret: (document.getElementById('bs-appsec-in') || { value: '' }).value.trim(),
    store_id: document.getElementById('bs-store-in').value.trim(),
    webhook_secret: document.getElementById('bs-secret-in').value.trim(),
  };
  if (!body.jwt && !body.app_secret && !body.store_id && !body.webhook_secret) { msg.className = 'msg err'; msg.textContent = 'いずれかの値を入力してください'; return; }
  try {
    const st = await api('/billing-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('bs-jwt-in').value = ''; document.getElementById('bs-appsec-in').value = ''; document.getElementById('bs-store-in').value = ''; document.getElementById('bs-secret-in').value = '';
    msg.className = 'msg ok';
    msg.textContent = st.enabled ? '保存しました。課金連携は有効です（Webhook受信・契約自動反映が動作します）。' : '保存しました。残りの値も設定すると課金連携が有効になります。';
    loadBillingSettings();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '保存に失敗: ' + (e.message || e); }
});

// テナント招待（初期パスワード無し→設定リンクを発行）
document.getElementById('inv-create').addEventListener('click', async () => {
  const email = document.getElementById('inv-email').value.trim();
  const name = document.getElementById('inv-name').value.trim();
  const msg = document.getElementById('inv-msg');
  if (!email) { msg.className = 'msg err'; msg.textContent = 'メールアドレスを入力してください'; return; }
  try {
    const r = await api('/tenants/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name }) });
    if (navigator.clipboard) { try { await navigator.clipboard.writeText(r.reset_url); } catch {} }
    msg.className = 'msg ok';
    msg.textContent = `作成しました（${r.email}）。パスワード設定リンク（コピー済・72時間有効）: ${r.reset_url}`;
    document.getElementById('inv-email').value = ''; document.getElementById('inv-name').value = '';
    loadTenants();
  } catch (e) { msg.className = 'msg err'; msg.textContent = '作成に失敗: ' + (e.message || e); }
});

document.getElementById('logout').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login'; });

// ===== 利用状況の見える化 =====
const HEALTH_LABEL = { follow: ['要フォロー', '#dc2626'], watch: ['様子見', '#b45309'], good: ['順調', '#0f7a6b'] };
const FEATURE_LABELS = [
  ['line_connected', 'LINE'], ['richmenu_active', 'メニュー'], ['steps', 'ステップ'],
  ['autoreplies', '自動応答'], ['bot', 'ボット'], ['forms', 'フォーム'], ['reminders', 'リマインド'], ['broadcast_used', '一斉配信'],
];

function drawSeriesChart(canvasId, rows, series) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const W = canvas.offsetWidth || 700, H = canvas.offsetHeight || 130;
  canvas.width = W * 2; canvas.height = H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.clearRect(0, 0, W, H);
  if (!rows || !rows.length) { ctx.fillStyle = '#999'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('データがまだありません', W / 2, H / 2); return; }
  const padL = 26, padB = 16, padT = 6;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key] || 0)));
  const bw = (W - padL - 4) / rows.length;
  // 目盛り
  ctx.strokeStyle = '#e2e8f0'; ctx.fillStyle = '#94a3b8'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (const f of [0, 0.5, 1]) {
    const y = padT + (H - padT - padB) * (1 - f);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - 2, y); ctx.stroke();
    ctx.fillText(String(Math.round(max * f)), padL - 4, y + 3);
  }
  // 棒（系列を横に並べる）
  const sw = Math.max(1.5, (bw - 2) / series.length);
  rows.forEach((r, i) => {
    series.forEach((s, k) => {
      const v = r[s.key] || 0;
      const h = (H - padT - padB) * (v / max);
      ctx.fillStyle = s.color;
      ctx.fillRect(padL + i * bw + k * sw, H - padB - h, Math.max(1, sw - 0.5), h);
    });
    if (i % 5 === 0) { ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.fillText(r.day.slice(5).replace('-', '/'), padL + i * bw + bw / 2, H - 4); }
  });
}

async function loadUsage() {
  const [rows, trend] = await Promise.all([api('/usage'), api('/usage/trend')]);
  drawSeriesChart('ov-chart', trend, [
    { key: 'friends', color: '#0f7a6b' }, { key: 'clicks', color: '#94a3b8' },
  ]);
  const body = document.getElementById('usage-body');
  body.textContent = '';
  if (!rows.length) { body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '7', text: 'まだ院がありません' })])); return; }
  for (const t of rows) {
    const u = t.usage;
    const tr = el('tr', { style: 'cursor:pointer' });
    const nameTd = el('td', null, [el('span', { text: t.name || '（未設定）' })]);
    if (u.webhook_stale) {
      nameTd.appendChild(el('span', {
        style: 'display:inline-block;margin-left:6px;background:#fef3c7;color:#b45309;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px',
        title: 'LINE接続済みですが、Webhookを7日以上受信していません。トークン失効や設定破壊の疑いがあります。',
        text: '⚠️LINE接続切れ疑い',
      }));
    }
    if (u.cancel_requested_at) {
      const badge = el('span', {
        style: 'display:inline-block;margin-left:6px;background:#fee2e2;color:#dc2626;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;cursor:pointer',
        title: `解約申請あり（${fmtDate(u.cancel_requested_at)}）。クリックで対応済みにします。詳細はサポート欄へ。`,
        text: '🚨解約申請',
      });
      badge.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm(`${t.name || t.email} の解約申請バッジを「対応済み」にしますか？（サポート欄での連絡をお忘れなく）`)) return;
        await api(`/tenants/${encodeURIComponent(t.id)}/clear-cancel`, { method: 'POST' });
        loadUsage();
      });
      nameTd.appendChild(badge);
    }
    tr.appendChild(nameTd);
    tr.appendChild(el('td', { text: `${PLAN_LABEL[t.plan] || t.plan}・${BILLING_LABEL[t.billing_status] || t.billing_status}` }));
    // 利用度バー＋バッジ
    const [hl, hc] = HEALTH_LABEL[u.health] || ['-', '#999'];
    const bar = el('div', { style: 'display:flex;align-items:center;gap:6px' }, [
      el('div', { style: 'width:70px;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden' }, [
        el('div', { style: `width:${u.score}%;height:100%;background:${hc}` }),
      ]),
      el('span', { style: `font-size:11px;font-weight:700;color:${hc}`, text: `${u.score} ${hl}` }),
    ]);
    tr.appendChild(el('td', null, [bar]));
    tr.appendChild(el('td', { class: 'num', text: `${fmtInt(u.friends_total)} / +${fmtInt(u.friends_30d)}` }));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(u.broadcast_sent_30d + u.step_sends_30d) }));
    const feats = el('td', { style: 'font-size:11px;line-height:1.9' });
    for (const [key, label] of FEATURE_LABELS) {
      feats.appendChild(el('span', {
        style: `display:inline-block;margin:0 4px 2px 0;padding:1px 6px;border-radius:8px;${u.features[key] ? 'background:#e7f5f1;color:#0f7a6b' : 'background:#f1f5f9;color:#b6c2cf'}`,
        text: `${u.features[key] ? '✓' : '·'}${label}`,
      }));
    }
    tr.appendChild(feats);
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(u.last_login_at) }));
    tr.addEventListener('click', async () => {
      const box = document.getElementById('usage-detail');
      document.getElementById('usage-detail-title').textContent = `📈 ${t.name || t.email} の直近30日`;
      box.style.display = '';
      const tt = await api(`/usage/${encodeURIComponent(t.id)}/trend`);
      drawSeriesChart('tenant-chart', tt, [
        { key: 'friends', color: '#0f7a6b' }, { key: 'clicks', color: '#94a3b8' }, { key: 'sends', color: '#7c3aed' },
      ]);
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    body.appendChild(tr);
  }
}

// ===== サポート対応 =====
let SUP_CURRENT = null;
const SENDER_STYLE = {
  tenant: ['院', 'background:#fff;border:1px solid #d8e5e0', 'left'],
  ai: ['AI', 'background:#eef2ff;border:1px solid #c7d2fe', 'left'],
  system: ['通知', 'background:#f8fafc;border:1px dashed #cbd5e1;color:#64748b', 'left'],
  operator: ['運営', 'background:#e7f5f1;border:1px solid #b7e0d6', 'right'],
};

function supBubble(m) {
  const [label, style, side] = SENDER_STYLE[m.sender] || SENDER_STYLE.system;
  const wrap = el('div', { style: `display:flex;justify-content:${side === 'right' ? 'flex-end' : 'flex-start'};margin-bottom:8px` });
  const d = new Date(m.created_at), p = (x) => String(x).padStart(2, '0');
  const b = el('div', { style: `max-width:85%;padding:8px 10px;border-radius:10px;font-size:13px;white-space:pre-wrap;${style}` });
  b.appendChild(el('div', { style: 'font-size:10px;color:#94a3b8;margin-bottom:2px', text: `${label} ${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}${m.escalated ? ' ✉️運営宛' : ''}` }));
  b.appendChild(document.createTextNode(m.text));
  wrap.appendChild(b);
  return wrap;
}

async function openThread(tenantId, title) {
  SUP_CURRENT = tenantId;
  const log = document.getElementById('sup-log');
  log.textContent = '';
  log.appendChild(el('div', { class: 'hint', style: 'margin-bottom:8px;font-weight:700', text: title }));
  const r = await api(`/support/${encodeURIComponent(tenantId)}`);
  for (const m of r.messages) log.appendChild(supBubble(m));
  log.scrollTop = log.scrollHeight;
  document.getElementById('sup-send').disabled = false;
  loadSupportThreads(); // 既読反映
  loadSupportKpi();
}

async function loadSupportThreads() {
  const list = await api('/support');
  const box = document.getElementById('sup-threads');
  box.textContent = '';
  if (!list.length) { box.appendChild(el('div', { class: 'empty', style: 'padding:16px', text: 'まだ問い合わせはありません' })); return; }
  for (const t of list) {
    const item = el('div', { style: `padding:10px 12px;border-bottom:1px solid #eef2f0;cursor:pointer;${t.tenant_id === SUP_CURRENT ? 'background:#f0faf7' : ''}` });
    const head = el('div', { style: 'display:flex;align-items:center;gap:6px' });
    head.appendChild(el('span', { style: 'font-weight:700;font-size:13px', text: t.name || t.email }));
    if (t.escalated_pending) head.appendChild(el('span', { style: 'background:#fef3c7;color:#b45309;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px', text: '未対応' }));
    if (t.unread > 0) head.appendChild(el('span', { style: 'background:#dc2626;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px', text: String(t.unread) }));
    item.appendChild(head);
    item.appendChild(el('div', { style: 'font-size:11px;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: t.last_text }));
    item.addEventListener('click', () => openThread(t.tenant_id, `${t.name || t.email}`));
    box.appendChild(item);
  }
}

async function loadSupportKpi() {
  try {
    const r = await api('/support/pending-count');
    document.getElementById('kpi-support').textContent = fmtInt(r.pending);
  } catch (e) { console.error(e); }
}

document.getElementById('sup-send').addEventListener('click', async () => {
  const ta = document.getElementById('sup-reply');
  const msg = document.getElementById('sup-msg');
  const text = ta.value.trim();
  if (!text || !SUP_CURRENT) return;
  try {
    await api(`/support/${encodeURIComponent(SUP_CURRENT)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    ta.value = '';
    msg.className = 'msg ok'; msg.textContent = '返信しました（院の画面とメールに届きます）';
    openThread(SUP_CURRENT, document.querySelector('#sup-log .hint') ? document.querySelector('#sup-log .hint').textContent : '');
  } catch (e) { msg.className = 'msg err'; msg.textContent = '返信に失敗: ' + (e.message || e); }
});

async function refresh() { try { await Promise.all([loadStats(), loadTenants(), loadCodes(), loadBillingSettings(), loadUsage(), loadSupportThreads(), loadSupportKpi()]); } catch (e) { console.error(e); } }
refresh();
