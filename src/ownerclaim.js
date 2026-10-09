'use strict';

/**
 * 「合言葉を自店LINEへ送った人を、お店への通知先にする」仕組み。
 *
 * なぜ作り直したか（2026-10-09 発見）:
 *   旧実装は、合言葉が一致すれば**登録済みでも無条件に通知先を上書き**していた。
 *   モンテローザ様の合言葉は「通知先登録」のまま有効で、友だち48人の誰かが偶然送ると、
 *   以後の予約（お名前・電話番号）と問い合わせがその人に届き、店主の方には届かなくなる状態だった。
 *   （実際の乗っ取りは無し。送った記録は 2026-09-07 の店主ご本人の1件のみ）
 *
 * いまの決まり:
 *   1. 合言葉は1回使ったら消える
 *   2. 通知先が登録済みなら、合言葉では上書きできない
 *      ただし管理画面から新しく発行した合言葉（issued_at あり・24時間有効）だけは、変更として受け付ける
 *   3. 発行する合言葉は推測できない文字列にする（「通知先登録-XXXX」）
 *   合言葉が条件を満たさないときは、何も起きなかったことにする（ふつうのメッセージとして扱う）。
 *   「すでに登録されています」と返すと、合言葉の存在をお客様に知らせてしまうため。
 */
const crypto = require('crypto');

const ISSUED_TTL_MS = 24 * 3600 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O・1/I は使わない

function newCode() {
  let s = '';
  for (const b of crypto.randomBytes(4)) s += ALPHABET[b % ALPHABET.length];
  return `通知先登録-${s}`;
}

/** 管理画面から合言葉を発行する。登録済みの通知先を変えたいときにも使う（24時間有効）。 */
function issueCode(db, tenantId, now = Date.now()) {
  const code = newCode();
  db.prepare('UPDATE tenants SET owner_claim_code = ?, owner_claim_issued_at = ?, updated_at = ? WHERE id = ?')
    .run(code, now, now, tenantId);
  return { code, expiresAt: now + ISSUED_TTL_MS };
}

/**
 * 受け取ったメッセージが合言葉なら、通知先として登録する。
 * @returns {null | {claimed:true, replyText:string}} 合言葉として扱わないときは null
 */
function tryClaim(db, tenant, lineUserId, text, now = Date.now()) {
  if (!tenant || !tenant.owner_claim_code || !lineUserId) return null;
  if (String(text || '').trim() !== String(tenant.owner_claim_code).trim()) return null;

  const issuedAt = Number(tenant.owner_claim_issued_at || 0);
  const freshlyIssued = issuedAt > 0 && now - issuedAt <= ISSUED_TTL_MS;
  if (tenant.owner_line_user_id && !freshlyIssued) return null; // 登録済みは上書きしない
  if (issuedAt > 0 && !freshlyIssued) return null;              // 期限切れの合言葉

  db.prepare('UPDATE tenants SET owner_line_user_id = ?, owner_claim_code = NULL, owner_claim_issued_at = NULL, updated_at = ? WHERE id = ?')
    .run(lineUserId, now, tenant.id);
  tenant.owner_line_user_id = lineUserId;
  tenant.owner_claim_code = null;
  tenant.owner_claim_issued_at = null;
  return {
    claimed: true,
    replyText: 'このLINEを、お店への通知先として登録しました。\n予約やお問い合わせが届くと、ここにお知らせします。',
  };
}

module.exports = { issueCode, tryClaim, newCode, ISSUED_TTL_MS };
