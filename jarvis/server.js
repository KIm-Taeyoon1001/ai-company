// jarvis/server.js — 모니터에 띄우는 음성 비서. 의존성 0(node:http).
//
//   node --env-file=.env jarvis/server.js   →  크롬에서 http://localhost:3939
//
// 음성 인식·음성 합성은 브라우저(크롬 Web Speech API)가 하고,
// 이 서버는 LLM 호출만 대신한다. API 키가 브라우저로 내려가지 않게 하려는 것이다.
// LLM 은 블로그 파이프라인과 같은 라우터(src/llm.js)를 쓴다 — 429 나면 모델 자동 전환.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chat } from '../src/llm.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.JARVIS_PORT || 3939);
const PAGE = new URL('./index.html', import.meta.url);

const SYSTEM = `너는 J.A.R.V.I.S. 다. 아이언맨의 AI 비서처럼 침착하고 정중하며 약간 위트 있게 말한다.
사용자를 "형님"이라고 부른다.
답은 소리 내어 읽힌다. 그러니 마크다운·목록·이모지·코드블록을 쓰지 말고
자연스러운 한국어 구어체 1~3문장으로 짧게 답한다. 길게 설명해 달라고 할 때만 길게 말한다.
모르는 실시간 정보(오늘 날씨, 주가 등)는 지어내지 말고 모른다고 말한다.`;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('요청이 너무 큼');
  }
  return JSON.parse(raw || '{}');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(res, 200, await readFile(PAGE, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && req.url === '/ask') {
      // 다른 사이트가 열린 탭을 통해 이 서버를 부르지 못하게 한다
      const origin = req.headers.origin;
      if (origin && origin !== `http://localhost:${PORT}` && origin !== `http://${HOST}:${PORT}`) {
        return send(res, 403, { error: '허용되지 않은 출처' });
      }
      const { history = [] } = await readBody(req);
      const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const messages = [
        { role: 'system', content: `${SYSTEM}\n현재 시각: ${now}` },
        ...history
          .slice(-12)
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
      ];
      const t0 = Date.now();
      const out = await chat({ messages, temperature: 0.6 });
      console.log(`[jarvis] ${out.provider}/${out.model} ${Date.now() - t0}ms`);
      return send(res, 200, { reply: out.message.content || '', model: out.model });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[jarvis]', e.message);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  J.A.R.V.I.S. 온라인 → http://localhost:${PORT}  (크롬으로 열기)\n`);
});
