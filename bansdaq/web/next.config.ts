import type { NextConfig } from "next";

const config: NextConfig = {
  // Firebase Google 로그인 팝업이 창을 닫을 수 있게
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }] }];
  },
};

export default config;
