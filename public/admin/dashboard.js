'use strict';

// 管理APIはBasic認証。ブラウザが /admin で得た資格情報を /api でも再利用する（realm一致が前提）。
async function api(path, opts) {
  const res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin' }, opts));
  if (!res.ok) throw new Error('API ' + path + ' -> ' + res.status);
  return res.status === 204 ? null : res.json();
}

const fmtInt = (n) => (n == null ? '–' : Number(n).toLocaleString('ja-JP'));
const fmtPct = (r) => (r == null ? '–' : (r * 100).toFixed(1) + '%');

function fmtDate(ms) {
  if (!ms) return '–';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  if (children) for (const c of children) e.appendChild(c);
  return e;
}

async function loadStats() {
  const s = await api('/stats');
  document.getElementById('kpi-clicks').textContent = fmtInt(s.clicks);
  document.getElementById('kpi-follows').textContent = fmtInt(s.follows);
  document.getElementById('kpi-rate').textContent = fmtPct(s.match_rate);
  document.getElementById('kpi-pb').textContent = `${fmtInt(s.postbacks_ok)} / ${fmtInt(s.postbacks_total)}`;
}

function copyButton(url) {
  const btn = el('button', { class: 'copy', type: 'button', title: url, text: url });
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      const old = btn.textContent;
      btn.textContent = 'コピーしました';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1200);
    } catch {
      window.prompt('コピーしてください', url);
    }
  });
  return btn;
}

async function loadLinks() {
  const rows = await api('/links');
  const body = document.getElementById('links-body');
  body.textContent = '';
  if (!rows.length) {
    body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '6', text: 'まだありません' })]));
    return;
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', null, [el('div', { text: r.name }),
      el('div', { class: 'muted', text: [r.campaign, r.creative].filter(Boolean).join(' / ') || '' })]));
    tr.appendChild(el('td', null, [copyButton(r.track_url)]));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(r.clicks) }));
    tr.appendChild(el('td', { class: 'num', text: fmtInt(r.follows) }));
    tr.appendChild(el('td', { class: 'num', text: fmtPct(r.cvr) }));
    const del = el('button', { class: 'del', type: 'button', text: '削除' });
    del.addEventListener('click', async () => {
      if (!confirm(`「${r.name}」を削除しますか？`)) return;
      await api('/links/' + encodeURIComponent(r.id), { method: 'DELETE' });
      refresh();
    });
    tr.appendChild(el('td', null, [del]));
    body.appendChild(tr);
  }
}

async function loadFollows() {
  const rows = await api('/follows?limit=50');
  const body = document.getElementById('follows-body');
  body.textContent = '';
  if (!rows.length) {
    body.appendChild(el('tr', null, [el('td', { class: 'empty', colspan: '5', text: 'まだありません' })]));
    return;
  }
  const labels = { matched: '紐づけ済', pending: '保留', unmatched: '未紐づけ' };
  for (const r of rows) {
    const tr = el('tr');
    const status = el('span', { class: 'status' }, [
      el('span', { class: 'dot ' + r.status }),
      el('span', { text: labels[r.status] || r.status }),
    ]);
    tr.appendChild(el('td', null, [status]));
    tr.appendChild(el('td', { class: 'mono', text: r.line_user_id_short || '–' }));
    tr.appendChild(el('td', null, [el('span', { class: 'method', text: r.match_method || '–' })]));
    tr.appendChild(el('td', { text: r.link_name || '–' }));
    tr.appendChild(el('td', { class: 'mono', text: fmtDate(r.created_at) }));
    body.appendChild(tr);
  }
}

async function refresh() {
  try {
    await Promise.all([loadStats(), loadLinks(), loadFollows()]);
  } catch (e) {
    console.error(e);
  }
}

document.getElementById('link-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const msg = document.getElementById('link-msg');
  const payload = {
    name: f.name.value.trim(),
    oa_add_url: f.oa_add_url.value.trim(),
    media: f.media.value.trim(),
    campaign: f.campaign.value.trim(),
    creative: f.creative.value.trim(),
  };
  try {
    const r = await api('/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    msg.textContent = '作成しました: ' + r.track_url;
    f.reset();
    refresh();
  } catch (e) {
    msg.textContent = '作成に失敗しました: ' + e.message;
  }
});

document.getElementById('refresh').addEventListener('click', refresh);
refresh();
