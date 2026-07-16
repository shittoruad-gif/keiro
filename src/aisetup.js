'use strict';

// AI初期構築: 店舗のホームページ/LPのURLから、その店に合わせた
// あいさつ・ステップ配信・キーワード自動応答・リッチメニュー構成・会話ボットを自動生成する。
// LLMは Claude（ANTHROPIC_API_KEY）優先、無ければ Gemini（GEMINI_API_KEY）を使用。
// どちらも未設定なら機能自体を無効として案内する（enabled()=false）。
const config = require('./config');
const logger = require('./logger');
const steps = require('./steps');
const autoreply = require('./autoreply');
const identify = require('./identify');
const forms = require('./forms');
const reminders = require('./reminders');

function enabled() {
  return !!(config.ai.anthropicKey || config.ai.geminiKey);
}

// ---------------- サイト取得・本文抽出 ----------------

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 800 * 1024;
const MAX_TEXT_CHARS = 9000;

const dns = require('dns').promises;

/** IPv4文字列がプライベート/ループバック/リンクローカル等かを判定。 */
function isPrivateIPv4(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || a >= 224
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127); // CGN
}

/** IPv6文字列がループバック/ユニークローカル/リンクローカル/IPv4射影かを判定。 */
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true; // fc00::/7 ユニークローカル
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true; // fe80::/10 リンクローカル
  const v4 = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4射影
  if (v4) return isPrivateIPv4(v4[1]);
  return false;
}

/** プライベートアドレス等へのSSRFを避ける形式チェック（DNS前）。 */
function isSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  let host = u.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  // IPv6リテラル
  if (host.includes(':')) return !isPrivateIPv6(host);
  // ドット4組のIPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIPv4(host);
  // 数値のみ（10進/8進/16進の単一整数ホスト＝127.0.0.1等の別表記）は拒否
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) return false;
  return true;
}

/** ホスト名をDNS解決し、いずれかがプライベート/ループバックなら危険と判定（DNSリバインド対策）。 */
async function resolvesToPrivate(hostname) {
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.some((a) => (a.family === 6 ? isPrivateIPv6(a.address) : isPrivateIPv4(a.address)));
  } catch { return true; } // 解決不能は安全側で拒否
}

/** HTMLからテキスト・タイトル・リンク一覧を抽出（依存追加なしの簡易パーサ）。 */
function extractFromHtml(html, baseUrl) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || '';

  // リンク（予約導線などの検出用）
  const links = [];
  const linkRe = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && links.length < 60) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text) continue;
    let href = m[1];
    try { href = new URL(href, baseUrl).href; } catch { continue; }
    links.push({ text, href: href.slice(0, 300) });
  }

  // 本文テキスト
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(h[1-6]|p|li|br|div|section|td|th)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n[\s\n]*/g, '\n')
    .trim();

  const tel = (body.match(/(0\d{1,4}[-(]?\d{1,4}[-)]?\d{3,4})/) || [])[1] || null;

  return {
    title: title.replace(/\s+/g, ' ').trim().slice(0, 200),
    description: metaDesc.slice(0, 500),
    tel,
    text: body.slice(0, MAX_TEXT_CHARS),
    links: links.slice(0, 30),
  };
}

