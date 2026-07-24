// 公式LINE活用セミナー スライド生成
// 構成: 導入 → 第1部(公式LINEのきほん) → 第2部(壁→活用で集客に効かせる) → 控えめな締め
const pptxgen = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, 'icons');
const icon = (name, variant) => 'image/png;base64,' + fs.readFileSync(path.join(ICON_DIR, `${name}_${variant}.png`)).toString('base64');

// パレット: LINEグリーンを差し色に、白ベース＋濃紺インクのサンドイッチ
const C = {
  ink: '0F1720',      // ダーク背景
  inkSoft: '1E2A33',
  green: '06C755',    // LINEグリーン（アクセント）
  greenDeep: '0B5A4F',
  text: '1F2937',
  muted: '6B7A88',
  card: 'F4F7F5',
  cardLine: 'E3E8EE',
  white: 'FFFFFF',
  warnBg: 'FDF3F1',
  warn: 'D0402B',
  tipBg: 'EAF7F0',
};
const FONT = 'Yu Gothic';

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5
pres.author = '株式会社しっとる';
pres.title = '公式LINE活用セミナー';

const W = 13.33, H = 7.5;

// ---- ヘルパー ----
function baseSlide(dark) {
  const s = pres.addSlide();
  s.background = { color: dark ? C.ink : C.white };
  return s;
}
function footer(s, dark, pageNo) {
  s.addText('株式会社しっとる', { x: 0.6, y: H - 0.42, w: 3, h: 0.3, fontFace: FONT, fontSize: 9, color: dark ? '8A95A1' : 'A9B4BE', margin: 0 });
  if (pageNo) s.addText(String(pageNo).padStart(2, '0'), { x: W - 1.1, y: H - 0.42, w: 0.5, h: 0.3, fontFace: FONT, fontSize: 9, color: dark ? '8A95A1' : 'A9B4BE', align: 'right', margin: 0 });
}
function chip(s, label, opts = {}) {
  const w = opts.w || (0.35 + label.length * 0.16);
  s.addText(label, {
    x: opts.x ?? 0.6, y: opts.y ?? 0.5, w, h: 0.34,
    fontFace: FONT, fontSize: 11, bold: true, color: C.white, align: 'center', valign: 'middle',
    fill: { color: opts.color || C.green }, margin: 0,
  });
  return w;
}
function title(s, text, opts = {}) {
  s.addText(text, {
    x: opts.x ?? 0.6, y: opts.y ?? 0.95, w: opts.w ?? (W - 1.2), h: opts.h ?? 0.75,
    fontFace: FONT, fontSize: opts.size ?? 30, bold: true, color: opts.color || C.text, margin: 0, valign: 'middle',
  });
}
function iconCircle(s, x, y, d, name, opts = {}) {
  s.addShape('ellipse', { x, y, w: d, h: d, fill: { color: opts.bg || C.green }, line: { type: 'none' } });
  const pad = d * 0.26;
  s.addImage({ data: icon(name, opts.variant || 'white'), x: x + pad, y: y + pad, w: d - pad * 2, h: d - pad * 2 });
}
function card(s, x, y, w, h, opts = {}) {
  s.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: opts.fill || C.card },
    line: opts.line ? { color: opts.line, width: 1 } : { type: 'none' },
  });
}

let pg = 0;

// ============ 01 表紙（ダーク） ============
{
  const s = baseSlide(true); pg++;
  s.addShape('ellipse', { x: W - 4.6, y: -1.6, w: 6.4, h: 6.4, fill: { color: C.inkSoft }, line: { type: 'none' } });
  iconCircle(s, W - 3.4, 1.15, 1.9, 'mobile', { bg: C.green });
  s.addText('SHITTORU SEMINAR', { x: 0.9, y: 1.35, w: 6, h: 0.4, fontFace: 'Courier New', fontSize: 13, color: C.green, charSpacing: 4, margin: 0 });
  s.addText('お店の集客に効く\n公式LINE活用のきほん', { x: 0.9, y: 1.85, w: 9.5, h: 2.4, fontFace: FONT, fontSize: 44, bold: true, color: C.white, margin: 0, lineSpacing: 58 });
  s.addText('〜 はじめての人でも大丈夫。「作る」から「集客に効かせる」まで 〜', { x: 0.9, y: 4.45, w: 10.5, h: 0.5, fontFace: FONT, fontSize: 18, color: 'CADCDC', margin: 0 });
  s.addText('株式会社しっとる', { x: 0.9, y: 6.35, w: 5, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: C.white, margin: 0 });
  s.addNotes('本日はお集まりいただきありがとうございます。今日は「売り込み」の場ではなく、公式LINEというものを正しく知って、お店の集客に活かしてもらうための勉強会です。');
}

