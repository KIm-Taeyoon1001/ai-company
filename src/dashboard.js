// dashboard.js — 파이프라인 관제 화면을 정적 HTML로 굽는다.
//
//   node --env-file=.env src/run.js dashboard
//
// 브라우저에서 Supabase를 직접 조회하지 않는다. 그러려면 service_role 키를 페이지에
// 심어야 하는데, 그 키는 RLS를 통째로 우회한다 — 페이지를 여는 사람 누구나 DB 전체
// 권한을 갖게 된다. 그래서 Node가 읽어서 스냅샷을 굽는다. 최신 상태가 필요하면 다시 굽는다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { select, recall, revenueSummary } from './db.js';
import { probeProvider } from './llm.js';
import * as posts from './posts.js';

const ROOT = process.cwd();
const ROLE_ORDER = ['editor', 'research', 'writer', 'qa'];
const ROLE_LABEL = {
  editor: '주제선정',
  research: '조사',
  writer: '집필',
  qa: '검수',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

// ---------- 수집 ----------

async function repoSlug() {
  try {
    const cfg = await fs.readFile(path.join(ROOT, '.git', 'config'), 'utf8');
    const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m.exec(cfg);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function ciRuns(slug) {
  if (!slug) return { runs: [], note: 'origin 원격이 GitHub가 아니다' };
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/actions/runs?per_page=6`, {
      headers: { 'User-Agent': 'ai-company-dashboard' },
    });
    if (!res.ok) return { runs: [], note: `GitHub ${res.status}` };
    const j = await res.json();
    return {
      runs: (j.workflow_runs || []).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        event: r.event,
        at: r.run_started_at || r.created_at,
        seconds: Math.max(0, Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000)),
        url: r.html_url,
      })),
      note: null,
    };
  } catch (e) {
    return { runs: [], note: `조회 실패: ${e.message}` };
  }
}

/** 실제로 대화가 되는지까지 본다. 1토큰 요청이라 비용은 사실상 없다. */
async function providerHealth() {
  const names = ['groq', 'cerebras', 'gemini', 'openrouter'];
  const out = [];
  for (const name of names) {
    const r = await probeProvider(name).catch((e) => ({ state: 'down', detail: e.message.slice(0, 60) }));
    out.push({ name, ...r });
  }
  return out;
}

export async function gather() {
  // 조회가 실패했는데 0으로 그리면 안 된다. 관제 화면이 "정상"처럼 보이는 게 최악이다.
  const errors = [];
  const guard = (label, p, fallback) =>
    p.catch((e) => {
      errors.push(`${label}: ${e.message.replace(/\s+/g, ' ').slice(0, 120)}`);
      return fallback;
    });

  const [tasks, logs, strategy, revenue, readyPosts, drafts, providers, donePosts] = await Promise.all([
    guard('작업 큐', select('tasks', 'select=id,role,title,status,attempts,priority,payload,result,created_at,updated_at&order=id.desc&limit=80'), null),
    guard('로그', select('logs', 'select=ts,role,level,msg&order=ts.desc&limit=60'), null),
    guard('전략', recall('strategy'), null),
    guard('장부', revenueSummary(30), null),
    posts.list('ready').catch(() => []),
    posts.list('drafts').catch(() => []),
    providerHealth(),
    posts.list('published').catch(() => []),
  ]);
  const slug = await repoSlug();
  const ci = await ciRuns(slug);
  return {
    tasks: tasks || [],
    logs: logs || [],
    strategy,
    revenue: revenue || { total: 0, count: 0, bySource: {} },
    published: readyPosts,
    donePosts,
    drafts,
    providers,
    ci,
    slug,
    errors,
    stale: { tasks: tasks === null, logs: logs === null, revenue: revenue === null },
  };
}

// ---------- 표현 ----------

const STATE = {
  pending: { label: '대기', tone: 'wait' },
  running: { label: '실행중', tone: 'live' },
  done: { label: '완료', tone: 'ok' },
  failed: { label: '실패', tone: 'crit' },
  cancelled: { label: '취소', tone: 'off' },
};

function chip(status) {
  const s = STATE[status] || { label: status, tone: 'off' };
  return `<span class="chip chip--${s.tone}">${esc(s.label)}</span>`;
}

const PROVIDER_STATE = {
  ok: { label: '사용 가능', tone: 'ok' },
  limited: { label: '한도 소진', tone: 'wait' },
  down: { label: '불가', tone: 'crit' },
  off: { label: '미설정', tone: 'off' },
};

function providerChip(state) {
  const s = PROVIDER_STATE[state] || PROVIDER_STATE.off;
  return `<span class="chip chip--${s.tone}">${esc(s.label)}</span>`;
}

function cmd(label, command, note) {
  return `<div class="cmd">
      <div class="cmd__text">
        <span class="cmd__label">${esc(label)}</span>
        ${note ? `<span class="cmd__note">${esc(note)}</span>` : ''}
      </div>
      <code class="cmd__code">${esc(command)}</code>
      <button class="copy" type="button" data-copy="${esc(command)}" aria-label="${esc(label)} 명령 복사">복사</button>
    </div>`;
}

function relay(tasks) {
  return ROLE_ORDER.map((role, i) => {
    const mine = tasks.filter((t) => t.role === role);
    const waiting = mine.filter((t) => t.status === 'pending').length;
    const failed = mine.filter((t) => t.status === 'failed').length;
    const done = mine.filter((t) => t.status === 'done').length;
    const tone = failed ? 'crit' : waiting ? 'wait' : 'idle';
    return `${i ? '<div class="relay__link" aria-hidden="true"></div>' : ''}
      <div class="relay__stage relay__stage--${tone}">
        <span class="relay__role">${esc(ROLE_LABEL[role])}</span>
        <span class="relay__count">${waiting}</span>
        <span class="relay__meta">대기 · 완료 ${done}${failed ? ` · 실패 ${failed}` : ''}</span>
      </div>`;
  }).join('');
}

// ---------- 사용량 ----------

const HOURS = 24;

/** 시간대별 토큰 소모. 기록이 있는 작업만 센다. */
function usageSeries(tasks) {
  const now = Date.now();
  const buckets = Array.from({ length: HOURS }, (_, i) => ({
    at: new Date(now - (HOURS - 1 - i) * 3600_000),
    tokens: 0,
    tasks: 0,
  }));
  for (const t of tasks) {
    const tok = t.result?.tokens;
    if (!tok) continue;
    const when = new Date(t.updated_at || t.created_at).getTime();
    const idx = HOURS - 1 - Math.floor((now - when) / 3600_000);
    if (idx >= 0 && idx < HOURS) {
      buckets[idx].tokens += tok;
      buckets[idx].tasks += 1;
    }
  }
  return buckets;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ko-KR');
}

function compact(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1000) return Math.round(v / 1000) + 'K';
  return String(v);
}

/** 면적 차트. 라이브러리 없이 SVG 로 직접 그린다. */
function areaChart(buckets) {
  const W = 1000;
  const H = 150;
  const padT = 12;
  const padB = 20;
  const max = Math.max(1, ...buckets.map((b) => b.tokens));
  const step = W / Math.max(1, buckets.length - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const pts = buckets.map((b, i) => [i * step, y(b.tokens)]);
  const line = pts.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${yy.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H - padB} L0,${H - padB} Z`;
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="0" y1="${y(max * f).toFixed(1)}" x2="${W}" y2="${y(max * f).toFixed(1)}" class="grid"/>`)
    .join('');
  const labels = buckets
    .map((b, i) =>
      i % 6 === 0
        ? `<text x="${(i * step).toFixed(1)}" y="${H - 5}" class="xlab" text-anchor="${i === 0 ? 'start' : 'middle'}">${String(
            b.at.getHours()
          ).padStart(2, '0')}시</text>`
        : ''
    )
    .join('');
  const last = pts[pts.length - 1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="최근 24시간 시간대별 토큰 소모">
    <defs><linearGradient id="fadeArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#fadeArea)"/>
    <path d="${line}" class="spark"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" class="tip"/>
    <text x="4" y="${(padT + 2).toFixed(1)}" class="ylab">${esc(compact(max))}</text>
    ${labels}
  </svg>`;
}

/** 링 게이지. 남은 비율을 호로 그린다. */
function ring(label, used, limit, note) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const ratio = limit ? Math.min(1, Math.max(0, used / limit)) : 0;
  const tone = ratio >= 0.9 ? 'crit' : ratio >= 0.6 ? 'warn' : 'ok';
  return `<div class="ring">
    <svg viewBox="0 0 76 76" aria-label="${esc(label)} ${Math.round(ratio * 100)} 퍼센트">
      <circle cx="38" cy="38" r="${R}" class="ring__track"/>
      <circle cx="38" cy="38" r="${R}" class="ring__bar ring__bar--${tone}"
        stroke-dasharray="${(C * ratio).toFixed(1)} ${(C * (1 - ratio)).toFixed(1)}"
        transform="rotate(-90 38 38)"/>
      <text x="38" y="42" class="ring__pct">${limit ? Math.round(ratio * 100) + '%' : '—'}</text>
    </svg>
    <span class="ring__label">${esc(label)}</span>
    <span class="ring__note">${esc(note)}</span>
  </div>`;
}

function usageSection(d) {
  const buckets = usageSeries(d.tasks);
  const scored = d.tasks.filter((t) => t.result?.tokens);
  const total = scored.reduce((s, t) => s + t.result.tokens, 0);
  const lastHour = buckets[buckets.length - 1].tokens;
  const peak = Math.max(0, ...buckets.map((b) => b.tokens));
  const avg = scored.length ? Math.round(total / scored.length) : 0;

  const byRole = {};
  for (const t of scored) byRole[t.role] = (byRole[t.role] || 0) + t.result.tokens;
  const roleRows = Object.entries(byRole).sort((a, b) => b[1] - a[1]);
  const roleMax = Math.max(1, ...roleRows.map((r) => r[1]));

  const byModel = {};
  for (const t of scored) for (const [k, v] of Object.entries(t.result.byModel || {})) byModel[k] = (byModel[k] || 0) + v;

  const groq = d.providers.find((p) => p.name === 'groq');
  const q = groq?.quota || {};
  const rings = [
    q.tokensLimit
      ? ring('분당 토큰', q.tokensLimit - (q.tokensRemaining ?? q.tokensLimit), q.tokensLimit,
          `잔량 ${fmt(q.tokensRemaining)} / ${fmt(q.tokensLimit)}`)
      : ring('분당 토큰', 0, 0, '헤더 없음'),
    q.requestsLimit
      ? ring('일일 요청', q.requestsLimit - (q.requestsRemaining ?? q.requestsLimit), q.requestsLimit,
          `잔량 ${fmt(q.requestsRemaining)} / ${fmt(q.requestsLimit)}`)
      : ring('일일 요청', 0, 0, '헤더 없음'),
    // 일일 한도는 모델마다 따로 걸린다. 어느 모델이 얼마를 먹었는지 모르면 비율을 낼 수 없다 —
    // 합계를 한 모델 한도와 비교하면 100% 처럼 보이는 거짓말이 된다.
    Object.keys(byModel).length
      ? ring(
          '일일 토큰',
          total,
          200000 * Object.keys(byModel).length,
          `기록 ${compact(total)} / 모델 ${Object.keys(byModel).length}개×200K`
        )
      : ring('일일 토큰', 0, 0, `기록 ${compact(total)} · 모델별 기록 없음`),
  ].join('');

  return `<section class="usage">
  <div class="usage__head">
    <div>
      <h2>API 소모</h2>
      <div class="usage__hero">
        <span class="usage__big">${esc(compact(lastHour))}</span><span class="usage__unit">토큰 / 최근 1시간</span>
      </div>
      <div class="usage__subs">
        <span><em>24시간 누적</em>${esc(fmt(total))}</span>
        <span><em>작업당 평균</em>${esc(fmt(avg))}</span>
        <span><em>시간당 최대</em>${esc(fmt(peak))}</span>
        <span><em>기록된 작업</em>${esc(scored.length)}건</span>
      </div>
    </div>
    <div class="rings">${rings}</div>
  </div>

  <div class="usage__chart">${areaChart(buckets)}</div>

  <div class="usage__foot">
    <div class="bars">
      <h3>역할별 소모</h3>
      ${roleRows
        .map(
          ([role, v]) => `<div class="bar">
        <span class="bar__k">${esc(ROLE_LABEL[role] || role)}</span>
        <span class="bar__track"><span class="bar__fill" style="width:${((v / roleMax) * 100).toFixed(1)}%"></span></span>
        <span class="bar__v">${esc(fmt(v))}</span>
      </div>`
        )
        .join('')}
    </div>
    <div class="bars">
      <h3>모델별 소모</h3>
      ${
        Object.keys(byModel).length
          ? Object.entries(byModel)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([m, v]) => `<div class="bar">
        <span class="bar__k mono">${esc(m.split('/').slice(-1)[0])}</span>
        <span class="bar__track"><span class="bar__fill" style="width:${(
          (v / Math.max(...Object.values(byModel))) * 100
        ).toFixed(1)}%"></span></span>
        <span class="bar__v">${esc(fmt(v))}</span>
      </div>`
              )
              .join('')
          : '<p class="note" style="margin:0">아직 기록 없음. 이번 변경 이후 실행되는 작업부터 모델별로 쌓인다.</p>'
      }
    </div>
  </div>

  <p class="note usage__caveat">
    우리가 기록한 값이다 — 실패해서 결과를 못 남긴 시도의 토큰은 빠져 있으므로 실제 소모는 이보다 크다.
    Groq 는 사용량 조회 API를 제공하지 않는다. 분당 토큰·일일 요청 게이지만 응답 헤더에서 읽은 실제 잔량이고,
    일일 토큰은 한도에 부딪히기 전까지 조회되지 않아 기록 기준 추정이다.
  </p>
</section>`;
}

