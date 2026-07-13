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

function enabled() {
  return !!(config.ai.anthropicKey || config.ai.geminiKey);
}

// ---------------- サイト取得・本文抽出 ----------------

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 800 * 1024;
const MAX_TEXT_CHARS = 9000;

/** プライベートアドレス等へのSSRFを避ける簡易チェック。 */
function isSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return false;
  }
  return true;
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
  if (!isSafeUrl(url)) return { error: 'URLの形式が正しくありません（http:// または https:// で始まる公開ページを指定してください）' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KeiroSetupBot/1.0)' , 'Accept-Language': 'ja' },
    });
    if (!res.ok) return { error: `ページを取得できませんでした（HTTP ${res.status}）。URLをご確認ください。` };
    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.slice(0, MAX_HTML_BYTES).toString('utf8');
    return { site: extractFromHtml(html, url) };
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
  }
}
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

  if (!plan.greeting && plan.steps.length) plan.greeting = plan.steps[0].text;
  if (!plan.steps.length || !plan.autoreplies.length) throw new Error('AIの提案内容が不完全でした。もう一度お試しください。');
  return plan;
}

/**
 * URLを解析して構築プランを生成（副作用なし・プレビュー用）。
 * @returns {{plan}|{error}}
 */
async function analyze(url, opts = {}) {
  const fetched = opts.site ? { site: opts.site } : await fetchSite(url);
  if (fetched.error) return fetched;
  const user = buildUserContent(fetched.site, url);
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

  return { ok: true, created, richmenu: plan.richmenu, campaign_id: campaign.id };
}

module.exports = { enabled, fetchSite, extractFromHtml, analyze, applyPlan, normalizePlan, parsePlanJson, isSafeUrl };
