'use strict';

// login/signup 共通。指定エンドポイントへPOSTし、成功で /app（operatorは/operator）へ遷移。
function initAuth(endpoint) {
  const form = document.getElementById('form');
  const msg = document.getElementById('msg');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.className = 'msg'; msg.textContent = '送信中…';
    const payload = {};
    for (const el of form.elements) if (el.name) payload[el.name] = el.value;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { msg.className = 'msg err'; msg.textContent = data.error || 'エラーが発生しました'; return; }
      if (data.code_error) alert('登録は完了しましたが、パスコードを適用できませんでした：\n' + data.code_error + '\n\n（パスコードは、このあとの画面からも入力できます）');
      location.href = data.role === 'operator' ? '/operator' : '/app';
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = '通信エラー: ' + e.message;
    }
  });
}
