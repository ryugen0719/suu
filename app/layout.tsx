import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "suu — ローカル画像圧縮",
  description:
    "画像をアップロードせず、端末内だけで圧縮。HEIC・HEIF・JPEG・PNG・WebPに対応したローカル画像圧縮ツール。",
  keywords: ["画像圧縮", "HEIC変換", "ローカル処理", "プライバシー"],
  robots: "index, follow",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
