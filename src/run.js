#!/usr/bin/env node
// run.js — 진입점. GitHub Actions cron이 이 파일을 역할별로 호출한다.
//   node src/run.js worker          # 큐에 쌓인 작업 처리
//   node src/run.js worker qa       # 그 역할의 작업만 처리
//   node src/run.js kick editor     # 편집장을 깨워 이번 주 주제를 고르게 한다
//   node src/run.js serve           # 관제 화면 (검수·복사까지 여기서)
//   node src/run.js audit          # 이미 올라간 글 전체 품질 검사
//   node src/run.js ready           # 발행 대기 목록
//   node src/run.js copy <slug>     # 티스토리에 붙여넣을 제목·태그·본문 출력
//   node src/run.js done <slug> [url]  # 발행 완료 기록

import { ROLES } from './roles/index.js';
import { listModels, chat } from './llm.js';
import { runAgent } from './agent.js';
import { claimTasks, finishTask, enqueue, log, revenueSummary, recall, update } from './db.js';
import { toolImpl, setCurrentTask } from './tools.js';
import * as posts from './posts.js';
import { audit } from './audit.js';
import { forTistory } from './posts.js';
import { dashboard } from './dashboard.js';
import { serve } from './serve.js';

const BATCH = Number(process.env.BATCH_SIZE || 3);

const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 4);

// ---------- 사람이 하는 검수와 발행 ----------
// 최종 결정권은 사람에게 있다. 그리고 티스토리 발행 자체도 사람이 한다.

async function drafts() {
  const rows = await posts.list('drafts');
  if (!rows.length) return console.log('검수 대기 초안이 없다.');
  console.log(`검수 대기 ${rows.length}편`);
  console.log('');
  for (const p of rows) {
    console.log(`  ${p.slug}`);
    console.log(`    ${p.title}`);
    console.log(`    ${p.chars}자 · 축 ${p.pillar || '-'} · 노리는 검색어 "${p.keyword || '-'}" · 출처 ${p.sources.length}개`);
    for (const u of p.sources) console.log(`      ${u}`);
    console.log('');
  }
  console.log('전문:  node src/run.js review <slug>');
  console.log('통과:  node --env-file=.env src/run.js approve <slug>');
  console.log('반려:  node --env-file=.env src/run.js reject <slug> "사유"');
}

async function ready() {
  const rows = await posts.list('ready');
  if (!rows.length) return console.log('발행 대기 글이 없다.');
  console.log(`발행 대기 ${rows.length}편 — 티스토리에 붙여넣으면 된다`);
  console.log('');
  for (const p of rows) console.log(`  ${p.slug}  ${p.title}  (${p.chars}자)`);
  console.log('');
  console.log('붙여넣을 내용:  node src/run.js copy <slug>');
  console.log('올린 뒤 기록:   node --env-file=.env src/run.js done <slug> <글주소>');
}

async function review(slug) {
  if (!slug) throw new Error('슬러그를 지정해라. 목록은 drafts 로 본다.');
  const p = await posts.read(slug, 'drafts');
  console.log(p.body);
}

/** 티스토리 에디터에 그대로 넣을 것들. HTML 모드로 붙여넣는다. */
async function copy(slug) {
  if (!slug) throw new Error('슬러그를 지정해라. 목록은 ready 로 본다.');
  const p = await posts.read(slug, 'ready');
  const t = forTistory(p);
  console.log('=== 제목 ===');
  console.log(t.title);
  console.log('');
  console.log('=== 태그 ===');
  console.log(t.tags);
  console.log('');
  console.log('=== 본문 (티스토리 에디터를 HTML 모드로 바꾸고 붙여넣기) ===');
  console.log(t.html);
}

async function approve(slug) {
  if (!slug) throw new Error('슬러그를 지정해라.');
  const r = await posts.approve(slug);
  console.log(`발행 대기로 이동 — ${r.slug}`);
  await log('human', 'info', `사람이 직접 통과시킴: ${slug}`);
}

