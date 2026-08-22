// site.js — site/posts/*.md 를 실제로 열리는 HTML로 굽는다. 의존성 0.
//
// 왜 에이전트가 아니라 코드가 하는가:
// publisher 에이전트가 index.html을 직접 쓰면 .md 파일을 링크해버린다(실제로 그랬다).
// GitHub Pages는 .md를 렌더링하지 않으므로 방문자는 마크다운 원문을 받게 된다.
// 목록과 링크는 틀리면 안 되는 종류의 일이라 LLM에 맡기지 않는다.
//
//   node --env-file=.env src/run.js build

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, 'site', 'posts');
const SITE_DIR = path.join(ROOT, 'site');

// ---------- 마크다운 → HTML ----------
// 에이전트가 쓴 텍스트는 신뢰하지 않는다. 먼저 전부 이스케이프한 뒤,
// 우리가 아는 마크다운 문법만 태그로 되살린다. 원문의 <script>는 태그가 되지 못한다.

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** http/https만 허용. javascript: 같은 스킴은 링크로 만들지 않는다. */
function safeHref(url) {
  const u = String(url).trim();
  return /^https?:\/\//i.test(u) || /^[\w./-]+\.html$/.test(u) ? u : null;
}

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${esc(href)}" rel="nofollow noopener">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 표에 쓰이는 벌거벗은 URL도 링크로
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${esc(url)}" rel="nofollow noopener">${esc(url)}</a>`.replace(/&amp;amp;/g, '&amp;'));
  return s;
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isDivider = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');

