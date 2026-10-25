'use strict';

// 初心者の道案内（2026-10-25）
// =====================================================
// 「使い方が全く分からない人」が、画面を探し回らずに済むための仕組み。
//
//  1. diagnose()  お店の設定と、LINE側の実際の状態（つながっているか・Webhookの送り先・受信・通数）を
//                 数秒で全部点検し、「いまやること」を順番どおりに1つずつ返す。人が見て回ると30分かかる確認。
//                 直せるものは fix（Keiroがボタン1つで直す）、手でやるものは goto（その画面のその場所へ連れて行く）。
//  2. fix()       ボタン1つで直す：トークンの出し直し・LINEから届くかの試し（Webhookの検証）。
//                 よそを向いているWebhookの切り替えは、前の業者に届かなくなるので画面で確認してから（/line/webhook-switch）。
//  3. findIntents() 「休みを知らせたい」のような言葉から、どの画面で何をすればいいかを返す（辞書で引く・AIは使わない）。
//
// 方針：お客様に何かを送る操作・今ある設定を消す操作は、ここからは一切しない。
//       文面は専門用語を使わない。使うときは言い換えを添える。

const tenantmod = require('./tenant');
const line = require('./line');
const linetoken = require('./linetoken');
const config = require('./config');

const DAY = 24 * 3600 * 1000;

// お客様に届く文に残っている「書きかけ」（業種別テンプレートの（ご予約URL）など）を見つける
const PLACEHOLDER_RE = /[（(][^（）()\n]{0,30}(URL|ＵＲＬ|特典内容|電話番号|例[:：]|有\/無|必要\/不要|院独自)[^（）()\n]{0,40}[）)]|（曜日）/;
function findPlaceholder(text) {
  const m = String(text || '').match(PLACEHOLDER_RE);
  return m ? m[0] : null;
}

/** お客様に届く文のうち、書きかけが残っているものを場所つきで返す。 */
function placeholderSpots(db, tenantId) {
  const spots = [];
  const push = (where, nav, target, text) => { const p = findPlaceholder(text); if (p) spots.push({ where, nav, target, sample: p }); };
  const t = db.prepare('SELECT greeting_text FROM tenants WHERE id = ?').get(tenantId) || {};
  push('友だち追加直後のあいさつ文', 'setting', '#sec-settings', t.greeting_text);
  for (const r of db.prepare(
    `SELECT c.name, m.position, m.text FROM step_messages m JOIN step_campaigns c ON c.id = m.campaign_id
     WHERE c.tenant_id = ? AND c.active = 1 ORDER BY c.created_at, m.position`).all(tenantId)) {
    push(`自動メッセージ「${r.name}」の${r.position}通目`, 'send', '#sec-steps', r.text);
  }
  for (const r of db.prepare('SELECT keyword, reply_text FROM autoreplies WHERE tenant_id = ? AND active = 1').all(tenantId)) {
    push(`自動の返事（「${r.keyword}」と送られたとき）`, 'auto', '#sec-autoreply', r.reply_text);
  }
  for (const r of db.prepare(
    `SELECT c.name, s.text FROM reminder_steps s JOIN reminder_campaigns c ON c.id = s.campaign_id
     WHERE c.tenant_id = ? AND c.active = 1`).all(tenantId)) {
    push(`予約日のお知らせ「${r.name}」`, 'send', '#sec-reminders', r.text);
  }
  for (const r of db.prepare(
    `SELECT f.name, ch.label, ch.reply_text FROM bot_choices ch JOIN bot_flows f ON f.id = ch.flow_id
     WHERE f.tenant_id = ? AND f.active = 1`).all(tenantId)) {
    push(`振り分けの返事（「${r.label}」を押したとき）`, 'auto', '#sec-bot', r.reply_text);
  }
  return spots;
}

/** 返事を待っているお客様（最後のやりとりがお客様から・14日以内）。 */
function waitingCustomers(db, tenantId, now) {
  const rows = db.prepare(
    `SELECT line_user_id, direction, created_at FROM inbox_messages m
     WHERE tenant_id = ? AND created_at >= ?
       AND created_at = (SELECT MAX(created_at) FROM inbox_messages x WHERE x.tenant_id = m.tenant_id AND x.line_user_id = m.line_user_id)`
  ).all(tenantId, now - 14 * DAY);
  return rows.filter((r) => r.direction === 'in').length;
}

