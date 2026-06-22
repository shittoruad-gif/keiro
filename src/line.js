'use strict';

const REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';

/**
 * 友だち追加のお礼＋claimリンク入りの挨拶を返信する（院ごとのアクセストークンで送信）。
 * LINE公式の「あいさつメッセージ」はOFF前提。
 * @param {string} accessToken  院のLINE_CHANNEL_ACCESS_TOKEN
 * @param {string} replyToken
 * @param {string} claimUrl     署名付きトークン入りのclaim URL
 */
async function replyGreeting(accessToken, replyToken, claimUrl) {
  if (!accessToken) {
    return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  }
  const text =
    '友だち追加ありがとうございます！\n' +
    '下のリンクを一度タップして登録を完了してください👇\n' +
    claimUrl;

  const body = { replyToken, messages: [{ type: 'text', text }] };

  try {
    const res = await fetch(REPLY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    const respText = await res.text();
    return { ok: res.ok, http_status: res.status, response: respText };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

module.exports = { replyGreeting };