// ============ 02 今日わかること ============
{
  const s = baseSlide(false); pg++;
  chip(s, '今日のゴール');
  title(s, 'この60分で「3つ」わかるようになります');
  const items = [
    { icon: 'mobile', t: '公式LINEで何ができるか', d: '個人のLINEとの違いから、無料でできることまで。今日から自分で始められる状態に。' },
    { icon: 'yen', t: '料金のしくみ', d: '「LINEって高いんでしょ？」の誤解を解消。実は月200通まで無料。損しない選び方。' },
    { icon: 'chart', t: '集客に「効かせる」使い方', d: '配って終わりにしない。来店・予約につなげるための考え方と、それを助ける機能。' },
  ];
  items.forEach((it, i) => {
    const x = 0.6 + i * 4.15;
    card(s, x, 2.2, 3.85, 3.9);
    iconCircle(s, x + 0.35, 2.6, 0.95, it.icon);
    s.addText(`その${i + 1}`, { x: x + 0.35, y: 3.75, w: 1.5, h: 0.35, fontFace: FONT, fontSize: 12, bold: true, color: C.greenDeep, margin: 0 });
    s.addText(it.t, { x: x + 0.35, y: 4.1, w: 3.2, h: 0.8, fontFace: FONT, fontSize: 18, bold: true, color: C.text, margin: 0 });
    s.addText(it.d, { x: x + 0.35, y: 4.95, w: 3.2, h: 1.0, fontFace: FONT, fontSize: 12.5, color: C.muted, margin: 0, lineSpacing: 18 });
  });
  s.addText('※ 特定のツールの売り込みが目的ではありません。まずは「公式LINEそのもの」を使いこなすのが第一歩です。', { x: 0.6, y: 6.45, w: 12, h: 0.4, fontFace: FONT, fontSize: 12, italic: true, color: C.muted, margin: 0 });
  footer(s, false, pg);
  s.addNotes('ゴールは3つ。①公式LINEで何ができるか ②料金のしくみ ③集客に効かせる使い方。売り込みではないことを最初に明言して安心してもらう。');
}

// ============ 03 なぜLINEなのか ============
{
  const s = baseSlide(false); pg++;
  chip(s, 'なぜLINEなのか');
  title(s, 'お客さまが「毎日ひらく場所」に、お店の窓口を');
  card(s, 0.6, 2.2, 6.0, 4.0);
  s.addText('約9,700万人', { x: 0.9, y: 2.7, w: 5.4, h: 1.2, fontFace: FONT, fontSize: 60, bold: true, color: C.greenDeep, margin: 0 });
  s.addText('LINEの国内月間利用者数', { x: 0.9, y: 3.95, w: 5.4, h: 0.4, fontFace: FONT, fontSize: 15, bold: true, color: C.text, margin: 0 });
  s.addText('※ LINEヤフー社公表。日本の人口の大半をカバーし、10代から70代まで幅広い年代がほぼ毎日使っています。', { x: 0.9, y: 4.4, w: 5.3, h: 0.9, fontFace: FONT, fontSize: 12, color: C.muted, margin: 0, lineSpacing: 17 });
  const rows = [
    { icon: 'bell', t: 'プッシュ通知で届く', d: 'メールとちがい、スマホの画面に直接お知らせが出る。埋もれにくい。' },
    { icon: 'comments', t: '返事のハードルが低い', d: '電話は緊張する・メールは面倒。LINEなら普段どおりの感覚で聞ける。' },
    { icon: 'handshake', t: '一度つながれば何度でも', d: 'チラシは1回きり。LINEの友だちには繰り返しお知らせを届けられる。' },
  ];
  rows.forEach((r, i) => {
    const y = 2.2 + i * 1.4;
    iconCircle(s, 7.0, y + 0.15, 0.8, r.icon);
    s.addText(r.t, { x: 8.0, y: y + 0.05, w: 4.7, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: C.text, margin: 0 });
    s.addText(r.d, { x: 8.0, y: y + 0.48, w: 4.7, h: 0.75, fontFace: FONT, fontSize: 12.5, color: C.muted, margin: 0, lineSpacing: 17 });
  });
  footer(s, false, pg);
  s.addNotes('チラシ・ハガキ・メールとの一番の違いは「毎日ひらく場所に、お店の窓口を持てる」こと。数字は9700万人だけ覚えて帰ってください。');
}