function count(db, sql, ...a) { return db.prepare(sql).get(...a).n; }

/**
 * 全部の点検。返り値: { items: [...], next, done_count, total, checked_at }
 * item: { key, level: 'ok'|'todo'|'warn'|'info', title, detail, fix?: {type:'auto'|'goto'|'switch', ...} }
 * opts.live=false でLINEに問い合わせない（テスト用）。opts.botInfo / opts.getWebhook / opts.quota で差し替え可。
 */
async function diagnose(db, tenantIn, opts = {}) {
  const now = opts.now || Date.now();
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantIn.id) || tenantIn;
  const tid = tenant.id;
  const s = tenantmod.resolveSettings(tenant);
  const h = linetoken.health(tenant);
  const live = opts.live !== false;
  const items = [];
  const add = (it) => items.push(it);
  const myWebhook = `${config.baseUrl}/webhook/${tenant.webhook_token}`;

  // 1) LINEとつながっているか
  let tokenValid = null, botName = null;
  if (h.token_set && live) {
    const info = await (opts.botInfo || line.getBotInfo)(s.line.channelAccessToken);
    tokenValid = !!(info && info.ok);
    if (tokenValid && info.info) botName = info.info.displayName || info.info.basicId || null;
    else if (info && info.http_status === 0) tokenValid = null; // 通信の一時エラーは判定しない
  } else if (h.token_set) tokenValid = !h.token_error;
  if (!h.secret_set || !h.token_set) {
    add({ key: 'line_connect', level: 'todo', title: 'お店のLINEとつなぐ',
      detail: 'LINE公式アカウントの管理画面（設定 → Messaging API）にある「Channel ID」と「Channel secret」の2つを貼るだけです。むずかしい設定はKeiroが代わりに行います。',
      fix: { type: 'goto', nav: 'setting', target: '#wizard', label: 'つなぐ画面を開く' } });
  } else if (tokenValid === false) {
    const canReissue = !!(tenant.line_channel_id);
    add({ key: 'line_connect', level: 'todo', title: 'LINEとのつながりが切れています',
      detail: canReissue
        ? 'Keiroが新しい合鍵（アクセストークン）を出し直せば、すぐ元に戻ります。'
        : 'つなぎ直しが必要です。管理画面（設定 → Messaging API）の「Channel ID」を貼ってください（Channel secret は登録済みです）。',
      fix: canReissue ? { type: 'auto', action: 'reissue_token', label: 'Keiroに直してもらう' }
        : { type: 'goto', nav: 'setting', target: '#wizard', label: 'つなぎ直す画面を開く' } });
  } else {
    add({ key: 'line_connect', level: 'ok', title: 'お店のLINEとつながっています' + (botName ? `（${botName}）` : ''),
      detail: h.auto ? '合鍵（アクセストークン）はKeiroが30日ごとに自動で新しくします。' : '' });
  }
  const connected = h.secret_set && h.token_set && tokenValid !== false;

  // 2) LINEからの連絡がKeiroに届く道（Webhook）
  if (connected) {
    let wh = null;
    if (live && tokenValid) { const w = await (opts.getWebhook || line.getWebhookEndpoint)(s.line.channelAccessToken); if (w && w.ok) wh = w; }
    if (wh && wh.endpoint !== myWebhook) {
      add({ key: 'webhook', level: 'todo', title: 'LINEからの連絡が、Keiroに届かない設定になっています',
        detail: `いまの届け先は「${wh.endpoint || '未設定'}」です。このままでは自動の返事も友だちの記録も動きません。Keiroに切り替えると、前の届け先には届かなくなります（前の値はKeiroが控えておき、戻せます）。`,
        fix: { type: 'switch', label: '届け先をKeiroに切り替える' } });
    } else if (wh && !wh.active) {
      add({ key: 'webhook', level: 'todo', title: 'LINE側で「Webhook」がオフになっています',
        detail: 'LINE公式アカウントの管理画面で、設定 → 応答設定 →「Webhook」をオンにしてください（ここだけはLINEの画面での操作が必要です）。',
        fix: { type: 'link', url: 'https://manager.line.biz/', label: 'LINEの管理画面を開く' } });
    } else if (!tenant.webhook_last_at) {
      add({ key: 'webhook', level: 'todo', title: 'LINEからKeiroに届くか、試してみる',
        detail: 'ボタンを押すと、LINEから試しの連絡を1回だけ送ってもらいます。お客様には何も届きません。',
        fix: { type: 'auto', action: 'webhook_test', label: '届くか試す' } });
    } else {
      const stale = now - tenant.webhook_last_at > 14 * DAY;
      add({ key: 'webhook', level: stale ? 'warn' : 'ok',
        title: stale ? 'しばらくLINEからの連絡が届いていません' : 'LINEからの連絡がKeiroに届いています',
        detail: stale ? `最後に届いたのは${Math.floor((now - tenant.webhook_last_at) / DAY)}日前です。お客様からのメッセージや友だち追加が無いだけなら問題ありません。心配なときは「届くか試す」を押してください。` : '',
        fix: stale ? { type: 'auto', action: 'webhook_test', label: '届くか試す' } : undefined });
    }
    if (tenant.silent_mode) add({ key: 'silent', level: 'info', title: '計測だけのモードになっています',
      detail: 'このモードの間、Keiroからはお客様に何も送りません（あいさつ・自動の返事も止まります）。ほかのシステムで返事をしている場合だけ使う設定です。',
      fix: { type: 'goto', nav: 'setting', target: '#sec-settings', label: '設定を見る' } });
  }

  // 3) 最初の設定（自動の返事・自動メッセージ・振り分け）
  const nReplies = count(db, 'SELECT COUNT(*) n FROM autoreplies WHERE tenant_id = ? AND active = 1', tid);
  const nSteps = count(db, 'SELECT COUNT(*) n FROM step_campaigns WHERE tenant_id = ? AND active = 1', tid);
  const nBots = count(db, 'SELECT COUNT(*) n FROM bot_flows WHERE tenant_id = ? AND active = 1', tid);
  if (!nReplies && !nSteps && !nBots) {
    add({ key: 'starter', level: 'todo', title: '最初の設定を作る（おまかせ）',
      detail: 'お店のホームページのURLを入れると、あいさつ・よくある質問への自動の返事・友だち追加後のご案内を、AIがお店に合わせて下書きします。あとから自由に直せます。',
      fix: { type: 'goto', nav: 'setting', target: '#sec-aisetup', label: 'おまかせで作る' } });
  } else {
    add({ key: 'starter', level: 'ok', title: `自動の返事 ${nReplies}件・自動のご案内 ${nSteps}本 が動いています`, detail: '' });
  }

  // 4) 書きかけのまま、お客様に届いてしまう文
  const spots = placeholderSpots(db, tid);
  if (spots.length) {
    add({ key: 'placeholder', level: 'warn', title: `お客様に届く文に、書きかけの部分が${spots.length}か所残っています`,
      detail: 'テンプレートの「（ご予約URL）」のような部分が、そのままお客様に届いてしまいます。お店の内容に書き換えてください。',
      spots: spots.slice(0, 10),
      fix: { type: 'goto', nav: spots[0].nav, target: spots[0].target, label: '1か所目を直しに行く' } });
  }

  // 5) トーク画面の下のメニュー（リッチメニュー）
  const nMenu = count(db, "SELECT COUNT(*) n FROM rich_menus WHERE tenant_id = ? AND status = 'active'", tid);
  if (!nMenu) add({ key: 'richmenu', level: 'todo', title: 'トーク画面の下に「予約・地図・料金」のボタンを出す',
    detail: 'お客様がLINEを開いたとき、画面の下にいつも出るボタンのメニューです。ひな形を選んで文字を入れるだけで、画像もKeiroが作ります。',
    fix: { type: 'goto', nav: 'auto', target: '#sec-richmenu', label: 'メニューを作る' } });
  else add({ key: 'richmenu', level: 'ok', title: 'トーク画面の下のメニューが出ています', detail: '' });

  // 6) 友だちを増やす（店頭のQR）
  const nLinks = count(db, 'SELECT COUNT(*) n FROM links WHERE tenant_id = ?', tid);
  const nFriends = count(db, "SELECT COUNT(*) n FROM friends WHERE tenant_id = ? AND status = 'active'", tid);
  if (!nLinks) add({ key: 'qr', level: 'todo', title: '店頭に貼るQRコードを作る',
    detail: 'どこから友だちが増えたかを数えるための、お店専用のQRコードです。作るとA4のポスターをそのまま印刷できます。',
    fix: { type: 'goto', nav: 'promo', target: '#sec-link-create', label: 'QRコードを作る' } });
  else if (!nFriends) add({ key: 'qr', level: 'todo', title: 'QRのポスターを印刷して、お会計のそばに置く',
    detail: 'まだKeiroで記録された友だちがいません。ポスターを置いて「LINEに登録すると特典があります」とひとこと添えるだけで増え始めます。',
    fix: { type: 'goto', nav: 'promo', target: '#sec-links', label: 'ポスターを開く' } });
  else add({ key: 'qr', level: 'ok', title: `Keiroで記録された友だち ${nFriends}人`, detail: '' });

  // 7) 返事を待っているお客様
  const waiting = waitingCustomers(db, tid, now);
  if (waiting) add({ key: 'inbox', level: 'warn', title: `返事を待っているお客様が${waiting}人います`,
    detail: '最後のメッセージがお客様からのままになっています（14日以内）。返事の下書きはAIが3案出せます。',
    fix: { type: 'goto', nav: 'talk', target: '#sec-inbox', label: 'メッセージを見る' } });

  // 8) 今月の無料で送れる通数
  if (connected && live && tokenValid) {
    const q = await (opts.quota || line.getMessageQuota)(s.line.channelAccessToken);
    if (q && q.limit) {
      const left = Math.max(0, q.limit - q.used);
      const ratio = q.used / q.limit;
      if (ratio >= 0.8) add({ key: 'quota', level: 'warn', title: `今月LINEで送れる残りが少なくなっています（残り${left}通）`,
        detail: `LINE公式アカウントの料金プランで、今月は${q.limit}通まで送れます。いま${q.used}通使っています。一斉に送る前に、送る相手を絞ると通数を節約できます。`,
        fix: { type: 'goto', nav: 'send', target: '#sec-broadcast', label: '送る相手を絞る' } });
      else add({ key: 'quota', level: 'ok', title: `今月LINEで送れる残り ${left}通（${q.limit}通のうち）`, detail: '' });
    }
  }

  const order = { todo: 0, warn: 1, info: 2, ok: 3 };
  const pending = items.filter((i) => i.level === 'todo' || i.level === 'warn');
  const next = pending.slice().sort((a, b) => order[a.level] - order[b.level])[0] || null;
  return {
    items, next,
    done_count: items.filter((i) => i.level === 'ok').length,
    total: items.filter((i) => i.level !== 'info').length,
    checked_at: now,
    advanced_in_use: advancedInUse(db, tid),
  };
}

