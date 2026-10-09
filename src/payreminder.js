'use strict';

/**
 * 予約の「代未」の方にだけ、お支払いのお願いをLINEで送る。
 *
 * なぜ要るか（2026-10-09 モンテローザ様のご質問）:
 *   クリスマスケーキを現金前払い制にし、予約締め切り12/15・お支払い締め切り12/20とする。
 *   「代未」の方へどう知らせるか。→ 決めた日（例: 12/16・12/19）の朝に、まだの方にだけ自動で送る。
 *
 * 決まり:
 *   ・フォームの remind_dates（"YYYY-MM-DD" の並び・JST）に書いた日の、remind_hour 時（既定10時）以降に1回送る
 *   ・送るのは paid_at が空（代未）で、LINEの方が分かっている予約だけ。代済の方には送らない
 *   ・同じ予約に同じ日に二度は送らない（form_payment_reminders に記録）
 *   ・送れなかったとき（通数の上限など）は、その日のうちに最大3回まで再試行する
 *   ・通数を使う。足りなくなれば quotanotice が運営と店舗へ知らせる
 */
const logger = require('./logger');
const { newId } = require('./sign');

const MAX_ATTEMPTS = 3;

function jstParts(now) {
  const d = new Date(now + 9 * 3600 * 1000);
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { ymd, hour: d.getUTCHours() };
}

/** "12月20日（日）" のような表示。 */
function fmtDue(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  const w = '日月火水木金土'[d.getUTCDay()];
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${w}）`;
}

function parseDates(v) {
  if (!v) return [];
  let arr = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { arr = v.split(/[,\s、]+/); }
  }
  return (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

/** お知らせの文面。フォームの remind_text があればそれを使う（{no} {name} {item} {date} {time} {due} {title} を差し込み）。 */
function buildText(form, row) {
  const due = fmtDue(form.pay_due_at);
  const tpl = String(form.remind_text || '').trim() || (
    '「{title}」のご予約ありがとうございます。\n\n'
    + (due ? 'お支払いの締め切りは{due}です。\n' : '')
    + 'まだお支払いが確認できていないため、ご来店のうえお支払いをお願いいたします。\n\n'
    + '受付番号: {no}\n'
    + '{item_line}{datetime_line}\n'
    + 'すでにお支払い済みの場合は、行き違いのご連絡となり申し訳ございません。'
  );
  return tpl
    .replace(/\{title\}/g, form.title || form.name || 'ご予約')
    .replace(/\{due\}/g, due)
    .replace(/\{no\}/g, row.no || '')
    .replace(/\{name\}/g, row.name || '')
    .replace(/\{item\}/g, row.item || '')
    .replace(/\{date\}/g, row.date || '')
    .replace(/\{time\}/g, row.time || '')
    .replace(/\{item_line\}/g, row.item ? `・${row.item}\n` : '')
    .replace(/\{datetime_line\}/g, row.date || row.time ? `・${row.date}　${row.time}\n` : '');
}

/**
 * 定期ジョブ。今日がお知らせの日のフォームについて、代未の方へ送る。
 * @param {object} db
 * @param {object} [opts] { now, push(token, userId, text) }
 */
async function processPaymentReminders(db, opts = {}) {
  const now = opts.now || Date.now();
  const { ymd, hour } = jstParts(now);
  const rsv = require('./reservations');
  const tenantmod = require('./tenant');
  const push = opts.push || require('./line').pushMessage;
  const result = { sent: 0, failed: 0, skipped: 0 };

  const formsToday = db.prepare("SELECT * FROM forms WHERE active = 1 AND remind_dates IS NOT NULL AND remind_dates <> ''").all()
    .filter((f) => parseDates(f.remind_dates).includes(ymd) && hour >= Number(f.remind_hour == null ? 10 : f.remind_hour));
  for (const f of formsToday) {
    const tenant = db.prepare("SELECT * FROM tenants WHERE id = ? AND status = 'active'").get(f.tenant_id);
    if (!tenant) continue;
    const token = tenantmod.resolveSettings(tenant).line.channelAccessToken;
    if (!token) { logger.warn('payment reminder: LINE未接続', { tenant_id: tenant.id }); continue; }
    const data = rsv.listForForm(db, tenant.id, f.id);
    if (!data) continue;
    for (const row of data.rows) {
      if (row.paidAt || !row.lineUserId) { result.skipped++; continue; }
      const rec = db.prepare('SELECT * FROM form_payment_reminders WHERE answer_id = ? AND remind_date = ?').get(row.id, ymd);
      if (rec && (rec.ok || rec.attempts >= MAX_ATTEMPTS)) { result.skipped++; continue; }
      const r = await push(token, row.lineUserId, buildText(f, row)).catch((e) => ({ ok: false, response: String((e && e.message) || e) }));
      const ok = !!(r && r.ok !== false);
      if (rec) {
        db.prepare('UPDATE form_payment_reminders SET ok = ?, http_status = ?, attempts = attempts + 1, sent_at = ? WHERE id = ?')
          .run(ok ? 1 : 0, (r && r.http_status) || null, now, rec.id);
      } else {
        db.prepare(`INSERT INTO form_payment_reminders (id, tenant_id, form_id, answer_id, remind_date, ok, http_status, attempts, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(newId('prm'), tenant.id, f.id, row.id, ymd, ok ? 1 : 0, (r && r.http_status) || null, now);
      }
      if (ok) result.sent++; else { result.failed++; logger.warn('payment reminder failed', { tenant_id: tenant.id, http_status: (r && r.http_status) || null }); }
    }
  }
  if (result.sent || result.failed) logger.info('payment reminders', result);
  return result;
}

/** 予約ごとの、お知らせを送った日（成功分）。一覧に表示する。 */
function sentDatesByAnswer(db, formId) {
  const map = {};
  try {
    for (const r of db.prepare('SELECT answer_id, remind_date FROM form_payment_reminders WHERE form_id = ? AND ok = 1 ORDER BY remind_date').all(formId)) {
      (map[r.answer_id] = map[r.answer_id] || []).push(r.remind_date);
    }
  } catch { /* 古いDB */ }
  return map;
}

module.exports = { processPaymentReminders, buildText, parseDates, fmtDue, sentDatesByAnswer, MAX_ATTEMPTS };
