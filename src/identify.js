'use strict';

// 会話ボット（自己申告フロー）: 友だち追加時に「あてはまる方」を選んでもらい、
// 選択に応じて friends.tags にタグを付与し、対応するステップ配信へ自動登録する。
// これで「新規/通院中で自動分岐」（本命B）を LINE公式アカウント単体ではなく
// Keiro（母艦）側で実現する。Phase1は「1問＋選択肢」の単一質問フロー。
const { newId } = require('./sign');
const logger = require('./logger');
const steps = require('./steps');
const friends = require('./friends');

// ---- フロー/選択肢 CRUD ----

function listFlows(db, tenantId) {
  const flows = db.prepare(
    'SELECT * FROM bot_flows WHERE tenant_id = ? ORDER BY created_at DESC'
  ).all(tenantId);
  for (const f of flows) {
    f.choices = db.prepare('SELECT * FROM bot_choices WHERE flow_id = ? ORDER BY sort, created_at').all(f.id);
  }
  return flows;
}

function getFlow(db, tenantId, id) {
  const f = db.prepare('SELECT * FROM bot_flows WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!f) return null;
  f.choices = db.prepare('SELECT * FROM bot_choices WHERE flow_id = ? ORDER BY sort, created_at').all(f.id);
  f.columns = db.prepare('SELECT * FROM bot_columns WHERE flow_id = ? ORDER BY sort, created_at').all(f.id);
  return f;
}

const MSG_TYPES = new Set(['quick', 'buttons', 'carousel']);

function createFlow(db, tenantId, { name, triggerType, triggerKeyword, questionText, active, messageType, altText, imageUrl }) {
  const id = newId('bf');
  const now = Date.now();
  db.prepare(
    `INSERT INTO bot_flows (id, tenant_id, name, trigger_type, trigger_keyword, question_text, message_type, alt_text, image_url, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, tenantId, String(name || '自己申告フロー'),
    triggerType === 'keyword' ? 'keyword' : 'follow',
    triggerKeyword ? String(triggerKeyword).trim() : null,
    String(questionText || 'あてはまる方を選んでください'),
    MSG_TYPES.has(messageType) ? messageType : 'quick',
    altText ? String(altText).slice(0, 400) : null,
    imageUrl ? String(imageUrl).trim() : null,
    active ? 1 : 0, now, now
  );
  return getFlow(db, tenantId, id);
}

function updateFlow(db, tenantId, id, fields) {
  const f = db.prepare('SELECT id FROM bot_flows WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!f) return null;
  const sets = [], vals = [];
  if ('name' in fields) { sets.push('name = ?'); vals.push(String(fields.name || '')); }
  if ('questionText' in fields) { sets.push('question_text = ?'); vals.push(String(fields.questionText || '')); }
  if ('triggerType' in fields) { sets.push('trigger_type = ?'); vals.push(fields.triggerType === 'keyword' ? 'keyword' : 'follow'); }
  if ('triggerKeyword' in fields) { sets.push('trigger_keyword = ?'); vals.push(fields.triggerKeyword ? String(fields.triggerKeyword).trim() : null); }
  if ('messageType' in fields) { sets.push('message_type = ?'); vals.push(MSG_TYPES.has(fields.messageType) ? fields.messageType : 'quick'); }
  if ('altText' in fields) { sets.push('alt_text = ?'); vals.push(fields.altText ? String(fields.altText).slice(0, 400) : null); }
  if ('imageUrl' in fields) { sets.push('image_url = ?'); vals.push(fields.imageUrl ? String(fields.imageUrl).trim() : null); }
  if ('active' in fields) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(Date.now(), id);
    db.prepare(`UPDATE bot_flows SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getFlow(db, tenantId, id);
}

/**
 * 選択肢を丸ごと置き換える。配列順がsort。
 * choices=[{label, tag, campaignId, replyText, actionType('postback'|'uri'), uri, nextFlowId, columnId}]
 */
function setChoices(db, tenantId, flowId, choices) {
  const f = db.prepare('SELECT id FROM bot_flows WHERE id = ? AND tenant_id = ?').get(flowId, tenantId);
  if (!f) return null;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bot_choices WHERE flow_id = ?').run(flowId);
    let sort = 0;
    for (const c of choices || []) {
      const label = (c.label || '').toString().trim();
      if (!label) continue;
      const actionType = c.actionType === 'uri' ? 'uri' : 'postback';
      db.prepare(
        `INSERT INTO bot_choices (id, flow_id, label, tag, campaign_id, reply_text, action_type, uri, next_flow_id, column_id, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newId('bc'), flowId, label,
        c.tag ? String(c.tag).trim() : null,
        c.campaignId ? String(c.campaignId).trim() : null,
        c.replyText ? String(c.replyText) : null,
        actionType,
        actionType === 'uri' && c.uri ? String(c.uri).trim() : null,
        c.nextFlowId ? String(c.nextFlowId).trim() : null,
        c.columnId ? String(c.columnId).trim() : null,
        sort++, Date.now()
      );
    }
  });
  tx();
  return getFlow(db, tenantId, flowId);
}

/** カルーセルのカラムを丸ごと置き換える。columns=[{id?, title, text, imageUrl}] 配列順がsort。
 *  返り値は {oldId: newId} のマップ（choices側の columnId を貼り替えるため）。 */
function setColumns(db, tenantId, flowId, columns) {
  const f = db.prepare('SELECT id FROM bot_flows WHERE id = ? AND tenant_id = ?').get(flowId, tenantId);
  if (!f) return null;
  const idMap = {};
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bot_columns WHERE flow_id = ?').run(flowId);
    let sort = 0;
    for (const col of columns || []) {
      const nid = newId('bcol');
      if (col.id) idMap[col.id] = nid;
      db.prepare(
        `INSERT INTO bot_columns (id, flow_id, title, text, image_url, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        nid, flowId,
        col.title ? String(col.title).slice(0, 40) : null,
        col.text ? String(col.text).slice(0, 120) : null,
        col.imageUrl ? String(col.imageUrl).trim() : null,
        sort++, Date.now()
      );
    }
  });
  tx();
  return idMap;
}

function deleteFlow(db, tenantId, id) {
  const f = db.prepare('SELECT id FROM bot_flows WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!f) return { deleted: 0 };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bot_choices WHERE flow_id = ?').run(id);
    db.prepare('DELETE FROM bot_columns WHERE flow_id = ?').run(id);
    db.prepare('DELETE FROM bot_flows WHERE id = ?').run(id);
  });
  tx();
  return { deleted: 1 };
}

