'use strict';

const REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';
const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
const LINE_TIMEOUT_MS = 10000;

/** タイムアウト付き fetch。LINE APIのハングでスケジューラ全体が止まるのを防ぐ。 */
async function fetchLine(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINE_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal }, options));
  } finally {
    clearTimeout(timer);
  }
}

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
    '友だち追加ありがとうございます🎁\n' +
    '【特典の受け取り準備】下のリンクを一度タップしてください👇\n' +
    claimUrl + '\n' +
    '（タップ後、すぐにご案内が届きます）';

  const body = { replyToken, messages: [{ type: 'text', text }] };

  try {
    const res = await fetchLine(REPLY_ENDPOINT, {
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
    const res = await fetchLine(PUSH_ENDPOINT, {
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
    const res = await fetchLine(REPLY_ENDPOINT, {
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
    const res = await fetchLine(REPLY_ENDPOINT, {
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
    const res = await fetchLine(PUSH_ENDPOINT, {
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
 * messagesOrText: 文字列（テキスト1通）または messages 配列（画像添付等）。
 * @returns {{ok, http_status, response}}
 */
async function multicast(accessToken, toUserIds, messagesOrText) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  if (!toUserIds || !toUserIds.length) return { ok: true, http_status: 200, response: 'no recipients' };
  const messages = typeof messagesOrText === 'string'
    ? [{ type: 'text', text: messagesOrText }]
    : (messagesOrText || []).slice(0, 5);
  try {
    const res = await fetchLine(MULTICAST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ to: toUserIds.slice(0, 500), messages }),
    });
    const respText = await res.text();
    return { ok: res.ok, http_status: res.status, response: respText };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

/** テキスト＋任意の画像1枚からLINEのmessages配列を組み立てる（配信共通）。 */
function buildTextImageMessages(text, imageUrl) {
  const messages = [];
  if (text) messages.push({ type: 'text', text });
  if (imageUrl && /^https:\/\//.test(imageUrl)) {
    messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  }
  return messages;
}

/** 友だちの表示名などプロフィール取得（best-effort）。 */
async function getProfile(accessToken, userId) {
  if (!accessToken) return null;
  try {
    const res = await fetchLine(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/**
 * Botの基本情報を取得（接続テスト用）。アクセストークンが有効なら200＋Bot情報。
 * @returns {{ok:boolean, http_status:number, info?:object, response?:string}}
 */
async function getBotInfo(accessToken) {
  if (!accessToken) return { ok: false, http_status: 0, reason: 'アクセストークン未設定' };
  try {
    const res = await fetchLine('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    let info = null; try { info = JSON.parse(text); } catch {}
    return { ok: res.ok, http_status: res.status, info, response: text };
  } catch (e) {
    return { ok: false, http_status: 0, response: String((e && e.message) || e) };
  }
}

// ---- リッチメニュー ----
const RICHMENU_API = 'https://api.line.me/v2/bot/richmenu';
const RICHMENU_DATA = 'https://api-data.line.me/v2/bot/richmenu';

/** リッチメニュー本体を作成。成功で {ok, richMenuId} を返す。 */
async function createRichMenu(accessToken, menuObject) {
  if (!accessToken) return { ok: false, skipped: true, reason: 'アクセストークン未設定' };
  try {
    const res = await fetchLine(RICHMENU_API, {
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
    const res = await fetchLine(`${RICHMENU_DATA}/${richMenuId}/content`, {
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
    const res = await fetchLine(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
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
    const res = await fetchLine('https://api.line.me/v2/bot/user/all/richmenu', {
      method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { ok: res.ok, http_status: res.status };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** リッチメニュー削除。 */
async function deleteRichMenu(accessToken, richMenuId) {
  if (!accessToken || !richMenuId) return { ok: false, skipped: true };
  try {
    const res = await fetchLine(`${RICHMENU_API}/${richMenuId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { ok: res.ok, http_status: res.status };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** 特定ユーザーへリッチメニューを個別リンク（タグ別出し分け用）。 */
async function linkRichMenuToUser(accessToken, userId, richMenuId) {
  if (!accessToken || !userId || !richMenuId) return { ok: false, skipped: true };
  try {
    const res = await fetchLine(`https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${richMenuId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { ok: res.ok, http_status: res.status };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** 特定ユーザーの個別リッチメニューを解除（デフォルトに戻す）。 */
async function unlinkRichMenuFromUser(accessToken, userId) {
  if (!accessToken || !userId) return { ok: false, skipped: true };
  try {
    const res = await fetchLine(`https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { ok: res.ok, http_status: res.status };
  } catch (e) { return { ok: false, http_status: 0, response: String((e && e.message) || e) }; }
}

/** 複数ユーザーへ一括リンク（最大500件/回）。 */
async function bulkLinkRichMenu(accessToken, userIds, richMenuId) {
  if (!accessToken || !richMenuId || !userIds || !userIds.length) return { ok: false, skipped: true };
  try {
    const res = await fetchLine(`${RICHMENU_API}/bulk/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ richMenuId, userIds: userIds.slice(0, 500) }),
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
  buildTextImageMessages,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, clearDefaultRichMenu, deleteRichMenu,
  linkRichMenuToUser, unlinkRichMenuFromUser, bulkLinkRichMenu,
  getMessageQuota, getBotInfo,
};
