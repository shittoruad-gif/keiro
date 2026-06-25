'use strict';

// 業種別プリセット（整体・整骨院 / 美容鍼 / ピラティス）。
// ステップ配信・自動応答・リッチメニュー構成を用意し、院がワンクリックで適用できる。
// URL等は院ごとに編集する想定でプレースホルダ（（…））を入れている。
const steps = require('./steps');
const autoreply = require('./autoreply');

const D = { now: 0, day1: 1440, day3: 4320, day7: 10080 };

const PRESETS = {
  seitai: {
    name: '整体・整骨院',
    description: '初回来院までの後押しと、よくある質問への自動応答一式。',
    stepCampaign: {
      name: '初回来院ナビ',
      messages: [
        { delay_minutes: D.now, text: '友だち追加ありがとうございます！\n当院では【初回限定の特別ケア】をご用意しています😊\nつらい肩こり・腰痛、根本から一緒に整えていきましょう。\nご予約はこちら→（ご予約URL）' },
        { delay_minutes: D.day1, text: 'その痛み、放っておくと“クセ”になってしまうことも。\n当院は国家資格者が一人ひとりの状態を見て施術します。\nまずは初回でお体の状態をチェックしてみませんか？\nご予約→（ご予約URL）' },
        { delay_minutes: D.day3, text: '【初回特典はまだ間に合います】\nお忙しいと思いますが、早めのケアが回復への近道です。\n空き状況はこちら→（ご予約URL）' },
        { delay_minutes: D.day7, text: '「長年の腰痛が楽になった」というお声を多くいただいています。\nあなたのご来院も心よりお待ちしています。\nご予約→（ご予約URL）' },
      ],
    },
    autoreplies: [
      { keyword: '予約', match_type: 'contains', reply_text: 'ご予約はこちらから24時間受付しています😊→（ご予約URL）' },
      { keyword: '料金', match_type: 'contains', reply_text: '料金のご案内です。初回は特別価格でご案内しています→（料金ページURL）' },
      { keyword: '営業時間', match_type: 'contains', reply_text: '営業時間は（例：平日9:00-20:00 / 土9:00-18:00）です。定休日は（曜日）です。' },
      { keyword: '場所', match_type: 'contains', reply_text: 'アクセスはこちらです→（GoogleマップURL）　駐車場（有/無）' },
    ],
    richMenu: {
      template: 'full-4', theme: 'green', chat_bar_text: 'メニュー',
      cells: [
        { label: 'ご予約', action_type: 'uri', action_value: '（ご予約URL）' },
        { label: 'メニュー・料金', action_type: 'uri', action_value: '（料金ページURL）' },
        { label: 'アクセス', action_type: 'uri', action_value: '（GoogleマップURL）' },
        { label: 'お問い合わせ', action_type: 'message', action_value: '質問したいです' },
      ],
    },
  },

  biyoshin: {
    name: '美容鍼',
    description: '美容鍼デビューを後押しするシナリオと、効果・料金の自動応答。',
    stepCampaign: {
      name: '美容鍼デビュー',
      messages: [
        { delay_minutes: D.now, text: '友だち追加ありがとうございます✨\n【初回限定】美容鍼のお試しプランをご用意しました。\nハリ・たるみ・むくみが気になる方へ。\nご予約はこちら→（ご予約URL）' },
        { delay_minutes: D.day1, text: '「美容鍼って痛くない？」とよく聞かれます。\n髪の毛ほどの細い鍼で、施術後はお顔がスッと軽く。\nダウンタイムもほぼありません😊\nご予約→（ご予約URL）' },
        { delay_minutes: D.day3, text: '【初回特典のご案内（再送）】\n継続でより変化を感じやすいのが美容鍼。\nまずは1回、体感してみませんか？→（ご予約URL）' },
        { delay_minutes: D.day7, text: 'お客様から「フェイスラインが上がった」と好評です。\nビフォーアフターはこちら→（実績ページURL）\nご予約→（ご予約URL）' },
      ],
    },
    autoreplies: [
      { keyword: '予約', match_type: 'contains', reply_text: 'ご予約はこちらから→（ご予約URL）' },
      { keyword: '料金', match_type: 'contains', reply_text: '美容鍼の料金・回数券のご案内です→（料金ページURL）' },
      { keyword: '効果', match_type: 'contains', reply_text: 'ハリ・むくみ・血色感の変化を実感される方が多いです。初回から体感いただけます😊' },
      { keyword: '営業時間', match_type: 'contains', reply_text: '営業時間は（例：10:00-19:00）、定休日は（曜日）です。' },
    ],
    richMenu: {
      template: 'full-4', theme: 'warm', chat_bar_text: 'メニュー',
      cells: [
        { label: 'ご予約', action_type: 'uri', action_value: '（ご予約URL）' },
        { label: '美容鍼メニュー', action_type: 'uri', action_value: '（メニューURL）' },
        { label: 'よくある質問', action_type: 'message', action_value: '美容鍼について質問' },
        { label: 'アクセス', action_type: 'uri', action_value: '（GoogleマップURL）' },
      ],
    },
  },

  pilates: {
    name: 'ピラティス',
    description: '体験レッスンへの導線と、初心者の不安を解消する自動応答。',
    stepCampaign: {
      name: '体験レッスン案内',
      messages: [
        { delay_minutes: D.now, text: '友だち追加ありがとうございます！\n【体験レッスン特別価格】でお試しいただけます😊\n姿勢改善・体幹強化・しなやかな身体づくりに。\nご予約はこちら→（体験予約URL）' },
        { delay_minutes: D.day1, text: '「運動が苦手でも大丈夫？」→大丈夫です！\nマシンピラティスは初心者の方こそ効果を感じやすいレッスンです。\nインストラクターが丁寧にサポートします。\n体験予約→（体験予約URL）' },
        { delay_minutes: D.day3, text: '【体験枠のご案内（再送）】\n人気の時間帯は埋まりやすくなっています。\n空き状況の確認はこちら→（体験予約URL）' },
        { delay_minutes: D.day7, text: '続けやすい料金プラン・通い放題もご用意しています。\nまずは体験から、お気軽にどうぞ→（体験予約URL）' },
      ],
    },
    autoreplies: [
      { keyword: '体験', match_type: 'contains', reply_text: '体験レッスンのご予約はこちら→（体験予約URL）　動きやすい服装でお越しください😊' },
      { keyword: '予約', match_type: 'contains', reply_text: 'ご予約はこちらから→（体験予約URL）' },
      { keyword: '料金', match_type: 'contains', reply_text: '料金プラン・通い放題のご案内です→（料金ページURL）' },
      { keyword: '持ち物', match_type: 'contains', reply_text: '動きやすい服装・お飲み物・タオルをお持ちください。靴下は（必要/不要）です。' },
    ],
    richMenu: {
      template: 'full-4', theme: 'ink', chat_bar_text: 'メニュー',
      cells: [
        { label: '体験予約', action_type: 'uri', action_value: '（体験予約URL）' },
        { label: 'レッスン・料金', action_type: 'uri', action_value: '（料金ページURL）' },
        { label: 'スケジュール', action_type: 'uri', action_value: '（予約システムURL）' },
        { label: 'アクセス', action_type: 'uri', action_value: '（GoogleマップURL）' },
      ],
    },
  },
};

