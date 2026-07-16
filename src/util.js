'use strict';

/**
 * クライアントIPを取得。Express の `trust proxy`（=信頼するプロキシ段数）に基づき
 * 計算済みの req.ip を使う。X-Forwarded-For 先頭をそのまま信じると、クライアントが
 * 偽ヘッダを付けてレート制限を回避できるため、生ヘッダは参照しない。
 */
function getIp(req) {
  const raw = (req.ip || (req.socket && req.socket.remoteAddress) || '');
  return raw.replace(/^::ffff:/, '') || null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { getIp, escapeHtml };