async function fetchSite(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // リダイレクトを自前で追い、各ホップで形式＋DNS解決先の私有IPを検査（SSRF/リバインド対策）。
    let current = String(url);
    for (let hop = 0; hop < 4; hop++) {
      if (!isSafeUrl(current)) return { error: 'URLの形式が正しくありません（http:// または https:// で始まる公開ページを指定してください）' };
      if (await resolvesToPrivate(new URL(current).hostname)) return { error: '指定のURLは取得できません（内部アドレスのため）' };
      const res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KeiroSetupBot/1.0)', 'Accept-Language': 'ja' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue; // 次のホップを再検査
      }
      if (!res.ok) return { error: `ページを取得できませんでした（HTTP ${res.status}）。URLをご確認ください。` };
      const buf = Buffer.from(await res.arrayBuffer());
      const html = buf.slice(0, MAX_HTML_BYTES).toString('utf8');
      return { site: extractFromHtml(html, current) };
    }
    return { error: 'リダイレクトが多すぎます。URLをご確認ください。' };
  } catch (e) {
    const msg = e.name === 'AbortError' ? '時間内にページを取得できませんでした' : String((e && e.message) || e);
    return { error: `ページを取得できませんでした（${msg}）` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- LLM 呼び出し ----------------

const PLAN_INSTRUCTION = `あなたは日本の店舗（治療院・整骨院・サロン等）のLINE公式アカウント構築の専門家です。
渡されたホームページの内容だけを根拠に、その店に合わせたLINE初期設定を提案してください。
事実（店名・メニュー名・営業時間・電話・住所・URL）はページに書かれているものだけを使い、書かれていない情報は創作しないこと。

次のJSONだけを出力してください（前後に説明文・コードフェンス不要）:
{
  "shop_name": "店名",
  "summary": "この店の特徴の要約（オーナーに見せる1〜2文）",
  "greeting": "友だち追加直後に送るあいさつ文（150字以内・絵文字1〜2個・店の特徴を反映）",
  "steps": [
    {"delay_minutes": 0, "text": "あいさつ（greetingと同じでよい）"},
    {"delay_minutes": 4320, "text": "3日後のフォロー文（店のメニューや強みに触れる）"},
    {"delay_minutes": 10080, "text": "1週間後の来店を後押しする文"}
  ],
  "autoreplies": [
    {"keyword": "予約", "match_type": "contains", "reply_text": "予約方法の案内（ページに予約URLや電話があればそれを使う）"},
    {"keyword": "営業時間", "match_type": "contains", "reply_text": "営業時間の案内（ページに記載があれば正確に）"},
    {"keyword": "料金", "match_type": "contains", "reply_text": "料金・メニューの案内"}
  ],
  "richmenu": {
    "chat_bar_text": "メニュー",
    "cells": [
      {"label": "ボタン名(6字以内)", "type": "uri または message", "value": "URL または 送信テキスト"},
      ... 6個ちょうど
    ]
  },
  "bot": {
    "question_text": "友だち追加時の1問目（例: ご来院は初めてですか？）",
    "choices": [
      {"label": "選択肢(12字以内)", "tag": "付与タグ(例: 新規)", "reply_text": "選択後の返信文"},
      {"label": "...", "tag": "既存", "reply_text": "..."}
    ]
  },
  "form": {
    "name": "事前問診",
    "title": "ご来店前アンケート",
    "description": "初回をスムーズにご案内するため、1分ほどでご回答ください。",
    "fields": [
      {"label": "お名前", "type": "text", "required": true},
      {"label": "気になること（複数選択可）", "type": "checkbox", "options": ["...", "..."], "required": true},
      {"label": "いつ頃からですか？", "type": "select", "options": ["...", "..."]},
      {"label": "その他伝えておきたいこと", "type": "textarea"}
    ]
  }
}
formはこの店の業種に合わせた事前アンケート（3〜5問）。typeは text/textarea/select/radio/checkbox のみ。
richmenuのcellsは、予約導線（ページ内の予約URLか電話）を必ず1つ含め、残りはページ内容に合わせて構成すること。
文体は丁寧で親しみやすく、医療広告ガイドラインに配慮して「治る」「根本改善」等の断定表現は使わないこと。`;

function buildUserContent(site, url) {
  const linkList = site.links.map((l) => `- ${l.text}: ${l.href}`).join('\n');
  return `対象ページURL: ${url}
タイトル: ${site.title}
説明(meta): ${site.description}
電話番号らしき記載: ${site.tel || 'なし'}

--- ページ本文（抜粋） ---
${site.text}

--- ページ内リンク ---
${linkList}`;
}

async function callClaude(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.ai.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: 3000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return (json.content || []).map((c) => c.text || '').join('');
}

async function callGemini(system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.ai.geminiModel)}:generateContent?key=${encodeURIComponent(config.ai.geminiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      // gemini-2.5系は思考トークンがmaxOutputTokensを消費するため、思考を切って上限も余裕を持たせる
      generationConfig: { maxOutputTokens: 8000, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('');
}

function parsePlanJson(text) {
  let t = String(text || '').trim();
  // コードフェンスや前置きを除去してJSON部分を取り出す
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AIの応答からJSONを取り出せませんでした');
  t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/** プランの形を検証・正規化（LLM出力は信用しない）。 */
function normalizePlan(raw) {
  const plan = {};
  plan.shop_name = String(raw.shop_name || '').slice(0, 100);
  plan.summary = String(raw.summary || '').slice(0, 300);
  plan.greeting = String(raw.greeting || '').slice(0, 500);

  plan.steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 5).map((s) => ({
    delay_minutes: Math.max(0, parseInt(s.delay_minutes, 10) || 0),
    text: String(s.text || '').slice(0, 1000),
  })).filter((s) => s.text.trim());

  plan.autoreplies = (Array.isArray(raw.autoreplies) ? raw.autoreplies : []).slice(0, 6).map((a) => ({
    keyword: String(a.keyword || '').slice(0, 30),
    match_type: a.match_type === 'exact' ? 'exact' : 'contains',
    reply_text: String(a.reply_text || '').slice(0, 1000),
  })).filter((a) => a.keyword.trim() && a.reply_text.trim());

  const rm = raw.richmenu || {};
  plan.richmenu = {
    chat_bar_text: String(rm.chat_bar_text || 'メニュー').slice(0, 14),
    cells: (Array.isArray(rm.cells) ? rm.cells : []).slice(0, 6).map((c) => ({
      label: String(c.label || '').slice(0, 20),
      type: c.type === 'message' ? 'message' : 'uri',
      value: String(c.value || '').slice(0, 500),
    })),
  };

  const bot = raw.bot || {};
  plan.bot = {
    question_text: String(bot.question_text || '').slice(0, 200),
    choices: (Array.isArray(bot.choices) ? bot.choices : []).slice(0, 4).map((c) => ({
      label: String(c.label || '').slice(0, 20),
      tag: String(c.tag || '').slice(0, 20),
      reply_text: String(c.reply_text || '').slice(0, 500),
    })).filter((c) => c.label.trim()),
  };

  const fm = raw.form || {};
  const FIELD_TYPES = new Set(['text', 'textarea', 'select', 'radio', 'checkbox']);
  plan.form = {
    name: String(fm.name || '事前アンケート').slice(0, 100),
    title: String(fm.title || fm.name || 'ご来店前アンケート').slice(0, 100),
    description: String(fm.description || '').slice(0, 300),
    fields: (Array.isArray(fm.fields) ? fm.fields : []).slice(0, 8).map((f) => ({
      label: String(f.label || '').slice(0, 100),
      type: FIELD_TYPES.has(f.type) ? f.type : 'text',
      options: (Array.isArray(f.options) ? f.options : []).slice(0, 8).map((o) => String(o).slice(0, 50)).filter(Boolean),
      required: !!f.required,
    })).filter((f) => f.label.trim()),
  };

  if (!plan.greeting && plan.steps.length) plan.greeting = plan.steps[0].text;
  if (!plan.steps.length || !plan.autoreplies.length) throw new Error('AIの提案内容が不完全でした。もう一度お試しください。');
  return plan;
}

/**
 * URLを解析して構築プランを生成（副作用なし・プレビュー用）。
 * @returns {{plan}|{error}}
 */
async function analyze(url, opts = {}) {
  let fetched;
  if (opts.site) fetched = { site: opts.site };
  else if (opts.rawText) {
    // ホームページが無い店向け: 紹介文の貼り付けだけで解析できるようにする
    const text = String(opts.rawText).slice(0, MAX_TEXT_CHARS);
    const tel = (text.match(/(0\d{1,4}[-(]?\d{1,4}[-)]?\d{3,4})/) || [])[1] || null;
    fetched = { site: { title: '', description: '', tel, text, links: [] } };
  } else fetched = await fetchSite(url);
  if (fetched.error) return fetched;
  const user = buildUserContent(fetched.site, url || '（URLなし・お店の紹介文から）');
  let text;
  try {
    if (opts.llm) text = await opts.llm(PLAN_INSTRUCTION, user);           // テスト用フック
    else if (config.ai.anthropicKey) text = await callClaude(PLAN_INSTRUCTION, user);
    else text = await callGemini(PLAN_INSTRUCTION, user);
  } catch (e) {
    logger.error('aisetup llm error', { err: String((e && e.message) || e) });
    return { error: 'AIによる解析に失敗しました。時間をおいて再度お試しください。' };
  }
  try {
    return { plan: normalizePlan(parsePlanJson(text)), site_title: fetched.site.title };
  } catch (e) {
    logger.warn('aisetup parse error', { err: String((e && e.message) || e), preview: String(text).slice(0, 300) });
    return { error: 'AIの提案を読み取れませんでした。もう一度お試しください。' };
  }
}

/**
 * プランを実際に反映する（ステップ配信・自動応答・会話ボットを作成）。
 * リッチメニュー構成は作成せず、フロントのビルダーへ渡すために返す（presetsと同じ方式）。
 */
function applyPlan(db, tenant, rawPlan) {
  const plan = normalizePlan(rawPlan || {});
  const created = { steps: 0, autoreplies: 0, bot: false };

  const campaign = steps.createCampaign(db, tenant.id, { name: `(AI) ${plan.shop_name || 'ホームページ'}から作成`, media: null, active: true });
  steps.setSteps(db, tenant.id, campaign.id, plan.steps.map((s) => ({ delay_minutes: s.delay_minutes, text: s.text })));
  created.steps = plan.steps.length;

  for (const a of plan.autoreplies) {
    autoreply.createRule(db, tenant.id, { keyword: a.keyword, match_type: a.match_type, reply_text: a.reply_text });
    created.autoreplies++;
  }

  if (plan.bot.question_text && plan.bot.choices.length >= 2) {
    const flow = identify.createFlow(db, tenant.id, {
      name: '(AI) 友だち追加時の振り分け',
      triggerType: 'follow',
      questionText: plan.bot.question_text,
      active: true,
      messageType: 'quick',
    });
    identify.setChoices(db, tenant.id, flow.id, plan.bot.choices.map((c) => ({
      label: c.label, tag: c.tag || null, replyText: c.reply_text || null,
    })));
    created.bot = true;
  }

  // 事前アンケート（問診）フォーム
  created.form = false;
  if (plan.form && plan.form.fields && plan.form.fields.length) {
    forms.createForm(db, tenant.id, {
      name: `(AI) ${plan.form.name}`,
      title: plan.form.title,
      description: plan.form.description,
      fields: plan.form.fields,
      tag: '回答済',
    });
    created.form = true;
  }

  // 前日リマインドの既定キャンペーン（予約システム連携・手動登録どちらでも使う受け皿）
  try { reminders.ensureQuickCampaign(db, tenant.id); created.reminder = true; } catch { created.reminder = false; }

  return { ok: true, created, richmenu: plan.richmenu, campaign_id: campaign.id };
}

// ---------------- サポートチャット（院の質問にAIが回答） ----------------

// Keiroの機能ナレッジ（AIサポートの唯一の根拠。ここに無いことは答えず運営へ誘導する）
const SUPPORT_KNOWLEDGE = `
【Keiroとは】LINE公式アカウントの集客・運用ツール。広告やチラシごとの計測リンクで「どこから友だちが増えたか」を計測し、ステップ配信・自動応答・リッチメニューなどで運用を自動化する。
【料金】ライトプラン 月4,980円(税込)（計測リンク3本まで・ステップ配信2シナリオ・基本機能）／プロプラン 月9,800円(税込)（全機能: 受信箱・リマインダ・回答フォーム・会話ボット・詳細分析・AI機能など）。無料期間: 自己申込14日・公式LINE制作とセット(パスコード入力)30日。支払いはクレジットカード（決済リンクから登録）。解約は無料期間内ならメール/LINEで連絡するだけ・費用ゼロ。
【初期設定】ダッシュボードの「かんたんスタート（LINE連携ウィザード）」の順に進める。LINE公式アカウントマネージャー(manager.line.biz)でMessaging APIを有効化→Channel secretとアクセストークン(長期)をKeiroに貼る→Webhook URLをLINE Developersに設定→応答メッセージをOFF。詳しい図解: https://keiro.s-toru.com/guide ／使い方全般: https://keiro.s-toru.com/manual
【AIおまかせ構築】「🪄ホームページから自動セットアップ」にURLを貼る（またはお店の紹介文を貼り付け）→「おまかせで全部つくる」で自動メッセージ・自動返信・振り分けボット・事前アンケート・リッチメニュー(背景画像まで)を一括作成。内容は各欄であとから編集可能。
【計測リンク】広告・チラシ・Googleマップ等の媒体ごとに発行し、そのリンク経由の友だち追加を自動でカウント。QRコードもその場で発行可能（一覧のQRボタン）。
【ステップ配信】友だち追加後に自動で送る複数通のメッセージ。流入経路別の出し分けも可能。
【一斉配信】全員/タグ/媒体別に送れる。LINE公式の無料枠(月200通)を超えるとLINE側で課金が必要な点に注意。
【自動応答】キーワード(例:営業時間)に自動返信。【会話ボット】ボタン選択で新規/既存を自動振り分け・タグ付け。
【リッチメニュー】トーク下部の固定メニュー。テンプレから作成しAIで背景画像も生成可能。「作成してLINEに反映」で公開。
【受信箱】(プロ)1対1のチャット。AI返信案ボタンあり。【リマインダ】(プロ)予約日を登録すると前日18時に自動リマインド。予約システムとの連携URL(リマインダ欄に表示)にPOSTすると予約確認+リマインド自動登録。
【回答フォーム】(プロ)事前問診などのフォームを作成しLINEで送信、回答でタグ付け。複数選択(チェックボックス)対応。
【マルチ店舗】ヘッダーの店舗切替メニュー「＋新しい店舗を追加」で2店舗目を追加できる（店舗ごとに別のLINE公式アカウントを接続・契約も店舗ごと）。
【パスワード】ログイン画面の「パスワードをお忘れですか？」からメールで再設定できる。
【うまくいかない時】LINEからの返信が二重になる→LINE公式アカウントマネージャーの応答メッセージをOFFに。友だち追加しても挨拶が来ない→Webhook URLの設定とWebhook利用ONを確認。
`;

const SUPPORT_INSTRUCTION = `あなたはLINE集客ツール「Keiro」のサポート担当AIです。院・店舗のオーナー（ITが得意でない方が多い）からの質問に答えます。

ルール:
- 根拠は「Keiroの機能ナレッジ」と「この院の利用状況」のみ。そこに無いことは推測で答えず、confident=false にして運営への問い合わせを勧める。
- 【重要】画面のボタン名・メニュー名・手順の詳細は、ナレッジに書かれているものだけを使う。書かれていない操作詳細は創作せず「ダッシュボードの◯◯の欄をご覧ください」程度に留める（Keiroは1ページのダッシュボードで、左側メニュー等は存在しない）。
- 専門用語を避けて短く。
- 料金・解約・契約に関する質問はナレッジの記載範囲で答え、個別の請求状況など分からないことは confident=false。
- 不具合報告・クレーム・個別対応が必要な内容（返金、個別カスタマイズ等）は謝意を示しつつ confident=false。
- 丁寧で親しみやすく。長くても400字。絵文字は多くても1つ。

次のJSONだけを出力（前後の説明・コードフェンス不要）:
{"answer": "回答文", "confident": true または false}
confident=false のときは answer の末尾で「下の『運営に問い合わせる』ボタンから送っていただければ、担当者が直接お答えします」と案内すること。`;

/**
 * サポートチャットのAI回答。history = [{sender, text}]（古い順・直近数件）。
 * @returns {{answer, confident}|{error}}
 */
async function supportReply(db, tenant, history, opts = {}) {
  if (!enabled() && !opts.llm) return { error: 'AIサポートは現在準備中です' };
  const counts = {
    links: db.prepare('SELECT COUNT(*) n FROM links WHERE tenant_id=?').get(tenant.id).n,
    steps: db.prepare('SELECT COUNT(*) n FROM step_campaigns WHERE tenant_id=? AND active=1').get(tenant.id).n,
    friends: db.prepare('SELECT COUNT(*) n FROM friends WHERE tenant_id=?').get(tenant.id).n,
  };
  const user = `--- Keiroの機能ナレッジ ---
${SUPPORT_KNOWLEDGE}

--- この院の利用状況 ---
院名: ${tenant.name || '未設定'} / プラン: ${tenant.plan === 'light' ? 'ライト' : 'プロ'}
LINE連携: ${tenant.line_channel_access_token ? '設定済み' : '未設定'} / 計測リンク${counts.links}本 / ステップ配信${counts.steps}件 / 友だち${counts.friends}人

--- 会話（古い順。「院」が質問者） ---
${history.map((m) => `${m.sender === 'tenant' ? '院' : m.sender === 'operator' ? '運営' : 'AI'}: ${m.text}`).join('\n')}

最後の「院」の質問に回答してください。`;
  let text;
  try {
    if (opts.llm) text = await opts.llm(SUPPORT_INSTRUCTION, user);
    else if (config.ai.anthropicKey) text = await callClaude(SUPPORT_INSTRUCTION, user);
    else text = await callGemini(SUPPORT_INSTRUCTION, user);
  } catch (e) {
    logger.error('support llm error', { err: String((e && e.message) || e) });
    return { error: 'AIの応答に失敗しました。時間をおくか、「運営に問い合わせる」からご連絡ください。' };
  }
  try {
    const j = parsePlanJson(text);
    const answer = String(j.answer || '').slice(0, 1200).trim();
    if (!answer) throw new Error('empty answer');
    return { answer, confident: j.confident !== false };
  } catch (e) {
    // JSONで返らなかった場合はテキストをそのまま回答として扱う
    const raw = String(text || '').trim();
    if (raw) return { answer: raw.slice(0, 1200), confident: false };
    return { error: 'AIの応答を読み取れませんでした。「運営に問い合わせる」からご連絡ください。' };
  }
}

// ---------------- AI返信案（受信箱） ----------------

const REPLY_INSTRUCTION = `あなたは日本の店舗（治療院・整骨院・サロン等）のLINE受付スタッフです。
お客様との会話履歴を読み、店側からの返信案を3つ提案してください。

ルール:
- 【最重要】「お店の情報（正しい事実）」に書かれていないことは一切断定しない。
  料金・空き状況・営業時間・駐車場・設備・メニュー内容など、事実の質問に情報が無い場合は、
  すべて「確認して折り返しご連絡いたします」のように受けること。「ございます」「あります」等の
  断定は、お店の情報に明記がある場合のみ許可。推測での回答は重大な誤案内になるため厳禁。
- 予約の確定を勝手に約束しない（「承りました。追ってご連絡します」まで）。
- 医療的な診断・効果の断定はしない。
- 丁寧で親しみやすい文体。絵文字は多くても1つ。各案は200字以内。
- 3案は方向性を変える（例: ①すぐ答える ②確認して折り返す ③追加の質問をする）。

次のJSONだけを出力すること（前後の説明・コードフェンス不要）:
{"suggestions": ["返信案1", "返信案2", "返信案3"]}`;

/**
 * 受信箱の会話履歴からAI返信案を最大3つ生成する。
 * 事実の情報源として、その院が設定済みのキーワード自動応答（＝オーナーが書いた正しい案内文）を渡す。
 */
async function suggestReplies(db, tenant, lineUserId, opts = {}) {
  const msgs = db.prepare(
    `SELECT direction, text FROM inbox_messages WHERE tenant_id = ? AND line_user_id = ? ORDER BY created_at DESC LIMIT 12`
  ).all(tenant.id, lineUserId).reverse();
  if (!msgs.length) return { error: 'この友だちとの会話がまだありません' };
  if (msgs[msgs.length - 1].direction !== 'in') return { error: '相手からの新しいメッセージがありません（最後の発言がこちら側です）' };

  const friend = db.prepare('SELECT display_name, tags, memo FROM friends WHERE tenant_id = ? AND line_user_id = ?').get(tenant.id, lineUserId);
  const knowledge = db.prepare('SELECT keyword, reply_text FROM autoreplies WHERE tenant_id = ? AND active = 1 LIMIT 20').all(tenant.id);

  const user = `店名: ${tenant.name || '当店'}
お客様: ${friend && friend.display_name ? friend.display_name + 'さん' : '（名前未取得）'}${friend && friend.tags ? `（タグ: ${friend.tags}）` : ''}
${friend && friend.memo ? `スタッフのメモ: ${friend.memo}` : ''}

--- お店の情報（正しい事実。ここに無いことは断定しない） ---
${knowledge.length ? knowledge.map((k) => `・${k.keyword}: ${k.reply_text}`).join('\n') : '（登録なし）'}

--- 会話履歴（古い順。「客」がお客様、「店」がこちら側） ---
${msgs.map((m) => `${m.direction === 'in' ? '客' : '店'}: ${m.text}`).join('\n')}

最後のお客様のメッセージへの返信案を3つ提案してください。`;

  let text;
  try {
    if (opts.llm) text = await opts.llm(REPLY_INSTRUCTION, user);          // テスト用フック
    else if (config.ai.anthropicKey) text = await callClaude(REPLY_INSTRUCTION, user);
    else text = await callGemini(REPLY_INSTRUCTION, user);
  } catch (e) {
    logger.error('ai reply llm error', { err: String((e && e.message) || e) });
    return { error: 'AIの生成に失敗しました。時間をおいて再度お試しください。' };
  }
  try {
    const raw = parsePlanJson(text);
    const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : [])
      .map((t) => String(t || '').trim().slice(0, 500)).filter(Boolean).slice(0, 3);
    if (!suggestions.length) throw new Error('empty');
    return { suggestions };
  } catch {
    logger.warn('ai reply parse error', { preview: String(text).slice(0, 200) });
    return { error: 'AIの提案を読み取れませんでした。もう一度お試しください。' };
  }
}

// ---------------- リッチメニューAI壁打ち ----------------

const RM_CHAT_INSTRUCTION = `あなたは日本の店舗（治療院・整骨院・サロン等）のLINEリッチメニュー設計の専門家です。
オーナーと相談しながら、リッチメニュー（LINEトーク画面下部のボタンメニュー）の構成を一緒に決めます。

利用できるテンプレート（key: ボタン数・形）:
- full-1: 大きい1ボタン / full-2col: 左右2分割 / full-2row: 上下2分割
- full-3col: 横3分割 / full-4: 4分割(2×2) / full-6: 6分割(2×3・定番)
- compact-1/compact-2/compact-3: 高さ半分のコンパクト型（1〜3ボタン）

各ボタンは label（表示文言・6字以内推奨）と、動作 type: "uri"（リンクを開く）または "message"（そのテキストをトークに送信→自動応答と組み合わせ可）を持ちます。

会話のコツ:
- オーナーの目的（予約を増やしたい/新規向け/キャンペーン等）を聞き、具体的な構成を提案する
- 提案するときは必ず menu をJSONに含める（構成が変わらない相談だけの返答なら menu は null）
- 予約導線は必ず目立つ位置（左上 or 大きいボタン）に置くよう助言する
- image_prompt には、背景画像をAI生成するための日本語の雰囲気説明を書く（例: 「淡いグリーンのグラデーションに葉のモチーフ、清潔感のあるフラットデザイン」）

必ず次のJSONだけを出力すること（コードフェンス不要）:
{
  "reply": "オーナーへの返答（丁寧・簡潔。提案理由や次に決めることを1〜3文で）",
  "menu": {
    "template": "full-6",
    "theme": "green | ink | warm",
    "chat_bar_text": "メニュー(14字以内)",
    "cells": [{"label": "ご予約", "type": "uri", "value": "https://..."}, ...テンプレのボタン数と同数],
    "image_prompt": "背景画像の雰囲気（日本語）"
  } または null
}`;

const RM_TEMPLATE_CELLS = { 'full-1': 1, 'full-2col': 2, 'full-2row': 2, 'full-3col': 3, 'full-4': 4, 'full-6': 6, 'compact-1': 1, 'compact-2': 2, 'compact-3': 3 };

function normalizeMenuProposal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const template = RM_TEMPLATE_CELLS[raw.template] ? raw.template : 'full-6';
  const n = RM_TEMPLATE_CELLS[template];
  const cells = (Array.isArray(raw.cells) ? raw.cells : []).slice(0, n).map((c) => ({
    label: String(c.label || '').slice(0, 20),
    type: c.type === 'message' ? 'message' : 'uri',
    value: String(c.value || '').slice(0, 500),
  }));
  while (cells.length < n) cells.push({ label: '', type: 'uri', value: '' });
  return {
    template,
    theme: ['green', 'ink', 'warm'].includes(raw.theme) ? raw.theme : 'green',
    chat_bar_text: String(raw.chat_bar_text || 'メニュー').slice(0, 14),
    cells,
    image_prompt: String(raw.image_prompt || '').slice(0, 500),
  };
}

/**
 * リッチメニューのAI壁打ち。会話履歴と現在のビルダー状態を渡し、返答＋構成案を得る。
 * @param {Array<{role:'user'|'model', text:string}>} messages
 */
async function richmenuChat(db, tenant, messages, currentMenu, opts = {}) {
  const history = (Array.isArray(messages) ? messages : []).slice(-12)
    .map((m) => `${m.role === 'model' ? 'AI' : 'オーナー'}: ${String(m.text || '').slice(0, 1000)}`).join('\n');
  const links = db.prepare('SELECT name, id FROM links WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10').all(tenant.id);
  const arps = db.prepare('SELECT keyword FROM autoreplies WHERE tenant_id = ? AND active = 1 LIMIT 10').all(tenant.id);
  const user = `店名: ${tenant.name || '当店'}
友だち追加URL: ${tenant.line_oa_add_url ? 'あり（予約ボタン等に使用可）' : '未設定'}
設定済みのキーワード自動応答: ${arps.map((a) => a.keyword).join('、') || 'なし'}
（type:"message" のボタンはこれらのキーワードを送ると自動返信と連動できます）
計測リンク: ${links.map((l) => `${l.name}=${config.baseUrl}/c/${l.id}`).join(' / ') || 'なし'}

現在のビルダーの状態: ${currentMenu ? JSON.stringify(currentMenu).slice(0, 1200) : '（未設定）'}

--- ここまでの会話 ---
${history || '（最初の相談です）'}`;

  let text;
  try {
    if (opts.llm) text = await opts.llm(RM_CHAT_INSTRUCTION, user);
    else if (config.ai.anthropicKey) text = await callClaude(RM_CHAT_INSTRUCTION, user);
    else text = await callGemini(RM_CHAT_INSTRUCTION, user);
  } catch (e) {
    logger.error('rm chat llm error', { err: String((e && e.message) || e) });
    return { error: 'AIとの通信に失敗しました。時間をおいて再度お試しください。' };
  }
  try {
    const raw = parsePlanJson(text);
    return {
      reply: String(raw.reply || '').slice(0, 2000) || 'ご希望を教えてください。',
      menu: raw.menu ? normalizeMenuProposal(raw.menu) : null,
    };
  } catch {
    // JSONで返らなかった場合は本文をそのまま返答として扱う（提案なし）
    return { reply: String(text || '').slice(0, 2000), menu: null };
  }
}

/**
 * リッチメニューの背景画像をAI生成（Gemini画像モデル）。文字は入れない前提で、
 * フロントのCanvasがこの上にボタン文言を重ねて完成させる。
 * @returns {{mime, base64}|{error}}
 */
async function generateMenuBackground(prompt, template) {
  if (!config.ai.geminiKey) return { error: '画像生成にはGeminiの設定が必要です（運営にお問い合わせください）' };
  const compact = String(template || '').startsWith('compact');
  const fullPrompt = `LINEリッチメニューの背景画像。${String(prompt || '清潔感のある淡いグラデーション').slice(0, 400)}。
フラットデザイン、上品で落ち着いた配色、店舗のメニューボタンの下地として使うため主張しすぎないこと。
【厳守】文字・数字・ロゴ・ボタン・枠線は一切描かない。写実的な人物は描かない。`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.ai.imageModel)}:generateContent?key=${encodeURIComponent(config.ai.geminiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: compact ? '21:9' : '3:2' } },
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Gemini image ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const img = parts.find((p) => p.inlineData && p.inlineData.data);
    if (!img) throw new Error('画像が返りませんでした');
    return { mime: img.inlineData.mimeType || 'image/png', base64: img.inlineData.data };
  } catch (e) {
    logger.error('rm image gen error', { err: String((e && e.message) || e) });
    return { error: '画像の生成に失敗しました。少し表現を変えて再度お試しください。' };
  }
}

module.exports = {
  supportReply,
  enabled, fetchSite, extractFromHtml, analyze, applyPlan, normalizePlan, parsePlanJson, isSafeUrl,
  suggestReplies, richmenuChat, generateMenuBackground, normalizeMenuProposal,
};
