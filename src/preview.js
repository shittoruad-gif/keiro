'use strict';

// お客さま体験プレビュー: 「新規のお客さまにはどう見えるか」を院がKeiro内で疑似体験できるようにする。
// 実際に設定されているデータ（あいさつ・ステップ配信・ボット・自動応答・リッチメニュー・リマインド）から
// タイムラインを組み立てて返す。送信は一切行わない（読み取り専用）。
const { renderMessage } = require('./templating');
const reminders = require('./reminders');

const SAMPLE = { lineUserId: 'Upreview-sample', displayName: '田中' };

function renderPreviewText(tenantId, text) {
  // {name}/{form:}/{url:} をサンプル値で展開（トークンはサンプル用なので実回答には使われない）
  return renderMessage(text, { tenantId, lineUserId: SAMPLE.lineUserId, displayName: SAMPLE.displayName });
}

/** 友だち追加直後にKeiroが送る挨拶（claimリンク付き）の文言（line.replyGreetingと同一文面）。 */
function greetingText() {
  return '友だち追加ありがとうございます🎁\n【特典の受け取り準備】下のリンクを一度タップしてください👇\nhttps://…（経路計測用リンク・お客さまごとに自動発行）\n（タップ後、すぐにご案内が届きます）';
}

function buildExperience(db, tenant) {
  const tid = tenant.id;

  // ステップ配信（有効のみ）。流入経路(media)・タグ別があるので属性ごと返す
  const campaigns = db.prepare(
    "SELECT id, name, media, audience_tag FROM step_campaigns WHERE tenant_id = ? AND active = 1 ORDER BY created_at"
  ).all(tid);
  const steps = campaigns.map((c) => ({
    campaign: c.name, media: c.media || null, audience_tag: c.audience_tag || null,
    messages: db.prepare('SELECT delay_minutes, text, image_url FROM step_messages WHERE campaign_id = ? ORDER BY delay_minutes, position')
      .all(c.id).map((m) => ({ delay_minutes: m.delay_minutes, text: renderPreviewText(tid, m.text), image_url: m.image_url || null })),
  }));

  // 友だち追加時の振り分けボット
  const flow = db.prepare(
    "SELECT * FROM bot_flows WHERE tenant_id = ? AND trigger_type = 'follow' AND active = 1 ORDER BY created_at DESC LIMIT 1"
  ).get(tid);
  const bot = flow ? {
    question: flow.question_text,
    choices: db.prepare('SELECT label, tag, reply_text FROM bot_choices WHERE flow_id = ? ORDER BY sort').all(flow.id)
      .map((c) => ({ label: c.label, tag: c.tag || null, reply_text: c.reply_text ? renderPreviewText(tid, c.reply_text) : null })),
  } : null;

  // キーワード自動応答（一覧はお試し候補として返す）
  const autoreplies = db.prepare(
    'SELECT keyword, match_type FROM autoreplies WHERE tenant_id = ? AND active = 1 ORDER BY created_at LIMIT 20'
  ).all(tid);

  // 表示中リッチメニュー（全員向けを優先）
  const rm = db.prepare(
    "SELECT name, template, chat_bar_text, config_json FROM rich_menus WHERE tenant_id = ? AND status = 'active' ORDER BY (audience_tag IS NOT NULL), created_at DESC LIMIT 1"
  ).get(tid);
  const richmenu = rm ? {
    chat_bar_text: rm.chat_bar_text || 'メニュー',
    template: rm.template,
    cells: (JSON.parse(rm.config_json || '{}').cells || []).map((c) => ({
      label: c.label || '', type: c.action_type === 'message' ? 'message' : 'uri',
      value: c.action_type === 'message' ? c.action_value : (c.dest_url || c.action_value),
    })).filter((c) => c.label || c.value),
  } : null;

  // 予約リマインド（自動）: 前日文面をサンプル日時で
  const quick = db.prepare('SELECT id FROM reminder_campaigns WHERE tenant_id = ? AND name = ? AND active = 1')
    .get(tid, reminders.QUICK_CAMPAIGN_NAME);
  let reminder = null;
  if (quick) {
    const st = db.prepare('SELECT offset_days, send_hour, text FROM reminder_steps WHERE campaign_id = ? ORDER BY offset_days').all(quick.id);
    if (st.length) {
      const fb = { date: '7月20日', time: '15時' };
      reminder = st.map((s) => ({
        when: s.offset_days === 0 ? `当日${s.send_hour}時` : s.offset_days < 0 ? `${-s.offset_days}日前の${s.send_hour}時` : `${s.offset_days}日後の${s.send_hour}時`,
        text: renderPreviewText(tid, s.text).replace(/\{date\}/g, fb.date).replace(/\{time\}/g, fb.time),
      }));
    }
  }

  return {
    shop_name: tenant.name || 'お店',
    greeting: greetingText(),
    steps, bot, autoreplies, richmenu, reminder,
    medias: [...new Set(campaigns.map((c) => c.media).filter(Boolean))],
    sample_name: SAMPLE.displayName,
  };
}

module.exports = { buildExperience, renderPreviewText };
