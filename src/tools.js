// tools.js — 에이전트가 실제로 세상에 영향을 주는 손발.
// 전부 무료 API 또는 로컬 파일시스템(=git repo)만 사용한다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { enqueue, remember, recall, recordRevenue } from './db.js';

const ROOT = process.cwd();

/** 저장소 밖으로 나가는 경로 차단 */
function safePath(p) {
  const abs = path.resolve(ROOT, p);
  if (!abs.startsWith(ROOT)) throw new Error(`경로 거부: ${p}`);
  return abs;
}

export const toolImpl = {
  async web_search({ query, count = 5 }) {
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
    return { results: out };
  },

  async web_fetch({ url, max_chars = 6000 }) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-company/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return { error: `fetch ${res.status}` };
    const html = await res.text();
    const text = strip(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    );
    return { url, text: text.slice(0, max_chars) };
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
      return { filepath, content: t.slice(0, max_chars) };
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

  async create_task({ role, title, payload, priority }) {
    const t = await enqueue({ role, title, payload, priority });
    return { ok: true, id: t?.id, role, title };
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