// ============ 04 第1部 とびら（ダーク） ============
{
  const s = baseSlide(true); pg++;
  s.addText('PART 1', { x: 0.9, y: 2.2, w: 4, h: 0.5, fontFace: 'Courier New', fontSize: 16, color: C.green, charSpacing: 5, margin: 0 });
  s.addText('公式LINEには、\nこんな機能があります', { x: 0.9, y: 2.8, w: 11, h: 2.0, fontFace: FONT, fontSize: 40, bold: true, color: C.white, margin: 0, lineSpacing: 52 });
  s.addText('まずは「無料でここまでできる」を知るところから。', { x: 0.9, y: 5.0, w: 10, h: 0.5, fontFace: FONT, fontSize: 16, color: 'CADCDC', margin: 0 });
  footer(s, true, pg);
  s.addNotes('第1部。公式LINEそのものの機能紹介。ここは完全に中立な解説パート。');
}

// ============ 05 公式LINEとは ============
{
  const s = baseSlide(false); pg++;
  chip(s, '公式LINEとは');
  title(s, '「お店用のLINEアカウント」です');
  card(s, 0.6, 2.15, 5.9, 4.15, { fill: C.white, line: C.cardLine });
  iconCircle(s, 0.95, 2.5, 0.85, 'comments', { bg: 'B6C0CA' });
  s.addText('個人のLINE', { x: 2.0, y: 2.62, w: 3.5, h: 0.5, fontFace: FONT, fontSize: 18, bold: true, color: C.muted, margin: 0 });
  s.addText([
    { text: '家族や友人との連絡用', options: { bullet: true, breakLine: true } },
    { text: '1対1のやりとりが基本', options: { bullet: true, breakLine: true } },
    { text: 'お店の宣伝には使えない（規約上もNG）', options: { bullet: true } },
  ], { x: 1.0, y: 3.6, w: 5.1, h: 2.3, fontFace: FONT, fontSize: 14, color: C.text, margin: 0, paraSpaceAfter: 10 });
  card(s, 6.85, 2.15, 5.9, 4.15, { fill: C.tipBg });
  iconCircle(s, 7.2, 2.5, 0.85, 'store');
  s.addText('公式LINE（LINE公式アカウント）', { x: 8.25, y: 2.62, w: 4.3, h: 0.5, fontFace: FONT, fontSize: 18, bold: true, color: C.greenDeep, margin: 0 });
  s.addText([
    { text: 'お店・会社の発信用アカウント', options: { bullet: true, breakLine: true } },
    { text: '無料で今日から作れる', options: { bullet: true, breakLine: true } },
    { text: 'お客さまに「友だち追加」してもらい、お知らせを届ける', options: { bullet: true, breakLine: true } },
    { text: '緑の「＠マーク」のアカウントが目印', options: { bullet: true } },
  ], { x: 7.25, y: 3.6, w: 5.2, h: 2.5, fontFace: FONT, fontSize: 14, color: C.text, margin: 0, paraSpaceAfter: 10 });
  footer(s, false, pg);
  s.addNotes('「LINEはやってるけど公式LINEは別物？」という質問が一番多い。個人LINEとの違いを最初に整理。');
}

// ============ 06 きほん機能①（届ける） ============
{
  const s = baseSlide(false); pg++;
  chip(s, 'きほん機能 1/2');
  title(s, '「届ける」ための機能');
  const rows = [
    { icon: 'plane', t: 'あいさつメッセージ', d: '友だち追加された瞬間に、自動で届く最初の1通。お礼とお店の案内を伝えます。', tag: '自動' },
    { icon: 'bullhorn', t: '一斉配信', d: '友だち全員に同じお知らせを一度に送信。キャンペーン・お休みのお知らせなど「チラシの代わり」。', tag: '手動' },
    { icon: 'comments', t: '1対1トーク', d: 'お客さまと個別にやりとり。予約の相談や質問に、ふつうのLINEと同じ感覚で返信できます。', tag: '無料・無制限' },
  ];
  rows.forEach((r, i) => {
    const y = 2.2 + i * 1.5;
    card(s, 0.6, y, 12.1, 1.3);
    iconCircle(s, 0.95, y + 0.22, 0.85, r.icon);
    s.addText(r.t, { x: 2.05, y: y + 0.16, w: 3.6, h: 0.45, fontFace: FONT, fontSize: 18, bold: true, color: C.text, margin: 0 });
    s.addText(r.tag, { x: 2.05, y: y + 0.68, w: 1.9, h: 0.32, fontFace: FONT, fontSize: 10.5, bold: true, color: C.greenDeep, fill: { color: C.tipBg }, align: 'center', valign: 'middle', margin: 0 });
    s.addText(r.d, { x: 5.9, y: y + 0.18, w: 6.5, h: 1.0, fontFace: FONT, fontSize: 13.5, color: C.text, margin: 0, valign: 'middle', lineSpacing: 19 });
  });
  footer(s, false, pg);
  s.addNotes('届ける系3つ。あいさつメッセージは自動、一斉配信はチラシの代わり、1対1トークは無料で無制限。');
}

