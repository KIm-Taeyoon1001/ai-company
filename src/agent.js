// agent.js — 툴 호출 루프.
// 스텝 예산을 역할마다 다르게 주고, 예산이 바닥나기 전에 결과를 넘기도록 강제한다.
// 이게 없으면 에이전트는 검색만 반복하다가 아무것도 안 넘기고 죽는다.

import { chat } from './llm.js';
import { toolImpl, toolSpecs } from './tools.js';
import { log } from './db.js';

const DEFAULT_STEPS = Number(process.env.MAX_STEPS || 8);
const KEEP_FULL = Number(process.env.KEEP_FULL_RESULTS || 2);
// 요청 하나가 이 크기를 넘으면 안 된다. Groq 무료 티어의 분당 한도가 8,000토큰이라
// 그걸 넘는 요청은 아무리 기다려도 통과하지 못한다(실제로 429로 작업이 죽었다).
const REQUEST_CAP = Number(process.env.REQUEST_TOKEN_CAP || 5000);

const estimate = (messages, tools) =>
  Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools || []).length) / 3.2);

/**
 * 대화가 한 요청 한도를 넘지 않을 때까지 오래된 툴 결과부터 줄인다.
 * 메시지를 삭제하지는 않는다 — tool_call 과 tool 응답의 짝이 깨지면 API가 400을 낸다.
 */
export function compact(messages, tools) {
  const toolIdx = messages
    .map((m, i) => (m.role === 'tool' && typeof m.content === 'string' ? i : -1))
    .filter((i) => i >= 0);

  // 1단계: 최근 KEEP_FULL개만 원문으로 두고 나머지는 스텁
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_FULL))) {
    if (messages[i].content.length > 400) {
      messages[i].content = messages[i].content.slice(0, 300) + ' …[오래된 결과 생략]';
    }
  }

  // 2단계: 그래도 크면 오래된 것부터 더 깎는다
  for (const limit of [150, 60]) {
    if (estimate(messages, tools) <= REQUEST_CAP) return;
    for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - 1))) {
      if (messages[i].content.length > limit) {
        messages[i].content = messages[i].content.slice(0, limit) + ' …[생략]';
      }
    }
  }

  // 3단계: 마지막 결과 하나만 남았는데도 넘치면 그것도 자른다
  if (estimate(messages, tools) > REQUEST_CAP && toolIdx.length) {
    const last = toolIdx[toolIdx.length - 1];
    const over = estimate(messages, tools) - REQUEST_CAP;
    const keep = Math.max(300, messages[last].content.length - Math.ceil(over * 3.2));
    messages[last].content = messages[last].content.slice(0, keep) + ' …[한도 초과분 생략]';
  }
}

/**
 * @param {object} o
 * @param {string} o.role         역할 이름 (로그용)
 * @param {string} o.system       그 직원의 직무기술서
 * @param {string} o.task         이번에 처리할 작업
 * @param {string[]} [o.tools]    쓸 수 있는 툴 이름
 * @param {number} [o.maxSteps]   스텝 예산
 * @param {string[]} [o.handoff]  일을 끝맺는 툴. 예산이 바닥나면 이것만 남긴다.
 */
export async function runAgent({ role, system, task, tools, maxSteps, handoff = [] }) {
  const budget = maxSteps || DEFAULT_STEPS;
  const allSpecs = tools ? toolSpecs.filter((t) => tools.includes(t.function.name)) : toolSpecs;
  const handoffSpecs = allSpecs.filter((t) => handoff.includes(t.function.name));

  const messages = [
    { role: 'system', content: `${system}\n\n너에게 주어진 툴 호출 예산은 ${budget}회다. 같은 검색을 반복하면 예산만 태우고 아무것도 못 넘긴 채 실패로 끝난다.` },
    { role: 'user', content: task },
  ];

  const trace = [];
  let usedTokens = 0;
  let handedOff = false;
  // 어느 제공자·모델이 얼마나 먹었는지. 나중에 모델별 소모를 볼 수 있어야 한다.
  const byModel = {};

  for (let step = 0; step < budget; step++) {
    const left = budget - step;

    // 예산이 얼마 안 남았는데 아직 결과를 안 넘겼으면, 끝맺는 툴만 남기고 재촉한다
    let specs = allSpecs;
    if (handoffSpecs.length && !handedOff && left <= 2) {
      specs = handoffSpecs;
      messages.push({
        role: 'user',
        content: `스텝이 ${left}회 남았다. 지금까지 모은 것만으로 즉시 ${handoff.join(' 또는 ')} 를 호출해 결과를 넘겨라. 추가 조사는 하지 마라.`,
      });
    } else if (handoffSpecs.length && !handedOff && left === 4) {
      messages.push({ role: 'user', content: `스텝 ${left}회 남았다. 슬슬 마무리하고 결과를 넘길 준비를 해라.` });
    }

    compact(messages, specs);
    const { message, provider, model, usage } = await chat({ messages, tools: specs });
    const spent = usage?.total_tokens || 0;
    usedTokens += spent;
    const key = `${provider}/${model}`;
    byModel[key] = (byModel[key] || 0) + spent;
    messages.push(message);

    const calls = message.tool_calls || [];
    if (!calls.length) {
      await log(role, 'info', `완료 (${step + 1}/${budget}스텝, ${provider}, ~${usedTokens}토큰, 인계=${handedOff})`);
      return { output: message.content || '', trace, steps: step + 1, tokens: usedTokens, byModel, handedOff };
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
      if (handoff.includes(name) && !result?.error) handedOff = true;

      trace.push({ tool: name, args, result });
      await log(role, 'debug', `[${step + 1}/${budget}] ${name} → ${JSON.stringify(result).slice(0, 200)}`);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 2500),
      });
    }
  }

  await log(role, handedOff ? 'info' : 'warn', `스텝 예산 ${budget} 소진 — 인계=${handedOff}`);
  return {
    output: handedOff ? '예산 소진, 인계는 완료' : '예산 소진, 인계 실패',
    trace,
    steps: budget,
    tokens: usedTokens,
    byModel,
    handedOff,
    truncated: !handedOff, // 인계까지 했으면 실패로 치지 않는다
  };
}