// ---- 実行（webhookから利用）----

/** 友だち追加トリガーの有効フローを1件返す（選択肢が無ければnull）。 */
function getActiveFollowFlow(db, tenantId) {
  const flow = db.prepare(
    "SELECT * FROM bot_flows WHERE tenant_id = ? AND trigger_type = 'follow' AND active = 1 ORDER BY created_at DESC LIMIT 1"
  ).get(tenantId);
  if (!flow) return null;
  flow.choices = db.prepare('SELECT * FROM bot_choices WHERE flow_id = ? ORDER BY sort, created_at').all(flow.id);
  return flow.choices.length ? flow : null;
}

/** キーワードトリガーの有効フローを返す（完全一致）。 */
function getKeywordFlow(db, tenantId, text) {
  if (!text) return null;
  const flow = db.prepare(
    "SELECT * FROM bot_flows WHERE tenant_id = ? AND trigger_type = 'keyword' AND active = 1 AND trigger_keyword = ? ORDER BY created_at DESC LIMIT 1"
  ).get(tenantId, String(text).trim());
  if (!flow) return null;
  flow.choices = db.prepare('SELECT * FROM bot_choices WHERE flow_id = ? ORDER BY sort, created_at').all(flow.id);
  return flow.choices.length ? flow : null;
}

// ---- メッセージ組み立て（クイックリプライ / ボタンテンプレ / カルーセル）----

