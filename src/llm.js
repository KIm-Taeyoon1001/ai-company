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


// ---------- 분당 토큰(TPM) 예산 ----------
// 무료 티어의 진짜 병목은 요청 수가 아니라 분당 토큰이다. 대화가 길어질수록
// 매 요청이 대화 전체를 다시 보내므로 순식간에 한도를 넘긴다.
// 제공자마다 60초 이동 창으로 사용량을 세고, 여유 있는 제공자를 먼저 쓴다.
// 기다리는 것보다 다른 제공자로 넘어가는 게 항상 빠르다.

const DEFAULT_TPM = Number(process.env.TPM_LIMIT || 6000);
const windows = new Map();
// 제공자가 응답 헤더로 알려주는 진짜 잔량. 우리 추정보다 항상 정확하다.
// Groq는 x-ratelimit-remaining-tokens / x-ratelimit-reset-tokens 를 준다.
const limits = new Map();

/** "1.597s" "2m59.56s" "1h3m" → ms */
function parseReset(v) {
  if (!v) return null;
  const m = /(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?/.exec(String(v).trim());
  if (!m) return null;
  const ms = (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000 + Number(m[4] || 0);
  return ms > 0 ? ms : null;
}

function readLimits(name, res) {
  const remaining = res.headers.get('x-ratelimit-remaining-tokens');
  const total = res.headers.get('x-ratelimit-limit-tokens');
  if (remaining == null) return;
  const resetMs = parseReset(res.headers.get('x-ratelimit-reset-tokens'));
  limits.set(name, {
    remaining: Number(remaining),
    limit: Number(total) || null,
    resetAt: Date.now() + (resetMs ?? 60_000),
  });
}

/** 헤더가 알려준 한도. 창이 지났으면 만료시킨다. */
function headerBudget(name) {
  const l = limits.get(name);
  if (!l) return null;
  if (Date.now() >= l.resetAt) {
    limits.delete(name);
    return null;
  }
  return l;
}
// 403(계정 차단)처럼 회복 불가능한 실패를 낸 제공자는 이번 실행에서 아예 건너뛴다.
// 안 그러면 매 스텝마다 죽은 제공자를 다시 두드리며 시간만 태운다.
const deadProviders = new Set();
const strikes = new Map(); // 제공자별 연속 실패 횟수. 2회 쌓이면 이번 실행에서 뺀다.

function strike(name, why) {
  const n = (strikes.get(name) || 0) + 1;
  strikes.set(name, n);
  if (n >= 2) {
    deadProviders.add(name);
    console.warn(`[llm] ${name} 연속 ${n}회 실패(${why}) → 이번 실행에서 제외`);
  }
}

function tpmOf(name) {
  return Number(process.env[`${name.toUpperCase()}_TPM`]) || DEFAULT_TPM;
}

function usedTPM(name) {
  const w = windows.get(name) || [];
  const cutoff = Date.now() - 60_000;
  while (w.length && w[0].t < cutoff) w.shift();
  windows.set(name, w);
  return w.reduce((s, x) => s + x.tokens, 0);
}

function estimate(messages, tools) {
  const chars = JSON.stringify(messages).length + JSON.stringify(tools || []).length;
  return Math.ceil(chars / 3.2);
}

/** 지금 바로 보낼 수 있으면 0, 아니면 기다려야 하는 ms. */
function waitNeeded(name, need) {
  // 헤더 정보가 있으면 그게 진실이다.
  const l = headerBudget(name);
  if (l) {
    if (need <= l.remaining) return 0;
    return Math.max(1000, l.resetAt - Date.now());
  }
  if (usedTPM(name) + need <= tpmOf(name)) return 0;
  const w = windows.get(name) || [];
  return w.length ? Math.max(1000, w[0].t + 60_000 - Date.now()) : 5000;
}

/** 이 제공자의 1분 한도 자체를 넘는 요청인가. 넘으면 아무리 기다려도 통과 못 한다. */
export function overHardLimit(name, need) {
  const cap = headerBudget(name)?.limit || tpmOf(name);
  return need > cap;
}

function record(name, tokens) {
  const w = windows.get(name) || [];
  w.push({ t: Date.now(), tokens });
  windows.set(name, w);
}

// ---------- 모델 자동 탐색 ----------
// 제공자들이 모델을 수시로 폐기해서 이름을 하드코딩하면 언젠가 반드시 404가 난다.
// .env에 *_MODEL이 없으면 /models 목록을 받아 쓸 만한 걸 직접 고른다.

const modelCache = new Map();
const bannedModels = new Set(); // 404로 죽은 모델은 다시 고르지 않는다

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
// 위에서부터 순서대로 찾는다. 같은 규칙 안에서는 파라미터가 큰 쪽을 우선.
const PREFER = [
  /gpt-oss-120b/i,
  /gpt-oss/i,
  /llama-4|llama-3\.[13]/i,
  /compound(?!-mini)/i,
  /gemini-3.*flash/i,
  /gemini-3.*pro/i,
  /gemini-.*flash/i,
  /gemini-.*pro/i,
  /kimi|deepseek/i,
  /qwen/i,
  /llama|mistral|gemma|allam|compound/i,
];

/** "...-120b" 같은 파라미터 표기를 숫자로 뽑는다. 없으면 0. */
function sizeOf(id) {
  const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(id);
  return m ? parseFloat(m[1]) : 0;
}

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

export function pickModel(ids) {
  const usable = ids.filter((id) => !NOT_CHAT.test(id) && !bannedModels.has(id));
  if (!usable.length) return null;
  for (const rule of PREFER) {
    const hit = usable.filter((id) => rule.test(id));
    if (hit.length) return hit.sort((a, b) => sizeOf(b) - sizeOf(a))[0];
  }
  return usable[0];
}

async function resolveModel(p) {
  const fromEnv = p.model();
  // .env로 고정한 모델이라도 일일 한도가 끝났으면 다른 모델로 넘어가야 한다
  if (fromEnv && !bannedModels.has(fromEnv)) return fromEnv;
  if (modelCache.has(p.name)) return modelCache.get(p.name);
  const ids = await listModels(p.name);
  const chosen = pickModel(ids);
  if (!chosen) throw new Error(`${p.name}: 쓸 수 있는 채팅 모델을 못 찾음`);
  modelCache.set(p.name, chosen);
  console.log(`[llm] ${p.name} 모델 자동 선택: ${chosen}  (.env에 ${p.name.toUpperCase()}_MODEL=${chosen} 로 고정 가능)`);
  return chosen;
}



function activeProviders() {
  const list = PROVIDERS.filter((p) => p.key() && !deadProviders.has(p.name));
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
  const failures = []; // 제공자별 실패 사유. 마지막 것만 던지면 진짜 원인이 가려진다
  const estFor = estimate(messages, tools);
  const tried = new Set();

  // 1차: 지금 바로 보낼 수 있는 제공자만 쓴다. 2차: 남은 제공자를 기다려서라도 쓴다.
  for (const pass of [0, 1]) {
  for (const p of list) {
    if (pass === 0 && waitNeeded(p.name, estFor) > 0) continue;
    if (pass === 1 && tried.has(p.name)) continue;
    tried.add(p.name);
    lastErr = null; // 이전 제공자의 에러가 이 제공자 로그로 새지 않게 한다
    // 모델 교체는 "재시도"가 아니다. 이걸 재시도로 세면 120b→20b→compound 세 번 갈아타는 동안
    // 예산이 끝나서 정작 쓸 수 있는 모델(qwen 등)을 못 만난다. 실제로 그렇게 실패했다.
    let swaps = 0;
    const MAX_SWAPS = 4;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const body = { model: await resolveModel(p), messages, temperature };
        if (tools && tools.length) {
          body.tools = tools;
          body.tool_choice = 'auto';
        }
        const est = estimate(messages, tools);
        const wait = waitNeeded(p.name, est);
        if (wait > 0) {
          console.log(`[llm] ${p.name} TPM 대기 ${Math.round(wait / 1000)}초`);
          await sleep(Math.min(wait, 20_000));
        }
        const res = await fetch(`${p.base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(p) },
          body: JSON.stringify(body),
        });

        readLimits(p.name, res);

        if (res.status === 429 || res.status === 503) {
          const text = await res.text().catch(() => '');

          // 일일 한도(TPD)는 기다려서 풀리지 않는다. 그런데 이건 **모델별** 한도라서
          // 같은 키의 다른 모델은 아직 살아 있다. 45초씩 헛기다리지 말고 모델을 갈아탄다.
          if (/per day|TPD/i.test(text)) {
            bannedModels.add(body.model);
            modelCache.delete(p.name);
            console.warn(`[llm] ${p.name} 모델 ${body.model} 일일 한도 소진 → 같은 제공자의 다른 모델로 전환`);
            if (swaps++ < MAX_SWAPS) {
              attempt--; // 교체는 재시도 예산을 쓰지 않는다
              continue;
            }
            deadProviders.add(p.name);
            throw new Error(`${p.name} 일일 한도 소진 (쓸 수 있는 모델을 다 소진)`);
          }

          // 분당 한도 → 서버가 알려준 만큼 기다렸다 같은 제공자로 다시 시도
          record(p.name, tpmOf(p.name)); // 이 제공자 창을 잠그고 식게 둔다
          const wait = Number(res.headers.get('retry-after')) * 1000 || 8000 * (attempt + 1);
          if (attempt < maxRetries) {
            console.warn(`[llm] ${p.name} 429 — ${Math.round(Math.min(wait, 45000) / 1000)}초 대기 후 재시도`);
            await sleep(Math.min(wait, 45000));
            continue;
          }
          strike(p.name, `${res.status}`);
          throw new Error(`${p.name} rate limited (${res.status})`);
        }
        if (res.status === 401 && !altAuth.has(p.name) && attempt < maxRetries) {
          altAuth.add(p.name);
          console.warn(`[llm] ${p.name} Bearer 거부됨 → x-goog-api-key 로 재시도`);
          continue;
        }
        // 402 = 결제 필요(무료 쿼터 없음). 403 = 차단. 둘 다 재시도해봐야 소용없다.
        if (res.status === 403 || res.status === 402 || (res.status === 401 && altAuth.has(p.name))) {
          const text = await res.text();
          deadProviders.add(p.name);
          console.warn(`[llm] ${p.name} 사용 불가로 판단해 이번 실행에서 제외: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
          break;
        }
        if (!res.ok) {
          const text = await res.text();

          // 툴 호출을 지원하지 않는 모델(예: groq/compound)이 후보로 뽑히는 일이 있다.
          // 이 회사의 에이전트는 전부 툴을 쓰므로 그런 모델은 쓸모가 없다. 빼고 다시 고른다.
          if (res.status === 400 && /tool call/i.test(text)) {
            bannedModels.add(body.model);
            modelCache.delete(p.name);
            console.warn(`[llm] ${p.name} 모델 ${body.model} 은 툴 호출 미지원 → 후보에서 제외`);
            if (swaps++ < MAX_SWAPS) {
              attempt--;
              continue;
            }
          }
          // 모델이 폐기됐으면 캐시를 비우고 목록을 다시 받아 한 번 더 시도
          if (res.status === 404 && /model/i.test(text) && !p.model() && attempt < maxRetries) {
            const dead = modelCache.get(p.name);
            if (dead) {
              bannedModels.add(dead);
              console.warn(`[llm] ${p.name} 모델 ${dead} 폐기 확인 → 후보에서 제외`);
            }
            modelCache.delete(p.name);
            console.warn(`[llm] ${p.name} 모델 폐기됨 → 목록 재조회`);
            continue;
          }
          throw new Error(`${p.name} ${res.status}: ${text.slice(0, 300)}`);
        }

        const json = await res.json();
        strikes.set(p.name, 0);
        record(p.name, json.usage?.total_tokens || est);
        const choice = json.choices?.[0];
        if (!choice) throw new Error(`${p.name}: 빈 응답`);
        if (typeof choice.message?.content === 'string') {
          choice.message.content = stripThinking(choice.message.content);
        }
        return {
          message: choice.message,
          provider: p.name,
          model: body.model,
          usage: json.usage || {},
        };
      } catch (e) {
        lastErr = e;
        // 모델 목록조차 못 받는 제공자(키 자체가 죽은 경우)는 재시도할 가치가 없다.
        // 안 그러면 매 스텝마다 같은 404를 다시 받으며 시간만 태운다.
        if (/\/models \d{3}|채팅 모델을 못 찾음/.test(e.message)) {
          deadProviders.add(p.name);
          console.warn(`[llm] ${p.name} 모델 목록 조회 불가 → 이번 실행에서 제외`);
          break;
        }
        if (attempt >= maxRetries) break;
        await sleep(1000 * (attempt + 1));
      }
    }
    if (lastErr) {
      failures.push(`${p.name}: ${lastErr.message.slice(0, 160).replace(/\s+/g, ' ')}`);
      console.warn(`[llm] ${p.name} 실패 → 다음 제공자로 전환: ${lastErr.message}`);
    }
  }
  }
  throw new Error(`모든 LLM 제공자 실패 — ${failures.join(' | ') || lastErr?.message}`);
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

/** 추론 모델의 <think>…</think> / <reasoning>…</reasoning> 흔적을 걷어낸다. */
export function stripThinking(text) {
  return String(text)
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/^[\s\S]*?<\/(?:think|thinking|reasoning)>/i, '')
    .trim();
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
