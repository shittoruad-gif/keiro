'use strict';

/**
 * 新規登録（お申込み）があったことを、株式会社しっとるの事務グループへ知らせる。
 *
 * なぜ要るか（2026-10-18 三上様）:
 *   Keiroは院ご自身で登録できるため、登録があっても運営は誰も気づけなかった。
 *   「フォームの入力があったら【しっとる報告用】公式LINEから通知・対応スタッフ名も」とのご指示。
 *
 * なぜ直接LINEに送らないか:
 *   【しっとる報告用】の鍵を契約管理（keiyaku.s-toru.com）の1か所だけに置くため。
 *   Keiroは契約管理の受け口 /api/intake-notify に「申込がありました」と知らせるだけにする。
 *
 * 環境変数（未設定なら静かに何もしない。登録の処理は一切止めない）:
 *   INTAKE_NOTIFY_URL    … 例 https://keiyaku.s-toru.com/api/intake-notify
 *   INTAKE_NOTIFY_SECRET … 契約管理と同じ合言葉（リポジトリには書かない）
 *   INTAKE_NOTIFY_STAFF  … 対応スタッフ名（既定「白神さん」）
 */
const logger = require('./logger');

function configured() {
  return !!(process.env.INTAKE_NOTIFY_URL && process.env.INTAKE_NOTIFY_SECRET);
}

/** 通知の本文行（テストしやすいよう分けておく）。パスワードは絶対に入れない。 */
function buildLines({ name, email, codeApplied, codeError }) {
  const lines = [
    `院名: ${String(name || '（未入力）').slice(0, 60)}`,
    `メール: ${String(email || '').slice(0, 80)}`,
  ];
  if (codeApplied) lines.push('パスコード: 適用済み（公式LINE構築のお客様の可能性）');
  else if (codeError) lines.push(`パスコード: 入力あり・適用できず（${String(codeError).slice(0, 40)}）`);
  lines.push('管理画面で登録内容をご確認ください。');
  return lines;
}

/** 登録の応答を待たせないよう、呼び出し側では await しない（失敗はログだけ）。 */
async function notifySignup(info, { fetchFn = fetch } = {}) {
  if (!configured()) return { skipped: true };
  try {
    const res = await fetchFn(process.env.INTAKE_NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Intake-Secret': process.env.INTAKE_NOTIFY_SECRET },
      body: JSON.stringify({
        service: 'Keiro',
        staff: process.env.INTAKE_NOTIFY_STAFF || '白神さん',
        lines: buildLines(info),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) logger.warn('intake notify not ok', { status: res.status });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    logger.warn('intake notify error', { err: String((e && e.message) || e) });
    return { ok: false };
  }
}

module.exports = { notifySignup, buildLines, configured };
