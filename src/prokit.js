'use strict';

// プロ機能一式（構築時に必ず入れるもの）
// =====================================================
// 2026-09-28 三上様「最初に構築するときに、プロプランでしかできないことを全部入れて、
// プロプランでないといけない状態を作ってほしい」。
//
// 公式LINE制作はプロが標準（契約書）。構築の最後にこれを呼べば、プロでしか作れない・使えない
// 仕組みが一通り入った状態になる。ライトに変えると何ができなくなるかは
// 資料「ライトとプロの違い」（shittoru-service-docs/docs/keiro-plans.pdf）と同じ並び。
//
// 方針:
//   - 何度呼んでも増えない（すでにあるものは作らない）。構築スクリプト・AIセットアップ・ウィザードの後に呼ぶ。
//   - プランの制限（ライトの上限）は通さない。構築はプロの無料期間中に行う前提。
//   - お客様に届く文面に絵文字・料金・効果の約束を入れない（業種を問わず使える言い回しにする）。
//   - LINEに実際に出す操作（リッチメニューの公開・一斉配信）はしない。作るだけ。
//   - 店側の情報が要るもの（Meta広告の連携キー、タグ別リッチメニューの画像）は作らず「手作業」として返す。

const { newId } = require('./sign');
const steps = require('./steps');
const identify = require('./identify');
const forms = require('./forms');
const reminders = require('./reminders');
const trackurl = require('./trackurl');

// 友だち追加直後の自動の会話（初めて／ご利用中で案内を分ける）
const FOLLOW_BOT = {
  name: '初めて／ご利用中の振り分け',
  questionText: 'ご登録ありがとうございます。\nぴったりのご案内をお届けするため、あてはまる方を選んでください。',
  choices: [
    { label: '初めての方', tag: '新規', replyText: 'ありがとうございます。\nこのあと、はじめての方向けのご案内をお送りします。\nご予約・ご質問は、いつでもこのトークへどうぞ。' },
    { label: 'ご利用中の方', tag: '既存', replyText: 'いつもありがとうございます。\nご予約・ご質問は、このトークにお送りください。' },
  ],
};

// はじめての方アンケート（回答すると「回答済」の目印が付く）
const FIRST_FORM = {
  name: 'はじめての方アンケート',
  title: 'はじめての方アンケート',
  description: 'ご来店前に、かんたんな質問にお答えください（1分ほど）。いただいた内容は、当日のご案内に使います。',
  tag: '回答済',
  fields: [
    { label: 'お名前', type: 'text', required: true },
    { label: '当店を何で知りましたか', type: 'radio', options: ['Instagram', 'Googleマップ・検索', 'ホームページ', 'チラシ・店頭', 'ご紹介', 'その他'], required: true },
    { label: '気になっていること・ご相談したいこと', type: 'textarea', required: false },
    { label: 'ご来店しやすい曜日・時間帯', type: 'text', required: false },
  ],
  done_text: 'ご回答ありがとうございました。内容を確認して、ご来店の際のご案内に役立てます。',
};

// 友だち追加後の自動メッセージ（目印ごとに3本。ライトは2本までなので、3本目以降が作れなくなる）
const STEP_CAMPAIGNS = [
  {
    audienceTag: '新規', name: '初めての方へのご案内',
    steps: [
      { delay_minutes: 60 * 24, text: 'ご登録いただきありがとうございます。\nはじめての方向けに、当店のことを少しご紹介させてください。\nご予約・ご質問は、このトークからいつでもどうぞ。' },
      { delay_minutes: 60 * 24 * 3, text: 'ご来店前に、かんたんなアンケートにお答えいただくと、当日のご案内がスムーズです。\n下のメニューの「アンケート」から開けます。' },
    ],
  },
  {
    audienceTag: '既存', name: 'ご利用中の方へのご案内',
    steps: [
      { delay_minutes: 60 * 24 * 7, text: 'いつもありがとうございます。\n次回のご予約や、気になることのご相談は、このトークにお送りください。' },
    ],
  },
  {
    audienceTag: '回答済', name: 'アンケートにお答えいただいた方へ',
    steps: [
      { delay_minutes: 30, text: 'アンケートへのご回答ありがとうございました。\n内容を確認しました。ご予約がまだの方は、このトークにご希望の日時をお送りください。' },
    ],
  },
];

// 入口ごとの計測リンク（ライトは3本まで。4本以上そろえる）
const LINKS = [
  { media: 'instagram', name: 'Instagramプロフィール', campaign: 'profile' },
  { media: 'google', name: 'Googleマップ（ビジネスプロフィール）', campaign: 'gbp' },
  { media: 'website', name: 'ホームページ', campaign: 'website' },
  { media: 'flyer', name: 'チラシ・店頭QR', campaign: 'flyer' },
  { media: 'meta', name: 'Instagram・Facebook広告', campaign: 'meta-ad' },
];

function countActiveSteps(db, tenantId) {
  return db.prepare('SELECT COUNT(*) n FROM step_campaigns WHERE tenant_id = ? AND active = 1').get(tenantId).n;
}

