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

/** 事前構築した messages 配列を replyToken で返信（クイックリプライ等の任意メッセージ用）。 */
async function replyMessages(accessToken, replyToken, messages) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetch(REPLY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ replyToken, messages: (messages || []).slice(0, 5) }),
    });
    const respText = await res.text();
    return { ok: res.ok, http_status: res.status, response: respText };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

/** 事前構築した messages 配列を push（クイックリプライ等の任意メッセージ用）。 */
async function pushMessages(accessToken, toUserId, messages) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetch(PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: toUserId, messages: (messages || []).slice(0, 5) }),
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

// ---- リッチメニュー ----
const RICHMENU_API = 'https://api.line.me/v2/bot/richmenu';
const RICHMENU_DATA = 'https://api-data.line.me/v2/bot/richmenu';

/** リッチメニュー本体を作成。成功で {ok, richMenuId} を返す。 */
async function createRichMenu(accessToken, menuObject) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetch(RICHMENU_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(menuObject),
    });
    const text = await res.text();
    let id = null; try { id = JSON.parse(text).richMenuId; } catch {}
    return { ok: res.ok, http_status: res.status, richMenuId: id, response: text };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** リッチメニュー画像をアップロード（content host）。imageBuffer はPNG/JPEGのバイト列。 */
async function uploadRichMenuImage(accessToken, richMenuId, imageBuffer, contentType) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetch(`${RICHMENU_DATA}/${richMenuId}/content`, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'image/png', Authorization: `Bearer ${accessToken}` },
      body: imageBuffer,
    });
    const text = await res.text();
    return { ok: res.ok, http_status: res.status, response: text };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** 全友だちのデフォルトリッチメニューに設定。 */
async function setDefaultRichMenu(accessToken, richMenuId) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    return { ok: res.ok, http_status: res.status, response: text };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** デフォルトリッチメニュー解除。 */
async function clearDefaultRichMenu(accessToken) {
  if (!accessToken) return { ok: false, skipped: true };
  try {
    const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
      method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { ok: res.ok, http_status: res.status };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** リッチメニュー削除。 */
async function deleteRichMenu(accessToken, richMenuId) {
  if (!accessToken || !richMenuId) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${RICHMENU_API}/${richMenuId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { ok: res.ok, http_status: res.status };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/**
 * 当月のメッセージ配信数と上限を取得（LINE公式の無料枠監視用）。
 * quota: {type:'limited', value:200} または {type:'none'}（無制限）
 * consumption: {totalUsage: N}
 */
async function getMessageQuota(accessToken) {
  if (!accessToken) return null;
  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const [qRes, cRes] = await Promise.all([
      fetch('https://api.line.me/v2/bot/message/quota', { headers }),
      fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers }),
    ]);
    if (!qRes.ok || !cRes.ok) return null;
    const quota = await qRes.json();
    const consumption = await cRes.json();
    return {
      limit: quota.type === 'limited' ? quota.value : null, // null=無制限プラン
      used: consumption.totalUsage || 0,
    };
  } catch { return null; }
}

module.exports = {
  replyGreeting, replyText, replyMessages, pushMessage, pushMessages, multicast, getProfile,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, clearDefaultRichMenu, deleteRichMenu,
  getMessageQuota,
};
