// serve.js — 관제 화면을 "보는 것"에서 "조작하는 것"으로 바꾼다. 의존성 0(node:http).
//
//   node --env-file=.env src/run.js serve
//
// 정적 파일로는 검수를 할 수 없다. 초안을 발행 폴더로 옮기고 DB에 작업을 넣는 일이라
// 실제로 무언가를 실행할 주체가 필요하다. 그 주체는 이 로컬 서버다.
//
// 안전장치 셋:
//  1. 127.0.0.1 에만 바인딩한다. 다른 기기에서 접근할 수 없다.
//  2. 실행할 때마다 무작위 열쇠를 만들고, 모든 요청에 그 열쇠를 요구한다.
//     열쇠가 없으면 다른 사이트가 열어둔 탭을 통해 이 서버에 요청을 보낼 수 없다.
//  3. Supabase 키는 이 프로세스 안에만 있다. 브라우저로 내려가지 않는다.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { gather, render } from './dashboard.js';
import * as posts from './posts.js';
import { forTistory } from './posts.js';
import { enqueue, log } from './db.js';

const HOST = '127.0.0.1';

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // 이 페이지는 자기 자신만 로드한다. 외부에서 프레임에 넣지 못하게 한다.
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(body);
}

const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('요청이 너무 크다');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('본문이 JSON 이 아니다');
  }
}

/** 한 번에 하나만 돈다. 워커 두 개가 같은 작업을 집으면 토큰만 태운다. */
const job = { running: null, last: null };

function startJob(name, fn) {
  if (job.running) return { ok: false, error: `이미 "${job.running}" 이(가) 돌고 있다. 끝나면 다시 눌러라.` };
  job.running = name;
  fn()
    .then((r) => {
      job.last = { name, ok: true, at: new Date().toISOString(), detail: r || '' };
    })
    .catch((e) => {
      job.last = { name, ok: false, at: new Date().toISOString(), detail: e.message };
    })
    .finally(() => {
      job.running = null;
    });
  return { ok: true, started: name };
}

export async function serve({ port = Number(process.env.PORT || 8787) } = {}) {
  const key = randomBytes(16).toString('hex');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${port}`);

    // DNS 리바인딩 방어 — Host 가 localhost 가 아니면 우리 서버로 온 요청이 아니다.
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 421, '잘못된 호스트');

    if (url.searchParams.get('k') !== key) {
      return send(res, 403, '열쇠가 필요하다. 터미널에 출력된 주소로 다시 열어라.');
    }

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const data = await gather();
        const html = render(data, { interactive: true, token: key, job });
        return send(res, 200, html, 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && url.pathname === '/job') {
        return json(res, 200, { running: job.running, last: job.last });
      }

      if (req.method !== 'POST') return send(res, 404, '없는 경로');

      const body = await readBody(req);

      if (url.pathname === '/approve') {
        try {
          const r = await posts.approve(body.slug);
          await log('human', 'info', `관제 화면에서 통과시킴: ${body.slug}`);
          return json(res, 200, { ok: true, message: `발행 대기로 이동 — ${r.slug}` });
        } catch (e) {
          return json(res, 400, { error: `초안을 못 찾았다: ${e.message}` });
        }
      }

      // 티스토리에 붙여넣을 것들. 브라우저가 클립보드에 넣는다.
      if (url.pathname === '/copy') {
        try {
          const p = await posts.read(body.slug, body.stage || 'ready');
          return json(res, 200, { ok: true, ...forTistory(p) });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      // 사람이 티스토리에 올린 뒤 누르는 것
      if (url.pathname === '/done') {
        try {
          const r = await posts.markPublished(body.slug, body.url || '');
          await log('human', 'info', `발행 완료: ${body.slug} ${body.url || ''}`);
          return json(res, 200, { ok: true, message: `발행 완료로 기록 — ${r.slug}` });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (url.pathname === '/reject') {
        const why = String(body.why || '').trim();
        if (!body.slug) return json(res, 400, { error: '슬러그가 없다' });
        if (!why) return json(res, 400, { error: '반려 사유를 적어라. 사유가 없으면 writer 가 고칠 수 없다.' });
        const t = await enqueue({
          role: 'writer',
          title: `사람 검수 반려: ${body.slug}`,
          priority: 2,
          payload: {
            slug: body.slug,
            issues: [{ problem: why, source: '사람 검수' }],
            instructions: why,
            round: 1,
          },
        });
        await log('human', 'info', `관제 화면에서 반려: ${body.slug} — ${why}`);
        return json(res, 200, { ok: true, message: `반려됨 — producer 작업 #${t?.id} 등록` });
      }

      if (url.pathname === '/run') {
        // 오래 걸리는 작업은 응답을 붙잡지 않는다. 시작만 하고 상태는 /job 으로 본다.
        const role = body.role || null;
        const { worker } = await import('./run.js');
        const r = startJob(role ? `worker:${role}` : 'worker', () => worker(role));
        return json(res, r.ok ? 200 : 409, r.ok ? { ok: true, message: `${r.started} 시작` } : { error: r.error });
      }

      return send(res, 404, '없는 경로');
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  await new Promise((r) => server.listen(port, HOST, r));
  const addr = `http://${HOST}:${port}/?k=${key}`;
  console.log('관제 서버 시작');
  console.log(`  ${addr}`);
  console.log('');
  console.log('  이 주소를 브라우저에 붙여넣어라. 열쇠는 실행할 때마다 새로 만들어진다.');
  console.log('  Ctrl+C 로 종료한다.');
  return { server, url: addr };
}