/** 選択肢1件をLINEの action オブジェクトへ。uri型はリンク、それ以外はpostback（タップで分岐）。 */
function choiceToAction(flow, c) {
  const label = String(c.label || '').slice(0, 20) || '選択';
  if (c.action_type === 'uri' && c.uri) {
    return { type: 'uri', label, uri: String(c.uri) };
  }
  return { type: 'postback', label, data: `idf:${flow.id}:${c.id}`, displayText: c.label };
}

/** クイックリプライ（キーボード上のボタン。最大13）。 */
function buildQuickReplyMessages(flow) {
  const items = (flow.choices || []).slice(0, 13).map((c) => ({ type: 'action', action: choiceToAction(flow, c) }));
  const msg = { type: 'text', text: flow.question_text || 'あてはまるものを選んでください' };
  if (items.length) msg.quickReply = { items };
  return [msg];
}

/** ボタンテンプレート（トークに残るボタンカード。最大4）。 */
function buildButtonsMessage(flow) {
  const choices = (flow.choices || []).slice(0, 4);
  if (!choices.length) return buildQuickReplyMessages(flow);
  const hasImg = !!flow.image_url;
  const text = String(flow.question_text || ' ').slice(0, hasImg ? 60 : 160) || ' ';
  const template = { type: 'buttons', text, actions: choices.map((c) => choiceToAction(flow, c)) };
  if (hasImg) { template.thumbnailImageUrl = flow.image_url; template.imageAspectRatio = 'rectangle'; template.imageSize = 'cover'; }
  return [{ type: 'template', altText: (flow.alt_text || flow.question_text || 'メッセージ').slice(0, 400), template }];
}

/** カルーセル（横スワイプのカード。最大10カラム／各カード最大3ボタン）。
 *  LINE仕様: 全カラムのボタン数を揃える必要があるため、少ないカラムはno-opでパディング。 */
function buildCarouselMessage(flow) {
  const cols = (flow.columns || []).slice(0, 10);
  if (!cols.length) return buildButtonsMessage(flow);
  const byCol = {};
  for (const c of flow.choices || []) { (byCol[c.column_id] = byCol[c.column_id] || []).push(c); }
  const actionsPer = cols.map((col) => (byCol[col.id] || []).slice(0, 3));
  const maxA = Math.max(1, ...actionsPer.map((a) => a.length));
  const noop = { type: 'postback', label: '　', data: 'idf:noop', displayText: ' ' };
  const columns = cols.map((col, i) => {
    const hasImg = !!col.image_url;
    const acts = actionsPer[i].map((c) => choiceToAction(flow, c));
    while (acts.length < maxA) acts.push(noop);
    const column = { text: String(col.text || ' ').slice(0, hasImg ? 60 : 120) || ' ', actions: acts };
    if (col.title) column.title = String(col.title).slice(0, 40);
    if (hasImg) column.thumbnailImageUrl = col.image_url;
    return column;
  });
  const template = { type: 'carousel', columns };
  if (cols.some((c) => c.image_url)) template.imageAspectRatio = 'rectangle', template.imageSize = 'cover';
  return [{ type: 'template', altText: (flow.alt_text || flow.name || 'メニュー').slice(0, 400), template }];
}

/** message_type に応じてフローのメッセージ配列を返す。 */
function buildFlowMessages(flow) {
  if (!flow) return [];
  if (flow.message_type === 'buttons') return buildButtonsMessage(flow);
  if (flow.message_type === 'carousel') return buildCarouselMessage(flow);
  return buildQuickReplyMessages(flow);
}

/**
 * postback（クイックリプライのタップ）を処理する。
 * data 形式: "idf:<flowId>:<choiceId>"
 * 副作用: friends.tags にタグ付与 ＋ 対応ステップ配信へ登録。
 * @returns {{replyText:string|null, tag:string|null}|null}
 */