/** いま何が入っているかだけを返す（作らない）。 */
function status(db, tenant) {
  const id = tenant.id;
  const n = (sql) => db.prepare(sql).get(id).n;
  const s = {
    bot: n("SELECT COUNT(*) n FROM bot_flows WHERE tenant_id = ? AND active = 1"),
    form: n('SELECT COUNT(*) n FROM forms WHERE tenant_id = ?'),
    reminder: n('SELECT COUNT(*) n FROM reminder_campaigns WHERE tenant_id = ? AND active = 1'),
    steps: countActiveSteps(db, id),
    links: n('SELECT COUNT(*) n FROM links WHERE tenant_id = ?'),
    trackedUrls: n('SELECT COUNT(*) n FROM tracked_urls WHERE tenant_id = ?'),
    tagRichMenu: (() => { try { return n("SELECT COUNT(*) n FROM rich_menus WHERE tenant_id = ? AND audience_tag IS NOT NULL AND audience_tag <> ''"); } catch { return 0; } })(),
    metaCv: tenant.meta_pixel_id && tenant.meta_capi_token ? 1 : 0,
  };
  const ok = {
    bot: s.bot >= 1, form: s.form >= 1, reminder: s.reminder >= 1, steps: s.steps >= 3,
    links: s.links >= 4, trackedUrls: s.trackedUrls >= 1, tagRichMenu: s.tagRichMenu >= 1, metaCv: s.metaCv >= 1,
  };
  return { counts: s, ok, complete: Object.values(ok).every(Boolean) };
}

/**
 * プロ機能一式を入れる（すでにあるものは作らない）。
 * opts.bookingUrl / opts.websiteUrl があれば、成果を追う計測URL（ROI）も作る。
 * 返り値: { created: [...], existed: [...], manual: [...], status }
 */
function ensure(db, tenant, opts = {}) {
  const tid = tenant.id;
  const created = [];
  const existed = [];
  const manual = [];

  // 1. 自動の会話
  const followBot = db.prepare("SELECT id FROM bot_flows WHERE tenant_id = ? AND trigger_type = 'follow'").get(tid);
  if (followBot) existed.push('自動の会話（友だち追加時の振り分け）');
  else {
    const flow = identify.createFlow(db, tid, { name: FOLLOW_BOT.name, triggerType: 'follow', questionText: FOLLOW_BOT.questionText, active: true, messageType: 'quick' });
    identify.setChoices(db, tid, flow.id, FOLLOW_BOT.choices);
    created.push('自動の会話（友だち追加時の振り分け）');
  }

  // 2. 回答フォーム
  const anyForm = db.prepare('SELECT id FROM forms WHERE tenant_id = ?').get(tid);
  if (anyForm) existed.push('回答フォーム');
  else {
    const f = forms.createForm(db, tid, FIRST_FORM);
    if (f && !f.error) created.push('回答フォーム（はじめての方アンケート）');
  }

  // 3. 予約日に合わせた自動連絡
  const hadReminder = db.prepare('SELECT COUNT(*) n FROM reminder_campaigns WHERE tenant_id = ?').get(tid).n > 0;
  reminders.ensureQuickCampaign(db, tid);
  (hadReminder ? existed : created).push('予約日の自動連絡（前日）');

  // 4. 友だち追加後の自動メッセージ（目印ごと・合計3本以上）
  for (const c of STEP_CAMPAIGNS) {
    const has = db.prepare('SELECT id FROM step_campaigns WHERE tenant_id = ? AND audience_tag = ?').get(tid, c.audienceTag);
    if (has) { existed.push(`自動メッセージ（${c.audienceTag}）`); continue; }
    const cmp = steps.createCampaign(db, tid, { name: c.name, media: null, audienceTag: c.audienceTag, active: true });
    steps.setSteps(db, tid, cmp.id, c.steps);
    created.push(`自動メッセージ（${c.audienceTag}）`);
  }

  // 5. 入口ごとの計測リンク（4本以上）
  if (!tenant.line_oa_add_url) {
    manual.push('計測リンク：公式LINEの友だち追加URL（line_oa_add_url）が未設定のため作れません。LINE連携を先に終えてください');
  } else {
    for (const l of LINKS) {
      const has = db.prepare('SELECT id FROM links WHERE tenant_id = ? AND media = ?').get(tid, l.media);
      if (has) { existed.push(`計測リンク（${l.name}）`); continue; }
      db.prepare(
        `INSERT INTO links (id, tenant_id, name, oa_add_url, media, campaign, creative, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      ).run(newId('lnk'), tid, l.name, tenant.line_oa_add_url, l.media, l.campaign, Date.now());
      created.push(`計測リンク（${l.name}）`);
    }
  }

  // 6. 成果を追う計測URL（ROI）
  const dest = opts.bookingUrl || opts.websiteUrl;
  const anyTracked = db.prepare('SELECT id FROM tracked_urls WHERE tenant_id = ?').get(tid);
  if (anyTracked) existed.push('成果を追う計測URL');
  else if (dest) {
    const r = trackurl.createUrl(db, tid, { name: opts.bookingUrl ? 'ご予約ページ' : 'ホームページ', destUrl: dest });
    if (!r.error) created.push('成果を追う計測URL');
    else manual.push(`成果を追う計測URL：${r.error}`);
  } else {
    manual.push('成果を追う計測URL：予約ページかホームページのURLを渡すと作れます（bookingUrl / websiteUrl）');
  }

  // 7. 店側の情報が要るもの（作らずに手作業として返す）
  const st = status(db, tenant);
  if (!st.ok.tagRichMenu) manual.push('タグ別リッチメニュー：「初めての方」「ご利用中の方」で下のメニューを分ける。画像が要るため、リッチメニュー画面で目印（新規／既存）を指定して公開してください');
  if (!st.ok.metaCv) manual.push('広告の成果連携：Instagram・Facebook広告を出すお店は、ピクセルIDとコンバージョンAPIのトークンを設定画面に入れてください（広告を出さないお店は不要）');

  return { created, existed, manual, status: st };
}

module.exports = { ensure, status, FOLLOW_BOT, FIRST_FORM, STEP_CAMPAIGNS, LINKS };
