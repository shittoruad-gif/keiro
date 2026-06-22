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

document.getElementById('logout').addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); location.href = '/login'; });

async function refresh() { try { await Promise.all([loadStats(), loadTenants()]); } catch (e) { console.error(e); } }
refresh();
