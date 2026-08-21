// llm.js — 무료 LLM 제공자 폴백 라우터 (의존성 0)
// 모두 OpenAI 호환 /chat/completions 엔드포인트를 사용한다.
// 429(쿼터 초과)가 나면 다음 제공자로 자동 전환 → 하루 종일 0원으로 버틴다.

const PROVIDERS = [
  {
    name: 'groq',
    base: 'https://api.groq.com/openai/v1',
    key: () => process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
  {
    name: 'cerebras',
    base: 'https://api.cerebras.ai/v1',
    key: () => process.env.CEREBRAS_API_KEY,
    model: process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
  },
  {
    name: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: () => process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  {
    name: 'openrouter',
    base: 'https://openrouter.ai/api/v1',
    key: () => process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function activeProviders() {
  const list = PROVIDERS.filter((p) => p.key());
  if (!list.length) {
    throw new Error('사용 가능한 LLM 키가 없습니다. .env에 GROQ_API_KEY 등을 넣으세요.');
  }
  return list;
}

/**
 * OpenAI 호환 chat completion. 제공자 순회 + 지수 백오프.
 * @param {object} opts
 * @param {Array} opts.messages
 * @param {Array} [opts.tools]      OpenAI function-calling 스펙
 * @param {number} [opts.temperature]
 * @param {string} [opts.forceProvider]
 * @returns {Promise<{message: object, provider: string, model: string, usage: object}>}
 */
export async function chat({ messages, tools, temperature = 0.4, forceProvider, maxRetries = 2 }) {
  const list = forceProvider
    ? activeProviders().filter((p) => p.name === forceProvider)
    : activeProviders();

  let lastErr;
  for (const p of list) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const body = { model: p.model, messages, temperature };
        if (tools && tools.length) {
          body.tools = tools;
          body.tool_choice = 'auto';
        }
        const res = await fetch(`${p.base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${p.key()}`,
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429 || res.status === 503) {
          // 쿼터 초과 → 짧게 기다렸다 재시도, 그래도 안 되면 다음 제공자
          const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * (attempt + 1);
          if (attempt < maxRetries) {
            await sleep(Math.min(wait, 15000));
            continue;
          }
          throw new Error(`${p.name} rate limited (${res.status})`);
        }
        if (!res.ok) {
          throw new Error(`${p.name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }

        const json = await res.json();
        const choice = json.choices?.[0];
        if (!choice) throw new Error(`${p.name}: 빈 응답`);
        return {
          message: choice.message,
          provider: p.name,
          model: p.model,
          usage: json.usage || {},
        };
      } catch (e) {
        lastErr = e;
        if (attempt >= maxRetries) break;
        await sleep(1000 * (attempt + 1));
      }
    }
    console.warn(`[llm] ${p.name} 실패 → 다음 제공자로 전환: ${lastErr?.message}`);
  }
  throw new Error(`모든 LLM 제공자 실패: ${lastErr?.message}`);
}

/** JSON만 뱉게 강제하는 헬퍼. 파싱 실패 시 1회 자가 교정. */
export async function chatJSON({ system, user, schemaHint, temperature = 0.2 }) {
  const messages = [
    {
      role: 'system',
      content:
        `${system}\n\n반드시 유효한 JSON 하나만 출력한다. 마크다운 코드펜스, 설명 문장 금지.` +
        (schemaHint ? `\n\n스키마:\n${schemaHint}` : ''),
    },
    { role: 'user', content: user },
  ];

  const first = await chat({ messages, temperature });
  const parsed = tryParse(first.message.content);
  if (parsed !== undefined) return parsed;

  const fix = await chat({
    messages: [
      ...messages,
      first.message,
      { role: 'user', content: '위 응답이 유효한 JSON이 아니다. JSON만 다시 출력하라.' },
    ],
    temperature: 0,
  });
  const parsed2 = tryParse(fix.message.content);
  if (parsed2 !== undefined) return parsed2;
  throw new Error(`JSON 파싱 실패: ${String(fix.message.content).slice(0, 200)}`);
}

function tryParse(text) {
  if (!text) return undefined;
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  // 본문 안에 섞인 첫 JSON 객체/배열 추출
  const m = cleaned.match(/[[{][\s\S]*[\]}]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return undefined;
}

export { activeProviders };
