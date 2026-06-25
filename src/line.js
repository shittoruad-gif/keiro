'use strict';

const REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';
const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

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

/**
 * push送信（ステップ配信用）。指定ユーザーへテキストを1通送る。
 * @param {string} accessToken 院のLINE_CHANNEL_ACCESS_TOKEN
 * @param {string} toUserId    送信先 line_user_id
 * @param {string} text
 */
async function pushMessage(accessToken, toUserId, text) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetch(PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: toUserId, messages: [{ type: 'text', text }] }),
    });
    const respText = await res.text();
    return { ok: res.ok, http_status: res.status, response: respText };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

/** 任意テキストを replyToken で返信（キーワード自動応答用）。 */
async function replyText(accessToken, replyToken, text) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetch(REPLY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
    const respText = await res.text();
    return { ok: res.ok, http_status: res.status, response: respText };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

const MULTICAST_ENDPOINT = 'https://api.line.me/v2/bot/message/multicast';

/**
 * 複数ユーザーへ同一メッセージを送る（一斉/セグメント配信用）。最大500件/回。
 * @returns {{ok, http_status, response}}
 */
async function multicast(accessToken, toUserIds, text) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  if (!toUserIds || !toUserIds.length) return { ok: true, http_status: 200, response: 'no recipients' };
  try {
    const res = await fetch(MULTICAST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: toUserIds.slice(0, 500), messages: [{ type: 'text', text }] }),
    });
    const respText = await res.text();
    return { ok: res.ok, http_status: res.status, response: respText };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

/** 友だちの表示名などプロフィール取得（best-effort）。 */
async function getProfile(accessToken, userId) {
  if (!accessToken) return null;
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

module.exports = { replyGreeting, replyText, pushMessage, multicast, getProfile };
