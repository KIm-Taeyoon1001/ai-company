# ai-company — 작업 맥락

0원으로 24시간 도는 다중 에이전트 파이프라인. 의존성 0개, Node 22 내장 fetch만 사용.
이 문서는 Claude Code가 이 저장소에서 작업을 이어받을 때 필요한 맥락이다.

## 이 프로젝트가 실제로 하는 일

CEO → RESEARCH → PRODUCER → QA → PUBLISHER 순으로 에이전트가 릴레이하며
`site/posts/*.md` 정적 파일을 생산하고, 그 뒤 **코드**(`src/site.js`)가 실제 HTML로 굽는다.
수익화(애드센스·제휴)는 사람이 나중에 붙인다.

**목록과 링크는 에이전트가 만들지 않는다.** publisher에게 index.html을 직접 쓰게 했더니
`.md` 파일을 링크해서 사이트가 열리지 않았다(GitHub Pages는 .md를 렌더링하지 않는다).
지금은 `node src/run.js build`가 마크다운 → HTML 변환, 목록 생성, 유령 페이지 정리를 전부 한다.
publisher는 소개문(`site/_intro.md`)만 쓴다. 틀리면 안 되는 일은 코드가 한다.

**에이전트끼리 직접 호출하지 않는다.** 전부 Supabase `tasks` 테이블을 거친다.
하나가 죽어도 나머지는 계속 돈다. 이 구조를 깨지 마라.

**초안과 발행물은 폴더가 다르다.** producer는 `drafts/<slug>.md` 에만 쓴다.
QA가 통과시키며 `approve_post(slug)` 를 호출해야 `site/posts/` 로 옮겨지고, 그때부터 사이트에 보인다.
전에는 producer가 site/posts에 직접 썼고, 그래서 **QA가 반려한 글도 이미 발행돼 있었다**(실제로 2편이 그랬다).
반려된 글은 drafts에 남아 producer가 같은 파일을 고친다.

## 현재 상태 (2026-08-22 오후 갱신)

- Supabase 프로젝트: `jadgrldnmorrjfshtqci` (ap-northeast-2, 무료)
- 테이블: `tasks` `memory` `logs` `ledger` — RLS 켜짐, 정책 없음(service_role 전용)
- **파이프라인 한 바퀴 완주 확인.** CEO → RESEARCH → PRODUCER → QA → PUBLISHER → 빌드까지 실제로 돌았다.
  - QA는 **반려도 하고 통과도 한다.** 지어낸 수치(150,000 스토어 / QBO 4.3M), 근거 없는 주기("5분마다"),
    그리고 **존재하지 않는 출처 URL(404)** 까지 잡아냈다. 통과시킨 글은 approve_post로 발행했다
  - 반려 → producer 수정 → QA 재검수 루프가 사람 개입 없이 돈다(#19→#22, #20→#23→#24)
- **발행 3편 — CEO가 세운 목표(정적 페이지 3개)를 채웠다.** 셋 다 QA를 통과해 approve_post로 발행됐다.
  `shopify-flow-crm-integration` / `backorder-cancellation-management-checklist` / `real-time-inventory-discrepancy-alerts`
- **Groq 일일 한도는 이동 창이다.** 120b·20b가 막혀도 조금 기다리면 다시 열린다. 막힌 동안엔 llm.js가 다른 모델로 넘어간다
- **Cerebras 키는 402다.** 키 자체는 유효하고 모델 목록도 보이는데 채팅이 `payment_required`(quota).
  이 계정은 무료 티어가 활성화돼 있지 않은 것으로 보인다. 대안은 OpenRouter
- GitHub 저장소는 아직 안 만들었다. Actions cron도 미가동

### 미해결 — 다음 사람이 반드시 알아야 할 것

1. ~~발행물이 웹에서 안 열린다~~ → **해결됨.** `src/site.js` 추가(아래 참조)
2. **Cerebras / OpenRouter 키가 `.env`에 비어 있다.** 문서에는 "추가하면 빨라진다"고만 되어 있는데 실제 값이 없다.
   지금은 Groq 단독이라 스텝마다 30~60초 TPM 대기가 걸린다. 작업 1건에 5~10분.
3. ~~큐에 이전 전략 잔재~~ → **해결됨.** #3 #4 #8을 `cancelled`로 바꿨다(`reset`으로 되살릴 수 있으니 주의 —
   `reset`은 running/failed만 건드리므로 cancelled는 안전하다). QA에 반려당한 첫 글도 site/posts에서 뺐다
   (지어낸 수치가 든 글이 그대로 발행되면 QA를 둔 의미가 없다). 원본은 세션 스크래치패드에 백업
