'use strict';

// メール送信（Resend API）。RESEND_API_KEY 未設定なら送信をスキップ（ログのみ）。
const config = require('./config');
const logger = require('./logger');

async function sendMail({ to, subject, text, html }) {
  const key = config.mail.resendApiKey;
  if (!key) {
    logger.warn('mail skipped (RESEND_API_KEY未設定)', { to, subject });
    return { ok: false, skipped: true, reason: 'RESEND_API_KEY未設定' };
  }
  if (!to) return { ok: false, skipped: true, reason: '宛先なし' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: config.mail.from, to: [to], subject, text, html: html || undefined }),
    });
    const body = await res.text();
    if (!res.ok) logger.warn('mail send failed', { to, http_status: res.status, body: String(body).slice(0, 200) });
    return { ok: res.ok, http_status: res.status, response: body };
  } catch (e) {
    logger.error('mail error', { err: String((e && e.message) || e) });
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

module.exports = { sendMail };
