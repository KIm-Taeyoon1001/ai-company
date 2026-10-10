import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Firebase Google 로그인 팝업이 창을 닫을 수 있게
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }] }];
  },
  webpack(cfg, { isServer }) {
    // 서버 번들에서도 Firestore 브라우저 빌드를 쓴다.
    // node 빌드는 grpc + protobufjs(new Function 코드 생성)를 끌고 오는데,
    // Cloudflare Workers 는 문자열 코드 생성을 금지해서 모든 페이지가 500 이 난다.
    if (isServer) {
      cfg.resolve.alias = {
        ...cfg.resolve.alias,
        "@firebase/firestore$": path.resolve("node_modules/@firebase/firestore/dist/index.esm.js"),
      };
    }
    return cfg;
  },
};

export default config;