4. ~~task #11 "2024 trends"~~ → **해결됨.** 2026으로 고침
5. 작업 트리가 HEAD와 다르다 — zip에만 있던 최신 `src/` + 아래 수정들이 아직 커밋 안 됨.

## 실행

```bash
node --env-file=.env src/run.js doctor   # 어느 키가 살아있나
node --env-file=.env src/run.js worker   # 큐에서 작업 처리
node --env-file=.env src/run.js kick ceo # 특정 역할 직접 실행
node --env-file=.env src/run.js reset    # 멈춘 작업 되살리기
node --env-file=.env src/run.js seed     # CEO에 최초 작업 투입
```

사람이 직접 검수할 때:

```bash
node src/run.js drafts                       # 검수 대기 목록 (제목·분량·출처 URL)
node src/run.js review <slug>                # 초안 전문
node --env-file=.env src/run.js approve <slug>          # 통과 → site/posts 로 발행 + 사이트 재생성
node --env-file=.env src/run.js reject <slug> "사유"     # 반려 → producer 에 수정 작업
```

QA 에이전트가 판정하지만 최종 결정권은 사람에게 있다. 에이전트를 기다리지 않고 직접 처리해도 된다.
`approve` 는 QA 가 쓰는 것과 같은 `approve_post` 를 호출하므로 발행일도 똑같이 승인 시점으로 박힌다.

`.env`는 커밋 금지(.gitignore에 있음). 필요한 키는 `.env.example` 참고.

## 실제로 터졌던 문제들 — 다시 건드릴 때 주의

| 문제 | 원인 | 현재 대응 |
|---|---|---|
| 리서치가 검색만 반복하다 죽음 | 스텝 예산 부족 + 중복 검색 | 역할별 `maxSteps`, `tools.js`의 searchCache/fetchCache, 예산 임박 시 `handoff` 툴만 노출 |
| Groq 429 | 무료 티어 **분당 토큰(TPM)** 한도. 매 요청이 대화 전체를 재전송 | `llm.js`의 제공자별 60초 토큰 창. 여유 있는 제공자 우선(pass 0), 없으면 대기(pass 1) |
| Groq 429로 작업이 아예 죽음 | **Groq TPM은 8,000이다**(헤더로 확인). 코드는 6,000으로 추측하고 있었고, 페이지 3개를 읽고 나면 요청 하나가 8,000에 근접해 **기다려도 통과 못 하는 벽**이 됐다 | `llm.js`가 `x-ratelimit-remaining-tokens`/`reset-tokens` 헤더를 읽어 실제 잔량으로 대기를 계산한다. `agent.js`의 `compact()`가 요청을 `REQUEST_TOKEN_CAP`(기본 5,000) 아래로 강제로 줄인다 — 메시지를 지우지 않고 오래된 툴 결과부터 깎아서 tool_call 짝을 유지한다 |
| 모델 404 무한 루프 | 폐기된 모델을 다시 선택 | `bannedModels` 집합 |
| 죽은 제공자에 시간 낭비 | 403/429를 매 스텝 재시도 | `deadProviders` + 연속 2회 실패 시 제외 |
| PRODUCER가 글 없이 인계 | `create_task`도 인계로 인정됨 | `handoff: ['write_file']` + `requires: ['write_file']`. `run.js`가 trace를 검사해 누락이면 pending으로 되돌림 |

