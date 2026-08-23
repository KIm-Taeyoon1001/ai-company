// render.js — 마크다운을 티스토리 에디터에 붙여넣을 HTML로 바꿈다. 의존성 0.
//
// 에이전트가 쓴 텍스트는 신뢰하지 않는다. 먼저 전부 이스케이프한 뒤 아는 문법만 태그로 되살린다.
//
// 표에는 인라인 스타일을 넣는다. 티스토리 스킨마다 표 테두리가 없는 경우가 많아
// 스킨에 기대면 표가 그냥 글자 뭉치로 보인다.



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

const NL = String.fromCharCode(10);

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
      // 글 제목은 티스토리가 따로 붙인다. 본문의 ## 는 h2 그대로 둔다.
      const lv = Math.min(Math.max(h[1].length, 2), 6);
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
      const cell = 'border:1px solid #ddd;padding:8px 10px;text-align:left;vertical-align:top';
      const th = head.map((c) => `<th style="${cell};background:#f5f5f5">${inline(c)}</th>`).join('');
      const tb = rows
        .map((r) => {
          const cells = [];
          for (let c = 0; c < head.length; c++) cells.push(`<td style="${cell}">${inline(r[c] ?? '')}</td>`);
          return `<tr>${cells.join('')}</tr>`;
        })
        .join('\n');
      out.push(`<table style="border-collapse:collapse;width:100%;margin:1em 0">` + NL +
        `<thead><tr>${th}</tr></thead>` + NL + `<tbody>` + NL + tb + NL + `</tbody>` + NL + `</table>`);
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

