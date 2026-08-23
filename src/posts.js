// posts.js — 글의 생애를 관리한다. 초안 → 검수 통과 → 발행 대기 → 사람이 붙여넣음.
//
// 티스토리 Open API 는 2024년 2월에 종료됐다. 브라우저를 조종해 올리는 방법은
// 약관 위반이고 카카오 계정이 정지되면 블로그도 같이 날아간다. 그래서 발행은 사람이 한다.
// 대신 사람이 할 일을 2분으로 줄인다 — 제목·태그·본문 HTML 을 그대로 복사만 하면 되게.

import fs from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdown, parseFrontMatter } from './render.js';

const ROOT = process.cwd();
export const DRAFTS = path.join(ROOT, 'drafts'); // 검수 전
export const READY = path.join(ROOT, 'ready'); // 검수 통과, 발행 대기
export const DONE = path.join(ROOT, 'published'); // 사람이 올린 것

const safeSlug = (s) => {
  const clean = String(s || '')
    .replace(/\.md$/, '')
    .replace(/^.*[\\/]/, '');
  if (!/^[\w-]+$/.test(clean)) throw new Error(`슬러그가 이상하다: ${s}`);
  return clean;
};

async function readDir(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && n !== 'README.md');
  } catch {
    return [];
  }
}

function meta(raw, slug) {
  const { meta: m, body } = parseFrontMatter(raw);
  const tags = Array.isArray(m.tags) ? m.tags : m.tags ? String(m.tags).split(/[,\s]+/).filter(Boolean) : [];
  const sources = Array.isArray(m.sources) ? m.sources : m.sources ? [m.sources] : [];
  return {
    slug,
    title: m.title || slug,
    tags,
    sources,
    pillar: m.pillar || '',
    keyword: m.keyword || '',
    date: m.date || '',
    body,
    chars: body.trim().length,
  };
}

export async function list(stage = 'drafts') {
  const dir = { drafts: DRAFTS, ready: READY, published: DONE }[stage];
  const names = await readDir(dir);
  const out = [];
  for (const n of names) {
    const raw = await fs.readFile(path.join(dir, n), 'utf8');
    out.push({ ...meta(raw, n.replace(/\.md$/, '')), stage });
  }
  return out.sort((a, b) => (a.slug < b.slug ? 1 : -1));
}

export async function read(slug, stage = 'drafts') {
  const dir = { drafts: DRAFTS, ready: READY, published: DONE }[stage];
  const raw = await fs.readFile(path.join(dir, `${safeSlug(slug)}.md`), 'utf8');
  return meta(raw, safeSlug(slug));
}

export async function save({ slug, title, tags = [], sources = [], pillar = '', keyword = '', body }) {
  const s = safeSlug(slug);
  if (!title) throw new Error('제목이 없다');
  if (!body || body.trim().length < 200) throw new Error('본문이 너무 짧다(200자 미만)');
  const front = [
    '---',
    `title: ${title}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `pillar: ${pillar}`,
    `keyword: ${keyword}`,
    `tags: [${tags.join(', ')}]`,
    `sources: [${sources.join(', ')}]`,
    '---',
    '',
  ].join('\n');
  await fs.mkdir(DRAFTS, { recursive: true });
  await fs.writeFile(path.join(DRAFTS, `${s}.md`), front + body.trim() + '\n', 'utf8');
  return { ok: true, slug: s, chars: body.trim().length };
}

/** 검수 통과 → 발행 대기로 옮긴다. 파일 이동은 코드가 한다. */
export async function approve(slug) {
  const s = safeSlug(slug);
  const from = path.join(DRAFTS, `${s}.md`);
  const to = path.join(READY, `${s}.md`);
  const raw = await fs.readFile(from, 'utf8');
  await fs.mkdir(READY, { recursive: true });
  await fs.writeFile(to, raw, 'utf8');
  await fs.unlink(from);
  return { ok: true, slug: s };
}

/** 사람이 티스토리에 올린 뒤 기록한다. 같은 주제를 다시 쓰지 않기 위해서다. */
export async function markPublished(slug, url = '') {
  const s = safeSlug(slug);
  const from = path.join(READY, `${s}.md`);
  const raw = await fs.readFile(from, 'utf8');
  const stamped = raw.replace(/^---\n/, `---\npublished_at: ${new Date().toISOString()}\npublished_url: ${url}\n`);
  await fs.mkdir(DONE, { recursive: true });
  await fs.writeFile(path.join(DONE, `${s}.md`), stamped, 'utf8');
  await fs.unlink(from);
  return { ok: true, slug: s };
}

/**
 * 티스토리 에디터에 그대로 붙여넣을 것들.
 * 이중 인코딩을 조심한다 — 기존 블로그 제목에 &amp;ndash; 가 박혀 있었다.
 * 여기서는 마크다운을 한 번만 변환하고 다시 이스케이프하지 않는다.
 */
export function forTistory(post) {
  const html = renderMarkdown(post.body);
  const sourceBlock = post.sources.length
    ? `\n<h2>참고한 자료</h2>\n<ul>\n` +
      post.sources
        .map((u) => `<li><a href="${u}" target="_blank" rel="nofollow noopener">${u}</a></li>`)
        .join('\n') +
      `\n</ul>`
    : '';
  return {
    title: post.title,
    tags: post.tags.join(','),
    html: html + sourceBlock,
  };
}

/** 이미 다룬 주제인가. 같은 걸 또 쓰면 서로 순위를 갉아먹는다. */
export async function coveredKeywords() {
  const all = [...(await list('drafts')), ...(await list('ready')), ...(await list('published'))];
  return all.map((p) => ({ slug: p.slug, title: p.title, keyword: p.keyword }));
}