function job(opts) {
  const j = opts.job;
  if (!j) return '';
  if (j.running) return `${j.running} 실행 중…`;
  if (j.last) return `마지막: ${j.last.name} ${j.last.ok ? '완료' : '실패 — ' + j.last.detail}`;
  return '대기 중';
}

/** 발행 대기 한 줄. 복사 버튼이 티스토리에 넣을 것을 클립보드에 담는다. */
function readyItem(p, live) {
  const head = `<span class="list__main"><span class="list__title">${esc(p.title)}</span>
      <span class="list__meta">${esc(p.slug)} · ${esc(p.chars)}자 · ${esc(p.tags.join(', ') || '태그 없음')}</span></span>`;
  if (!live) return `<li>${head}${chip('done')}</li>`;
  return `<li class="draft" data-slug="${esc(p.slug)}">
    <div class="act">
      ${head}
    </div>
    <div class="act">
      <button type="button" class="btn btn--ok" data-act="copy" data-slug="${esc(p.slug)}">본문 복사</button>
      <input type="text" class="act__url" placeholder="올린 글 주소 (선택)" aria-label="발행한 글 주소">
      <button type="button" class="btn btn--ghost" data-act="done" data-slug="${esc(p.slug)}">발행 완료</button>
    </div>
  </li>`;
}