**모델 이름을 하드코딩하지 마라.** 제공자들이 수시로 폐기한다. `llm.js`가 `/models`에서 자동 선택한다.

## 알려진 제약

- **Gemini 사용 불가** — 이 계정 키(`AQ.` 형식)가 `403 PERMISSION_DENIED`. Google 쪽 문제
- **Groq 단독이면 느리다** — TPM 대기 때문에 작업 1건에 5분 안팎. Cerebras나 OpenRouter 키를 추가하면 크게 빨라진다 (`.env`에 `CEREBRAS_API_KEY` / `OPENROUTER_API_KEY`)
- **GitHub Actions는 public 저장소여야 무료 무제한.** private이면 월 2,000분
- `web_fetch` 403/503이 흔하다. 정상이고, 에이전트가 다른 URL로 넘어가게 되어 있다

## 하면 안 되는 것

- 사업 방향에 OAuth·결제·앱심사·로그인 웹앱이 필요한 것을 넣지 마라. 이 스택으로 못 만든다 (CEO 프롬프트에 이미 금지되어 있음)
- 역할에 툴을 넉넉히 주지 마라. 권한을 좁히는 게 폭주를 막는 유일한 수단이다
- `MAX_STEPS` / `attempts<3` / `safePath()` / `concurrency` 안전장치를 제거하지 마라

## 다음 할 일 (우선순위 순)

1. **Cerebras 또는 OpenRouter 키 발급해서 `.env`에 넣기** — 지금 Groq 단독이라 스텝마다 30~60초 TPM 대기.
   작업 1건에 5~10분, 페이지 1개에 30분쯤 걸린다. 게다가 **2026-08-22 오늘 Groq `gpt-oss-120b`의
   일일 20만 토큰을 다 썼다**(지금은 `gpt-oss-20b`로 돌고 있다). 이게 지금 가장 큰 병목이다
2. 남은 research #10 #11을 돌려 페이지 3개 채우기 (`node --env-file=.env src/run.js worker research`)
3. GitHub public 저장소 생성 + Secrets 등록 + Actions 첫 수동 실행 — `SETUP.md` 5~7절.
   Pages를 켤 거면 `site/`를 발행 폴더로 쓸 수 없다(Pages는 루트 또는 /docs만 지원).
   Actions로 배포하거나 `site/` → `docs/`로 옮겨야 한다. 아직 안 정했다
4. **글은 영어인데 `site/_intro.md`는 한국어로 나왔다.** 대상 독자를 정하고 프롬프트에 못박아야 한다.
   지금은 역할 프롬프트가 한국어라 에이전트가 상황마다 다르게 판단한다
5. 남은 research #11(2026 트렌드)을 돌리면 4번째 글이 나온다. 목표 3편은 이미 채웠다

## 2026-08-22 오후에 고친 것

- `src/` 5개 파일이 구버전이었다(zip에만 최신본이 있었음) → 최신본으로 교체
- **`src/site.js` 신규** — 의존성 0 마크다운 렌더러 + 목록 생성기. `node src/run.js build`.
  - 에이전트가 쓴 텍스트를 **먼저 전부 이스케이프한 뒤** 아는 문법만 태그로 되살린다.
    LLM이 쓴 `<script>`나 `javascript:` 링크는 태그가 되지 못한다. 실제로 주입 테스트해서 확인했다
  - `.md`가 사라지면 짝 없는 `.html`도 지운다(목록엔 없는데 URL로 열리는 유령 페이지 방지)
  - front matter는 인라인 배열(`sources: [a, b]`)과 YAML 블록 리스트(`sources:` + `  - a`) 둘 다 읽는다.
    프롬프트는 인라인을 요구하지만 에이전트가 블록으로 쓴다. 블록을 못 읽으면 출처 목록이 페이지에서 통째로 사라진다
  - `worker`/`kick` 끝, 그리고 Actions 커밋 직전(`if: always()`)에 자동 실행된다
