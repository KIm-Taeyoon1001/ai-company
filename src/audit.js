// audit.js — 이미 올라간 글을 밖에서 전부 읽어 품질 문제를 찾는다. 의존성 0.
//
//   node src/run.js audit
//
// 새 글을 쓰기 전에 이걸 먼저 본다. 오타와 깨진 문장이 박힌 글이 쌓여 있으면
// 블로그 전체 평가가 내려가고, 새로 잘 쓴 글도 같이 묻힌다.

import fs from 'node:fs/promises';

const UA = 'Mozilla/5.0 (compatible; blog-audit/1.0; +self-check)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 본문 컨테이너를 여는 태그부터 짝이 맞는 닫는 태그까지 깊이를 세며 잘라낸다.
 * 정규식으로 `<div ...>[\s\S]*?</div>` 를 쓰면 중첩된 첫 </div> 에서 멈춘다.
 * 실제로 그 버그로 본문을 3글자만 가져왔고 43편 전부 "얇음"으로 오판했다.
 */
function extractArticle(html) {
  const open = /<div[^>]+class="[^"]*(?:tt_article_useless_p_margin|entry-content|article-view|contents_style|tt_article)[^"]*"[^>]*>/i.exec(
    html
  );
  if (!open) return null;
  let i = open.index + open[0].length;
  let depth = 1;
  const tag = /<(\/?)div[^>]*>/gi;
  tag.lastIndex = i;
  let m;
  while ((m = tag.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index, m.index + m[0].length);
  }
  return html.slice(open.index);
}

/** 엔티티를 한 번 푼다. 푼 뒤에도 엔티티가 남아 있으면 이중 인코딩이다. */
function decodeOnce(t) {
  return String(t)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&');
}

function strip(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 실제로 발행된 글에서 찾는 문제들.
 * 오탐을 줄이려고 "명백히 잘못된 것"만 본다 — 문장이 어색한지는 판단하지 않는다.
 */
const CHECKS = [
  {
    id: 'double_encoded',
    label: 'HTML 엔티티 이중 인코딩',
    why: '독자 눈에 &ndash; 같은 문자가 글자 그대로 보인다.',
    // 한 번 푼 뒤에도 엔티티가 남아 있을 때만 문제다. <title>의 &ndash; 는 정상 인코딩이고
    // 브라우저는 – 로 그린다. 이걸 문제로 세면 멀쩡한 글이 전부 걸린다(실제로 43편 전부 걸렸다).
    test: (t, title) => /&(amp|ndash|middot|quot|hellip|nbsp);/i.test(decodeOnce(title) + ' ' + decodeOnce(t.slice(0, 4000))),
  },
  {
    id: 'thin',
    label: '내용이 얇음',
    why: '본문 900자 미만. 검색엔진이 가치 없는 페이지로 본다.',
    test: (t) => t.length < 900,
  },
  {
    id: 'no_heading',
    label: '소제목 없음',
    why: '긴 글에 h2/h3 가 하나도 없으면 구조가 없는 글로 읽힌다.',
    test: (t, title, html) => t.length > 1200 && !/<h[23][\s>]/i.test(html),
  },
  {
    id: 'no_desc',
    label: '설명 메타 없음',
    why: '검색 결과에 표시될 요약이 없다.',
    test: (t, title, html) => !/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html),
  },
  {
    id: 'listicle_flood',
    label: 'BEST/TOP 나열형',
    why: '같은 형식이 반복되면 양산형으로 보인다. 순위 근거가 없으면 특히 그렇다.',
    test: (t, title) => /\b(BEST|TOP)\s*\d+/i.test(title),
  },
];

/** 한글 문장에 섞인 깨진 어절. 확실한 것만 잡는다. */
const GARBLED = [
  // 실제로 발행된 제목에서 확인한 것만 넣는다.
  // '핫플레이' 를 넣었더니 정상 단어 '핫플레이스' 를 43편 전부에서 잡았다.
  '즉기는', '얼어 식당', '실소 트렌딩', '쿠울하게', '맜집', '맏집',
];

export async function audit({ host = 'https://jusdv.tistory.com', log = console.log } = {}) {
  log('사이트맵 읽는 중...');
  const xml = await (await fetch(`${host}/sitemap.xml`, { headers: { 'User-Agent': UA } })).text();
  const all = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

  // 모바일 중복(/m/)과 목록 페이지를 뺀다
  const urls = all.filter((u) => u.includes('/entry/') && !u.includes('/m/entry/'));
  log(`글 ${urls.length}편 발견 (사이트맵 총 ${all.length}개 URL, 모바일 중복·목록 제외)`);

  const rows = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      const html = await res.text();
      const title = (/<title>([^<]*)<\/title>/.exec(html)?.[1] || '').trim();
      // 본문만 추리기 — 티스토리 스킨마다 다르므로 실패하면 전체에서 뺀다
      const area = extractArticle(html);
      const text = strip(area || html);
      const problems = [];
      for (const c of CHECKS) if (c.test(text, title, html)) problems.push(c.id);
      const garbled = GARBLED.filter((g) => (title + ' ' + text).includes(g));
      if (garbled.length) problems.push('garbled');

      rows.push({ url, title, status: res.status, chars: text.length, problems, garbled });
      log(`  [${i + 1}/${urls.length}] ${problems.length ? '문제 ' + problems.length : 'OK'}  ${title.slice(0, 46)}`);
    } catch (e) {
      rows.push({ url, title: '', status: 0, chars: 0, problems: ['fetch_failed'], garbled: [], error: e.message });
      log(`  [${i + 1}/${urls.length}] 읽기 실패  ${url}`);
    }
    await sleep(400); // 자기 블로그라도 몰아치지 않는다
  }

  // 집계
  const byProblem = {};
  for (const r of rows) for (const p of r.problems) byProblem[p] = (byProblem[p] || 0) + 1;

  const report = {
    checked_at: new Date().toISOString(),
    host,
    posts: rows.length,
    clean: rows.filter((r) => !r.problems.length).length,
    by_problem: byProblem,
    checks: CHECKS.map((c) => ({ id: c.id, label: c.label, why: c.why })),
    rows: rows.sort((a, b) => b.problems.length - a.problems.length),
  };
  await fs.writeFile('audit.json', JSON.stringify(report, null, 2), 'utf8');

  log('');
  log(`검사 완료 — ${rows.length}편 중 문제 없는 글 ${report.clean}편`);
  for (const c of CHECKS) {
    const n = byProblem[c.id] || 0;
    if (n) log(`  ${String(n).padStart(3)}편  ${c.label}`);
  }
  if (byProblem.garbled) log(`  ${String(byProblem.garbled).padStart(3)}편  깨진 어절`);
  log('');
  log('자세한 내용은 audit.json');
  return report;
}
