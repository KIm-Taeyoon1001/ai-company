# 반스닥 (BANSDAQ)

전국 중·고등학교 반이 상장된 가상 주식 게임. 코인은 현금과 무관하다.

```
bansdaq/
  functions/        Cloud Functions (asia-northeast3) — 코인·주식 변경은 전부 여기서만
    src/engine.ts   게임 규칙 원본 (순수 함수, 단위 테스트)
    src/index.ts    joinClass · listPending · approveMember · reportMember · checkin · trade
                    tick(10분) · closeMarket(23:10) · delistLastYear(3/1)
    test/e2e.mjs    에뮬레이터 통합 테스트
  web/              Next.js 16 + Tailwind 4 (Vercel)
  firestore.rules   클라이언트는 읽기만
```

## 처음 세팅

1. Firebase 프로젝트 생성 → Authentication 에서 Google 로그인 켜기 → Firestore 생성(서울)
2. 나이스 교육정보 개방 포털에서 인증키 발급
3. 배포
   ```bash
   npm i -g firebase-tools
   cd bansdaq && firebase use --add
   firebase functions:secrets:set NEIS_KEY
   cd functions && npm i && cd ..
   firebase deploy --only firestore,functions
   ```
4. 웹: `web/.env.example` → `web/.env.local` 로 복사해 채운 뒤 `cd web && npm i && npm run dev`.
   Vercel 에선 Root Directory 를 `bansdaq/web` 으로, 같은 환경변수를 넣는다.

## 테스트

```bash
cd functions
npm test        # 게임 규칙 단위 테스트
npm run e2e     # 에뮬레이터: 가입→승인→상장→출석→매매→마감→신고→상장폐지
```

`npm run e2e` 는 `functions/.secret.local` 에 `NEIS_KEY=emulator` 가 있어야 한다.
이 값과 `MARKET_ALWAYS_OPEN` 은 **에뮬레이터에서만** 동작한다 (`FUNCTIONS_EMULATOR` 가 없으면 무시).

게임 규칙을 바꾸면 `functions/src/engine.ts` 를 고치고 `cd web && npm run sync-engine` 으로 웹에 복사한다.

## 명세서와 달라진 점

| 명세 | 구현 | 이유 |
|---|---|---|
| 학교·반 존재 확인은 클라이언트 프록시만 | `joinClass` 가 서버에서 나이스로 다시 확인, 학교명도 나이스 값 사용 | 클라이언트 값을 믿으면 가짜 반·가짜 학교명(욕설 등)을 만들 수 있음 |
| 새 학년도 재가입 시 `cash` 를 덮어씀 | 시작 코인은 최초 1회만, 이후 잔고 유지 | 매년 코인이 날아가거나 무한 리셋되는 문제 |
| 대기 중 반 변경 불가 | 승인 전엔 반 다시 고르기 가능 | 반을 잘못 고르면 1년간 갇힘 |
| 일봉은 문서 ID 로 정렬 | `days` 에 `date` 필드 추가 | Firestore 는 문서 ID 역순 스캔을 지원하지 않음 |
| 등락률 필드 없음 | `classes.change` 저장 | 급등·급락 탭 정렬에 필요 |
| 시장 목록 비로그인 차단 | `classes` · `rankings` 공개 읽기 | 랜딩에서 "너네 반 몇 위" 를 로그인 전에 보여줘야 유입됨. 개인정보 없음 |
| 랭킹·신고·상장폐지·listPending 미구현 | 구현 | |
| 개인 수익률 기준 없음 | `principal` = 받은 코인 합(시작+출석) 기준 | 출석 보상을 수익으로 치면 출석만 해도 1등 |
| 공모가 1,000 | **공모가 100** (내재가치 50~150) | 1,000이면 시작 코인으로 9주밖에 못 사서 100주·30주 한도가 무의미하고, 한 명이 사도 주가가 0.5%밖에 안 움직임. 100이면 100주 매수 = +5%, 6명이 몰리면 상한가 → 공유 카드가 실제로 나온다 |
| 닉네임 자유 입력 2~12자 | **형용사+동물+두 자리 숫자** 프리셋 (예: 용감한고양이07) | 랭킹에 공개되는 유일한 자유 텍스트였음. 친구 실명을 넣어 놀리는 데 쓰일 수 있어 반 별명과 같은 원칙 적용 |

## 성장 전략 변경

명세 6장의 **학교별 인스타 미끼 계정(대량 팔로우·일괄 수락)은 쓰지 않는다.**
인스타 약관(가짜·자동화 계정) 위반으로 정지되고, 미성년자 대량 팔로우는 학교·학부모 민원으로 번진다.
대신 이미 구현된 두 경로로 퍼뜨린다.

- **초대 링크**: 우리 반 화면 → 학교·학년·반이 미리 채워진 가입 링크. 상장 대기 "3/5" 가 초대 동기
- **공유 카드**: 종목 화면 → 1080×1920 스토리 이미지. 학생 본인 계정에서 링크 스티커로 공유
- 형님 학교에서 먼저 친구 5명으로 첫 반 상장 → 그 반 학생들이 다른 반을 끌어오게 한다

## 남은 일

- 보상형 광고 (광고 SDK 선정 후)
- 월간 리그 (월초 자산 스냅샷)
- 이용약관·개인정보처리방침·청소년보호정책 페이지 + 변호사 검토
- 신고로 보류된 계정을 검토하는 운영자 화면