/** クライアント向けに全プリセットを返す（リッチメニュー構成も含む＝ビルダー反映用）。 */
function listPresets() {
  return Object.keys(PRESETS).map((key) => ({ key, ...PRESETS[key] }));
}

function getPreset(key) { return PRESETS[key] || null; }

/**
 * プリセットを適用：ステップ配信キャンペーンと自動応答を院に作成する。
 * リッチメニューはサーバ側で画像生成しないため適用対象外（ビルダーへ反映する）。
 * @returns {{campaign, autoreplies}} 作成結果サマリ
 */
function applyPreset(db, tenant, key, { applySteps = true, applyAutoreplies = true } = {}) {
  const p = PRESETS[key];
  if (!p) return { error: '不明なプリセットです' };
  let campaign = null, replies = 0;
  if (applySteps && p.stepCampaign) {
    const c = steps.createCampaign(db, tenant.id, { name: p.stepCampaign.name, media: null, active: true });
    steps.setSteps(db, tenant.id, c.id, p.stepCampaign.messages);
    campaign = c.id;
  }
  if (applyAutoreplies && p.autoreplies) {
    for (const r of p.autoreplies) { autoreply.createRule(db, tenant.id, r); replies++; }
  }
  return { ok: true, campaign, autoreplies: replies };
}

module.exports = { PRESETS, listPresets, getPreset, applyPreset };
