// agent.js — 툴 호출 루프. 한 번의 실행에 쓸 수 있는 토큰/스텝을 강제로 제한해
// 무료 쿼터가 하루 만에 증발하는 사고를 막는다.

import { chat } from './llm.js';
import { toolImpl, toolSpecs } from './tools.js';
import { log } from './db.js';

const MAX_STEPS = Number(process.env.MAX_STEPS || 8);
const ALLOW = (process.env.TOOL_ALLOWLIST || '').split(',').filter(Boolean);

/**
 * @param {object} o
 * @param {string} o.role      에이전트 역할 이름 (로그용)
 * @param {string} o.system    시스템 프롬프트 = 그 직원의 직무기술서
 * @param {string} o.task      이번에 처리할 작업 설명
 * @param {string[]} [o.tools] 이 역할이 쓸 수 있는 툴 이름 목록 (미지정 시 전체)
 */
export async function runAgent({ role, system, task, tools }) {
  const allowed = tools || (ALLOW.length ? ALLOW : null);
  const specs = allowed ? toolSpecs.filter((t) => allowed.includes(t.function.name)) : toolSpecs;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: task },
  ];

  const trace = [];
  let usedTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const { message, provider, usage } = await chat({ messages, tools: specs });
    usedTokens += usage?.total_tokens || 0;
    messages.push(message);

    const calls = message.tool_calls || [];
    if (!calls.length) {
      await log(role, 'info', `완료 (${step + 1}스텝, ${provider}, ~${usedTokens}토큰)`);
      return { output: message.content || '', trace, steps: step + 1, tokens: usedTokens };
    }

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {}

      let result;
      if (!toolImpl[name]) {
        result = { error: `알 수 없는 툴: ${name}` };
      } else {
        try {
          result = await toolImpl[name](args);
        } catch (e) {
          result = { error: e.message };
        }
      }
      trace.push({ tool: name, args, result });
      await log(role, 'debug', `tool ${name} → ${JSON.stringify(result).slice(0, 200)}`);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }

  await log(role, 'warn', `MAX_STEPS(${MAX_STEPS}) 도달 — 강제 종료`);
  return { output: '스텝 한도 도달', trace, steps: MAX_STEPS, tokens: usedTokens, truncated: true };
}
