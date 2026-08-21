#!/usr/bin/env node
// run.js — 진입점. GitHub Actions cron이 이 파일을 역할별로 호출한다.
//   node src/run.js worker          # 큐에 쌓인 작업 처리 (30분마다)
//   node src/run.js kick research   # 특정 역할을 직접 깨움 (하루 1회 등)

import { ROLES } from './roles/index.js';
import { runAgent } from './agent.js';
import { claimTasks, finishTask, enqueue, log, revenueSummary, recall } from './db.js';
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

const [cmd, arg] = process.argv.slice(2);
const main = {
  worker,
  kick: () => kick(arg),
  health,
  seed: async () => {
    await enqueue({ role: 'ceo', title: '회사 최초 전략 수립', priority: 1 });
    console.log('초기 작업 등록 완료');
  },
}[cmd || 'worker'];

if (!main) {
  console.error('사용법: node src/run.js [worker|kick <role>|health|seed]');
  process.exit(1);
}

main().catch((e) => {
  console.error('치명적 오류:', e);
  process.exit(1);
});
