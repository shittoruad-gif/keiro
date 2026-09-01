'use strict';

/**
 * しっとる通知ハブ（notify.s-toru.com）への送信。
 *
 * なぜ使うか:
 *   月次レポートはこれまでメールだけだった。メールは開かれないことが多く、
 *   「使っている実感」を届けるという目的を果たしきれていない。
 *   LINEなら開封される。ただし院ごとにLINEチャネルを用意すると、
 *   ご契約のたびに設定作業が発生する（＝人件費が乗る）。
 *   そこで、しっとる共通の「お知らせ用」公式LINEを1つだけ持つハブに寄せる。
 *   Keiroは「どのご契約（code）へ、どんな本文を」だけ伝えればよい。
 *
 *   注意: ここで言うLINEは「しっとるからお客様（院長）へのお知らせ」用。
 *   院が自分の患者さんへ送るLINE（Keiro本来の機能）とは別物。混同しないこと。
 *
 * 環境変数（未設定なら静かに無効。既存の動きは何も変わらない）:
 *   NOTIFY_HUB_URL … 例 https://notify.s-toru.com
 *   NOTIFY_HUB_KEY … ハブの送信APIキー
 */
const config = require('./config');
const logger = require('./logger');

function enabled() {
  return Boolean(config.notifyHub.url && config.notifyHub.key);
}

async function call(path, method, body) {
  const url = config.notifyHub.url.replace(/\/+$/, '') + path;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.notifyHub.key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSONでない応答はそのまま扱う */ }
  return { ok: res.ok, status: res.status, text, json };
}

/**
 * この院ぶんの宛先をハブに作り、お客様にお渡しする連携リンクを返す。
 * コードはハブ側で推測できない文字列が発行される（こちらでは決めない）。
 * すでに code を持っている院は、お店の名前とサービス一覧の更新だけ行う。
 */
async function ensureRecipient(db, tenant) {
  if (!enabled()) return { skipped: true, reason: 'ハブ未設定' };
  const services = [{ name: 'Keiro（ダッシュボード）', url: config.baseUrl + '/app' }];
  const body = { shopName: tenant.name || tenant.email, services };
  if (tenant.notify_code) body.code = tenant.notify_code;

  const r = await call('/recipients', 'POST', body);
  if (!r.ok || !r.json || !r.json.code) {
    logger.warn('通知ハブへの宛先登録に失敗', { tenant_id: tenant.id, status: r.status, body: r.text.slice(0, 200) });
    return { ok: false, status: r.status };
  }
  db.prepare('UPDATE tenants SET notify_code = ?, notify_link = ? WHERE id = ?')
    .run(r.json.code, r.json.linkUrl || null, tenant.id);
  return { ok: true, code: r.json.code, linkUrl: r.json.linkUrl };
}

/**
 * この院のLINEへ本文を送る。
 * dedupeKey を渡すと、同じものは二度送られない（ハブ側で弾く）。
 *
 * 戻り値の sent が false でも呼び出し側は失敗扱いにしないこと。
 * 「まだ連携が済んでいない院」は正常な状態であり、メールは別途届いているため。
 */
async function notify(tenant, text, dedupeKey) {
  if (!enabled()) return { sent: false, reason: 'ハブ未設定' };
  if (!tenant.notify_code) return { sent: false, reason: '宛先コード未発行' };

  const r = await call('/notify', 'POST', {
    code: tenant.notify_code,
    service: 'keiro',
    text,
    dedupeKey,
  });
  if (r.status === 409) {
    // まだ院が連携リンクを開いていない。ハブ側から運営に案内が飛ぶので、ここでは記録だけ。
    logger.info('通知ハブ: この院はまだLINE連携が済んでいない', { tenant_id: tenant.id });
    return { sent: false, reason: '未連携' };
  }
  if (!r.ok) {
    logger.warn('通知ハブへの送信に失敗', { tenant_id: tenant.id, status: r.status, body: r.text.slice(0, 200) });
    return { sent: false, reason: 'エラー', status: r.status };
  }
  if (r.json && r.json.skipped) return { sent: false, reason: '送信済み' };
  return { sent: true };
}

module.exports = { enabled, ensureRecipient, notify };
