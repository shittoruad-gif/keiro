# セミナー資料・PDFガイドの再生成手順

## 公式LINE活用セミナー.pptx（19枚）
```
npm install react react-dom react-icons sharp pptxgenjs
node gen_icons.js   # icons/ にアイコンPNGを生成
node gen_deck.js    # 公式LINE活用セミナー.pptx を生成
```

## Keiroかんたんガイド.pdf（Web版manual.htmlが唯一のソース）
public/manual.html を編集後：
```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --print-to-pdf="$HOME/Downloads/Keiroかんたんガイド.pdf" \
  --no-pdf-header-footer --virtual-time-budget=15000 \
  "file:///Users/kabushikikaishashitsutoru/CODE/keiro/public/manual.html"
```
