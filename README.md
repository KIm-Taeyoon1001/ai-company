# ai-company — 0원으로 24시간 도는 에이전트 회사

의존성 0개. Node 22 내장 `fetch`만 쓴다. 카드 등록 없이 굴러간다.

## 먼저 알아야 할 것

**"사람 없이 알아서 돈이 들어오는 회사"는 지금 기술로 안 된다.** 이유는 셋이다.

1. **결제·정산이 막힌다.** 애드센스, Gumroad, Stripe, 앱스토어 전부 실명 인증·세금 정보·은행 계좌를 요구한다. 에이전트가 대신 못 한다. 돈이 들어오는 마지막 구간에는 반드시 네가 서 있어야 한다.
2. **장기 자율 판단이 무너진다.** LLM 에이전트를 며칠씩 방치하면 목표가 표류하고, 자기가 만든 환각을 근거로 다음 판단을 한다. 그래서 이 저장소는 QA 에이전트가 **반려**하는 걸 기본으로 설계했다.
3. **완전 자동 = 스팸 판정.** 사람 확인 없이 대량 게시/발송하면 플랫폼이 차단한다. 애드센스는 자동 생성 콘텐츠 사이트를 거절한다.

**대신 되는 것:** 탐색 → 제작 → 검수 → 배포까지 전부 자동, 마지막에 네가 하루 5분 승인. 이게 현실적인 최대치다. 이 저장소는 그걸 만든다.

## 무료 스택 (2026-08 기준)

| 역할 | 서비스 | 무료 한도 | 주의 |
|---|---|---|---|
| 실행 (cron) | GitHub Actions | **public 저장소는 실행 시간 무제한** | private은 월 2,000분. cron 최소 5분 간격, 60일 무활동 시 자동 비활성 → `keepalive.yml`이 방지 |
| LLM | Groq | 무료 티어 약 30 RPM / 8K TPM, 모델별 일 요청 한도 | 초과 시 429 |
| LLM 백업 | Google Gemini | 무료 티어 (모델별 RPM/RPD 상이, AI Studio 대시보드에서 확인) | 카드 불필요 |
| LLM 백업 | Cerebras / OpenRouter free 모델 | 별도 한도 | `llm.js`가 429 나면 자동 전환 |
| DB / 큐 | Supabase | 500MB DB, 프로젝트 2개 | 7일 무접속 시 일시정지 (cron이 계속 찔러서 방지됨, 보장은 안 됨) |
| 웹훅/상시 | Cloudflare Workers | 10만 req/일, Cron Trigger 포함, KV 10만 read/일, D1 5GB | invocation당 CPU 10ms |
| 호스팅 | GitHub Pages / Cloudflare Pages | 무료 | |
| 알림 | Discord 웹훅 | 무료 | |

**GitHub Actions는 public 저장소일 때만 무제한이다.** 이 저장소를 private으로 두면 한 달도 못 가서 분이 떨어진다. 대신 public이면 코드가 공개되니 API 키는 반드시 Secrets에만 넣어라.

## 구조

```
CEO (주 1회)      전략 1개로 좁히고 목표/지표 결정 → research 작업 생성
  └ RESEARCH (일 1회)  실제 수요 신호 검색, 근거 URL 수집 → producer 작업 생성
      └ PRODUCER       근거를 실제로 읽고 결과물 작성 → qa 작업 생성
          └ QA         출처 대조 후 통과/반려. 반려가 기본값 → publisher 또는 producer
              └ PUBLISHER  index.html 갱신 → Actions가 git push
CFO (일 1회)      비용 0원 초과 감시, 30일 무수익이면 실패 판정 → 디스코드 보고
```

작업은 Supabase `tasks` 테이블에 쌓이고, 30분마다 도는 `worker`가 꺼내서 처리한다. 에이전트끼리 직접 호출하지 않고 **큐를 통해서만** 연결된다. 하나가 죽어도 전체가 안 멈춘다.

## 설치 (15분)

```bash
# 1. GitHub에 public 저장소로 올린다
git init && git add . && git commit -m "init"
gh repo create ai-company --public --source=. --push

# 2. Supabase 프로젝트 생성 → SQL Editor에 schema.sql 붙여넣고 실행

# 3. 키 발급 (전부 무료, 카드 불필요)
#    console.groq.com/keys
#    aistudio.google.com/apikey
#    Discord 서버 설정 → 연동 → 웹후크

# 4. GitHub 저장소 Settings → Secrets and variables → Actions 에 등록
#    GROQ_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, DISCORD_WEBHOOK_URL

# 5. 로컬 확인
cp .env.example .env   # 값 채우고
node --env-file=.env src/run.js health
node --env-file=.env src/run.js seed     # CEO에게 첫 작업 부여
node --env-file=.env src/run.js worker
```

Actions 탭에서 `ai-company` 워크플로를 한 번 수동 실행(`workflow_dispatch`)하면 그때부터 cron이 돈다.

## 안전장치 (이거 빼면 사고 난다)

- `MAX_STEPS=8` — 에이전트 1회 실행당 툴 호출 라운드 상한. 무한 루프로 무료 쿼터를 태우는 걸 막는다.
- `attempts<3` — 같은 작업을 3번 실패하면 큐에서 빠진다.
- `write_file`은 저장소 밖 경로를 거부한다.
- 역할별 툴 화이트리스트. CFO는 파일을 못 쓰고, PRODUCER는 알림을 못 보낸다. **권한을 좁게 주는 게 폭주를 막는 유일한 방법이다.**
- 모든 역할 프롬프트에 "돈 쓰는 행동 금지"가 박혀 있다.
- `concurrency: ai-company` — 워크플로 동시 실행 방지.

## 수익 모델 현실 순위

| 모델 | 자동화 적합도 | 첫 수익까지 | 막히는 지점 |
|---|---|---|---|
| 니치 정보 사이트 + 애드센스/제휴 | 높음 | 3~6개월 | 애드센스 승인. 자동 생성 티가 나면 거절 |
| 유료 뉴스레터 / 리포트 (Gumroad) | 높음 | 1~3개월 | 초기 구독자 확보는 사람이 해야 함 |
| 마이크로 SaaS / API 판매 | 중간 | 2~4개월 | 결제 연동, CS |
| 자동화 대행 서비스 | 낮음 | 즉시 가능 | 영업이 100% 사람 |

**0원 + 사람 최소 개입**이면 1번이 유일하게 말이 된다. 단, "AI가 쓴 글 대량 발행"은 검색엔진과 애드센스 양쪽에서 걸린다. 그래서 QA 에이전트가 출처 대조를 강제하고, 발행 전 네 승인을 넣는 구조로 짰다.

## 이 저장소가 하지 않는 것

- 계정 자동 생성, 캡차 우회, 대량 발송 — 안 한다. 계정 정지된다.
- 결제 연동 — 사람이 해야 한다.
- "돈이 저절로 들어온다" — 안 들어온다. 이건 **네 시간을 하루 3시간에서 5분으로 줄이는 도구**지, 0으로 만드는 도구가 아니다.
