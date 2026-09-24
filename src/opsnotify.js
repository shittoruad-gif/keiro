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
 *   相乗りすると、肝心なときに送れない。Keiroの報告は独立したチャネルで持つ。
 *
 * 環境変数（未設定なら静かに無効。既存の動きは何も変わらない）:
 *   OPS_LINE_TOKEN … Keiro報告用チャネルのアクセストークン
 *   OPS_LINE_TO    … 送り先（三上様のユーザーID U… またはグループID C…）
 *
 * ⚠️ この通知自体もそのチャネルの通数を1通使う。院の通数とは別枠。
 */
const config = require('./config');
const logger = require('./logger');

function enabled() {
  return Boolean(config.opsLine.token && config.opsLine.to);
}

/**
 * 運営へ1通送る。設定が無ければ何もしない（呼び出し側で分岐しなくてよい）。
 * @param {string} text 本文
 * @param {object} [opts] { push } テスト用の差し替え
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string}>}
 */
async function notifyOps(text, opts = {}) {
  if (!enabled()) return { ok: false, skipped: true, reason: '報告用LINE未設定' };
  const push = opts.push || require('./line').pushMessage;
  try {
    const r = await push(config.opsLine.token, config.opsLine.to, String(text || '').slice(0, 4900));
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

module.exports = { enabled, notifyOps };