// ============ 07 きほん機能②（迎える） ============
{
  const s = baseSlide(false); pg++;
  chip(s, 'きほん機能 2/2');
  title(s, '「迎える・もてなす」ための機能');
  const rows = [
    { icon: 'reply', t: 'キーワード自動応答', d: '「営業時間」と送られたら自動で返信、のような仕組み。夜中でも自動でお答えできます。', tag: '自動・無料' },
    { icon: 'menu', t: 'リッチメニュー', d: 'トーク画面の下に常に表示されるボタンのメニュー。予約・地図・料金などの「入口」になります。', tag: '常時表示' },
    { icon: 'gift', t: 'クーポン・ショップカード', d: '割引クーポンの配布や、来店ポイントカードをLINEの中で。紙のカードが不要になります。', tag: '販促' },
  ];
  rows.forEach((r, i) => {
    const y = 2.2 + i * 1.5;
    card(s, 0.6, y, 12.1, 1.3);
    iconCircle(s, 0.95, y + 0.22, 0.85, r.icon);
    s.addText(r.t, { x: 2.05, y: y + 0.16, w: 3.6, h: 0.45, fontFace: FONT, fontSize: 18, bold: true, color: C.text, margin: 0 });
    s.addText(r.tag, { x: 2.05, y: y + 0.68, w: 1.9, h: 0.32, fontFace: FONT, fontSize: 10.5, bold: true, color: C.greenDeep, fill: { color: C.tipBg }, align: 'center', valign: 'middle', margin: 0 });
    s.addText(r.d, { x: 5.9, y: y + 0.18, w: 6.5, h: 1.0, fontFace: FONT, fontSize: 13.5, color: C.text, margin: 0, valign: 'middle', lineSpacing: 19 });
  });
  footer(s, false, pg);
  s.addNotes('迎える系3つ。自動応答は営業時間外の取りこぼし防止。リッチメニューは常設の看板。クーポン・ショップカードで紙が不要に。');
}

// ============ 08 料金のきほん ============
{
  const s = baseSlide(false); pg++;
  chip(s, '料金のきほん', { color: C.warn });
  title(s, '実は、月200通までは「無料」です');
  const plans = [
    { name: 'コミュニケーション', price: '¥0', cond: '月200通まで', note: 'まずはここから。友だちが少ないうちはこれで十分。', hot: true },
    { name: 'ライト', price: '¥5,500', cond: '月5,000通まで（税込）', note: '友だちが増えて、配信をしっかり出すようになったら。' },
    { name: 'スタンダード', price: '¥16,500', cond: '月30,000通＋従量（税込）', note: '本格的に配信するお店向け。' },
  ];
  plans.forEach((p, i) => {
    const x = 0.6 + i * 4.15;
    card(s, x, 2.15, 3.85, 3.1, { fill: p.hot ? C.tipBg : C.card });
    s.addText(p.name + 'プラン', { x: x + 0.3, y: 2.45, w: 3.25, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: p.hot ? C.greenDeep : C.muted, margin: 0 });
    s.addText(p.price, { x: x + 0.3, y: 2.9, w: 3.25, h: 0.9, fontFace: FONT, fontSize: 44, bold: true, color: C.text, margin: 0 });
    s.addText(p.cond, { x: x + 0.3, y: 3.85, w: 3.25, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: C.text, margin: 0 });
    s.addText(p.note, { x: x + 0.3, y: 4.25, w: 3.25, h: 0.85, fontFace: FONT, fontSize: 11.5, color: C.muted, margin: 0, lineSpacing: 16 });
  });
  card(s, 0.6, 5.55, 12.1, 1.15, { fill: C.tipBg });
  iconCircle(s, 0.9, 5.75, 0.7, 'bulb');
  s.addText([
    { text: '「通数」に数えるのは一斉配信などの「こちらから送る」ぶんだけ。', options: { bold: true, breakLine: true } },
    { text: '1対1トークの返信・自動応答・あいさつメッセージは何通でも無料。だから最初は0円で始められます。', options: {} },
  ], { x: 1.8, y: 5.72, w: 10.7, h: 0.85, fontFace: FONT, fontSize: 13, color: C.greenDeep, margin: 0, valign: 'middle', lineSpacing: 19 });
  footer(s, false, pg);
  s.addNotes('料金の誤解を解くページ。「高いんでしょ？」→月200通まで無料。返信・自動応答は通数に数えない。※料金は2026年7月時点のLINEヤフー社公表値。');
}

