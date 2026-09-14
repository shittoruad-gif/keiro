'use strict';

// 課金状態の日次照合。
//
// なぜ必要か:
//   契約状態の更新は /webhook/univapay の受信時にしか行われないため、
//   ①解約のWebhookが届かない（設定漏れ・送信失敗・イベント未対応）
//   ②無料期間が満了しただけ（＝イベントが1つも発生しない）
//   のどちらでも、DBは古い状態のまま固まり、誰も気づけない。
//   実際に、UnivaPay側で解約済みの契約がKeiro上は trialing のまま、
//   無料期間の満了後もテナントが active のまま使われ続けた事例が発生した（2026-08-31 検出）。
//
// 何をするか:
//   1. univapay_subscription_id を持つ契約について、UnivaPay APIで実状態を取得しDBへ反映する
//   2. 無料期間が満了し、有効な契約が無いテナントを洗い出す
//   3. 対応が要るものを運営へメールで1通にまとめて通知する
//
// テナントの自動停止について:
//   既定では tenants.status を自動では変えない（BILLING_AUTO_SUSPEND=true で有効化）。
//   お客様の計測をこちらの判断で止めてしまうより、まず運営が気づける状態にすることを優先する。
//   ※ 計測そのものは billing.isMeasurementActive() が契約状態から都度判定しており、
//      本ジョブの停止有無に関わらず、無料期間満了かつ未契約なら止まる。
const config = require('./config');
const logger = require('./logger');
const mailer = require('./mailer');
const billing = require('./billing');
const univapay = require('./univapay');

const DAY = 24 * 3600 * 1000;

// UnivaPayの契約ステータス → Keiroの subscriptions.status
// （UnivaPay: current / unconfirmed / canceled / completed / unpaid / suspended）
const STATUS_MAP = {
  current: 'active',
  unconfirmed: 'trialing',
  canceled: 'canceled',
  completed: 'canceled',
  unpaid: 'past_due',
  suspended: 'past_due',
};

function mapStatus(univapayStatus) {
  return STATUS_MAP[String(univapayStatus || '').toLowerCase()] || null;
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString('ja-JP') : '不明';
}

/**
 * 契約状態をUnivaPayと照合し、ずれていればDBを実態に合わせる。
 * @returns {Promise<{checked:number, updated:Array, failed:Array}>}
 */
async function reconcileSubscriptions(db) {
  const result = { checked: 0, updated: [], failed: [] };
  if (!univapay.enabled()) {
    logger.warn('reconcile: UnivaPay APIが未設定のため契約照合をスキップしました');
    return result;
  }

  const rows = db.prepare(
    `SELECT s.*, t.email, t.name AS tenant_name, t.role
       FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
      WHERE s.univapay_subscription_id IS NOT NULL
        AND s.univapay_subscription_id <> ''
        AND t.role = 'tenant'`
  ).all();

  for (const row of rows) {
    result.checked += 1;
    let res;
    try {
      res = await univapay.getSubscription(row.univapay_subscription_id);
    } catch (e) {
      result.failed.push({ id: row.id, reason: String((e && e.message) || e) });
      continue;
    }
    if (!res.ok || !res.json) {
      // 404 = UnivaPay側に無い契約（テスト用IDなど）。落とさずに記録だけ残す。
      result.failed.push({ id: row.id, reason: `HTTP ${res.status}`, tenant: row.tenant_name });
      logger.warn('reconcile: 契約の取得に失敗', { subscription_id: row.id, status: res.status });
      continue;
    }

    const remote = mapStatus(res.json.status);
    if (!remote) {
      logger.warn('reconcile: 未知のUnivaPayステータス', { status: res.json.status, subscription_id: row.id });
      continue;
    }
    if (remote === row.status) continue;

    const periodEnd = res.json.next_payment && res.json.next_payment.due_date
      ? Date.parse(res.json.next_payment.due_date) || null
      : null;
    billing.upsertSubscription(db, {
      tenantId: row.tenant_id,
      planId: row.plan_id,
      univapaySubId: row.univapay_subscription_id,
      status: remote,
      currentPeriodEnd: periodEnd,
    });
    result.updated.push({
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      email: row.email,
      from: row.status,
      to: remote,
      amount: res.json.amount,
    });
    logger.info('reconcile: 契約状態をUnivaPayに合わせて更新', {
      tenant_id: row.tenant_id, from: row.status, to: remote,
    });
  }
  return result;
}

