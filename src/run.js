#!/usr/bin/env node
// run.js — 진입점. GitHub Actions cron이 이 파일을 역할별로 호출한다.
//   node src/run.js worker          # 큐에 쌓인 작업 처리 (30분마다)
//   node src/run.js kick research   # 특정 역할을 직접 깨움 (하루 1회 등)

import { ROLES } from './roles/index.js';
import { listModels, chat } from './llm.js';
import { runAgent } from './agent.js';
import { claimTasks, finishTask, enqueue, log, revenueSummary, recall, update } from './db.js';
import { toolImpl } from './tools.js';

const BATCH = Number(process.env.BATCH_SIZE || 3);

async function handleTask(task) {
  const role = ROLES[task.role];
  if (!role) {
    await finishTask(task.id, { status: 'failed', result: { error: `없는 역할: ${task.role}` } });
    return;
  }
  const prompt = [
    `작업: ${task.title}`,
    `payload: ${JSON.stringify(task.payload || {})}`,
    `task_id: ${task.id}`,
  ].join('\n');

  try {
    const r = await runAgent({ role: task.role, system: role.system, task: prompt, tools: role.tools });
    await finishTask(task.id, {
      status: r.truncated ? 'failed' : 'done',
      result: { output: r.output, steps: r.steps, tokens: r.tokens },
    });
  } catch (e) {
    await log(task.role, 'error', `작업 ${task.id} 실패: ${e.message}`);
    await finishTask(task.id, { status: 'pending', result: { error: e.message } }); // 재시도 (attempts<3)
  }
}

async function worker() {
  const tasks = await claimTasks(null, BATCH);
  if (!tasks.length) {
    console.log('처리할 작업 없음');
    return;
  }
  console.log(`작업 ${tasks.length}건 처리 시작`);
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
  worker,
  kick: () => kick(arg),
  health,
  doctor,
  reset,
  seed: async () => {
    await enqueue({ role: 'ceo', title: '회사 최초 전략 수립', priority: 1 });
    console.log('초기 작업 등록 완료');
  },
}[cmd || 'worker'];

if (!main) {
  console.error('사용법: node src/run.js [worker|kick <role>|health|doctor|reset|seed]');
  process.exit(1);
}

main().catch((e) => {
  console.error('치명적 오류:', e);
  process.exit(1);
});