// ============ 09 第1部まとめ ============
{
  const s = baseSlide(false); pg++;
  chip(s, '第1部まとめ');
  title(s, '公式LINEだけでも「お店の連絡網」は作れます');
  const checks = ['チラシ代わりの一斉配信ができる', '営業時間外も自動応答が対応してくれる', 'クーポンやポイントカードで再来店のきっかけを作れる', '1対1の相談窓口を無料で持てる'];
  checks.forEach((t, i) => {
    const y = 2.3 + i * 0.78;
    iconCircle(s, 0.7, y, 0.5, 'check');
    s.addText(t, { x: 1.45, y: y - 0.02, w: 10.5, h: 0.55, fontFace: FONT, fontSize: 17, color: C.text, margin: 0, valign: 'middle' });
  });
  card(s, 0.6, 5.6, 12.1, 1.15, { fill: C.card });
  s.addText([
    { text: 'ただ、実際に運用を始めたお店の多くが、あることに気づきます。', options: { bold: true, breakLine: true } },
    { text: '「がんばって配信しているのに、集客につながっている実感がない…」——第2部はこの話です。', options: {} },
  ], { x: 1.0, y: 5.78, w: 11.3, h: 0.85, fontFace: FONT, fontSize: 14, color: C.text, margin: 0, lineSpacing: 20 });
  footer(s, false, pg);
  s.addNotes('第1部の締め。公式LINEだけで十分できることを肯定した上で、「でも運用すると気づくことがある」と第2部への橋渡し。');
}

// ============ 10 第2部 とびら（ダーク） ============
{
  const s = baseSlide(true); pg++;
  s.addText('PART 2', { x: 0.9, y: 2.2, w: 4, h: 0.5, fontFace: 'Courier New', fontSize: 16, color: C.green, charSpacing: 5, margin: 0 });
  s.addText('集客に「効かせる」には', { x: 0.9, y: 2.8, w: 11.5, h: 1.1, fontFace: FONT, fontSize: 40, bold: true, color: C.white, margin: 0 });
  s.addText('〜 使ってみると出てくる「4つの壁」と、それを越える機能 〜', { x: 0.9, y: 4.0, w: 11, h: 0.6, fontFace: FONT, fontSize: 18, color: 'CADCDC', margin: 0 });
  footer(s, true, pg);
  s.addNotes('第2部。運用フェーズで出てくる4つの壁を先に見せてから、それぞれを越える機能を紹介する構成。');
}

// ============ 11 4つの壁 ============
{
  const s = baseSlide(false); pg++;
  chip(s, 'よくあるつまずき', { color: C.warn });
  title(s, '使い始めたお店がぶつかる「4つの壁」');
  const walls = [
    { t: 'どの宣伝が効いたか分からない', d: 'チラシ？Instagram？広告？——友だちは増えたけど、どこから来たのか誰にも分からない。' },
    { t: '全員に同じ配信しかできない', d: '新規の人にも常連さんにも同じ文面。「自分に関係ない」と思われてブロックされてしまう。' },
    { t: 'ぜんぶ手作業で続かない', d: '配信文を毎回考えて、送って、返信して…。忙しい営業の合間では続けられない。' },
    { t: '効果が数字で見えない', d: '配信の結果が売上につながったのか分からないから、改善のしようがない。' },
  ];
  walls.forEach((wl, i) => {
    const x = 0.6 + (i % 2) * 6.25, y = 2.2 + Math.floor(i / 2) * 2.15;
    card(s, x, y, 5.95, 1.95, { fill: C.warnBg });
    iconCircle(s, x + 0.3, y + 0.3, 0.7, 'warn', { bg: C.warn });
    s.addText(`壁${i + 1}：${wl.t}`, { x: x + 1.2, y: y + 0.22, w: 4.55, h: 0.55, fontFace: FONT, fontSize: 16, bold: true, color: C.warn, margin: 0 });
    s.addText(wl.d, { x: x + 1.2, y: y + 0.8, w: 4.55, h: 1.0, fontFace: FONT, fontSize: 12.5, color: C.text, margin: 0, lineSpacing: 18 });
  });
  footer(s, false, pg);
  s.addNotes('会場に「あるある」と頷いてもらうページ。4つの壁はこのあと1つずつ解決策を見せる。');
}