/**
 * UnivaPay側にあるのに、こちらのDBに1行も無い契約を拾い上げる。
 *
 * なぜ必要か:
 *   reconcileSubscriptions() は「DBに行がある契約」しか見に行かないため、
 *   Webhookの送り先が未登録だった期間に結ばれた契約は、照合しても永久に見つからない。
 *   実際に、keiro.s-toru.com がUnivaPayの通知先に登録されておらず（2026-09-14 検出）、
 *   初の外部有料契約（モンテローザ様・月9,800円・初回課金2026-10-13）がDBに存在しなかった。
 *   放置すると「お金はいただくのに、無料期間切れで計測が止まる」状態になる。
 *
 * 何をするか:
 *   ストアの定期課金を全件取り、メールアドレスがテナントと一致し、かつその契約IDが
 *   DBに無いものを追加する。⚠️ストアは全事業で共用なので、Keiroのテナントに
 *   メールが一致するものだけを拾う（他事業の契約は無視する）。
 *
 * @returns {Promise<{checked:number, adopted:Array, ok:boolean}>}
 */
async function adoptOrphanSubscriptions(db) {
  const result = { checked: 0, adopted: [], ok: false };
  if (!univapay.enabled()) {
    logger.warn('reconcile: UnivaPay APIが未設定のため取りこぼしの拾い上げをスキップしました');
    return result;
  }

  const res = await univapay.listSubscriptions();
  if (!res.ok) {
    logger.warn('reconcile: 契約一覧の取得に失敗', { status: res.status });
    return result;
  }
  result.ok = true;
  result.checked = res.items.length;

  // メール → テナント（Keiroのテナントだけ。他事業の契約はここで落ちる）
  const tenants = db.prepare("SELECT * FROM tenants WHERE role = 'tenant'").all();
  const byEmail = new Map();
  for (const t of tenants) {
    const k = String(t.email || '').toLowerCase();
    if (!k) continue;
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k).push(t);
  }

  const knownSubIds = new Set(
    db.prepare('SELECT univapay_subscription_id AS id FROM subscriptions WHERE univapay_subscription_id IS NOT NULL')
      .all().map((r) => String(r.id))
  );
  const keiroLinkIds = await univapay.resolveLinkIds();

  for (const s of res.items) {
    const email = String((s.user_data && s.user_data.email) || '').toLowerCase();
    if (!email || !byEmail.has(email)) continue;         // 他事業の契約
    if (knownSubIds.has(String(s.id))) continue;         // すでに把握している
    // ⚠️ メール一致だけでは足りない。同じ方が他事業（交通事故など）の契約も
    // 持っていることがあるため、Keiroの決済リンクから作られた契約だけを拾う。
    if (!univapay.belongsToKeiro(keiroLinkIds, univapay.linkIdOf(s), s.amount)) continue;
    const status = mapStatus(s.status);
    if (!status || status === 'canceled') continue;      // 終わった契約は拾わない

    // 同一メールに複数店舗がある場合は「有効な契約を持たない店舗」を優先（Webhookと同じ考え方）
    const candidates = byEmail.get(email);
    const tenant = candidates.find((t) => {
      const cur = billing.latestSubscription(db, t.id);
      return !cur || cur.status !== 'active';
    }) || candidates[0];

    const plan = billing.ensureDefaultPlan(db);
    const periodEnd = s.next_payment_date ? (Date.parse(s.next_payment_date) || null) : null;
    billing.upsertSubscription(db, {
      tenantId: tenant.id,
      planId: plan.id,
      univapaySubId: s.id,
      status,
      currentPeriodEnd: periodEnd,
    });
    billing.syncTenantStatus(db, tenant.id);
    knownSubIds.add(String(s.id));
    result.adopted.push({
      tenantId: tenant.id,
      tenantName: tenant.name,
      email,
      status,
      amount: s.amount,
      firstChargeOn: (s.schedule_settings && s.schedule_settings.start_on) || s.next_payment_date || null,
    });
    logger.info('reconcile: UnivaPayにあってDBに無い契約を取り込みました', {
      tenant_id: tenant.id, subscription_id: s.id, status,
    });
  }
  return result;
}

/**
 * 無料期間が満了しているのに、有効な契約が無いテナントを洗い出す。
 * （＝お金をいただかずに使われ続けている状態）
 * @returns {Array}
 */
function findLapsedTenants(db, now = Date.now()) {
  const tenants = db.prepare("SELECT * FROM tenants WHERE role = 'tenant'").all();
  const lapsed = [];
  for (const t of tenants) {
    if (t.manual_hold) continue;
    const st = billing.subscriptionState(db, t);
    if (st.active) continue;          // 契約中 or 無料期間中なら問題なし
    if (st.inTrial) continue;         // 念のため
    lapsed.push({
      tenantId: t.id,
      tenantName: t.name,
      email: t.email,
      plan: t.plan,
      status: st.status,
      trialEndsAt: st.trialEndsAt,
      lapsedDays: Math.floor((now - st.trialEndsAt) / DAY),
      tenantStatus: t.status,
      lastLoginAt: t.last_login_at,
    });
  }
  return lapsed;
}

