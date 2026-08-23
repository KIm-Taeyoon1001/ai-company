-- Supabase SQL Editor에 그대로 붙여넣고 실행.

create table if not exists tasks (
  id          bigserial primary key,
  role        text not null,
  title       text not null,
  payload     jsonb default '{}'::jsonb,
  status      text not null default 'pending',   -- pending|running|done|failed
  priority    int  not null default 5,           -- 1이 가장 높음
  attempts    int  not null default 0,
  parent_id   bigint,
  result      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tasks_queue_idx on tasks (status, priority, created_at);

create table if not exists memory (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists logs (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  role   text,
  level  text,
  msg    text,
  meta   jsonb default '{}'::jsonb
);
create index if not exists logs_ts_idx on logs (ts desc);

create table if not exists ledger (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  source    text not null,      -- adsense | gumroad | affiliate | ...
  amount    numeric not null,   -- 비용은 음수로 기록
  currency  text not null default 'KRW',
  note      text
);
create index if not exists ledger_ts_idx on ledger (ts desc);

-- 서비스 키만 접근하므로 RLS는 켜두고 정책은 만들지 않는다(익명 접근 차단).
alter table tasks  enable row level security;
alter table memory enable row level security;
alter table logs   enable row level security;
alter table ledger enable row level security;

-- 무료 플랜 용량 보호: 30일 지난 로그 정리 (pg_cron 확장 활성화 후 사용)
-- select cron.schedule('purge-logs', '0 4 * * *', $$delete from logs where ts < now() - interval '30 days'$$);