- `run.js`: `worker [role]` — 역할별로만 큐를 집는다(단계별 검증용), `build` 명령 추가
- `llm.js`: `/models` 조회부터 실패하는 제공자(지금의 Gemini)를 즉시 제외.
  전에는 매 스텝마다 죽은 Gemini를 3회씩 재시도하며 시간을 태웠다
- `llm.js`: 이전 제공자의 에러(`lastErr`)가 다음 제공자 로그로 새던 것 수정
- `tools.js`: `read_file`에 반복 읽기 경고 추가. QA가 같은 파일을 3번 읽어 예산 3스텝을 태웠다
- `roles/index.js`: publisher 담당 변경(목록 작성 → 소개문 작성). 위 "이 프로젝트가 하는 일" 참조
- **`drafts/` 도입 + `approve_post` 툴** — QA가 반려한 글이 그대로 사이트에 올라가 있던 문제.
  파일 이동은 코드가 한다(LLM이 본문을 다시 쓰면 검수한 내용이 아니게 된다). 경로 탈출 시도는 슬러그 검증으로 막았다
- `tools.js`: 같은 URL을 3번째부터는 본문 없이 거부. 안내문만으로는 안 멈춘다
  (producer가 URL 3개를 10스텝 동안 돌려 부르며 예산을 태웠다). `read_file`도 같은 규칙.
  `#anchor`를 바꿔 캐시를 우회하던 것도 막았다(QA가 실제로 그렇게 했다)
- `llm.js`: 429 본문에 `per day`가 있으면 **그 모델**을 banned에 넣고 같은 제공자의 다른 모델로 즉시 전환.
  전에는 일일 한도를 분당 한도로 오해해 45초씩 두 번 헛기다린 뒤 작업을 실패시켰다
- `.env`: `GROQ_MODEL` 고정을 풀었다. 고정해두면 위 모델 전환이 막힌다
- `llm.js`: 400 `tool calling is not supported` 도 같은 방식으로 모델을 제외한다.
  일일 한도로 모델을 갈아타다 `groq/compound`(툴 미지원)까지 내려가 QA가 통째로 죽었다
- `roles/index.js`: QA 반려 payload에 `{slug, filepath, sources, issues}` 를 강제.
  slug가 없어서 producer가 어느 파일을 고칠지 몰라 수정 작업 2건이 실패했다(하나는 CEO에게 문의 작업을 만들었다)
- `roles/index.js`: producer에게 "출처를 지어내지 마라, 404 난 URL은 sources에서 지워라"를 명시.
  실제로 존재하지 않는 URL을 만들어 넣었고 QA가 접속해보고 잡아냈다
- **왕복 차단기** (`run.js` `MAX_ROUNDS`, 기본 4): 반려할 때마다 **새 task**가 생기므로 `attempts<3`이
  걸리지 않아 producer↔qa가 영원히 돌 수 있었다. `create_task`가 `parent_id`와 `round`를 물려주고,
  한도를 넘은 **producer** 작업은 실패 처리 + notify한다.
  **한도는 producer에만 건다** — qa까지 막으면 방금 고친 초안이 판정도 못 받고 죽는다(그렇게 한 번 죽였다)
- `llm.js`: 402(결제 필요)도 403처럼 즉시 제외. Cerebras가 여기 걸린다
- `approve_post`: 발행일(`date:`)을 승인 시점으로 덮어쓴다. LLM이 적게 두면 지어낸다
  (실제로 오늘 쓴 글에 `2026-01-02` 이 박혀 나왔고 QA도 못 잡았다). 발행일은 시스템이 아는 사실이다
- `llm.js`: **모델 교체는 재시도 예산을 쓰지 않는다.** 120b→20b→compound 세 번 갈아타는 사이 예산이 끝나
  정작 쓸 수 있는 qwen을 못 만나고 실패했다. 최종 에러도 제공자별 사유를 모두 담게 했다(전엔 마지막 것만 나와 원인이 가려졌다)