export function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 코드 펜스
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 수평선 (--- 은 표 구분선과 겹치지 않게 앞뒤가 빈 줄일 때만)
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line) && !isDivider(lines[i + 1] || '')) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 제목
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = Math.min(h[1].length + 1, 6); // 문서 h1은 제목이 쓰므로 한 단계 내린다
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 표 — 헤더 + 구분선이 있어야 표로 본다
    if (line.includes('|') && isDivider(lines[i + 1] || '')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const tb = rows
        .map((r) => {
          const cells = [];
          for (let c = 0; c < head.length; c++) cells.push(`<td>${inline(r[c] ?? '')}</td>`);
          return `<tr>${cells.join('')}</tr>`;
        })
        .join('\n');
      out.push(`<div class="table-wrap"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${tb}\n</tbody>\n</table></div>`);
      continue;
    }

    // 인용
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 목록 (중첩은 지원하지 않는다 — 에이전트 글에 안 나온다)
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(`<li>${inline(re.exec(lines[i])[1])}</li>`);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>\n${items.join('\n')}\n</${tag}>`);
      continue;
    }

    // 문단 — 빈 줄이 나올 때까지 이어붙인다
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) &&
      !(lines[i].includes('|') && isDivider(lines[i + 1] || ''))
    ) {
      para.push(lines[i++]);
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    else i++; // 어떤 규칙에도 안 걸리면 무한루프 방지
  }

  return out.join('\n');
}

// ---------- front matter ----------

export function parseFrontMatter(raw) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw.replace(/^﻿/, ''));
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  const fmLines = m[1].split('\n');
  for (let li = 0; li < fmLines.length; li++) {
    const line = fmLines[li];
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();

    // YAML 블록 리스트도 받는다. 에이전트가 인라인 배열 대신 이 형식으로 쓰는 일이 잦고,
    // 못 읽으면 출처 목록이 페이지에서 통째로 사라진다.
    if (!v) {
      const items = [];
      while (li + 1 < fmLines.length && /^\s*-\s+/.test(fmLines[li + 1])) {
        items.push(fmLines[++li].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
      }
      if (items.length) {
        meta[kv[1]] = items;
        continue;
      }
    }
    if (/^\[.*\]$/.test(v)) {
      try {
        v = JSON.parse(v.replace(/'/g, '"'));
      } catch {
        v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      }
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    meta[kv[1]] = v;
  }
  return { meta, body: raw.slice(m[0].length) };
}

// ---------- 페이지 틀 ----------

const CSS = `
:root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --muted:#5c6470; --line:#e2e5ea; --link:#0b5fbf; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8e8e8; --bg:#16181c; --muted:#9aa3ae; --line:#2c3138; --link:#7db3ff; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font: 16px/1.65 -apple-system, "Segoe UI", "Malgun Gothic", Roboto, sans-serif; }
.wrap { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
a { color: var(--link); }
h1 { font-size: 1.8rem; line-height:1.3; margin: 0 0 .35rem; }
h2 { font-size: 1.3rem; margin: 2.2rem 0 .6rem; padding-top:.4rem; border-top:1px solid var(--line); }
h3 { font-size: 1.08rem; margin: 1.5rem 0 .4rem; }
p, li { overflow-wrap: anywhere; }
ul, ol { padding-left: 1.3rem; }
li { margin: .3rem 0; }
code { background: rgba(127,127,127,.16); padding: .1em .35em; border-radius: 3px; font-size: .9em; }
pre { background: rgba(127,127,127,.12); padding: .9rem 1rem; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 1rem 0; padding: .3rem 0 .3rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
.table-wrap { overflow-x: auto; margin: 1rem 0; }
table { border-collapse: collapse; width: 100%; font-size: .94rem; }
th, td { border: 1px solid var(--line); padding: .45rem .6rem; text-align: left; vertical-align: top; }
th { background: rgba(127,127,127,.1); }
.meta { color: var(--muted); font-size: .88rem; margin: 0 0 2rem; }
.sources { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .9rem; color: var(--muted); }
.sources li { word-break: break-all; }
.index-list { list-style: none; padding: 0; }
.index-list li { margin: 0; border-bottom: 1px solid var(--line); }
.index-list a { display: block; padding: .85rem 0; text-decoration: none; font-weight: 600; }
.index-list a:hover { text-decoration: underline; }
.index-list .date { display:block; font-weight: 400; font-size: .82rem; color: var(--muted); }
footer { margin-top: 3rem; font-size: .82rem; color: var(--muted); }
`.trim();

function page({ title, body, canonicalDesc }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${canonicalDesc ? `<meta name="description" content="${esc(canonicalDesc)}">\n` : ''}<style>
${CSS}
</style>
</head>
<body>
<div class="wrap">
${body}
<footer>자동 생성됨 · <a href="../index.html">목록</a></footer>
</div>
</body>
</html>
`;
}

// ---------- 빌드 ----------

function toDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function build({ log = console.log } = {}) {
  let names = [];
  try {
    names = (await fs.readdir(POSTS_DIR)).filter((n) => n.endsWith('.md'));
  } catch {
    log('site/posts 가 없다. 아직 발행할 글이 없음.');
  }

  const posts = [];
  for (const name of names) {
    const slug = name.replace(/\.md$/, '');
    const raw = await fs.readFile(path.join(POSTS_DIR, name), 'utf8');
    const { meta, body } = parseFrontMatter(raw);
    const title = meta.title || slug.replace(/[-_]/g, ' ');
    const sources = Array.isArray(meta.sources) ? meta.sources : meta.sources ? [meta.sources] : [];
    const date = meta.date || '';

    const sourceBlock = sources.length
      ? `<div class="sources"><strong>출처</strong>\n<ul>\n${sources
          .map((u) => {
            const href = safeHref(u);
            return `<li>${href ? `<a href="${esc(href)}" rel="nofollow noopener">${esc(u)}</a>` : esc(u)}</li>`;
          })
          .join('\n')}\n</ul>\n</div>`
      : '';

    const html = page({
      title,
      canonicalDesc: '',
      body: `<h1>${esc(title)}</h1>\n<p class="meta">${esc(date)}</p>\n${renderMarkdown(body)}\n${sourceBlock}`,
    });
    await fs.writeFile(path.join(POSTS_DIR, `${slug}.html`), html, 'utf8');
    posts.push({ slug, title, date, d: toDate(date) });
    log(`  구움: site/posts/${slug}.html`);
  }

  // 짝이 없어진 html은 지운다. 글을 지우거나 이름을 바꿨는데 옛 페이지가 남아 있으면
  // 목록에는 없는데 URL로는 열리는 유령 페이지가 된다.
  // 마지막 글까지 지운 경우에도 돌아야 한다. names 로 가드하면 그때 유령이 남는다.
  const alive = new Set(posts.map((p) => `${p.slug}.html`));
  let existing = [];
  try {
    existing = await fs.readdir(POSTS_DIR);
  } catch {}
  for (const n of existing) {
    if (n.endsWith('.html') && !alive.has(n)) {
      await fs.unlink(path.join(POSTS_DIR, n));
      log(`  치움: site/posts/${n} (원본 .md 없음)`);
    }
  }

  // 최신순. 날짜가 없으면 뒤로.
  posts.sort((a, b) => (b.d?.getTime() ?? -Infinity) - (a.d?.getTime() ?? -Infinity));

  // 소개문은 publisher 에이전트가 쓴다. 없으면 생략.
  let intro = '';
  try {
    const rawIntro = await fs.readFile(path.join(SITE_DIR, '_intro.md'), 'utf8');
    intro = renderMarkdown(parseFrontMatter(rawIntro).body);
  } catch {}

  const list = posts.length
    ? `<ul class="index-list">\n${posts
        .map(
          (p) =>
            `<li><a href="posts/${esc(p.slug)}.html">${esc(p.title)}<span class="date">${esc(p.date)}</span></a></li>`
        )
        .join('\n')}\n</ul>`
    : '<p>아직 발행된 글이 없습니다.</p>';

  const indexHtml = page({
    title: 'Notes',
    body: `<h1>Notes</h1>\n${intro}\n${list}`,
  }).replace('<a href="../index.html">목록</a>', `글 ${posts.length}편`);

  await fs.writeFile(path.join(SITE_DIR, 'index.html'), indexHtml, 'utf8');
  log(`site/index.html 갱신 — 글 ${posts.length}편`);
  return { count: posts.length, posts };
}
