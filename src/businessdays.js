'use strict';

/**
 * お店のお休み（定休日・臨時休業）と、予約で選べる日。
 *
 * なぜ要るか（2026-10-31 モンテローザ様）:
 *   ホールケーキの予約で、受け取り日を文字で書く欄だったため、定休日を指定するお客様がいた。
 *   お休みの一覧をお店ごとに1つだけ持ち（tenants.closed_dates）、予約画面の「受け取り日」（項目の種類 date）は
 *   その一覧を除いた営業日だけを選択肢に出す。送られてきた日がお休みなら、理由を書いて受け付けない。
 *
 * 日付はすべて日本時間。お休みは "YYYY-MM-DD" の並び。曜日の定休（毎週水曜など）は、月ごとの一覧に展開して持つ
 * （モンテローザ様は「水曜定休だが営業する水曜がある」ため、曜日の決まりより日付の一覧のほうが間違えない）。
 */
const DAY = 24 * 3600 * 1000;
const WEEK = '日月火水木金土';
const LEAD_DAYS = 1;   // 「受け取り日の前日までにご予約ください」＝選べるのは明日から
const RANGE_DAYS = 60; // 約2か月先まで

function parseList(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = v.split(/[,\s、]+/); } }
  return [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)))].sort();
}

function ymdOf(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** "2026-11-20" → "11月20日（金）" */
function labelOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}月${d}日（${w}）`;
}

/** その日を含む月の末日 "YYYY-MM-DD"。 */
function monthEnd(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return ymdOf(Date.UTC(y, m, 0) - 9 * 3600 * 1000 + 12 * 3600 * 1000);
}

/**
 * 選べる受け取り日（明日から RANGE_DAYS 日先まで・お休みを除く）。
 * お休みを登録してある月の末日より先は出さない（まだお休みを聞いていない月の定休日を選べてしまうため）。
 */
function availableDates(closed, now = Date.now(), { lead = LEAD_DAYS, range = RANGE_DAYS } = {}) {
  const list = parseList(closed);
  const off = new Set(list);
  const until = list.length ? monthEnd(list[list.length - 1]) : null;
  const out = [];
  for (let i = lead; i <= range; i++) {
    const ymd = ymdOf(now + i * DAY);
    if (until && ymd > until) break;
    if (!off.has(ymd)) out.push({ ymd, label: labelOf(ymd) });
  }
  return out;
}

/**
 * 送られてきた受け取り日を確かめる。
 * @returns {{ok:true}|{ok:false, error:string}}
 */
function checkDate(value, closed, now = Date.now()) {
  const v = String(value || '').trim();
  if (!v) return { ok: false, error: '受け取り日をお選びください' };
  if (availableDates(closed, now).some((d) => d.label === v)) return { ok: true };
  const offDay = parseList(closed).find((ymd) => labelOf(ymd) === v);
  if (offDay) return { ok: false, error: `${v}は定休日のため、ご予約いただけません。営業日カレンダーをご確認のうえ、別の日をお選びください。` };
  return { ok: false, error: `${v}はご予約いただけない日です。一覧から受け取り日を選び直してください。` };
}

module.exports = { parseList, ymdOf, labelOf, monthEnd, availableDates, checkDate, LEAD_DAYS, RANGE_DAYS };
