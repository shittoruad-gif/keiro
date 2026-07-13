'use strict';

// 業種別プリセット（整体・整骨院 / 美容鍼 / ピラティス）。
// プロのマーケター設計: ①初回=特典+期限+CTA ②共感→放置リスク→社会的証明
// ③売り込まない価値提供（セルフケア等） ④不安の先回り解消Q&A ⑤期限リマインド
// ⑥静かなクローズ（追わない） ⑦30日掘り起こし。{name}差し込みで開封・反応率を向上。
// 会話ボットの「新規/既存」タグと連動する2シナリオ構成（新規向け＋再来向け）が標準。
// URL等は院ごとに編集する想定でプレースホルダ（（…））を入れている。
const steps = require('./steps');
const autoreply = require('./autoreply');

// delay_minutes は「直前の通からの間隔」。絶対日: 0,1,3,5,7,14,30日
const D = { now: 0, d1: 1440, plus2: 2880, plus7: 10080, plus16: 23040 };

const PRESETS = {
  seitai: {
    name: '整体・整骨院',
    description: '初回来院の後押し（特典→共感→価値提供→不安解消→期限→掘り起こし）と再来促進、よくある質問への自動応答。',
    stepCampaign: {
      name: '初回来院ナビ（新規向け）',
      audienceTag: '新規',
      messages: [
        { delay_minutes: D.now, text: '{name}様、友だち追加ありがとうございます😊\n\n【LINE友だち限定特典】\n初回（特典内容）でご案内します✨\n\n▼ご予約はこちら（24時間受付）\n（ご予約URL）\n\n※ご予約時に「LINEを見た」とお伝えください\n※特典の有効期限：友だち追加から30日' },
        { delay_minutes: D.d1, text: '{name}様\n\n肩こり・腰痛・体の痛み…「そのうち治るだろう」と我慢していませんか？\n\n実は、痛みを放置すると体が“かばい方”を覚えてしまい、回復までに時間がかかるようになります。\n\n当院は国家資格者が、原因から丁寧に施術します。\n「もっと早く来ればよかった」というお声を多くいただいています😊\n\n▼初回特典でお体の状態をチェック\n（ご予約URL）' },
        { delay_minutes: D.plus2, text: '【1分セルフケア】デスクワークの肩こりに😊\n\n① 両肩をぐっとすくめて5秒キープ→ストンと落とす ×5回\n② 肩甲骨を後ろに大きく回す ×10回\n\n朝・昼・晩に行うと血流が良くなります✨\nお仕事の合間にぜひお試しください。\n\n※セルフケアで改善しない痛みは、体からのSOSです。我慢せずご相談ください\n（ご予約URL）' },
        { delay_minutes: D.plus2, text: '【はじめての方から、よくいただくご質問】\n\nQ. 施術は痛くないですか？\n→ ボキボキしない、お体に合わせたやさしい施術です\n\nQ. 持ち物は？\n→ 手ぶらでOK。動きやすい服装だとなお◎\n\nQ. 時間はどのくらい？\n→ 初回は約60分（カウンセリング込み）です\n\nほかに不安なことがあれば、このトークで何でもご質問ください😊\n▼ご予約（初回特典あり）\n（ご予約URL）' },
        { delay_minutes: D.plus2, text: '{name}様、初回特典の期限が近づいています⏰\n\n【友だち追加から30日まで】\n初回（特典内容）でご案内できます。\n\n「長年の腰痛がラクになった」\n「もっと早く来ればよかった」\nそんなお声に、私たちも励まされています。\n\nあなたのお悩みも、一度聞かせてください😊\n▼空き状況を見る\n（ご予約URL）' },
        { delay_minutes: D.plus7, text: '{name}様\n\nその後、お体の調子はいかがですか？\n\nご案内はこれでいったん区切りにしますね。\nつらくなったときは、いつでもこのLINEにご連絡ください。\n「予約」と送っていただければ、すぐにご案内します😊\n\nお体、大切になさってください🌿' },
        { delay_minutes: D.plus16, text: '{name}様、お久しぶりです😊\n\n季節の変わり目は、体の不調が出やすい時期です。\n毎日がんばっているお体、悲鳴を上げていませんか？\n\n【今月中のご予約で】初回特典をご利用いただけます✨\n▼ご予約はこちら\n（ご予約URL）' },
      ],
    },
    stepCampaignReturning: {
      name: '再来ナビ（通院中の方向け）',
      audienceTag: '既存',
      messages: [
        { delay_minutes: D.now, text: '{name}様、いつもありがとうございます😊\n\n公式LINEから、かんたんにご予約・ご相談いただけるようになりました。\n\n✔「予約」と送る → ご予約のご案内\n✔ お体のご相談 → そのままトークへどうぞ\n\n今後ともよろしくお願いいたします🌿' },
        { delay_minutes: 14400, text: '{name}様\n\n前回の施術から少し時間が空きましたが、お体の調子はいかがですか？\n\n良い状態をキープするには、「痛くなる前のメンテナンス」が一番の近道です✨\n\n▼次回のご予約\n（ご予約URL）またはこのトークへどうぞ😊' },
        { delay_minutes: 28800, text: '{name}様、ご無沙汰しています😊\n\nお体のメンテナンス、後回しになっていませんか？\n急な痛みが出る前の「予防ケア」がおすすめです。\n\nご予約はこのトーク、または（ご予約URL）から。\nお待ちしています！' },
      ],
    },
    autoreplies: [
      { keyword: '予約', match_type: 'contains', reply_text: 'ご予約はこちらから24時間受付しています😊\n→（ご予約URL）\nお電話（（電話番号））でも承ります。ご希望の日時をこのトークに送っていただいてもOKです！\n※メニューで入力欄がかくれている時は、左下の ⌨ マークをタップすると開きます' },
      { keyword: '料金', match_type: 'contains', reply_text: '【料金のご案内】\nLINE友だちは初回（特典内容）でご案内しています✨\n詳しくはこちら→（料金ページURL）\nご不明な点は、このトークでお気軽にどうぞ😊' },
      { keyword: '営業時間', match_type: 'contains', reply_text: '営業時間は（例：平日9:00-20:00 / 土9:00-18:00）です。定休日は（曜日）です。\nご予約は「予約」と送ってください😊' },
      { keyword: '場所', match_type: 'contains', reply_text: 'アクセスはこちらです→（GoogleマップURL)\n駐車場（有/無）\nお気をつけてお越しください😊' },
      { keyword: 'クーポン', match_type: 'contains', reply_text: '【LINE友だち限定】初回（特典内容）🎟\nご予約時に「LINEを見た」とお伝えください。\n▼ご予約\n（ご予約URL）' },
      { keyword: 'クーポン', match_type: 'contains', audience_tag: '既存', reply_text: 'いつもありがとうございます😊\n通院中の方には【スタンプカード】をご用意——来院ごとにスタンプが貯まり、満了で特典と交換できます✨\nお誕生月には特別なご案内もお届けします🎁\n詳しくはスタッフまでお気軽にどうぞ！' },
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
    description: '美容鍼デビューの後押し（特典→不安解消→価値提供→期限→掘り起こし）と再来促進、効果・料金の自動応答。',
    stepCampaign: {
      name: '美容鍼デビュー（新規向け）',
      audienceTag: '新規',
      messages: [
        { delay_minutes: D.now, text: '{name}様、友だち追加ありがとうございます✨\n\n【LINE友だち限定】\n初回お試し（特典内容）でご案内します。\nハリ・たるみ・むくみが気になる方へ😊\n\n▼ご予約はこちら（24時間受付）\n（ご予約URL）\n※特典の有効期限：友だち追加から30日' },
        { delay_minutes: D.d1, text: '{name}様\n\n「美容鍼って痛くないの？」——一番多いご質問です。\n\n使うのは髪の毛ほどの細い鍼。チクッとする程度で、施術中に眠ってしまう方も多いんです😊\nダウンタイムもほぼなく、施術後すぐにメイクもOK。\n\n「フェイスラインが上がった」「化粧ノリが変わった」というお声を多数いただいています✨\n\n▼初回お試しはこちら\n（ご予約URL）' },
        { delay_minutes: D.plus2, text: '【自宅でできる むくみケア】\n\n① 耳を横に軽く引っぱりながら10回まわす\n② 鎖骨の上を内→外に10回さする\n\n朝のメイク前に行うと、顔色がパッと明るくなります✨\n\nより深いケアは、プロの美容鍼で。\n血流と表情筋に直接アプローチします😊\n（ご予約URL）' },
        { delay_minutes: 5760, text: '{name}様、初回特典の期限が近づいています⏰\n\n【友だち追加から30日まで】初回（特典内容）\n\n美容鍼は1回でも変化を感じる方が多いですが、継続でより効果を実感いただけます。\nまずは1回、体験してみませんか？😊\n\n▼空き状況を見る\n（ご予約URL）' },
        { delay_minutes: D.plus7, text: '{name}様\n\nご案内はこれでいったん区切りにしますね。\n気になったときは、いつでもこのLINEからご予約・ご質問ください😊\n\nキレイは、思い立った日が始めどきです✨' },
        { delay_minutes: D.plus16, text: '{name}様、お久しぶりです😊\n\n大切な予定の前に、お顔のコンディションを整えませんか？\n【今月中のご予約で】初回特典をご利用いただけます✨\n\n▼ご予約はこちら\n（ご予約URL）' },
      ],
    },
    stepCampaignReturning: {
      name: '再来ナビ（通院中の方向け）',
      audienceTag: '既存',
      messages: [
        { delay_minutes: D.now, text: '{name}様、いつもありがとうございます✨\n\n公式LINEから、かんたんにご予約いただけるようになりました。\n「予約」と送るか、ご希望日時をこのトークへどうぞ😊' },
        { delay_minutes: 14400, text: '{name}様\n\n前回の施術から少し空きましたが、お肌の調子はいかがですか？\n美容鍼は2〜3週間ごとの継続で、効果が定着しやすくなります✨\n\n▼次回のご予約\n（ご予約URL）またはこのトークへ😊' },
        { delay_minutes: 28800, text: '{name}様、ご無沙汰しています😊\nお顔のメンテナンス、そろそろいかがですか？\nご予約はこのトーク、または（ご予約URL）から。お待ちしています✨' },
      ],
    },
    autoreplies: [
      { keyword: '予約', match_type: 'contains', reply_text: 'ご予約はこちらから😊→（ご予約URL）\nご希望日時をこのトークに送っていただいてもOKです！\n※メニューで入力欄がかくれている時は、左下の ⌨ マークをタップすると開きます' },
      { keyword: '料金', match_type: 'contains', reply_text: '【美容鍼の料金・回数券のご案内】✨\nLINE友だちは初回（特典内容）でご案内しています。\n詳しくは→（料金ページURL）' },
      { keyword: '効果', match_type: 'contains', reply_text: 'ハリ・むくみ・血色感の変化を実感される方が多いです✨\n初回から体感いただけます。まずはお試しください😊\n▼ご予約\n（ご予約URL）' },
      { keyword: '痛', match_type: 'contains', reply_text: '使うのは髪の毛ほどの細さの鍼で、チクッとする程度です😊\n施術中に眠ってしまう方も多いので、ご安心ください。\nご不安な点は何でもご質問ください！' },
      { keyword: '営業時間', match_type: 'contains', reply_text: '営業時間は（例：10:00-19:00）、定休日は（曜日）です。\nご予約は「予約」と送ってください😊' },
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
    description: '体験レッスンへの導線（特典→不安解消→価値提供→期限→掘り起こし）と継続促進、初心者の不安を解消する自動応答。',
    stepCampaign: {
      name: '体験レッスン案内（新規向け）',
      audienceTag: '新規',
      messages: [
        { delay_minutes: D.now, text: '{name}様、友だち追加ありがとうございます！\n\n【体験レッスン特別価格】でお試しいただけます😊\n姿勢改善・体幹強化・しなやかな身体づくりに✨\n\n▼体験のご予約はこちら\n（体験予約URL）\n※特別価格の有効期限：友だち追加から30日' },
        { delay_minutes: D.d1, text: '{name}様\n\n「運動が苦手でも大丈夫？」——ご安心ください！\n\nマシンピラティスは、マシンが動きをサポートしてくれるので、初心者の方こそ効果を感じやすいレッスンです。\n実際、会員様の多くは運動未経験からのスタートです😊\n\nインストラクターがマンツーマンで丁寧にサポートします。\n▼体験予約\n（体験予約URL）' },
        { delay_minutes: D.plus2, text: '【デスクワークの方へ：30秒姿勢リセット】\n\n① 椅子に座ったまま、頭のてっぺんを糸で吊られるイメージで背筋を伸ばす\n② 肩を後ろに大きく3回まわす\n③ 深呼吸を3回\n\n1時間に1回やるだけで、肩・腰がラクになります✨\n\n正しい姿勢を「体で覚える」のがピラティスです😊\n（体験予約URL）' },
        { delay_minutes: 5760, text: '{name}様、体験特別価格の期限が近づいています⏰\n\n【友だち追加から30日まで】体験（特典内容）\n\n人気の時間帯（平日夜・土日午前）は埋まりやすくなっています。\nまずはお試しから、お気軽にどうぞ😊\n\n▼空き状況を見る\n（体験予約URL）' },
        { delay_minutes: D.plus7, text: '{name}様\n\nご案内はこれでいったん区切りにしますね。\n「体験」と送っていただければ、いつでもご案内します😊\n\n体を変える一歩、お待ちしています✨' },
        { delay_minutes: D.plus16, text: '{name}様、お久しぶりです😊\n\n「最近、姿勢が気になる」「運動不足かも…」\nそう感じたときが、始めどきです✨\n\n【今月中のご予約で】体験特別価格をご利用いただけます。\n▼体験のご予約\n（体験予約URL）' },
      ],
    },
    stepCampaignReturning: {
      name: '継続サポート（会員様向け）',
      audienceTag: '既存',
      messages: [
        { delay_minutes: D.now, text: '{name}様、いつもありがとうございます😊\n\n公式LINEから、レッスン予約・振替のご相談ができるようになりました。\n「予約」と送るか、このトークへどうぞ✨' },
        { delay_minutes: 14400, text: '{name}様\n\n最近レッスンの間隔が空いていませんか？\n週1回の継続が、体の変化を実感する一番の近道です✨\n\n▼次回のご予約\n（予約システムURL）またはこのトークへ😊' },
        { delay_minutes: 28800, text: '{name}様、ご無沙汰しています😊\n体は正直です。再開するなら、早いほど戻りも早いですよ✨\nレッスン予約はこのトーク、または（予約システムURL）から。お待ちしています！' },
      ],
    },
    autoreplies: [
      { keyword: '体験', match_type: 'contains', reply_text: '体験レッスンのご予約はこちら→（体験予約URL）\n動きやすい服装でお越しください😊 手ぶらでOKです！\n※メニューで入力欄がかくれている時は、左下の ⌨ マークをタップすると開きます' },
      { keyword: '予約', match_type: 'contains', reply_text: 'ご予約はこちらから→（体験予約URL）\nご希望の日時をこのトークに送っていただいてもOKです😊\n※メニューで入力欄がかくれている時は、左下の ⌨ マークをタップすると開きます' },
      { keyword: '料金', match_type: 'contains', reply_text: '【料金プラン・通い放題のご案内】✨\n体験当日のご入会で特典もご用意しています。\n詳しくは→（料金ページURL）' },
      { keyword: '持ち物', match_type: 'contains', reply_text: '動きやすい服装・お飲み物・タオルをお持ちください。靴下は（必要/不要）です😊' },
      { keyword: '初心者', match_type: 'contains', reply_text: '当スタジオは初心者の方が9割です😊\nマシンが動きをサポートするので、運動が苦手な方こそ効果を感じやすいですよ✨\n▼まずは体験から\n（体験予約URL）' },
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
 * プリセットを適用：新規向け＋再来向けの2シナリオ（会話ボットの 新規/既存 タグと自動連動）と
 * 自動応答を院に作成する。リッチメニューはサーバ側で画像生成しないため対象外（ビルダーへ反映）。
 * @returns {{campaign, campaignReturning, autoreplies}} 作成結果サマリ
 */
function applyPreset(db, tenant, key, { applySteps = true, applyAutoreplies = true } = {}) {
  const p = PRESETS[key];
  if (!p) return { error: '不明なプリセットです' };
  let campaign = null, campaignReturning = null, replies = 0;
  if (applySteps && p.stepCampaign) {
    const c = steps.createCampaign(db, tenant.id, {
      name: p.stepCampaign.name, media: null,
      audienceTag: p.stepCampaign.audienceTag || null, active: true,
    });
    steps.setSteps(db, tenant.id, c.id, p.stepCampaign.messages);
    campaign = c.id;
  }
  if (applySteps && p.stepCampaignReturning) {
    const c = steps.createCampaign(db, tenant.id, {
      name: p.stepCampaignReturning.name, media: null,
      audienceTag: p.stepCampaignReturning.audienceTag || null, active: true,
    });
    steps.setSteps(db, tenant.id, c.id, p.stepCampaignReturning.messages);
    campaignReturning = c.id;
  }
  if (applyAutoreplies && p.autoreplies) {
    for (const r of p.autoreplies) { autoreply.createRule(db, tenant.id, r); replies++; }
  }
  return { ok: true, campaign, campaignReturning, autoreplies: replies };
}

module.exports = { PRESETS, listPresets, getPreset, applyPreset };
