'use strict';

/** クライアントIPを取得。プロキシ(Traefik/ngrok等)経由を考慮し X-Forwarded-For を優先。 */
function getIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const raw = (req.ip || (req.socket && req.socket.remoteAddress) || '');
  return raw.replace(/^::ffff:/, '') || null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { getIp, escapeHtml };