async function reject(slug, why) {
  if (!slug) throw new Error('슬러그를 지정해라.');
  if (!why) throw new Error('반려 사유를 적어라. 사유 없는 반려는 writer 가 고칠 수 없다.');
  const p = await posts.read(slug, 'drafts').catch(() => null);
  const t = await enqueue({
    role: 'writer',
    title: `사람 검수 반려: ${slug}`,
    priority: 2,
    payload: {
      slug,
      keyword: p?.keyword || '',
      sources: p?.sources || [],
      issues: [{ problem: why, source: '사람 검수' }],
      instructions: why,
      round: 1,
    },
  });
  console.log(`반려 — writer 에 수정 작업 #${t?.id} 등록`);
  await log('human', 'info', `사람이 직접 반려: ${slug} — ${why}`);
}

async function done(slug, url) {
  if (!slug) throw new Error('슬러그를 지정해라.');
  const r = await posts.markPublished(slug, url || '');
  console.log(`발행 완료로 기록 — ${r.slug}${url ? ' · ' + url : ''}`);
  await log('human', 'info', `발행 완료: ${slug} ${url || ''}`);
}

async function handleTask(task) {
  const role = ROLES[task.role];
  if (!role) {
    await finishTask(task.id, { status: 'failed', result: { error: `없는 역할: ${task.role}` } });
    return;
  }

  // 반려 → 수정 → 재검수가 끝없이 도는 걸 끊는다. 한도는 집필 쪽에만 건다 —
  // 검수까지 막으면 방금 고친 초안이 판정도 못 받고 죽는다.
  const round = Number(task.payload?.round || 0);
  if (task.role === 'writer' && round >= MAX_ROUNDS) {
    await log(task.role, 'warn', `작업 ${task.id}: ${round}번째 왕복 — 이 주제는 접는다`);
    await finishTask(task.id, {
      status: 'failed',
      result: { error: `왕복 한도(${MAX_ROUNDS}) 초과. 자료가 주장을 뒷받침하지 못하는 주제로 보인다.` },
    });
    await toolImpl.notify({
      text: `"${task.title}" 를 ${round}회 왕복 끝에 접었다.`,
      title: 'BLACK OUT — 주제 폐기',
    });
    return;
  }
  setCurrentTask(task);

  const prompt = [
    `작업: ${task.title}`,
    `payload: ${JSON.stringify(task.payload || {})}`,
    `task_id: ${task.id}`,
  ].join(String.fromCharCode(10));

  try {
    const r = await runAgent({
      role: task.role,
      system: role.system,
      task: prompt,
      tools: role.tools,
      maxSteps: role.maxSteps,
      handoff: role.handoff,
    });
    const called = new Set(r.trace.filter((t) => !t.result?.error).map((t) => t.tool));
    const missing = (role.requires || []).filter((t) => !called.has(t));
    const ok = !r.truncated && missing.length === 0;
    if (missing.length) {
      await log(task.role, 'warn', `필수 작업 누락: ${missing.join(', ')} — 실패 처리하고 재시도한다`);
    }
    await finishTask(task.id, {
      status: ok ? 'done' : 'pending',
      result: { output: r.output, steps: r.steps, tokens: r.tokens, byModel: r.byModel, missing },
    });
  } catch (e) {
    await log(task.role, 'error', `작업 ${task.id} 실패: ${e.message}`);
    await finishTask(task.id, { status: 'pending', result: { error: e.message } });
  } finally {
    setCurrentTask(null);
  }
}

export async function worker(roleFilter) {
  // 역할을 주면 그 역할의 작업만 집는다. 특정 단계만 검증할 때 쓴다.
  const tasks = await claimTasks(roleFilter || null, BATCH);
  if (!tasks.length) {
    console.log(roleFilter ? `${roleFilter} 작업 없음` : '처리할 작업 없음');
    return;
  }
  console.log(`작업 ${tasks.length}건 처리 시작${roleFilter ? ` (${roleFilter}만)` : ''}`);
  for (const t of tasks) await handleTask(t);
}

async function kick(roleName) {
  const role = ROLES[roleName];
  if (!role) throw new Error(`없는 역할: ${roleName}`);

  let context = '';
  if (roleName === 'cfo') {
    context = `\n최근 30일 수익 요약: ${JSON.stringify(await revenueSummary(30))}`;
  }
  if (roleName === 'ceo' || roleName === 'research') {
    context = `\n현재 전략: ${JSON.stringify(await recall('strategy', {}))}`;
  }

  const r = await runAgent({
    role: roleName,
    system: role.system,
    task: `정기 실행이다. 직무기술서대로 이번 차례의 일을 수행하라.${context}`,
    tools: role.tools,
    maxSteps: role.maxSteps,
    handoff: role.handoff,
  });
  console.log(`[${roleName}] ${r.output}`);
}

