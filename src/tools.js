// tools.js — 에이전트가 실제로 세상에 영향을 주는 손발.
// 전부 무료 API 또는 로컬 파일시스템(=git repo)만 사용한다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { enqueue, remember, recall, recordRevenue } from './db.js';

const ROOT = process.cwd();

// 지금 처리 중인 작업. create_task가 부모를 기록하고 왕복 횟수를 세는 데 쓴다.
// 이게 없으면 producer↔qa 반려 루프가 영원히 돈다 — 반려할 때마다 새 task가 생겨서
// attempts<3 안전장치가 걸리지 않는다.
let currentTask = null;
export function setCurrentTask(t) {
  currentTask = t || null;
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
    const html = await res.text();
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

  async write_file({ filepath, content }) {
    const abs = safePath(filepath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { ok: true, filepath, bytes: Buffer.byteLength(content) };
  },

  async read_file({ filepath, max_chars = 8000 }) {
    try {
      const t = await fs.readFile(safePath(filepath), 'utf8');
      const seen = (readCount.get(filepath) || 0) + 1;
      readCount.set(filepath, seen);
      if (seen > 2) {
        // 경고만으로는 안 멈춘다. 본문을 안 주면 멈춘다.
        return {
          filepath,
          error: `이 파일을 이미 ${seen - 1}번 읽었다. 내용은 바뀌지 않았다. 더 읽지 말고 지금까지 읽은 것으로 판단해 결과를 넘겨라.`,
        };
      }
      const out = { filepath, content: t.slice(0, max_chars) };
      if (seen > 1) {
        out.note = `이 파일은 이미 ${seen - 1}번 읽었다. 내용은 그대로다. 다시 읽지 말고 판단해서 다음 단계로 넘어가라.`;
      }
      return out;
    } catch (e) {
      return { error: e.message };
    }
  },

  async list_files({ dir = '.', max = 100 }) {
    const abs = safePath(dir);
    const out = [];
    async function walk(d, depth) {
      if (depth > 3 || out.length >= max) return;
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else out.push(path.relative(ROOT, full));
        if (out.length >= max) return;
      }
    }
    await walk(abs, 0);
    return { files: out };
  },

  /**
   * QA 통과한 초안만 발행 폴더로 옮긴다.
   * producer가 site/posts에 직접 쓰면 반려된 글도 그대로 사이트에 올라간다 — 실제로 그랬다.
   * 내용은 건드리지 않고 파일만 옮긴다. LLM이 본문을 다시 쓰면 검수한 내용이 아니게 된다.
   */
  async approve_post({ slug }) {
    const clean = String(slug || '').replace(/\.md$/, '').replace(/^.*[\/]/, '');
    if (!/^[\w-]+$/.test(clean)) return { error: `슬러그가 이상하다: ${slug}` };
    const from = safePath(path.join('drafts', `${clean}.md`));
    const to = safePath(path.join('site', 'posts', `${clean}.md`));
    try {
      const raw = await fs.readFile(from, 'utf8');
      // 발행일은 우리가 아는 사실이다. LLM이 적게 두면 지어낸다(실제로 2026-01-02 로 적혀 나왔다).
      const today = new Date().toISOString().slice(0, 10);
      const body = /^---\s*\n[\s\S]*?\n---/.test(raw)
        ? (/^date:\s*.*$/m.test(raw.split(/\n---/)[0])
            ? raw.replace(/^date:\s*.*$/m, `date: ${today}`)
            : raw.replace(/^---\s*\n/, `---\ndate: ${today}\n`))
        : raw;
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, body, 'utf8');
      await fs.unlink(from);
      return { ok: true, published: `site/posts/${clean}.md`, bytes: Buffer.byteLength(body) };
    } catch (e) {
      return { error: `초안을 못 찾았다(${e.code || e.message}). drafts/${clean}.md 가 맞는지 확인해라.` };
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
  spec('write_file', '저장소에 파일을 쓴다(덮어쓰기). 결과물은 site/ 아래에 둔다.', {
    filepath: { type: 'string' },
    content: { type: 'string' },
  }, ['filepath', 'content']),
  spec('read_file', '저장소의 파일을 읽는다.', { filepath: { type: 'string' } }, ['filepath']),
  spec('list_files', '디렉터리의 파일 목록을 얻는다.', { dir: { type: 'string' } }, []),
  spec('approve_post', '검수를 통과한 초안을 발행한다. drafts/<slug>.md 를 site/posts/ 로 옮긴다.', {
    slug: { type: 'string', description: '확장자 없는 파일 이름. 예: my-post' },
  }, ['slug']),
  spec('create_task', '다른 역할의 에이전트에게 후속 작업을 넘긴다.', {
    role: { type: 'string', enum: ['ceo', 'research', 'producer', 'qa', 'publisher', 'cfo'] },
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