/**
 * かんたん表示でも隠さない欄（その店がすでに使っている上級者向けの機能）。
 * 既存のお店で、使っている機能が急に見えなくならないようにする（2026-10-25）。
 */
function advancedInUse(db, tenantId) {
  const has = (sql) => { try { return db.prepare(sql).get(tenantId).n > 0; } catch { return false; } };
  const ids = [];
  if (has('SELECT COUNT(*) n FROM forms WHERE tenant_id = ?')) ids.push('sec-forms');
  if (has('SELECT COUNT(*) n FROM coupons WHERE tenant_id = ?')) ids.push('sec-coupons');
  if (has('SELECT COUNT(*) n FROM stamp_cards WHERE tenant_id = ?')) ids.push('sec-stamp');
  if (has('SELECT COUNT(*) n FROM birthday_campaigns WHERE tenant_id = ?')) ids.push('sec-birthday');
  if (has("SELECT COUNT(*) n FROM reminder_enrollments WHERE tenant_id = ?")) ids.push('sec-reminders');
  if (has('SELECT COUNT(*) n FROM bot_flows WHERE tenant_id = ?')) ids.push('sec-bot');
  if (has('SELECT COUNT(*) n FROM tracked_urls WHERE tenant_id = ?')) ids.push('sec-turl');
  if (has('SELECT COUNT(*) n FROM vacancy_settings WHERE tenant_id = ? AND enabled = 1')) ids.push('sec-vacancy');
  if (has('SELECT COUNT(*) n FROM links WHERE tenant_id = ?')) ids.push('sec-link-create');
  return ids;
}

