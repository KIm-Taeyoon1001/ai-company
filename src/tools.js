// tools.js — 에이전트가 실제로 세상에 영향을 주는 손발.
// 전부 무료 API 또는 로컬 파일시스템(=git repo)만 사용한다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { enqueue, remember, recall, recordRevenue } from './db.js';
import * as posts from './posts.js';
import { expand, surveyPillar, todayTrends, PILLARS } from './keywords.js';

const ROOT = process.cwd();

// 지금 처리 중인 작업. create_task가 부모를 기록하고 왕복 횟수를 세는 데 쓴다.
// 이게 없으면 producer↔qa 반려 루프가 영원히 돈다 — 반려할 때마다 새 task가 생겨서
// attempts<3 안전장치가 걸리지 않는다.
let currentTask = null;
let searchCount = 0; // 작업 하나가 검색을 몇 번 했는가
// 3회는 너무 빡빡했다. 한국어 질의는 검색 품질이 들쭉날쭉해서 몇 번 더 필요하다.
// 다만 무제한이면 7번씩 돌다 인계를 못 한다. 그 중간이 5다.
const SEARCH_LIMIT = Number(process.env.SEARCH_LIMIT || 5);
export function setCurrentTask(t) {
  currentTask = t || null;
  searchCount = 0;
}

/** 저장소 밖으로 나가는 경로 차단 */
function safePath(p) {
  const abs = path.resolve(ROOT, p);
  if (!abs.startsWith(ROOT)) throw new Error(`경로 거부: ${p}`);
  return abs;
}

const searchCache = new Map();
const fetchCache = new Map();
const readCount = new Map(); // 같은 파일을 반복해서 읽으며 스텝 예산을 태우는 걸 막는다
const fetchCount = new Map(); // 같은 URL도 마찬가지. 안내문만으로는 에이전트가 안 멈춘다