function handlePostback(db, tenant, lineUserId, data) {
  if (!data || typeof data !== 'string' || data.indexOf('idf:') !== 0) return null;
  if (data === 'idf:noop') return null; // カルーセルのパディングボタン
  const parts = data.split(':');
  const flowId = parts[1], choiceId = parts[2];
  const choice = db.prepare(
    `SELECT c.* FROM bot_choices c JOIN bot_flows f ON c.flow_id = f.id
     WHERE c.id = ? AND c.flow_id = ? AND f.tenant_id = ?`
  ).get(choiceId, flowId, tenant.id);
  if (!choice) return null;

  // 1) タグ付与（既存タグに追記・重複回避）
  if (choice.tag) {
    const fr = db.prepare('SELECT id, tags FROM friends WHERE tenant_id = ? AND line_user_id = ?').get(tenant.id, lineUserId);
    if (fr) {
      const set = new Set(String(fr.tags || '').split(',').map((s) => s.trim()).filter(Boolean));
      set.add(choice.tag);
      friends.setTags(db, tenant.id, fr.id, Array.from(set));
    }
  }

  // 2) ステップ配信へ登録（明示campaign優先、無ければtagのaudience_tagで解決）
  try {
    if (choice.campaign_id) steps.enrollInCampaign(db, { tenantId: tenant.id, lineUserId, campaignId: choice.campaign_id });
    else if (choice.tag) steps.enrollByTag(db, { tenantId: tenant.id, lineUserId, tag: choice.tag });
  } catch (e) {
    logger.error('identify enroll error', { err: String((e && e.message) || e) });
  }

  // 3) 回答済みマーク（見逃し救済の再質問を止める）
  db.prepare('UPDATE friends SET identified_at = ? WHERE tenant_id = ? AND line_user_id = ?')
    .run(Date.now(), tenant.id, lineUserId);

  logger.info('identify choice', { tenant_id: tenant.id, flow_id: flowId, tag: choice.tag || null, next: choice.next_flow_id || null });
  return { replyText: choice.reply_text || null, tag: choice.tag || null, nextFlowId: choice.next_flow_id || null };
}

// ---- 見逃し救済（自己申告の再質問） ----

const REASK_INTERVAL_MS = 24 * 3600 * 1000; // 24時間間隔
const REASK_MAX_ASKS = 3;                   // 質問は合計3回まで（初回含む）

/** 質問を送った記録（回数カウント）。 */
function markAsked(db, tenantId, lineUserId, now = Date.now()) {
  db.prepare(
    `UPDATE friends SET identify_asked_at = ?, identify_ask_count = COALESCE(identify_ask_count, 0) + 1
     WHERE tenant_id = ? AND line_user_id = ?`
  ).run(now, tenantId, lineUserId);
}