/** ボタン1つで直す（お客様には何も送らない・今ある設定は消さない）。 */
async function fix(db, tenantIn, action, opts = {}) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantIn.id) || tenantIn;
  if (action === 'reissue_token') {
    if (!tenant.line_channel_id) return { ok: false, error: 'Channel ID が登録されていないため、出し直せません。つなぐ画面で Channel ID を貼ってください。' };
    const r = await linetoken.connect(db, tenant, { channelId: tenant.line_channel_id, issue: opts.issue, botInfo: opts.botInfo, by: 'coach' });
    return r.ok ? { ok: true, message: `直りました（${[r.bot_name, r.basic_id].filter(Boolean).join(' ')}）。` } : { ok: false, error: r.error };
  }
  if (action === 'webhook_test') {
    const token = tenantmod.resolveSettings(tenant).line.channelAccessToken;
    if (!token) return { ok: false, error: '先にLINEとつないでください。' };
    const before = tenant.webhook_last_at || 0;
    const r = await (opts.testWebhook || line.testWebhookEndpoint)(token);
    if (!r.ok) return { ok: false, error: 'LINEから試しの連絡を送ってもらえませんでした（' + (r.error || r.http_status) + '）。' };
    if (!r.success) return { ok: false, error: `LINEからKeiroに届きませんでした（${r.reason || r.status_code || '不明'}）。届け先がKeiroになっているか、Channel secret が正しいかを確かめてください。` };
    await new Promise((res) => setTimeout(res, opts.waitMs != null ? opts.waitMs : 800));
    const after = (db.prepare('SELECT webhook_last_at FROM tenants WHERE id = ?').get(tenant.id) || {}).webhook_last_at || 0;
    return { ok: true, message: after > before ? 'LINEからの連絡がKeiroに届きました。これで自動の返事が動きます。' : 'LINE側では送れました。Keiroへの到着はまだ確認できていません。少しおいて、もう一度点検してください。' };
  }
  return { ok: false, error: '不明な操作です' };
}