/** 검수 대기 초안 한 줄. 서버로 띄운 경우엔 펼쳐서 전문을 읽고 그 자리에서 판정한다. */
function draftItem(p, live) {
  const head = `<span class="list__main"><span class="list__title">${esc(p.title)}</span>
      <span class="list__meta">${esc(p.slug)} · ${esc(p.bytes)}B · 출처 ${esc((p.urls || []).length)}개</span></span>`;
  if (!live) return `<li>${head}${chip('pending')}</li>`;

  const sources = (p.urls || [])
    .map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></li>`)
    .join('');

  return `<li class="draft" data-slug="${esc(p.slug)}">
    <details>
      <summary>${head}${chip('pending')}</summary>
      <div class="draft__body">
        ${sources ? `<div class="draft__src"><strong>출처</strong><ul>${sources}</ul></div>` : '<p class="warnline">출처가 하나도 없다. 통과시키면 안 된다.</p>'}
        <pre class="draft__text">${esc(p.body || '')}</pre>
        <div class="act">
          <button type="button" class="btn btn--ok" data-act="approve" data-slug="${esc(p.slug)}">통과시켜 발행</button>
          <input type="text" class="act__why" placeholder="반려 사유 (필수)" aria-label="반려 사유">
          <button type="button" class="btn btn--no" data-act="reject" data-slug="${esc(p.slug)}">반려</button>
        </div>
      </div>
    </details>
  </li>`;
}

export function render(d, opts = {}) {
  const live = !!opts.interactive;
  const K = opts.token || '';
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const pending = d.tasks.filter((t) => t.status === 'pending');
  const failed = d.tasks.filter((t) => t.status === 'failed');
  const running = d.tasks.filter((t) => t.status === 'running');
  const lastRun = d.ci.runs[0];
  const liveProviders = d.providers.filter((p) => p.state === 'ok');
  const limitedProviders = d.providers.filter((p) => p.state === 'limited');
  const problems = d.logs.filter((l) => l.level === 'error' || l.level === 'warn');

  const tiles = [
    {
      k: '발행 대기',
      v: String(d.published.length),
      u: '편',
      note: d.published.length ? '티스토리에 붙여넣으면 된다' : '검수를 통과한 글이 없다',
      tone: d.published.length ? 'ok' : 'idle',
    },
    { k: '검수 대기', v: String(d.drafts.length), u: '편', note: '읽고 통과·반려', tone: d.drafts.length ? 'wait' : 'idle' },
    { k: '발행 완료', v: String((d.donePosts || []).length), u: '편', note: '올린 뒤 기록한 것', tone: 'idle' },
    { k: '큐 대기', v: String(pending.length), u: '건', note: running.length ? `실행중 ${running.length}건` : '실행중 없음', tone: pending.length ? 'wait' : 'idle' },
    { k: '실패', v: String(failed.length), u: '건', note: failed.length ? '조치 필요' : '없음', tone: failed.length ? 'crit' : 'idle' },
    {
      k: 'LLM 제공자',
      v: `${liveProviders.length}/${d.providers.length}`,
      u: '',
      note:
        (liveProviders.map((p) => p.name).join(', ') || '사용 가능 없음') +
        (limitedProviders.length ? ` · 한도 ${limitedProviders.map((p) => p.name).join(', ')}` : ''),
      tone: liveProviders.length ? 'ok' : limitedProviders.length ? 'wait' : 'crit',
    },
  ];

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-company 관제반</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root {
  --ground: #eef1f0;
  --surface: #ffffff;
  --surface-2: #f6f8f7;
  --ink: #101d1b;
  --muted: #5a6b68;
  --line: #d4dedb;
  --line-strong: #b9c7c3;
  --accent: #0d6b62;
  --accent-soft: #ddeceA;
  --ok: #2f7a4f;
  --warn: #9c6410;
  --crit: #a53333;
  --live: #0d6b62;
  --shadow: 0 1px 2px rgba(16, 29, 27, .07), 0 8px 24px -18px rgba(16, 29, 27, .5);
  --r: 6px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0a1211;
    --surface: #111c1a;
    --surface-2: #16221f;
    --ink: #e2ecea;
    --muted: #8fa3a0;
    --line: #21322e;
    --line-strong: #2e433e;
    --accent: #43b6a8;
    --accent-soft: #102b28;
    --ok: #56c087;
    --warn: #d99a3b;
    --crit: #e57373;
    --live: #43b6a8;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 10px 30px -20px rgba(0, 0, 0, .9);
  }
}
:root[data-theme="dark"] {
  --ground: #0a1211;
  --surface: #111c1a;
  --surface-2: #16221f;
  --ink: #e2ecea;
  --muted: #8fa3a0;
  --line: #21322e;
  --line-strong: #2e433e;
  --accent: #43b6a8;
  --accent-soft: #102b28;
  --ok: #56c087;
  --warn: #d99a3b;
  --crit: #e57373;
  --live: #43b6a8;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 10px 30px -20px rgba(0, 0, 0, .9);
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: "IBM Plex Sans", -apple-system, "Malgun Gothic", sans-serif;
  font-size: 15px;
  line-height: 1.55;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 64px; display: flex; flex-direction: column; gap: 26px; }

h1, h2, h3 { font-family: Archivo, "IBM Plex Sans", sans-serif; margin: 0; text-wrap: balance; }
h1 { font-size: 1.5rem; letter-spacing: -.01em; }
h2 {
  font-size: .74rem; text-transform: uppercase; letter-spacing: .14em;
  color: var(--muted); font-weight: 600;
}
code, .num, .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }

/* ── 머리 ── */
.head { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between;
  padding-bottom: 18px; border-bottom: 2px solid var(--line-strong); }
.head__id { display: flex; align-items: baseline; gap: 10px; }
.head__mark { width: 10px; height: 10px; background: var(--accent); border-radius: 2px; transform: translateY(-2px); }
.head__sub { margin: 4px 0 0; color: var(--muted); font-size: .86rem; }
.head__stamp { text-align: right; font-size: .78rem; color: var(--muted); }
.head__stamp .mono { display: block; color: var(--ink); font-size: .95rem; }

/* ── 요약 타일 ── */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  padding: 13px 14px; display: flex; flex-direction: column; gap: 3px; box-shadow: var(--shadow);
  border-left: 3px solid var(--line-strong); }
.tile--ok { border-left-color: var(--ok); }
.tile--wait { border-left-color: var(--warn); }
.tile--crit { border-left-color: var(--crit); }
.tile__k { font-size: .72rem; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
.tile__v { font-family: Archivo, sans-serif; font-size: 1.75rem; font-weight: 700; line-height: 1.1;
  font-variant-numeric: tabular-nums; }
.tile__v span { font-size: .8rem; font-weight: 600; color: var(--muted); margin-left: 3px; }
.tile__note { font-size: .76rem; color: var(--muted); overflow-wrap: anywhere; }

/* ── 릴레이 ── */
.relay { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding-bottom: 4px; }
.relay__stage { flex: 1 1 0; min-width: 116px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r); padding: 11px 13px; display: flex; flex-direction: column; gap: 1px; }
.relay__stage--wait { border-color: var(--warn); background: var(--surface); }
.relay__stage--crit { border-color: var(--crit); }
.relay__role { font-size: .74rem; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
.relay__count { font-family: Archivo, sans-serif; font-size: 1.4rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.relay__stage--wait .relay__count { color: var(--warn); }
.relay__stage--crit .relay__count { color: var(--crit); }
.relay__meta { font-size: .72rem; color: var(--muted); }
.relay__link { flex: 0 0 26px; align-self: center; height: 1px; background: var(--line-strong); position: relative; }
.relay__link::after { content: ""; position: absolute; right: 0; top: -3px;
  border-left: 6px solid var(--line-strong); border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent; }

/* ── 본문 배치 ── */
.cols { display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(0, 1fr); gap: 22px; align-items: start; }
@media (max-width: 880px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.stack { display: flex; flex-direction: column; gap: 22px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); }
.panel__head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px; border-bottom: 1px solid var(--line); }
.panel__body { padding: 12px 14px; }
.panel__body--flush { padding: 0; }

/* ── 칩 ── */
.chip { display: inline-block; font-size: .7rem; font-weight: 600; letter-spacing: .04em;
  padding: 2px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.chip--ok { color: var(--ok); }
.chip--wait { color: var(--warn); }
.chip--crit { color: var(--crit); }
.chip--live { color: var(--live); }
.chip--off { color: var(--muted); }

/* ── 표 ── */
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .84rem; }
th, td { text-align: left; padding: 8px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 600;
  position: sticky; top: 0; background: var(--surface-2); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: var(--surface-2); }
td.id { font-family: "IBM Plex Mono", monospace; color: var(--muted); font-variant-numeric: tabular-nums; }
td.title { max-width: 380px; }
.rowmeta { color: var(--muted); font-size: .75rem; }

/* ── 필터 ── */
.filters { display: flex; gap: 5px; flex-wrap: wrap; }
.filters button { font: inherit; font-size: .74rem; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--line-strong); background: transparent; color: var(--muted); cursor: pointer; }
.filters button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--surface); }

/* ── 목록 ── */
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.list li { padding: 9px 14px; border-bottom: 1px solid var(--line); display: flex; gap: 10px;
  align-items: baseline; justify-content: space-between; }
.list li:last-child { border-bottom: 0; }
.list__main { min-width: 0; }
.list__title { display: block; font-size: .85rem; overflow-wrap: anywhere; }
.list__meta { font-size: .73rem; color: var(--muted); }
.empty { padding: 14px; color: var(--muted); font-size: .82rem; }

/* ── 로그 ── */
.log { list-style: none; margin: 0; padding: 0; font-family: "IBM Plex Mono", monospace; font-size: .78rem; }
.log li { padding: 6px 14px; border-bottom: 1px solid var(--line); display: grid;
  grid-template-columns: 62px 74px 1fr; gap: 10px; align-items: baseline; }
.log li:last-child { border-bottom: 0; }
.log__t { color: var(--muted); }
.log__lv { font-weight: 500; }
.log__lv--error { color: var(--crit); }
.log__lv--warn { color: var(--warn); }
.log__lv--info { color: var(--muted); }
.log__lv--debug { color: var(--muted); opacity: .75; }
.log__msg { overflow-wrap: anywhere; }

/* ── 운영 명령 ── */
.ops { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
.cmd { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  padding: 11px 12px; display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center;
  box-shadow: var(--shadow); }
.cmd__text { grid-column: 1; display: flex; flex-direction: column; }
.cmd__label { font-size: .84rem; font-weight: 600; }
.cmd__note { font-size: .74rem; color: var(--muted); }
.cmd__code { grid-column: 1 / -1; grid-row: 2; background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 4px; padding: 6px 8px; font-size: .76rem; overflow-x: auto; white-space: nowrap; color: var(--ink); }
.copy { grid-column: 2; grid-row: 1; font: inherit; font-size: .74rem; padding: 4px 11px;
  border: 1px solid var(--accent); background: transparent; color: var(--accent);
  border-radius: 4px; cursor: pointer; }
.copy:hover { background: var(--accent); color: var(--surface); }
.copy[data-done="1"] { background: var(--ok); border-color: var(--ok); color: var(--surface); }

/* ── API 소모 ── */
.usage { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow); overflow: hidden; }
.usage__head { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start;
  justify-content: space-between; padding: 15px 18px 6px; }
.usage__hero { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
.usage__big { font-family: Archivo, sans-serif; font-size: 3rem; font-weight: 700; line-height: 1;
  letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.usage__unit { font-size: .82rem; color: var(--muted); }
.usage__subs { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 10px; font-size: .82rem;
  font-variant-numeric: tabular-nums; }
.usage__subs span { display: flex; flex-direction: column; }
.usage__subs em { font-style: normal; font-size: .7rem; text-transform: uppercase;
  letter-spacing: .1em; color: var(--muted); }

.rings { display: flex; gap: 18px; }
.ring { display: flex; flex-direction: column; align-items: center; width: 92px; text-align: center; }
.ring svg { width: 68px; height: 68px; }
.ring__track { fill: none; stroke: var(--line); stroke-width: 7; }
.ring__bar { fill: none; stroke-width: 7; stroke-linecap: butt; }
.ring__bar--ok { stroke: var(--accent); }
.ring__bar--warn { stroke: var(--warn); }
.ring__bar--crit { stroke: var(--crit); }
.ring__pct { font-family: "IBM Plex Mono", monospace; font-size: 15px; font-weight: 500;
  fill: var(--ink); text-anchor: middle; font-variant-numeric: tabular-nums; }
.ring__label { font-size: .74rem; margin-top: 3px; }
.ring__note { font-size: .68rem; color: var(--muted); line-height: 1.3; }

.usage__chart { padding: 0 4px; }
.chart { display: block; width: 100%; height: 150px; }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .spark { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.chart .tip { fill: var(--accent); }
.chart .xlab, .chart .ylab { font-family: "IBM Plex Mono", monospace; font-size: 11px; fill: var(--muted); }

.usage__foot { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px;
  padding: 12px 18px 4px; border-top: 1px solid var(--line); }
.bars h3 { font-size: .7rem; text-transform: uppercase; letter-spacing: .12em; color: var(--muted);
  font-weight: 600; margin-bottom: 7px; }
.bar { display: grid; grid-template-columns: 62px 1fr 62px; gap: 9px; align-items: center;
  font-size: .78rem; margin-bottom: 5px; }
.bar__k { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar__track { height: 7px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 2px; overflow: hidden; }
.bar__fill { display: block; height: 100%; background: var(--accent); }
.bar__v { text-align: right; font-family: "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums; }
.usage__caveat { padding: 8px 18px 14px; margin: 0; }

/* ── 검수 조작 ── */
.draft { flex-direction: column; align-items: stretch; }
.draft details summary { display: flex; gap: 10px; align-items: baseline; justify-content: space-between;
  cursor: pointer; list-style: none; }
.draft details summary::-webkit-details-marker { display: none; }
.draft details summary:hover .list__title { color: var(--accent); }
.draft__body { padding-top: 10px; display: flex; flex-direction: column; gap: 9px; }
.draft__src { font-size: .74rem; color: var(--muted); }
.draft__src strong { font-size: .68rem; text-transform: uppercase; letter-spacing: .1em; }
.draft__src ul { margin: 3px 0 0; padding-left: 16px; }
.draft__src li { word-break: break-all; margin: 1px 0; }
.draft__text { max-height: 300px; overflow: auto; background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 4px; padding: 9px 11px; font-family: "IBM Plex Mono", monospace; font-size: .74rem;
  line-height: 1.6; white-space: pre-wrap; margin: 0; }
.warnline { margin: 0; font-size: .78rem; color: var(--crit); }
.act { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.act__url { flex: 1 1 170px; min-width: 0; font: inherit; font-size: .76rem; padding: 5px 8px;
  border: 1px solid var(--line-strong); border-radius: 4px; background: var(--surface); color: var(--ink); }
.copybox { width: 100%; height: 160px; margin-top: 8px; font-family: "IBM Plex Mono", monospace;
  font-size: .72rem; border: 1px solid var(--line-strong); border-radius: 4px; padding: 8px;
  background: var(--surface-2); color: var(--ink); }
.act__why { flex: 1 1 150px; min-width: 0; font: inherit; font-size: .76rem; padding: 5px 8px;
  border: 1px solid var(--line-strong); border-radius: 4px; background: var(--surface); color: var(--ink); }
.btn { font: inherit; font-size: .76rem; font-weight: 600; padding: 5px 12px; border-radius: 4px;
  cursor: pointer; border: 1px solid transparent; }
.btn--ok { background: var(--accent); border-color: var(--accent); color: var(--surface); }
.btn--no { background: transparent; border-color: var(--crit); color: var(--crit); }
.btn--ghost { background: transparent; border-color: var(--line-strong); color: var(--ink); }
.btn:disabled { opacity: .5; cursor: default; }
.actionbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.actionbar__status { font-size: .78rem; color: var(--muted); }
.toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
  background: var(--ink); color: var(--ground); padding: 9px 16px; border-radius: 5px;
  font-size: .82rem; box-shadow: var(--shadow); max-width: 80vw; }
.toast--bad { background: var(--crit); color: #fff; }

.alarm { background: var(--surface); border: 1px solid var(--crit); border-left: 3px solid var(--crit);
  border-radius: var(--r); padding: 11px 14px; font-size: .82rem; }
.alarm strong { color: var(--crit); }
.alarm ul { margin: 6px 0 0; padding-left: 18px; font-family: "IBM Plex Mono", monospace; font-size: .74rem; }

a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
footer { color: var(--muted); font-size: .78rem; border-top: 1px solid var(--line); padding-top: 14px; }
.note { font-size: .78rem; color: var(--muted); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
</head>
<body>
<div class="wrap">

<header class="head">
  <div>
    <div class="head__id"><span class="head__mark"></span><h1>파이프라인 관제반</h1></div>
    <p class="head__sub">${esc(d.slug || 'ai-company')} · CEO → 조사 → 집필 → 검수 → 배포 릴레이</p>
  </div>
  <div class="head__stamp">
    스냅샷 시각
    <span class="mono">${esc(stamp)}</span>
  </div>
</header>

${
  live
    ? `<section class="actionbar">
  <button type="button" class="btn btn--ghost" data-run="">큐 처리</button>
  <button type="button" class="btn btn--ghost" data-run="qa">검수만 실행</button>
  <button type="button" class="btn btn--ghost" data-run="producer">집필만 실행</button>
  <button type="button" class="btn btn--ghost" data-build>사이트 다시 굽기</button>
  <button type="button" class="btn btn--ghost" data-reload>새로고침</button>
  <span class="actionbar__status" id="jobstatus">${esc(job(opts))}</span>
</section>`
    : ''
}

${
  d.errors && d.errors.length
    ? `<section class="alarm">
  <strong>조회 실패</strong> — 아래 값은 실제 상태가 아니다. 0으로 보이는 것은 "없음"이 아니라 "모름"이다.
  <ul>${d.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
</section>`
    : ''
}

<section class="tiles">
  ${tiles
    .map(
      (t) => `<div class="tile tile--${t.tone}">
    <span class="tile__k">${esc(t.k)}</span>
    <span class="tile__v">${esc(t.v)}${t.u ? `<span>${esc(t.u)}</span>` : ''}</span>
    <span class="tile__note">${esc(t.note)}</span>
  </div>`
    )
    .join('\n  ')}
</section>

<section>
  <h2 style="margin-bottom:9px">단계별 적체</h2>
  <div class="relay">${relay(d.tasks)}</div>
</section>

${usageSection(d)}

<div class="cols">
  <div class="stack">

    <section class="panel">
      <div class="panel__head">
        <h2>작업 큐</h2>
        <div class="filters">
          <button type="button" data-filter="all" aria-pressed="true">전체</button>
          <button type="button" data-filter="pending" aria-pressed="false">대기</button>
          <button type="button" data-filter="failed" aria-pressed="false">실패</button>
          <button type="button" data-filter="done" aria-pressed="false">완료</button>
        </div>
      </div>
      <div class="panel__body panel__body--flush scroll">
        ${
          d.tasks.length
            ? `<table>
          <thead><tr><th>#</th><th>단계</th><th>작업</th><th>상태</th><th>갱신</th></tr></thead>
          <tbody>
            ${d.tasks
              .map((t) => {
                const round = t.payload?.round;
                return `<tr data-status="${esc(t.status)}">
              <td class="id">${esc(t.id)}</td>
              <td>${esc(ROLE_LABEL[t.role] || t.role)}</td>
              <td class="title">${esc(t.title)}
                <div class="rowmeta">시도 ${esc(t.attempts)}${round ? ` · 왕복 ${esc(round)}` : ''}${
                  t.result?.error ? ` · ${esc(String(t.result.error).slice(0, 70))}` : ''
                }</div>
              </td>
              <td>${chip(t.status)}</td>
              <td class="rowmeta">${esc(ago(t.updated_at || t.created_at))}</td>
            </tr>`;
              })
              .join('\n            ')}
          </tbody>
        </table>`
            : '<p class="empty">작업이 없다.</p>'
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel__head">
        <h2>최근 이벤트</h2>
        <span class="note">경고·실패 ${problems.length}건</span>
      </div>
      <div class="panel__body panel__body--flush scroll">
        ${
          d.logs.length
            ? `<ul class="log">
          ${d.logs
            .slice(0, 28)
            .map(
              (l) => `<li>
            <span class="log__t">${esc(String(l.ts).slice(11, 16))}</span>
            <span class="log__lv log__lv--${esc(l.level)}">${esc(l.level)}</span>
            <span class="log__msg">${esc(String(l.msg).slice(0, 220))}</span>
          </li>`
            )
            .join('\n          ')}
        </ul>`
            : '<p class="empty">로그가 없다.</p>'
        }
      </div>
    </section>

  </div>

  <div class="stack">

    <section class="panel">
      <div class="panel__head"><h2>현재 전략</h2></div>
      <div class="panel__body">
        ${
          d.strategy
            ? `<p style="margin:0 0 8px"><strong>${esc(d.strategy.goal || '목표 없음')}</strong></p>
        <p class="note" style="margin:0 0 6px">지표 · ${esc(d.strategy.metric || '—')}</p>
        <p class="note" style="margin:0">가설 · ${esc(d.strategy.hypothesis || '—')}</p>`
            : '<p class="empty" style="padding:0">저장된 전략이 없다. <code>kick ceo</code> 로 세운다.</p>'
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><h2>발행 대기</h2><span class="note">${d.published.length}편</span></div>
      <div class="panel__body panel__body--flush">
        ${
          d.published.length
            ? `<ul class="list">${d.published.map((p) => readyItem(p, live)).join('')}</ul>`
            : '<p class="empty">검수를 통과한 글이 없다.</p>'
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><h2>검수 대기</h2><span class="note">${d.drafts.length}편</span></div>
      <div class="panel__body panel__body--flush">
        ${
          d.drafts.length
            ? `<ul class="list">${d.drafts.map((p) => draftItem(p, live)).join('')}</ul>`
            : '<p class="empty">초안 없음. 검수를 통과해야 발행된다.</p>'
        }
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><h2>LLM 제공자</h2></div>
      <div class="panel__body panel__body--flush">
        <ul class="list">
          ${d.providers
            .map(
              (p) => `<li><span class="list__main"><span class="list__title mono">${esc(p.name)}</span>
        <span class="list__meta">${esc(p.detail)}</span></span>${providerChip(p.state)}</li>`
            )
            .join('')}
        </ul>
        <p class="note" style="padding:10px 14px;margin:0;border-top:1px solid var(--line)">
          1토큰 요청을 실제로 보내 확인한 결과다. 모델 목록이 보여도 대화는 막혀 있는 경우가 있다.
          일일 한도는 모델마다 따로 걸리며, 막히면 라우터가 같은 키의 다른 모델로 넘어간다.
        </p>
      </div>
    </section>

    <section class="panel">
      <div class="panel__head"><h2>CI 실행</h2></div>
      <div class="panel__body panel__body--flush">
        ${
          d.ci.runs.length
            ? `<ul class="list">${d.ci.runs
                .map(
                  (r) => `<li><span class="list__main"><span class="list__title"><a href="${esc(
                    r.url
                  )}" target="_blank" rel="noopener">${esc(r.name)}</a></span>
          <span class="list__meta">${esc(r.event)} · ${esc(r.seconds)}초 · ${esc(ago(r.at))}</span></span>${chip(
                    r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'done' : 'failed'
                  )}</li>`
                )
                .join('')}</ul>`
            : `<p class="empty">${esc(d.ci.note || '실행 기록 없음')}</p>`
        }
      </div>
    </section>

  </div>
</div>

<section${live ? ' hidden' : ''}>
  <h2 style="margin-bottom:9px">운영 명령</h2>
  <p class="note" style="margin:0 0 10px">
    이 페이지는 스냅샷이라 여기서 직접 실행하지 않는다. 명령을 복사해 저장소 폴더에서 실행한다.
  </p>
  <div class="ops">
    ${cmd('이 화면 새로 굽기', 'node --env-file=.env src/run.js dashboard', '현재 상태로 다시 생성한다')}
    ${cmd('큐 처리', 'node --env-file=.env src/run.js worker', '우선순위 순으로 처리한다')}
    ${cmd('한 단계만 처리', 'node --env-file=.env src/run.js worker qa', '역할을 바꿔 단계별로 검증한다')}
    ${cmd('사이트 다시 굽기', 'node src/run.js build', 'md → html, 목록 갱신, 유령 페이지 정리')}
    ${cmd('키 점검', 'node --env-file=.env src/run.js doctor', '어느 제공자가 살아있는지 확인한다')}
    ${cmd('멈춘 작업 되살리기', 'node --env-file=.env src/run.js reset', 'running·failed 를 pending 으로 되돌린다')}
    ${cmd('전략 다시 세우기', 'node --env-file=.env src/run.js kick ceo', '큐에 새 조사 작업이 들어간다')}
    ${
      d.slug
        ? cmd('CI 수동 실행', `https://github.com/${d.slug}/actions/workflows/company.yml`, '주소를 열어 Run workflow 를 누른다')
        : ''
    }
  </div>
</section>

<footer>
  브라우저에서 DB를 직접 읽지 않는다 — 그러려면 RLS를 우회하는 service_role 키를 이 파일에 심어야 한다.
  Node 가 읽어서 구운 스냅샷이므로, 최신 상태가 필요하면 다시 굽는다.
</footer>

</div>
${
  live
    ? `<script>
(function () {
  var K = ${JSON.stringify(K)};
  function toast(msg, bad) {
    var el = document.createElement('div');
    el.className = 'toast' + (bad ? ' toast--bad' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, bad ? 6000 : 2600);
  }
  function post(path, payload, btn) {
    if (btn) btn.disabled = true;
    return fetch(path + '?k=' + K, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok) { toast(o.j.error || '실패', true); if (btn) btn.disabled = false; return null; }
        toast(o.j.message || '완료');
        return o.j;
      })
      .catch(function (e) { toast('요청 실패: ' + e.message, true); if (btn) btn.disabled = false; return null; });
  }
  function reload() { setTimeout(function () { location.reload(); }, 700); }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;

    if (b.hasAttribute('data-reload')) return location.reload();
    if (b.hasAttribute('data-build')) return post('/build', {}, b).then(function (r) { if (r) reload(); });
    if (b.hasAttribute('data-run')) {
      return post('/run', { role: b.getAttribute('data-run') || null }, b).then(function (r) {
        b.disabled = false;
        if (r) poll();
      });
    }

    var act = b.getAttribute('data-act');

    if (act === 'copy') {
      return post('/copy', { slug: b.getAttribute('data-slug'), stage: 'ready' }, b).then(function (r) {
        b.disabled = false;
        if (!r) return;
        var payload = '제목: ' + r.title + String.fromCharCode(10) + '태그: ' + r.tags +
          String.fromCharCode(10) + String.fromCharCode(10) + r.html;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(payload).then(
            function () { toast('복사됨 — 티스토리 에디터를 HTML 모드로 바꾸고 붙여넣어라'); },
            function () { showBox(b, payload); }
          );
        } else { showBox(b, payload); }
      });
    }

    if (act === 'done') {
      var urlBox = b.parentNode.querySelector('.act__url');
      return post('/done', { slug: b.getAttribute('data-slug'), url: (urlBox && urlBox.value || '').trim() }, b)
        .then(function (r) { if (r) reload(); });
    }

    if (act === 'approve') {
      if (!confirm('이 초안을 발행한다. 되돌리려면 파일을 직접 옮겨야 한다. 계속할까?')) return;
      return post('/approve', { slug: b.getAttribute('data-slug') }, b).then(function (r) { if (r) reload(); });
    }
    if (act === 'reject') {
      var box = b.parentNode.querySelector('.act__why');
      var why = (box && box.value || '').trim();
      if (!why) { toast('반려 사유를 적어라. 사유가 없으면 producer 가 고칠 수 없다.', true); if (box) box.focus(); return; }
      return post('/reject', { slug: b.getAttribute('data-slug'), why: why }, b).then(function (r) { if (r) reload(); });
    }
  });

  // 클립보드 권한이 없는 환경에서는 직접 고를 수 있게 펼쳐 준다
  function showBox(btn, text) {
    var box = document.createElement('textarea');
    box.className = 'copybox';
    box.value = text;
    box.readOnly = true;
    btn.parentNode.parentNode.appendChild(box);
    box.focus();
    box.select();
    toast('클립보드가 막혀 있다. 아래 상자에서 직접 복사해라.', true);
  }

  var timer = null;
  function poll() {
    clearInterval(timer);
    timer = setInterval(function () {
      fetch('/job?k=' + K).then(function (r) { return r.json(); }).then(function (j) {
        var el = document.getElementById('jobstatus');
        if (!el) return;
        if (j.running) { el.textContent = j.running + ' 실행 중…'; return; }
        clearInterval(timer);
        el.textContent = j.last ? ('마지막: ' + j.last.name + ' ' + (j.last.ok ? '완료' : '실패 — ' + j.last.detail)) : '대기 중';
        reload();
      }).catch(function () { clearInterval(timer); });
    }, 3000);
  }
  if (document.getElementById('jobstatus') && /실행 중/.test(document.getElementById('jobstatus').textContent)) poll();
})();
<\/script>`
    : ''
}
<script>
(function () {
  var buttons = document.querySelectorAll('.filters button');
  var rows = document.querySelectorAll('tbody tr[data-status]');
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      var want = b.getAttribute('data-filter');
      buttons.forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      rows.forEach(function (r) {
        r.style.display = (want === 'all' || r.getAttribute('data-status') === want) ? '' : 'none';
      });
    });
  });

  document.querySelectorAll('.copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy');
      var done = function () {
        var old = b.textContent;
        b.textContent = '복사됨';
        b.setAttribute('data-done', '1');
        setTimeout(function () { b.textContent = old; b.removeAttribute('data-done'); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        // 클립보드가 막힌 환경에서는 명령을 선택해 준다. 직접 복사하면 된다.
        var code = b.parentNode.querySelector('.cmd__code');
        if (!code) return;
        var range = document.createRange();
        range.selectNodeContents(code);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        b.textContent = '선택됨';
        setTimeout(function () { b.textContent = '복사'; }, 1600);
      }
    });
  });
})();
</script>
</body>
</html>
`;
}

export async function dashboard({ log = console.log } = {}) {
  const data = await gather();
  const html = render(data);
  const out = path.join(ROOT, 'dashboard.html');
  await fs.writeFile(out, html, 'utf8');
  log(
    `dashboard.html 생성 — 작업 ${data.tasks.length}건, 발행 ${data.published.length}편, 초안 ${data.drafts.length}편, 제공자 ${
      data.providers.filter((p) => p.state === 'ok').length
    }/${data.providers.length} 사용 가능`
  );
  return { out, data };
}