export const toolImpl = {
  async web_search({ query, count = 5 }) {
    const key = String(query).trim().toLowerCase();
    // 프롬프트로 "최대 3회"라고 해도 안 지킨다. 실제로 한 작업에서 7번 검색하고
    // 인계를 못 한 채 예산을 태웠다. 안내문이 아니라 거절로 막는다.
    if (!searchCache.has(key)) {
      searchCount += 1;
      if (searchCount > SEARCH_LIMIT) {
        return {
          error: `검색을 이미 ${SEARCH_LIMIT}번 했다. 더 찾지 말고 지금까지 읽은 것으로 결과를 넘겨라. ` +
            `읽은 자료가 하나라도 있으면 그것으로 쓸 수 있는 만큼만 써서 넘겨라. 전부 되돌리지 마라.`,
          searches_done: searchCount - 1,
        };
      }
    }
    if (searchCache.has(key)) {
      return {
        note: '이 검색어는 이미 조회했다. 같은 검색을 반복하지 말고 결과를 web_fetch로 읽거나 다음 단계로 넘어가라.',
        results: searchCache.get(key),
      };
    }
    // DuckDuckGo HTML — 키 불필요, 0원. 실패 시 빈 배열.
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-company/1.0)' },
    });
    if (!res.ok) return { results: [], error: `search ${res.status}` };
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && out.length < count) {
      out.push({ url: unwrap(m[1]), title: strip(m[2]) });
    }
    searchCache.set(key, out);
    return { results: out };
  },

  async web_fetch({ url, max_chars = 2000 }) {
    // #anchor 는 서버 입장에선 같은 페이지다. 이걸 안 벗기면 에이전트가 #section-... 을
    // 붙여가며 같은 문서를 몇 번이고 다시 받아 스텝 예산을 태운다(실제로 그랬다).
    const cacheKey = String(url).split('#')[0];
    if (fetchCache.has(cacheKey)) {
      const n = (fetchCount.get(cacheKey) || 1) + 1;
      fetchCount.set(cacheKey, n);
      // 3번째부터는 본문을 주지 않는다. 안내문만 붙여 돌려주면 에이전트가 계속 다시 부른다
      // (실제로 producer가 URL 3개를 10스텝 동안 돌려 부르며 예산을 태웠다).
      if (n > 2) {
        return {
          url,
          error: `이 URL을 이미 ${n - 1}번 읽었다. 내용은 바뀌지 않는다. 더 읽지 말고 지금 가진 것으로 결과물을 써라.`,
        };
      }
      return { url, note: '이 URL은 이미 읽었다. #anchor 를 바꿔도 같은 페이지다. 다시 읽지 마라.', text: fetchCache.get(cacheKey) };
    }
    // 봇 차단이 흔해서 평범한 브라우저처럼 보이게 하고, 403이면 UA를 바꿔 한 번 더 시도한다.
    const UAS = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    ];
    let res;
    for (const ua of UAS) {
      res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
        },
        redirect: 'follow',
      }).catch((e) => ({ ok: false, status: 0, _err: e.message }));
      if (res.ok) break;
      if (res.status !== 403 && res.status !== 429) break;
    }
    if (!res.ok) {
      return {
        error: `fetch ${res.status}${res._err ? ' ' + res._err : ''}`,
        hint: '이 사이트는 막혀 있다. 다른 URL을 시도하고, 이 URL은 근거로 쓰지 마라.',
      };
    }
    // 한국 정부·협회 사이트는 아직 EUC-KR 이 많다. UTF-8 로 읽으면 글자가 통째로 깨지고,
    // 깨진 글로 조사한 결과는 쓸 수 없다. 헤더와 meta 를 보고 맞는 인코딩으로 다시 읽는다.
    const buf = Buffer.from(await res.arrayBuffer());
    let charset = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1];
    let html = buf.toString('utf8');
    if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(html.slice(0, 2000))?.[1];
    if (charset && !/^utf-?8$/i.test(charset)) {
      try {
        html = new TextDecoder(charset).decode(buf);
      } catch {
        // 모르는 인코딩이면 utf8 로 읽은 것을 그대로 쓴다
      }
    }
    const text = strip(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    );
    const out = text.slice(0, max_chars);
    fetchCache.set(cacheKey, out);
    fetchCount.set(cacheKey, 1);
    return { url, text: out };
  },




  /**
   * QA 통과한 초안만 발행 폴더로 옮긴다.
   * producer가 site/posts에 직접 쓰면 반려된 글도 그대로 사이트에 올라간다 — 실제로 그랬다.
   * 내용은 건드리지 않고 파일만 옮긴다. LLM이 본문을 다시 쓰면 검수한 내용이 아니게 된다.
   */

  async find_topics({ pillar, seed, count = 12 }) {
    const covered = new Set((await posts.coveredKeywords()).map((p) => p.keyword).filter(Boolean));
    let rows = [];
    if (seed) rows = await expand(seed);
    else if (pillar) rows = await surveyPillar(pillar, { perSeed: 4 });
    else return { error: `pillar 또는 seed 를 지정해라. 가능한 pillar: ${Object.keys(PILLARS).join(', ')}` };
    const fresh = rows.filter((r) => !covered.has(r.query));
    return {
      skipped_already_covered: rows.length - fresh.length,
      topics: fresh.slice(0, count).map((r) => ({ query: r.query, score: r.score, sources: r.sources })),
    };
  },

  async today_trends() {
    const t = await todayTrends();
    return { note: '실시간 이슈는 뉴스 사이트가 이긴다. 계절·시기 판단에만 참고해라.', trends: t.slice(0, 12) };
  },

  async covered_topics() {
    const c = await posts.coveredKeywords();
    return { count: c.length, posts: c.slice(0, 60) };
  },

  async write_post({ slug, title, tags, sources, pillar, keyword, body }) {
    try {
      return await posts.save({ slug, title, tags, sources, pillar, keyword, body });
    } catch (e) {
      return { error: e.message };
    }
  },

  async read_post({ slug, stage = 'drafts' }) {
    try {
      const p = await posts.read(slug, stage);
      return { slug: p.slug, title: p.title, sources: p.sources, chars: p.chars, body: p.body.slice(0, 9000) };
    } catch (e) {
      return { error: e.message };
    }
  },

  async approve_post({ slug }) {
    try {
      return await posts.approve(slug);
    } catch (e) {
      return { error: `초안을 못 찾았다(${e.code || e.message}). drafts/${slug}.md 가 맞는지 확인해라.` };
    }
  },

  async create_task({ role, title, payload, priority }) {
    const round = Number(currentTask?.payload?.round || 0) + 1;
    const t = await enqueue({
      role,
      title,
      payload: { ...(payload || {}), round },
      priority,
      parent_id: currentTask?.id ?? null,
    });
    return { ok: true, id: t?.id, role, title, round };
  },

  async save_memory({ key, value }) {
    await remember(key, value);
    return { ok: true, key };
  },

  async load_memory({ key }) {
    return { key, value: await recall(key) };
  },

  async record_revenue({ source, amount, currency, note }) {
    await recordRevenue({ source, amount, currency, note });
    return { ok: true };
  },

  async notify({ text, title = 'AI Company' }) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return { skipped: '알림 웹훅 미설정' };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**\n${String(text).slice(0, 1800)}` }),
    });
    return { ok: res.ok, status: res.status };
  },
};

/** DuckDuckGo 리다이렉트 링크(//duckduckgo.com/l/?uddg=...)에서 실제 URL만 뽑는다. */
function unwrap(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {}
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

function strip(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// OpenAI function-calling 스펙
export const toolSpecs = [
  spec('web_search', '웹을 검색해 제목/URL 목록을 얻는다.', {
    query: { type: 'string' },
    count: { type: 'integer' },
  }, ['query']),
  spec('web_fetch', 'URL의 본문 텍스트를 가져온다.', {
    url: { type: 'string' },
    max_chars: { type: 'integer' },
  }, ['url']),
  spec('find_topics', '사람들이 실제로 검색하는 질문을 찾는다. pillar 또는 seed 중 하나를 준다.', {
    pillar: { type: 'string' },
    seed: { type: 'string' },
    count: { type: 'integer' },
  }, []),
  spec('today_trends', '오늘 뜨는 검색어. 계절·시기 판단용 참고다.', {}, []),
  spec('covered_topics', '이미 쓴 글의 주제 목록.', {}, []),
  spec('write_post', '초안을 저장한다. 본문은 마크다운으로 쓴다.', {
    slug: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
    pillar: { type: 'string' },
    keyword: { type: 'string' },
  }, ['slug', 'title', 'body']),
  spec('read_post', '저장된 글을 읽는다.', {
    slug: { type: 'string' },
    stage: { type: 'string', enum: ['drafts', 'ready', 'published'] },
  }, ['slug']),
  spec('approve_post', '검수를 통과시킨다. 발행 대기로 옮겨진다.', {
    slug: { type: 'string' },
  }, ['slug']),
  spec('create_task', '다른 역할의 에이전트에게 후속 작업을 넘긴다.', {
    role: { type: 'string', enum: ['editor', 'research', 'writer', 'qa'] },
    title: { type: 'string' },
    payload: { type: 'object' },
    priority: { type: 'integer', description: '1이 가장 높음, 기본 5' },
  }, ['role', 'title']),
  spec('save_memory', '회사의 장기 기억에 저장한다.', {
    key: { type: 'string' },
    value: { type: 'object' },
  }, ['key', 'value']),
  spec('load_memory', '장기 기억에서 불러온다.', { key: { type: 'string' } }, ['key']),
  spec('record_revenue', '수익을 장부에 기록한다.', {
    source: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string' },
    note: { type: 'string' },
  }, ['source', 'amount']),
  spec('notify', '사람(사장)에게 디스코드로 알린다.', {
    text: { type: 'string' },
    title: { type: 'string' },
  }, ['text']),
];

function spec(name, description, properties, required) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}