// ---- やりたいこと → どこで何をするか（辞書） ----
// words: お客様が書きそうな言葉。nav/target: 連れて行く場所。steps: やること（専門用語を使わない）。
const INTENTS = [
  { key: 'connect', title: 'お店のLINEとつなぐ', words: ['つなぐ', 'つなぎ', 'つなげ', '繋ぐ', '繋ぎ', 'LINEと', '連携', '接続', 'つながらない', '動かない', '返事が来ない', 'Channel', 'チャネル', 'トークン'],
    nav: 'setting', target: '#wizard', steps: ['LINE公式アカウントの管理画面で 設定 → Messaging API を開く', '「Channel ID」と「Channel secret」をコピーする', 'Keiroの「2つを貼って接続する」に貼って押す'] },
  { key: 'reply', title: 'よくある質問に自動で返事をする', words: ['自動返信', '自動で返', '自動応答', '返事', '返信', '質問', 'キーワード', '営業時間', '駐車場', '場所', 'アクセス', '料金'],
    nav: 'auto', target: '#sec-autoreply', steps: ['「キーワード」に、お客様が送りそうな言葉（例：駐車場）を入れる', '「返信文」を書く（「AIに下書きを頼む」もあります）', '「追加」を押す（すぐに動きます）'] },
  { key: 'holiday', title: 'お休み・臨時休業を知らせる', words: ['休み', '休む', '休業', '臨時', '定休', '休館', '休診', 'お盆', '年末', '正月', 'GW', 'ゴールデンウィーク', '休館'],
    nav: 'send', target: '#sec-broadcast', steps: ['本文に、お休みの日にちと再開する日を書く', '送る相手を「全員」にし、日時を入れて予約する（空欄なら今すぐ）', '「まず自分に試し送り」で確かめる。あわせて「休み」と聞かれたときの自動の返事も直しておくと安心です'] },
  { key: 'broadcast', title: '友だち全員（または一部の人）にお知らせを送る', words: ['一斉', 'お知らせ', '配信', '全員に送', 'キャンペーン', 'セール', '告知', '送りたい', 'メッセージを送'],
    nav: 'send', target: '#sec-broadcast', steps: ['本文を書く（「AIに下書きを頼む」もあります）', '送る相手を選ぶ（全員・タグで絞る など）。日時を入れると予約になります', '「まず自分に試し送り」で見え方を確かめてから「作成して送信/予約」'] },
  { key: 'steps', title: '友だち追加のあと、日にちを空けて自動でご案内を送る', words: ['ステップ', '友だち追加後', '追加した人', '新規', '自動で送', '数日後', '翌日', 'シナリオ'],
    nav: 'send', target: '#sec-steps', steps: ['「シナリオ名」を入れて「シナリオを作成」を押す', '一覧のシナリオを開き、1通目・2通目…の文と、前の通からあける時間を入れる', '有効になっていれば、友だち追加した人に自動で届きます'] },
  { key: 'greeting', title: '友だち追加されたときのあいさつを変える', words: ['あいさつ', '挨拶', '友だち追加された', 'ウェルカム', '最初のメッセージ'],
    nav: 'setting', target: '#sec-settings', steps: ['「友だち追加直後のあいさつ文」に書く', '「設定を保存」を押す'] },
  { key: 'richmenu', title: 'トーク画面の下に「予約・地図・料金」のボタンを出す', words: ['メニュー', 'リッチメニュー', 'ボタン', '下の', '予約ボタン', '画像'],
    nav: 'auto', target: '#sec-richmenu', steps: ['「テンプレート」でボタンの並びを選ぶ（「AIと相談しながら決める」でも作れます）', '各ボタンの文字と、押したときに開くページを入れる', '「作成してLINEに反映」を押す（画像はKeiroが作ります）'] },
  { key: 'qr', title: '店頭に貼るQRコード・ポスターを作る', words: ['QR', 'qr', 'ポスター', 'チラシ', '店頭', '印刷', '友だちを増や', '友達を増や', '登録してもら'],
    nav: 'promo', target: '#sec-links', steps: ['「店頭ポスター・チラシQR」の行の「ポスター」を押す', 'A4で印刷して、お会計のそばに置く', 'お会計のときに「LINE登録で特典があります」とひとこと'] },
  { key: 'coupon', title: 'クーポンを作って配る', words: ['クーポン', '割引', '特典', '初回'],
    nav: 'promo', target: '#sec-coupons', steps: ['「クーポン名」と「割引内容」（例：初回500円引き）を書く', '有効期限と、送る相手（全員・タグで絞る など）を選んで「クーポンを作成」', '一覧の「送信」で、LINEに届けます'] },
  { key: 'stamp', title: 'スタンプカード（ポイントカード）を始める', words: ['スタンプ', 'ポイント', '来店カード', 'ポイントカード'],
    nav: 'promo', target: '#sec-stamp', steps: ['「カード名」「何個で特典か」「特典の中身」を入れて「カードを作成」', 'ご来店のたびに「友だち管理」の各行の「スタンプ」を押す', '決めた数になると、特典のお知らせが自動でLINEに届きます'] },
  { key: 'reminder', title: '予約の前日にお知らせを送る（無断キャンセルを減らす）', words: ['リマインド', '前日', '予約の前', 'キャンセル', 'ドタキャン', '無断'],
    nav: 'send', target: '#sec-reminders', steps: ['お知らせの名前を入れて作り、送る日（例：前日）と文を決める', '予約が入ったら「友だち管理」の各行の「リマインダ」で予約日を登録する（予約システムとつなぐと自動）', '決めた日に自動で届きます'] },
  { key: 'birthday', title: '誕生日に自動でお祝いを送る', words: ['誕生日', 'バースデー', 'お祝い'],
    nav: 'send', target: '#sec-birthday', steps: ['名前とお祝いの文を書いて「キャンペーンを作成」', '「友だち管理」の各行で誕生日を登録する（アンケートで聞くと自動で入ります）', '誕生日の朝に自動で届きます'] },
  { key: 'form', title: 'アンケート・事前の問診票を作る', words: ['アンケート', '問診', 'フォーム', '申込', '申し込み', '質問票'],
    nav: 'promo', target: '#sec-forms', steps: ['フォームの名前とタイトルを入れ、質問を並べて「フォームを作成」', '答えた人に付ける目印（タグ）を決めておくと、あとで絞って送れます', '一覧の「本文用タグ」をお知らせや自動の返事に貼ると、誰が答えたか分かります'] },
  { key: 'inbox', title: 'お客様からのメッセージに返事をする', words: ['受信', 'メッセージが来', '返事を書', 'チャット', '問い合わせ', 'お客様から'],
    nav: 'talk', target: '#sec-inbox', steps: ['一覧からお客様を選ぶ', '返事を書く（「AI返信案」で下書きを出せます）', '「返信」を押す'] },
  { key: 'friends', title: '友だちの一覧を見る・目印（タグ）を付ける', words: ['友だち一覧', '友達一覧', 'タグ', '目印', '顧客', 'お客様の一覧', 'リスト'],
    nav: 'talk', target: '#sec-friends', steps: ['一覧でお客様を探す（名前・入口・目印で絞れます）', '各行で「来店済み」などの目印（タグ）や誕生日を入れる', '目印で絞ってお知らせを送れます'] },
  { key: 'results', title: '友だちがどれだけ増えたか・どこから来たかを見る', words: ['成績', '数字', '分析', '何人', '増えた', '効果', '広告', 'どこから', '集計'],
    nav: 'home', target: '#sec-analytics', steps: ['ホームの「集客の成績表」を見る', '入口（QR・Instagram など）ごとの人数が分かります'] },
  { key: 'preview', title: 'お客様のLINEでどう見えるかを確かめる', words: ['見え方', 'プレビュー', '確認したい', 'どう見える', 'テスト'],
    nav: 'setting', target: '#sec-preview', steps: ['「お客さま体験プレビュー」を開く', '友だち追加から順に、届く内容がそのまま見られます（実際には送りません）'] },
  { key: 'vacancy', title: '空いている予約枠をお知らせする', words: ['空き', '空き枠', 'キャンセル待ち', '予約が空'],
    nav: 'send', target: '#sec-vacancy', steps: ['予約システムが出している「空き枠フィードURL」を入れる', '送る時刻・相手・文を決めて保存（空きが無い日は送りません）', '「いま送るとどうなるか確認」で先に見られます'] },
  { key: 'password', title: 'パスワードを変える', words: ['パスワード', 'ログイン'],
    nav: 'setting', target: '#sec-account', steps: ['今のパスワードと新しいパスワード（8文字以上）を入れる', '「パスワードを変更」を押す'] },
  { key: 'help', title: '分からないことを質問する', words: ['分からない', 'わからない', '困った', '質問したい', '問い合わせたい', '相談'],
    nav: 'help', target: '#sec-support', steps: ['「質問・サポート」に、困っていることをそのまま書く', 'AIがすぐ答えます。解決しなければ運営に届きます'] },
];

function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }

/** 言葉から、近い「やりたいこと」を最大3件返す。 */
function findIntents(q, limit = 3) {
  const nq = norm(q);
  if (!nq) return [];
  const scored = [];
  for (const it of INTENTS) {
    let score = 0;
    for (const w of it.words) { const nw = norm(w); if (nw && nq.includes(nw)) score += 2 + Math.min(nw.length, 6) / 3; }
    if (norm(it.title).includes(nq)) score += 3;
    if (score > 0) scored.push({ score, it });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ it }) => ({ key: it.key, title: it.title, nav: it.nav, target: it.target, steps: it.steps }));
}

module.exports = { diagnose, fix, advancedInUse, findIntents, findPlaceholder, placeholderSpots, waitingCustomers, INTENTS };
