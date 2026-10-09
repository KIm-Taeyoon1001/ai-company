import type { Metadata, Viewport } from "next";
import "./globals.css";
import TabBar from "@/components/TabBar";

export const metadata: Metadata = {
  title: "반스닥 — 너네 반 지금 몇 위?",
  description: "전국 중·고등학교 반이 상장된 가상 주식 게임. 실제 돈과 무관합니다.",
  openGraph: { title: "반스닥 — 너네 반 지금 몇 위?", description: "우리 반 주가 올리러 가기" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-dvh">
        <div className="sticky top-0 z-20 bg-ink text-bg text-center text-[11px] py-1">
          가상 게임 코인이며 실제 돈과 무관합니다
        </div>
        <main className="mx-auto max-w-md px-4 pb-24 pt-4">{children}</main>
        <TabBar />
      </body>
    </html>
  );
}