function buildReport(updated, lapsed, failed, autoSuspend, adopted = []) {
  const lines = [];
  if (adopted.length) {
    lines.push('■ 決済会社にあって、こちらに記録が無かった契約（取り込みました）');
    for (const a of adopted) {
      lines.push(`　・${a.tenantName || '(名称なし)'}（${a.email}）: ${a.status}`
        + (a.amount ? `　月額 ${Number(a.amount).toLocaleString()}円` : '')
        + (a.firstChargeOn ? `　初回請求 ${a.firstChargeOn}` : ''));
    }
    lines.push('　※ 通知の取りこぼしが起きていた可能性があります。通知の送り先の設定をご確認ください。');
    lines.push('');
  }
  if (updated.length) {
    lines.push('■ UnivaPayと食い違っていた契約（実態に合わせて修正しました）');
    for (const u of updated) {
      lines.push(`　・${u.tenantName || '(名称なし)'}（${u.email}）: ${u.from} → ${u.to}`
        + (u.amount ? `　月額 ${Number(u.amount).toLocaleString()}円` : ''));
    }
    lines.push('');
  }
  if (lapsed.length) {
    lines.push('■ 無料期間が終わっているのに、有効な契約が無い院');
    for (const l of lapsed) {
      lines.push(`　・${l.tenantName || '(名称なし)'}（${l.email}）`);
      lines.push(`　　無料期間の終了: ${fmtDate(l.trialEndsAt)}（${l.lapsedDays}日経過）`
        + `　契約状態: ${l.status}　最終ログイン: ${fmtDate(l.lastLoginAt)}`);
    }
    lines.push('');
    lines.push(autoSuspend
      ? '　※ 自動停止が有効なため、上記の院は停止扱いに変更しました。'
      : '　※ アカウントは自動では停止していません。継続のご案内・無償延長・停止のいずれかをご判断ください。');
    lines.push('');
  }
  if (failed.length) {
    lines.push('■ 照合できなかった契約（UnivaPayに見つからない等）');
    for (const f of failed) lines.push(`　・${f.tenant || f.id}: ${f.reason}`);
    lines.push('');
  }
  lines.push(`ダッシュボード: ${config.baseUrl}/operator`);
  return lines.join('\n');
}

/**
 * 日次の課金照合。ずれ・失効を見つけたら運営へ1通にまとめて通知する。
 * @param {object} [opts] { now, notify }
 */
async function processBillingReconcile(db, opts = {}) {
  const now = opts.now || Date.now();
  const autoSuspend = !!config.billing.autoSuspend;

  // 先に「DBに無い契約」を拾ってから照合する（拾った直後の行も同じ回で整合が取れる）。
  const orphans = await adoptOrphanSubscriptions(db);
  const sub = await reconcileSubscriptions(db);
  const lapsed = findLapsedTenants(db, now);

  // テナント状態の同期。
  //   ・入金を確認できた（active になった）院は、止まっていても常に復帰させる
  //   ・逆に「止める」方向は、既定では行わない（BILLING_AUTO_SUSPEND=true のときだけ）。
  //     計測自体は billing.isMeasurementActive() が契約状態から都度判定するため、
  //     ここで止めなくても未契約の院に機能が提供され続けることはない。
  for (const u of sub.updated) {
    if (u.to === 'active' || autoSuspend) billing.syncTenantStatus(db, u.tenantId);
  }
  if (autoSuspend) {
    for (const l of lapsed) billing.syncTenantStatus(db, l.tenantId);
  }

  const needsAttention = sub.updated.length || lapsed.length || sub.failed.length || orphans.adopted.length;
  if (needsAttention && opts.notify !== false && config.operator.email) {
    await mailer.sendMail({
      to: config.operator.email,
      subject: `[Keiro] 課金の照合結果: 要確認 ${sub.updated.length + lapsed.length + orphans.adopted.length}件`,
      text: buildReport(sub.updated, lapsed, sub.failed, autoSuspend, orphans.adopted),
    }).catch((e) => logger.error('reconcile: 通知メールの送信に失敗', { err: String((e && e.message) || e) }));
  }

  logger.info('reconcile: 完了', {
    checked: sub.checked, updated: sub.updated.length, lapsed: lapsed.length, failed: sub.failed.length,
    scanned: orphans.checked, adopted: orphans.adopted.length,
  });
  return {
    checked: sub.checked, updated: sub.updated, lapsed, failed: sub.failed, adopted: orphans.adopted,
  };
}

module.exports = {
  processBillingReconcile, reconcileSubscriptions, adoptOrphanSubscriptions, findLapsedTenants, mapStatus,
};