/** フローの選択肢タグを既に持っているか（回答済みの保険判定）。 */
function hasFlowTag(flow, friendTags) {
  const tags = String(friendTags || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (flow.choices || []).some((c) => c.tag && tags.includes(c.tag));
}

/**
 * この友だちに再質問すべきなら follow フローを返す（不要なら null）。
 * 条件: 有効なfollowフローあり／未回答／24h以上経過／質問回数が上限未満。
 */
function getReaskFlow(db, tenant, lineUserId, now = Date.now()) {
  const flow = getActiveFollowFlow(db, tenant.id);
  if (!flow) return null;
  const fr = db.prepare('SELECT * FROM friends WHERE tenant_id = ? AND line_user_id = ?').get(tenant.id, lineUserId);
  if (!fr || fr.status !== 'active') return null;
  if (fr.identified_at) return null;
  if (hasFlowTag(flow, fr.tags)) return null; // 旧データ救済: タグ持ち=回答済み扱い
  if ((fr.identify_ask_count || 0) >= REASK_MAX_ASKS) return null;
  if (fr.identify_asked_at && now - fr.identify_asked_at < REASK_INTERVAL_MS) return null;
  return flow;
}

/** 再質問用メッセージ。ボタン4個以下なら「トークに残るボタンカード」で送る（後からでも押せる）。 */
function buildReaskMessages(flow) {
  const f = { ...flow };
  if ((flow.choices || []).length <= 4 && flow.message_type !== 'carousel') f.message_type = 'buttons';
  if (!f.alt_text) f.alt_text = f.question_text;
  return buildFlowMessages(f);
}

/**
 * 定期ジョブ: 質問を見逃したまま無反応の友だちへ、24時間後に1回だけ再質問をプッシュする。
 * （メッセージを送ってきた人は webhook 側で都度救済されるため、ここは「無反応の人」専用）
 * @param {object} [opts.send] テスト用の送信関数 (token, userId, messages) => Promise<{ok}>
 */
async function processReasks(db, opts = {}) {
  const now = opts.now || Date.now();
  const send = opts.send || ((token, userId, messages) => require('./line').pushMessages(token, userId, messages));
  const tenantmod = require('./tenant');
  const tenants = db.prepare("SELECT * FROM tenants WHERE role = 'tenant' AND status = 'active'").all();
  let sent = 0;
  for (const tenant of tenants) {
    const flow = getActiveFollowFlow(db, tenant.id);
    if (!flow) continue;
    const token = tenantmod.resolveSettings(tenant).line.channelAccessToken;
    if (!token) continue;
    // 初回質問(count=1)のまま24時間以上無反応の友だちだけ対象（自動プッシュは1回に留める）
    const rows = db.prepare(
      `SELECT * FROM friends WHERE tenant_id = ? AND status = 'active' AND identified_at IS NULL
        AND COALESCE(identify_ask_count, 0) = 1 AND identify_asked_at IS NOT NULL AND identify_asked_at < ?
        LIMIT 50`
    ).all(tenant.id, now - REASK_INTERVAL_MS);
    for (const fr of rows) {
      if (hasFlowTag(flow, fr.tags)) { // タグ持ちは回答済み扱いにして終了
        db.prepare('UPDATE friends SET identified_at = ? WHERE id = ?').run(now, fr.id);
        continue;
      }
      try {
        const r = await send(token, fr.line_user_id, buildReaskMessages(flow));
        if (r && r.ok) { markAsked(db, tenant.id, fr.line_user_id, now); sent++; }
      } catch (e) {
        logger.error('identify reask push error', { tenant_id: tenant.id, err: String((e && e.message) || e) });
      }
    }
  }
  if (sent) logger.info('identify reask sent', { sent });
  return { sent };
}

// ---- 初期セット（治療院/整骨院向け 新規/通院中フロー）----

/**
 * 「初めて/通院中」の自己申告フローを生成する（でみず等の初期セット）。
 * ステップ配信キャンペーンは別途作成し audience_tag=新規/既存 を付ければ自動連結される。
 */
function seedSeitaiIdentify(db, tenantId, opts = {}) {
  const existing = db.prepare(
    "SELECT id FROM bot_flows WHERE tenant_id = ? AND trigger_type = 'follow'"
  ).get(tenantId);
  if (existing && !opts.force) return getFlow(db, tenantId, existing.id);

  const flow = createFlow(db, tenantId, {
    name: '新規/通院中 自己申告',
    triggerType: 'follow',
    questionText: 'ご登録ありがとうございます😊\nあてはまる方をタップしてください👇',
    active: true,
  });
  setChoices(db, tenantId, flow.id, [
    {
      label: '🔰 初めて',
      tag: '新規',
      replyText: 'はじめまして！ご来院お待ちしております🌿\n初回特典クーポンは「クーポン」と送るとご確認いただけます。',
    },
    {
      label: '🔁 通院中',
      tag: '既存',
      replyText: 'いつもありがとうございます😊\nお身体の調子はいかがですか？ご予約は「予約」と送ってください。',
    },
  ]);
  return getFlow(db, tenantId, flow.id);
}

module.exports = {
  listFlows, getFlow, createFlow, updateFlow, setChoices, setColumns, deleteFlow,
  getActiveFollowFlow, getKeywordFlow,
  buildQuickReplyMessages, buildButtonsMessage, buildCarouselMessage, buildFlowMessages,
  handlePostback, seedSeitaiIdentify,
  markAsked, getReaskFlow, buildReaskMessages, processReasks,
};
