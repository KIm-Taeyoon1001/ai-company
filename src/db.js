// db.js — Supabase(PostgREST) 클라이언트. SDK 없이 fetch만 사용 (의존성 0).
// 무료 플랜에서 작업 큐 / 메모리 / 수익 장부를 저장한다.

const URL_BASE = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = () => process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

function headers(extra = {}) {
  const k = KEY();
  if (!URL_BASE() || !k) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.');
  return {
    apikey: k,
    Authorization: `Bearer ${k}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE()}/rest/v1/${path}`, init);
  if (!res.ok) throw new Error(`supabase ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function insert(table, rows) {
  return rest(table, {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
}

export async function select(table, query = '') {
  return rest(`${table}?${query}`, { method: 'GET', headers: headers() });
}

export async function update(table, query, patch) {
  return rest(`${table}?${query}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
}

// ---------- 작업 큐 ----------

export async function enqueue(task) {
  const row = {
    role: task.role,
    title: task.title,
    payload: task.payload || {},
    priority: task.priority ?? 5,
    status: 'pending',
    parent_id: task.parent_id ?? null,
  };
  const [created] = await insert('tasks', row);
  return created;
}

/** 우선순위 높은 pending 작업 n개를 원자적으로 running 으로 바꾸고 가져온다. */
export async function claimTasks(role, limit = 3) {
  const q =
    `status=eq.pending&attempts=lt.3` +
    (role ? `&role=eq.${encodeURIComponent(role)}` : '') +
    `&order=priority.asc,created_at.asc&limit=${limit}`;
  const candidates = await select('tasks', q);
  const claimed = [];
  for (const t of candidates) {
    // 낙관적 잠금: 아직 pending 일 때만 성공
    const res = await update('tasks', `id=eq.${t.id}&status=eq.pending`, {
      status: 'running',
      attempts: (t.attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    });
    if (res && res.length) claimed.push(res[0]);
  }
  return claimed;
}

export async function finishTask(id, { status, result }) {
  return update('tasks', `id=eq.${id}`, {
    status,
    result: result ?? null,
    updated_at: new Date().toISOString(),
  });
}

// ---------- 메모리 (에이전트 장기 기억) ----------

export async function remember(key, value) {
  return rest('memory', {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  });
}

export async function recall(key, fallback = null) {
  const rows = await select('memory', `key=eq.${encodeURIComponent(key)}&limit=1`);
  return rows?.[0]?.value ?? fallback;
}

// ---------- 로그 / 장부 ----------

export async function log(role, level, msg, meta = {}) {
  console.log(`[${role}][${level}] ${msg}`);
  try {
    await insert('logs', { role, level, msg: String(msg).slice(0, 4000), meta });
  } catch (e) {
    console.warn('로그 저장 실패:', e.message);
  }
}

export async function recordRevenue({ source, amount, currency = 'KRW', note = '' }) {
  return insert('ledger', { source, amount, currency, note });
}

export async function revenueSummary(days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = await select('ledger', `ts=gte.${since}&select=source,amount,currency,ts`);
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const bySource = {};
  for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + Number(r.amount || 0);
  return { days, total, bySource, count: rows.length };
}
