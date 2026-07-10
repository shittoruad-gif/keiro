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
    tr.appendChild(el('td', null, [btn]));
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

document.getElementById('logout').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login'; });

async function refresh() { try { await Promise.all([loadStats(), loadTenants(), loadCodes()]); } catch (e) { console.error(e); } }
refresh();
