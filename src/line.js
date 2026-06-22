'use strict';

const config = require('./config');

const REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';

/**
 * 友だち追加のお礼＋claimリンク入りの挨拶を返信する。
 * LINE公式の「あいさつメッセージ」はOFF前提（本ツールがclaim付き挨拶を送るため）。
 * @param {string} replyToken
 * @param {string} claimUrl  署名付きトークン入りのclaim URL
 */
async function replyGreeting(replyToken, claimUrl) {
  if (!config.line.channelAccessToken) {
    return { ok: false, skipped: true, reason: 'LINE_CHANNEL_ACCESS_TOKEN 未設定' };
  }
  const text =
    '友だち追加ありがとうございます！\n' +
    '下のリンクを一度タップして登録を完了してください👇\n' +
    claimUrl;

  const body = {
    replyToken,
    messages: [{ type: 'text', text }],
  };

  try {
    const res = await fetch(REPLY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.line.channelAccessToken}`,
      },
      body: JSON.stringify(body),
    });
    const respText = await res.text();
    return { ok: res.ok, http_status: res.status, response: respText };
  } catch (e) {
    return { ok: false, http_status: 0, response: String(e && e.message || e) };
  }
}

module.exports = { replyGreeting };
