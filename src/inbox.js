'use strict';

// 1:1チャット受信箱（Lステップの「個別トーク」相当）。
// 受信テキストはwebhookで全プラン保存し、閲覧・返信APIをプロ限定にする
// （ライト→プロへ変更した際に過去の会話が見えるようにするため）。
const { newId } = require('./sign');
const line = require('./line');
const friends = require('./friends');

function saveMessage(db, { tenantId, lineUserId, direction, text }) {
  const id = newId('im');
  db.prepare(
    `INSERT INTO inbox_messages (id, tenant_id, line_user_id, direction, text, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, lineUserId, direction === 'out' ? 'out' : 'in', String(text).slice(0, 5000),
    direction === 'out' ? 1 : 0, Date.now());
  return id;
}

/** スレッド一覧（友だちごとの最新メッセージ＋未読数）。 */
function listThreads(db, tenantId, limit = 100) {
  return db.prepare(
    `SELECT m.line_user_id,
            (SELECT text FROM inbox_messages WHERE tenant_id = ? AND line_user_id = m.line_user_id ORDER BY created_at DESC LIMIT 1) AS last_text,
            MAX(m.created_at) AS last_at,
            SUM(CASE WHEN m.direction = 'in' AND m.read = 0 THEN 1 ELSE 0 END) AS unread,
            f.display_name, f.tags
     FROM inbox_messages m
     LEFT JOIN friends f ON f.tenant_id = m.tenant_id AND f.line_user_id = m.line_user_id
     WHERE m.tenant_id = ?
     GROUP BY m.line_user_id
     ORDER BY last_at DESC LIMIT ?`
  ).all(tenantId, tenantId, limit);
}

function listMessages(db, tenantId, lineUserId, limit = 200) {
  return db.prepare(
    `SELECT id, direction, text, created_at FROM inbox_messages
     WHERE tenant_id = ? AND line_user_id = ? ORDER BY created_at ASC LIMIT ?`
  ).all(tenantId, lineUserId, limit);
}

function markRead(db, tenantId, lineUserId) {
  db.prepare("UPDATE inbox_messages SET read = 1 WHERE tenant_id = ? AND line_user_id = ? AND direction = 'in'")
    .run(tenantId, lineUserId);
}

function unreadCount(db, tenantId) {
  return db.prepare("SELECT COUNT(*) n FROM inbox_messages WHERE tenant_id = ? AND direction = 'in' AND read = 0")
    .get(tenantId).n;
}

/** 返信を送信し会話ログに残す。 */
async function sendReply(db, tenant, settings, lineUserId, text) {
  const token = settings.line.channelAccessToken;
  if (!token) return { error: 'LINEのアクセストークンが未設定です' };
  const r = await line.pushMessage(token, lineUserId, String(text).slice(0, 2000));
  if (!r.ok) return { error: `送信に失敗しました（HTTP ${r.http_status}）` };
  saveMessage(db, { tenantId: tenant.id, lineUserId, direction: 'out', text });
  return { ok: true };
}

/**
 * お店に知らせる必要のない「決まった言葉」か。
 * メニューのボタン・自動応答の言葉・会話ボットの合言葉・通知先登録の合言葉と完全一致するものは、
 * 自動で返事が済んでいるので店主の方へは知らせない。
 *
 * なぜ要るか（2026-09 モンテローザ様の実例）:
 *   受信96件のうち95件がメニューのボタンで、通知43回がすべてボタン押下がきっかけだった。
 *   唯一の本当の問い合わせ「今日ホールケーキが欲しいのですが…」は、18分前のボタン押下に
 *   30分の間引き枠を取られて通知されなかった。ボタン押下の通知は通数も消費していた。
 *   ※自動応答の言葉を「含む」だけの文（例: 支払い方法を教えて）は、お客様が書いた文なので知らせる。
 */
function isCannedText(db, tenant, text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (tenant && tenant.owner_claim_code && t === String(tenant.owner_claim_code).trim()) return true;
  try {
    if (db.prepare('SELECT 1 FROM autoreplies WHERE tenant_id = ? AND active = 1 AND TRIM(keyword) = ? LIMIT 1').get(tenant.id, t)) return true;
  } catch (e) { /* 表が無い古いDBでは判定しない */ }
  try {
    if (db.prepare("SELECT 1 FROM bot_flows WHERE tenant_id = ? AND trigger_type = 'keyword' AND TRIM(trigger_keyword) = ? LIMIT 1").get(tenant.id, t)) return true;
  } catch (e) { /* noop */ }
  try {
    for (const m of db.prepare("SELECT config_json FROM rich_menus WHERE tenant_id = ? AND status = 'active'").all(tenant.id)) {
      const cells = (JSON.parse(m.config_json || '{}').cells || []);
      if (cells.some((c) => c && c.action_type === 'message' && String(c.action_value || '').trim() === t)) return true;
    }
  } catch (e) { /* noop */ }
  return false;
}

// 同じお客様から続けて届いたときだけ、10分に1回へまとめる（別のお客様の質問は必ず知らせる）。
const NOTICE_GAP_PER_CUSTOMER_MS = 10 * 60 * 1000;
const lastNoticeAt = new Map();

/** このお客様の書き込みを、今お店に知らせてよいか。知らせるなら時刻を記録する。 */
function shouldNotify(tenantId, lineUserId, now = Date.now()) {
  const key = `${tenantId}:${lineUserId || ''}`;
  const last = lastNoticeAt.get(key) || 0;
  if (now - last < NOTICE_GAP_PER_CUSTOMER_MS) return false;
  lastNoticeAt.set(key, now);
  if (lastNoticeAt.size > 5000) lastNoticeAt.clear(); // 長く動かしても膨らまないように
  return true;
}

module.exports = { saveMessage, listThreads, listMessages, markRead, unreadCount, sendReply, isCannedText, shouldNotify, NOTICE_GAP_PER_CUSTOMER_MS };