async function health() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.CEREBRAS_API_KEY)
    missing.push('LLM 키(GROQ/GEMINI/CEREBRAS 중 하나)');
  if (missing.length) {
    console.error('환경변수 누락:', missing.join(', '));
    process.exit(1);
  }
  const rev = await revenueSummary(30);
  console.log('DB 연결 OK. 30일 수익:', rev);
  await toolImpl.notify({ text: `헬스체크 정상. 30일 수익 ${rev.total}원`, title: 'AI Company' });
}


/** 어느 키가 살아있고 어느 게 죽었는지 하나씩 짚어준다. */
async function doctor() {
  console.log('=== 1. Supabase ===');
  try {
    const rev = await revenueSummary(1);
    console.log(`  OK — 연결됨 (기록 ${rev.count}건)`);
  } catch (e) {
    console.log(`  실패 — ${e.message}`);
  }

  const providers = [
    ['groq', 'GROQ_API_KEY', 'https://console.groq.com/keys'],
    ['cerebras', 'CEREBRAS_API_KEY', 'https://cloud.cerebras.ai'],
    ['gemini', 'GEMINI_API_KEY', 'https://aistudio.google.com/apikey'],
    ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/keys'],
  ];

  for (const [name, envName, url] of providers) {
    const raw = process.env[envName];
    console.log(`\n=== ${name} ===`);
    if (!raw) {
      console.log(`  건너뜀 — ${envName} 없음`);
      continue;
    }
    if (raw !== raw.trim() || /^["']|["']$/.test(raw)) {
      console.log(`  경고 — 값에 공백이나 따옴표가 붙어 있다. .env를 확인해라.`);
    }
    console.log(`  키: ${raw.slice(0, 6)}…${raw.slice(-4)} (${raw.length}자)`);
    try {
      const ids = await listModels(name);
      console.log(`  모델 ${ids.length}개 조회됨`);
      ids.forEach((id) => console.log(`    - ${id}`));
    } catch (e) {
      console.log(`  /models 실패 — ${e.message}`);
      console.log(`  → 키를 다시 발급해라: ${url}`);
      continue;
    }
    try {
      const r = await chat({
        messages: [{ role: 'user', content: '1+1은? 숫자만.' }],
        forceProvider: name,
        maxRetries: 0,
      });
      console.log(`  대화 테스트 OK — model=${r.model}, 응답="${String(r.message.content).trim().slice(0, 20)}"`);
    } catch (e) {
      console.log(`  대화 테스트 실패 — ${e.message}`);
    }
  }
}

/** 재시도 한도에 걸려 멈춘 작업을 되살린다. */
async function reset() {
  const rows = await update('tasks', 'status=in.(running,failed)', {
    status: 'pending',
    attempts: 0,
    updated_at: new Date().toISOString(),
  });
  console.log(`${rows?.length || 0}건을 pending / attempts=0 으로 되돌렸다.`);
}

const [cmd, arg] = process.argv.slice(2);
const main = {
  worker: () => worker(arg),
  kick: () => kick(arg),
  health,
  doctor,
  reset,
  dashboard: () => dashboard(),
  serve: () => serve().then(() => new Promise(() => {})), // Ctrl+C 까지 살아 있는다
  audit: () => audit(),
  drafts,
  ready,
  review: () => review(arg),
  copy: () => copy(arg),
  done: () => done(arg, process.argv[4]),
  approve: () => approve(arg),
  reject: () => reject(arg, process.argv.slice(4).join(' ')),
  seed: async () => {
    await enqueue({ role: 'ceo', title: '회사 최초 전략 수립', priority: 1 });
    console.log('초기 작업 등록 완료');
  },
}[cmd || 'worker'];

if (!main) {
  console.error('사용법: node src/run.js [worker [role]|kick <role>|serve|serve|dashboard|drafts|ready|review <slug>|copy <slug>|approve <slug>|reject <slug> <사유>|done <slug> [url]|health|doctor|reset|seed]');
  process.exit(1);
}

main().catch((e) => {
  // 사람이 손으로 치는 명령이 늘었다. 스택 트레이스를 쏟아내는 대신 무엇이 잘못됐는지만 말한다.
  console.error(`오류: ${e.message}`);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