// ============ 12 壁1: 流入経路の計測 ============
function kabeSlide(no, kicker, ttl, beforeTxt, afterTxt, effectTitle, effectTxt, iconName) {
  const s = baseSlide(false); pg++;
  chip(s, `壁${no}を越える`, { color: C.greenDeep });
  title(s, ttl);
  // Before
  card(s, 0.6, 2.25, 5.5, 2.5, { fill: C.warnBg });
  s.addText('いままで', { x: 0.95, y: 2.5, w: 2, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: C.warn, margin: 0 });
  s.addText(beforeTxt, { x: 0.95, y: 2.95, w: 4.8, h: 1.6, fontFace: FONT, fontSize: 14, color: C.text, margin: 0, lineSpacing: 21 });
  // 矢印
  s.addText('→', { x: 6.15, y: 3.15, w: 0.8, h: 0.7, fontFace: FONT, fontSize: 36, bold: true, color: C.green, align: 'center', margin: 0 });
  // After
  card(s, 7.0, 2.25, 5.7, 2.5, { fill: C.tipBg });
  iconCircle(s, 7.3, 2.5, 0.6, iconName);
  s.addText('この機能があると', { x: 8.05, y: 2.6, w: 3.5, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: C.greenDeep, margin: 0 });
  s.addText(afterTxt, { x: 7.35, y: 3.15, w: 5.0, h: 1.5, fontFace: FONT, fontSize: 14, color: C.text, margin: 0, lineSpacing: 21 });
  // 効果
  card(s, 0.6, 5.05, 12.1, 1.6, { fill: C.card });
  s.addText('📈 集客にどう効く？', { x: 1.0, y: 5.25, w: 3.5, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: C.greenDeep, margin: 0 });
  s.addText(effectTitle, { x: 1.0, y: 5.68, w: 11.3, h: 0.45, fontFace: FONT, fontSize: 16, bold: true, color: C.text, margin: 0 });
  s.addText(effectTxt, { x: 1.0, y: 6.15, w: 11.3, h: 0.45, fontFace: FONT, fontSize: 12.5, color: C.muted, margin: 0 });
  footer(s, false, pg);
  return s;
}
kabeSlide(1, null, '「どこから来たか」が分かる：流入経路の計測',
  'チラシ・Instagram・広告…\n友だち追加が増えても、どの宣伝のおかげか分からず、勘で広告費を配分。',
  '宣伝ごとに専用のリンクやQRコードを発行。友だち追加された瞬間に「どの宣伝から来た人か」が自動で記録される。',
  '効いた宣伝にお金と手間を集中できる',
  '例：チラシ経由が0人と分かれば、その費用をInstagramに回せる。広告のムダ打ちが減り、同じ予算で友だちが増える。',
  'route'
).addNotes('壁1の解決。宣伝ごとの専用リンク・QRで流入経路を記録。効いた宣伝に予算を集中。');

// ============ 13 壁2: タグと絞り込み配信 ============
kabeSlide(2, null, '「その人に関係ある話」だけ届ける：タグと絞り込み配信',
  '新規の人にも10年来の常連さんにも同じ文面。心当たりのないお知らせが続くと、ブロックの原因に。',
  'お客さまに「新規」「来店済み」「腰痛」などの目印（タグ）を付けて、そのグループだけに配信できる。',
  'ブロックが減り、反応が上がる',
  '例：初回クーポンは「未来店の人だけ」に。常連さんには会員向けの案内を。関係ある話だけ届くから、読んでもらえる。',
  'tags'
).addNotes('壁2の解決。タグ＝目印。絞り込み配信でブロック減・反応増。');

// ============ 14 壁3: 自動化（ステップ配信・リマインド） ============
kabeSlide(3, null, '「自動で動く仕組み」に働いてもらう：ステップ配信',
  '追加のお礼、数日後のフォロー、予約前日の確認…。ぜんぶ手作業では、忙しい日は必ず抜けてしまう。',
  '「追加直後→翌日→3日後」と自動で届く流れを一度作れば、あとは寝ている間も働いてくれる。予約前日のリマインドや誕生日のお祝いも自動。',
  '手を動かさなくても、フォローが続く',
  '例：友だち追加の熱が冷めないうちに自動でクーポン→数日後に予約案内。前日リマインドで無断キャンセルも減る。',
  'clock'
).addNotes('壁3の解決。ステップ配信・リマインド・誕生日。一度作れば自動で回る。');

