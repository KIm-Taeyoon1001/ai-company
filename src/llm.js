// llm.js — 무료 LLM 제공자 폴백 라우터 (의존성 0)
// 모두 OpenAI 호환 /chat/completions 엔드포인트를 사용한다.
// 429(쿼터 초과)가 나면 다음 제공자로 자동 전환 → 하루 종일 0원으로 버틴다.

const PROVIDERS = [
  {
    name: 'groq',
    base: 'https://api.groq.com/openai/v1',
    key: () => process.env.GROQ_API_KEY,
    model: () => process.env.GROQ_MODEL,
  },
  {
    name: 'cerebras',
    base: 'https://api.cerebras.ai/v1',
    key: () => process.env.CEREBRAS_API_KEY,
    model: () => process.env.CEREBRAS_MODEL,
  },
  {
    name: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_MODEL,
  },
  {
    name: 'openrouter',
    base: 'https://openrouter.ai/api/v1',
    key: () => process.env.OPENROUTER_API_KEY,
    model: () => process.env.OPENROUTER_MODEL,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 모델 자동 탐색 ----------
// 제공자들이 모델을 수시로 폐기해서 이름을 하드코딩하면 언젠가 반드시 404가 난다.
// .env에 *_MODEL이 없으면 /models 목록을 받아 쓸 만한 걸 직접 고른다.

const modelCache = new Map();

// Gemini는 2026년부터 AQ. 로 시작하는 새 키를 발급하는데, 일부 계정에서 Bearer 인증이
// 401로 거부된다. Bearer가 막히면 x-goog-api-key 로 한 번 더 시도한다.
const altAuth = new Set();

function authHeaders(p) {
  return altAuth.has(p.name)
    ? { 'x-goog-api-key': p.key() }
    : { Authorization: `Bearer ${p.key()}` };
}

// 채팅용이 아닌 것들 — 이름에 이게 있으면 후보에서 뺀다
const NOT_CHAT = /whisper|tts|embed|embedding|guard|moderat|rerank|image|vision-only|audio|transcribe|orpheus|playai|speech|sora|veo|imagen|dall|canopylabs|distil/i;
// 선호 순서 (위에 있을수록 우선)
const PREFER = [
  /gpt-oss|kimi|deepseek|qwen3|llama-4|llama-3\.[13]/i,
  /compound(?!-mini)/i,
  /gemini.*(flash|pro)/i,
  /llama|qwen|mistral|gemma|allam|compound/i,
];

export async function listModels(providerName) {
  const p = PROVIDERS.find((x) => x.name === providerName);
  if (!p || !p.key()) return [];
  let res = await fetch(`${p.base}/models`, { headers: authHeaders(p) });
  if (res.status === 401 && !altAuth.has(p.name)) {
    altAuth.add(p.name);
    res = await fetch(`${p.base}/models`, { headers: authHeaders(p) });
    if (!res.ok) altAuth.delete(p.name);
  }
  if (!res.ok) throw new Error(`${p.name} /models ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id).filter(Boolean);
}

function pickModel(ids) {
  const usable = ids.filter((id) => !NOT_CHAT.test(id));
  if (!usable.length) return null;
  for (const rule of PREFER) {
    const hit = usable.filter((id) => rule.test(id));
    if (hit.length) return hit.sort((a, b) => a.length - b.length)[0];
  }
  return usable[0];
}

async function resolveModel(p) {
  const fromEnv = p.model();
  if (fromEnv) return fromEnv;
  if (modelCache.has(p.name)) return modelCache.get(p.name);
  const ids = await listModels(p.name);
  const chosen = pickModel(ids);
  if (!chosen) throw new Error(`${p.name}: 쓸 수 있는 채팅 모델을 못 찾음`);
  modelCache.set(p.name, chosen);
  console.log(`[llm] ${p.name} 모델 자동 선택: ${chosen}  (.env에 ${p.name.toUpperCase()}_MODEL=${chosen} 로 고정 가능)`);
  return chosen;
}



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
        const body = { model: await resolveModel(p), messages, temperature };
        if (tools && tools.length) {
          body.tools = tools;
          body.tool_choice = 'auto';
        }
        const res = await fetch(`${p.base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(p) },
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
        if (res.status === 401 && !altAuth.has(p.name) && attempt < maxRetries) {
          altAuth.add(p.name);
          console.warn(`[llm] ${p.name} Bearer 거부됨 → x-goog-api-key 로 재시도`);
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          // 모델이 폐기됐으면 캐시를 비우고 목록을 다시 받아 한 번 더 시도
          if (res.status === 404 && /model/i.test(text) && !p.model() && attempt < maxRetries) {
            modelCache.delete(p.name);
            console.warn(`[llm] ${p.name} 모델 폐기됨 → 목록 재조회`);
            continue;
          }
          throw new Error(`${p.name} ${res.status}: ${text.slice(0, 300)}`);
        }

        const json = await res.json();
        const choice = json.choices?.[0];
        if (!choice) throw new Error(`${p.name}: 빈 응답`);
        return {
          message: choice.message,
          provider: p.name,
          model: body.model,
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
