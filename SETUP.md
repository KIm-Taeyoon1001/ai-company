# 남은 작업 — 네가 해야 하는 것만

## 이미 끝난 것 (내가 함)

- Supabase 프로젝트: `KIm-Taeyoon1001's Project` (ap-northeast-2, 무료)
- URL: `https://jadgrldnmorrjfshtqci.supabase.co`
- 테이블 4개 생성 완료: `tasks` `memory` `logs` `ledger` (+ 인덱스, RLS 활성화)
- 첫 작업 투입 완료: `tasks.id=1` — CEO / "회사 최초 전략 수립" / pending

## 1. Supabase service_role 키 복사 (30초)

MCP로는 비밀키를 못 꺼낸다. 대시보드에서 직접 복사해야 한다.

<https://supabase.com/dashboard/project/jadgrldnmorrjfshtqci/settings/api-keys>

`service_role` (secret) 값을 복사. **anon 키는 안 된다** — RLS를 켜고 정책을 안 만들었기 때문에 anon으로는 아무것도 못 읽는다. 그게 의도된 설계다.

## 2. LLM 키 발급 (3분, 카드 불필요)

| 서비스 | 링크 | 비고 |
|---|---|---|
| Groq | <https://console.groq.com/keys> | 1순위. 가장 빠름 |
| Gemini | <https://aistudio.google.com/apikey> | 예비. Groq 429 시 자동 전환 |

둘 다 넣는 걸 권한다. 하나만 있으면 쿼터 터지는 순간 회사가 멈춘다.

## 3. Discord 웹훅 (1분)

서버 → 채널 설정(톱니) → 연동 → 웹후크 → 새 웹후크 → URL 복사.
안 만들면 알림만 조용히 스킵되고 나머지는 정상 동작한다.

## 4. 로컬에서 먼저 돌려보기

```bash
cp .env.example .env      # 위 3개 값 채우기
node --env-file=.env src/run.js health   # DB 연결 + 키 확인
node --env-file=.env src/run.js worker   # 대기 중인 CEO 작업 처리
```

`health`가 통과하면 인프라는 끝난 거다.

## 5. GitHub 저장소 (public 필수)

내 토큰은 이 세션에 설정된 저장소로만 제한돼 있어서 새 저장소를 못 만든다. 직접 해야 한다.

```bash
gh repo create ai-company --public --source=. --push
# gh가 없으면 github.com/new 에서 public으로 만들고
git remote add origin https://github.com/KIm-Taeyoon1001/ai-company.git
git push -u origin main
```

**반드시 public.** private이면 Actions 무료 분(월 2,000분)이 한 달 안에 떨어진다.

## 6. Secrets 등록

저장소 → Settings → Secrets and variables → Actions → New repository secret

```
GROQ_API_KEY
GEMINI_API_KEY
SUPABASE_URL            = https://jadgrldnmorrjfshtqci.supabase.co
SUPABASE_SERVICE_KEY
DISCORD_WEBHOOK_URL
```

`.env` 파일은 절대 커밋하지 마라. `.gitignore`에 이미 넣어놨다.

## 7. 시동

Actions 탭 → `ai-company` → Run workflow → `worker` 실행.
한 번 수동 실행하면 그때부터 cron이 스스로 돈다.

---

## 확인해둘 것

Supabase 보안 검사에서 `public.rls_auto_enable()` 함수가 anon 권한으로 호출 가능하다고 나온다. 내가 만든 게 아니라 프로젝트에 원래 있던 것이다. 안 쓰는 거면 지우는 게 낫다.
<https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable>
