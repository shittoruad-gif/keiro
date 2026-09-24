'use strict';

/**
 * 運営（株式会社しっとる）への報告をLINEで送る。
 *
 * なぜ要るか（2026-09にモンテローザ様で起きたこと）:
 *   LINEの無料通数を使い切って配信が止まったとき、お知らせは「院」にだけ届いていた。
 *   院がお気づきにならなければ誰も動けず、33通が6日間届かないまま放置された。
 *   運営が先に気づいてフォローできるよう、運営あての連絡経路を別に持つ。
 *
 * なぜ専用チャネルか:
 *   【しっとる報告用】@839xovdn は 2026-09 時点で月200通を使い切っている（実測 200/200）。
 *   相乗りすると、肝心なときに送れない。Keiroの報告は専用チャネル【Keiro報告用】@667kfhsw で持つ。
 *
 * 送り先の決め方:
 *   友だち一覧API（/v2/bot/followers/ids）は未認証アカウントでは使えない（403）。
 *   そこで、報告を受けたい人がこのアカウントへ合言葉を送ると、その場所を送り先として覚える。
 *   1対1でもグループでもよい（グループなら全員が見られる）。
 *
 * 環境変数（未設定なら静かに無効。既存の動きは何も変わらない）:
 *   OPS_LINE_CHANNEL_ID     … 【Keiro報告用】のChannel ID
 *   OPS_LINE_CHANNEL_SECRET … 同 Channel secret（トークンの自動発行と署名検証に使う）
 *   OPS_LINE_TOKEN          … トークンを直接指定したいときだけ（通常は自動発行）
 *   OPS_LINE_TO             … 合言葉での登録が済むまでの暫定の送り先
 *
 * ⚠️ この通知もこのチャネルの通数を1通使う（月200通）。院の通数とは別枠。
 */
const config = require('./config');
const logger = require('./logger');
const appsettings = require('./appsettings');

const TOKEN_KEY = 'ops_line_token';
const TOKEN_EXP_KEY = 'ops_line_token_expires_at';
const TO_KEY = 'ops_line_to';
const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000; // 期限の7日前で入れ替える

/** 合言葉。これをアカウントへ送ると、その場所が報告先になる。 */
const CLAIM_WORDS = ['報告先登録', '通知先登録', '登録'];

function configured() {
  return Boolean(config.opsLine.token || (config.opsLine.channelId && config.opsLine.channelSecret));
}

/** 送り先。合言葉で登録されたものを優先し、無ければ環境変数。 */
function getTo(db) {
  const saved = db ? appsettings.getValue(db, TO_KEY) : null;
  return saved || config.opsLine.to || '';
}

function enabled(db) {
  return Boolean(configured() && getTo(db));
}

/**
 * 送信に使うトークンを返す。期限が近ければ発行し直して保存する。
 * env で直接指定されていればそれを使う（更新しない）。
 */
async function getToken(db, opts = {}) {
  if (config.opsLine.token) return config.opsLine.token;
  if (!db || !config.opsLine.channelId || !config.opsLine.channelSecret) return '';
  const now = opts.now || Date.now();
  const saved = appsettings.getValue(db, TOKEN_KEY);
  const exp = Number(appsettings.getValue(db, TOKEN_EXP_KEY) || 0);
  if (saved && exp - now > RENEW_BEFORE_MS) return saved;

  const issue = opts.issue || require('./line').issueChannelAccessToken;
  const r = await issue(config.opsLine.channelId, config.opsLine.channelSecret);
  if (!r || !r.ok) {
    logger.warn('ops line: トークンを発行できませんでした', { reason: (r && r.error) || null });
    return saved || ''; // 期限切れ間近でも、あるものは使ってみる
  }
  appsettings.setValue(db, TOKEN_KEY, r.accessToken);
  appsettings.setValue(db, TOKEN_EXP_KEY, String(now + (r.expiresIn || 30 * 24 * 3600) * 1000));
  logger.info('ops line: トークンを発行しました', { expires_in: r.expiresIn });
  return r.accessToken;
}

/**
 * 合言葉を受け取って、その場所を報告先として覚える。
 * @returns {{ok:boolean, to?:string, replyText?:string}}
 */
function claimFrom(db, event) {
  const text = String((event && event.message && event.message.text) || '').trim();
  if (!CLAIM_WORDS.includes(text)) return { ok: false };
  const src = (event && event.source) || {};
  const to = src.groupId || src.roomId || src.userId || '';
  if (!to) return { ok: false };
  appsettings.setValue(db, TO_KEY, to);
  logger.info('ops line: 報告先を登録しました', { kind: src.groupId ? 'group' : src.roomId ? 'room' : 'user' });
  return {
    ok: true,
    to,
    replyText: 'Keiroの報告先として、この場所を登録しました。\n\n通数が残りわずかになったときと、使い切って配信が止まったときにお知らせします。',
  };
}

/**
 * 運営へ1通送る。設定が無ければ何もしない（呼び出し側で分岐しなくてよい）。
 * @param {string} text 本文
 * @param {object} [opts] { db, push } テスト用の差し替え
 */
async function notifyOps(text, opts = {}) {
  const db = opts.db || null;
  const to = getTo(db);
  if (!configured() || !to) return { ok: false, skipped: true, reason: '報告用LINE未設定' };
  const token = opts.token || await getToken(db, opts);
  if (!token) return { ok: false, skipped: true, reason: 'トークンなし' };
  const push = opts.push || require('./line').pushMessage;
  try {
    const r = await push(token, to, String(text || '').slice(0, 4900));
    if (!r || r.ok === false) {
      logger.warn('ops notify failed', { http_status: (r && r.http_status) || null });
      return { ok: false, reason: (r && r.response) || 'push失敗' };
    }
    return { ok: true };
  } catch (e) {
    logger.warn('ops notify error', { err: String((e && e.message) || e) });
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

module.exports = { enabled, configured, notifyOps, getToken, getTo, claimFrom, CLAIM_WORDS, TO_KEY, TOKEN_KEY, TOKEN_EXP_KEY };
