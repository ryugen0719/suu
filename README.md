# suu

画像をアップロードせず、ブラウザー内で圧縮・変換するWebアプリです。

## 機能

- 画像のトリミングと圧縮前後の比較
- JPEG、PNG、WebPでの出力
- 目標容量の指定（初期値128 KB）
- モノクロ出力と出力寸法の指定
- HEIC / HEIF、JPEG、PNG、WebPの読み込み
- 画像の圧縮・変換はブラウザー内で実行

## 起動

```bash
npm ci
npm run dev
```

本番ビルドと静的検査:

```bash
npm run build
npm run lint
npx tsc --noEmit
```

100 MBを超えるファイルと5,000万画素を超える画像は受け付けません。目標容量や出力寸法が極端な場合、設定によっては圧縮できないため、アプリに表示される案内に従ってください。

## サードパーティライセンス

HEIC / HEIFの読み込みに `heic-to` を使用しています。ライセンス情報は [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。
