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
  return f;
}

function createFlow(db, tenantId, { name, triggerType, triggerKeyword, questionText, active }) {
  const id = newId('bf');
  const now = Date.now();
  db.prepare(
    `INSERT INTO bot_flows (id, tenant_id, name, trigger_type, trigger_keyword, question_text, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, tenantId, String(name || '自己申告フロー'),
    triggerType === 'keyword' ? 'keyword' : 'follow',
    triggerKeyword ? String(triggerKeyword).trim() : null,
    String(questionText || 'あてはまる方を選んでください'),
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
  if ('active' in fields) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(Date.now(), id);
    db.prepare(`UPDATE bot_flows SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return getFlow(db, tenantId, id);
}

/** 選択肢を丸ごと置き換える。choices=[{label, tag, campaignId, replyText}] 配列順がsort。 */
function setChoices(db, tenantId, flowId, choices) {
  const f = db.prepare('SELECT id FROM bot_flows WHERE id = ? AND tenant_id = ?').get(flowId, tenantId);
  if (!f) return null;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bot_choices WHERE flow_id = ?').run(flowId);
    let sort = 0;
    for (const c of choices || []) {
      const label = (c.label || '').toString().trim();
      if (!label) continue;
      db.prepare(
        `INSERT INTO bot_choices (id, flow_id, label, tag, campaign_id, reply_text, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newId('bc'), flowId, label,
        c.tag ? String(c.tag).trim() : null,
        c.campaignId ? String(c.campaignId).trim() : null,
        c.replyText ? String(c.replyText) : null,
        sort++, Date.now()
      );
    }
  });
  tx();
  return getFlow(db, tenantId, flowId);
}

function deleteFlow(db, tenantId, id) {
  const f = db.prepare('SELECT id FROM bot_flows WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!f) return { deleted: 0 };
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bot_choices WHERE flow_id = ?').run(id);
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

/** LINEのクイックリプライ付きメッセージ配列を組み立てる（postbackで選択を受ける）。 */
function buildQuickReplyMessages(flow) {
  const items = (flow.choices || []).slice(0, 13).map((c) => ({
    type: 'action',
    action: {
      type: 'postback',
      label: String(c.label || '').slice(0, 20),
      data: `idf:${flow.id}:${c.id}`,
      displayText: c.label,
    },
  }));
  return [{ type: 'text', text: flow.question_text, quickReply: { items } }];
}

/**
 * postback（クイックリプライのタップ）を処理する。
 * data 形式: "idf:<flowId>:<choiceId>"
 * 副作用: friends.tags にタグ付与 ＋ 対応ステップ配信へ登録。
 * @returns {{replyText:string|null, tag:string|null}|null}
 */
function handlePostback(db, tenant, lineUserId, data) {
  if (!data || typeof data !== 'string' || data.indexOf('idf:') !== 0) return null;
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

  logger.info('identify choice', { tenant_id: tenant.id, flow_id: flowId, tag: choice.tag || null });
  return { replyText: choice.reply_text || null, tag: choice.tag || null };
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
  listFlows, getFlow, createFlow, updateFlow, setChoices, deleteFlow,
  getActiveFollowFlow, getKeywordFlow, buildQuickReplyMessages, handlePostback,
  seedSeitaiIdentify,
};