// ============ 15 壁4: 数字の見える化（ファネル） ============
{
  const s = baseSlide(false); pg++;
  chip(s, '壁4を越える', { color: C.greenDeep });
  title(s, '「どこで減っているか」が見える：数字の見える化');
  // 左: ファネル図（シェイプで表現）
  const stages = [
    { t: '宣伝を見てクリック', v: '100人', w: 5.0 },
    { t: '友だち追加', v: '40人', w: 3.9 },
    { t: '予約・問い合わせ', v: '12人', w: 2.8 },
  ];
  stages.forEach((st, i) => {
    const y = 2.4 + i * 1.15;
    s.addShape('roundRect', { x: 0.8, y, w: st.w, h: 0.85, rectRadius: 0.06, fill: { color: i === 2 ? C.green : (i === 1 ? '69C9A0' : 'A8DFC6') }, line: { type: 'none' } });
    s.addText(`${st.t}　${st.v}`, { x: 0.95, y: y + 0.18, w: st.w - 0.2, h: 0.5, fontFace: FONT, fontSize: 14, bold: true, color: i === 0 ? C.greenDeep : C.white, margin: 0, valign: 'middle' });
  });
  s.addText('↑ バーの「段差」が大きいところ＝改善ポイント', { x: 0.8, y: 5.95, w: 5.6, h: 0.4, fontFace: FONT, fontSize: 13, bold: true, color: C.greenDeep, margin: 0 });
  // 右: 説明
  s.addText([
    { text: '「クリック→友だち追加→予約」の各段階で、何人残っているかを数字で見る考え方です（ファネル＝じょうご）。', options: { breakLine: true } },
    { text: '', options: { breakLine: true } },
    { text: '段差が大きい場所＝直すべき場所。', options: { bold: true, breakLine: true } },
    { text: '・クリックは多いのに追加が少ない → 追加ページを見直す', options: { breakLine: true } },
    { text: '・追加は多いのに予約が少ない → 配信内容や特典を見直す', options: { breakLine: true } },
    { text: '', options: { breakLine: true } },
    { text: '感覚ではなく数字で判断できるので、打ち手に迷わなくなります。', options: {} },
  ], { x: 6.7, y: 2.4, w: 6.0, h: 4.0, fontFace: FONT, fontSize: 14, color: C.text, margin: 0, lineSpacing: 22 });
  footer(s, false, pg);
  s.addNotes('壁4の解決。ファネルの考え方を図で。段差が大きいところが改善ポイント、数字で打ち手が決まる。');
}

// ============ 16 AIの手伝い ============
{
  const s = baseSlide(false); pg++;
  chip(s, 'さいきんの進化');
  title(s, '「文章が苦手」「時間がない」はAIがカバーする時代に');
  const rows = [
    { icon: 'magic', t: '配信文の下書きをAIが作る', d: '「雨の日キャンペーンのお知らせを書いて」と頼むと数秒で下書き。人は確認して直すだけ。' },
    { icon: 'menu', t: 'メニューやデザインも自動生成', d: 'リッチメニューのボタン構成や背景画像まで、AIと相談しながら作れる。デザイナー不要。' },
    { icon: 'robot', t: '初期設定まるごとおまかせ', d: 'お店のホームページを読み込んで、あいさつ文・自動応答・メニューの一式をAIが提案。' },
  ];
  rows.forEach((r, i) => {
    const y = 2.2 + i * 1.5;
    card(s, 0.6, y, 12.1, 1.3);
    iconCircle(s, 0.95, y + 0.22, 0.85, r.icon);
    s.addText(r.t, { x: 2.05, y: y + 0.18, w: 4.3, h: 0.5, fontFace: FONT, fontSize: 17, bold: true, color: C.text, margin: 0 });
    s.addText(r.d, { x: 6.5, y: y + 0.18, w: 5.9, h: 1.0, fontFace: FONT, fontSize: 13, color: C.text, margin: 0, valign: 'middle', lineSpacing: 19 });
  });
  s.addText('※ AIが作るのはあくまで「下書き」。お客さまに届く前に、必ず人が確認して送るのが安心の使い方です。', { x: 0.6, y: 6.6, w: 12, h: 0.4, fontFace: FONT, fontSize: 12, italic: true, color: C.muted, margin: 0 });
  footer(s, false, pg);
  s.addNotes('続かない最大の理由=文章作成の手間。今はAIが下書きしてくれる。ただし送信は人が確認、という安全設計が大事。');
}

// ============ 17 まとめ比較 ============
{
  const s = baseSlide(false); pg++;
  chip(s, 'まとめ');
  title(s, '公式LINEは「土台」。集客の道具にするのが拡張機能');
  const rows = [
    [{ text: 'できること', options: { bold: true } }, { text: '公式LINEだけ', options: { bold: true, align: 'center' } }, { text: '＋拡張機能', options: { bold: true, align: 'center' } }],
    ['お知らせを全員に届ける', { text: '○', options: { align: 'center', color: C.greenDeep, bold: true } }, { text: '○', options: { align: 'center', color: C.greenDeep, bold: true } }],
    ['どの宣伝が効いたかの計測', { text: '×', options: { align: 'center', color: 'B6C0CA', bold: true } }, { text: '○', options: { align: 'center', color: C.greenDeep, bold: true } }],
    ['相手に合わせた絞り込み配信', { text: '△ おおまかな属性のみ', options: { align: 'center', color: C.muted } }, { text: '○ タグで1人単位', options: { align: 'center', color: C.greenDeep, bold: true } }],
    ['自動のフォロー（経路別ステップ・リマインド）', { text: '×', options: { align: 'center', color: 'B6C0CA', bold: true } }, { text: '○', options: { align: 'center', color: C.greenDeep, bold: true } }],
    ['成果までの数字の見える化（ファネル・CPA）', { text: '×', options: { align: 'center', color: 'B6C0CA', bold: true } }, { text: '○', options: { align: 'center', color: C.greenDeep, bold: true } }],
    ['AIによる文面・設定の下書き', { text: '×', options: { align: 'center', color: 'B6C0CA', bold: true } }, { text: '○', options: { align: 'center', color: C.greenDeep, bold: true } }],
  ];
  s.addTable(rows, {
    x: 0.6, y: 2.2, w: 12.1, colW: [6.1, 3.0, 3.0],
    fontFace: FONT, fontSize: 13, color: C.text, valign: 'middle',
    border: { type: 'solid', color: C.cardLine, pt: 0.75 },
    fill: { color: C.white },
    rowH: 0.52,
  });
  card(s, 0.6, 6.0, 12.1, 0.95, { fill: C.tipBg });
  s.addText('まずは公式LINEを無料で始める。育ってきたら拡張機能で「集客の道具」に。この順番が失敗しません。', { x: 1.0, y: 6.12, w: 11.3, h: 0.7, fontFace: FONT, fontSize: 15, bold: true, color: C.greenDeep, margin: 0, valign: 'middle' });
  footer(s, false, pg);
  s.addNotes('まとめの比較表。公式LINEを否定しない。「土台→道具」の順番を強調。');
}

// ============ 18 ひかえめなご案内 ============
{
  const s = baseSlide(false); pg++;
  chip(s, 'ちいさなご案内');
  title(s, '今日の「拡張機能」をひとつにまとめた道具もあります', { size: 28 });
  s.addText([
    { text: '私たち しっとる は、今日お話しした 計測・絞り込み配信・自動化・見える化・AI をひとつの管理画面で使える「Keiro（ケイロ）」というサービスを作っています。', options: { breakLine: true } },
    { text: '', options: { breakLine: true } },
    { text: 'とはいえ、今日の本題は「まず公式LINEを始めて、正しく育てること」。', options: { bold: true, breakLine: true } },
    { text: '拡張が必要になるのは、友だちが増えて配信が本格化してからで十分です。', options: {} },
  ], { x: 0.6, y: 2.2, w: 7.3, h: 3.2, fontFace: FONT, fontSize: 15, color: C.text, margin: 0, lineSpacing: 24 });
  card(s, 8.3, 2.2, 4.4, 4.4, { fill: C.card });
  iconCircle(s, 8.65, 2.55, 0.8, 'store');
  s.addText('こんな方はお声がけください', { x: 8.65, y: 3.5, w: 3.8, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: C.text, margin: 0 });
  s.addText([
    { text: '公式LINEの開設を手伝ってほしい', options: { bullet: true, breakLine: true } },
    { text: '自分のお店に合う使い方を相談したい', options: { bullet: true, breakLine: true } },
    { text: '拡張機能を試してみたい（30日無料）', options: { bullet: true } },
  ], { x: 8.75, y: 3.95, w: 3.75, h: 1.9, fontFace: FONT, fontSize: 12.5, color: C.text, margin: 0, paraSpaceAfter: 9 });
  s.addText('個別のご相談は無料です。セミナー後にお気軽にどうぞ。', { x: 0.6, y: 6.0, w: 7.3, h: 0.5, fontFace: FONT, fontSize: 13, italic: true, color: C.muted, margin: 0 });
  footer(s, false, pg);
  s.addNotes('唯一の宣伝ページ。ただし「今日の本題はまず公式LINEを始めること」と引く姿勢を明言。押し売りしない。');
}

// ============ 19 クロージング（ダーク） ============
{
  const s = baseSlide(true); pg++;
  s.addShape('ellipse', { x: -2.2, y: H - 4.2, w: 6.0, h: 6.0, fill: { color: C.inkSoft }, line: { type: 'none' } });
  s.addText('ご清聴ありがとうございました', { x: 0.9, y: 2.5, w: 11.5, h: 1.0, fontFace: FONT, fontSize: 36, bold: true, color: C.white, margin: 0 });
  s.addText('まずは、無料の公式LINEをひとつ作るところから始めてみてください。\nご質問・ご相談はこのあとの時間か、下記までお気軽に。', { x: 0.9, y: 3.7, w: 11, h: 1.0, fontFace: FONT, fontSize: 16, color: 'CADCDC', margin: 0, lineSpacing: 26 });
  s.addText([
    { text: '株式会社しっとる', options: { bold: true, breakLine: true } },
    { text: 'shittoru@s-toru.com', options: {} },
  ], { x: 0.9, y: 5.2, w: 6, h: 0.9, fontFace: FONT, fontSize: 15, color: C.white, margin: 0, lineSpacing: 24 });
  s.addNotes('クロージング。行動喚起は「まず無料の公式LINEを作る」。相談窓口を案内して終了。');
}

pres.writeFile({ fileName: path.join(__dirname, '公式LINE活用セミナー.pptx') }).then(() => console.log('deck written:', pg, 'slides'));
