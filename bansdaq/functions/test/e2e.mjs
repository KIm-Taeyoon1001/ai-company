// 에뮬레이터 통합 테스트: 가입 → 승인 → 상장 → 출석 → 매매 → 마감 → 신고 → 상장폐지
// 실행: npm run e2e  (firebase emulators:exec 가 이 파일을 돌린다)
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PROJECT = process.env.GCLOUD_PROJECT;
const AUTH = "http://127.0.0.1:9099";
const FN = `http://127.0.0.1:5001/${PROJECT}/asia-northeast3`;

// 스케줄 함수는 에뮬레이터가 자동 실행하지 않으므로 직접 부른다
const fns = require("../lib/index.js");
const { getFirestore } = require("firebase-admin/firestore");
const db = getFirestore();

async function signUp(email) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1", returnSecureToken: true }),
  });
  const j = await r.json();
  return { uid: j.localId, token: j.idToken };
}

async function call(user, name, data = {}) {
  const r = await fetch(`${FN}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${user.token}` },
    body: JSON.stringify({ data }),
  });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.status = j.error.status; throw e; }
  return j.result;
}

const join = (u, nickname, classNm = "3", extra = {}) =>
  call(u, "joinClass", { nickname, birthDate: "2010-05-05", officeCode: "H10", schoolCode: "7480001", grade: "2", classNm, ...extra });

const user = async (uid) => (await db.doc(`users/${uid}`).get()).data();
const cls = async (id) => (await db.doc(`classes/${id}`).get()).data();
const step = (s) => console.log(`✓ ${s}`);

const [A, B, C, D, E, Z, Y] = await Promise.all(["a", "b", "c", "d", "e", "z", "y"].map((n) => signUp(`${n}@t.com`)));

// --- 가입 검증
await assert.rejects(join(Y, "어린이", "3", { birthDate: "2015-01-01" }), /만 14세/);
await assert.rejects(join(Y, "ㅅㅂ왕"), /닉네임/);
await assert.rejects(join(Y, "정상닉", "3", { birthDate: "2011-02-30" }), /생년월일/);
step("14세 미만·금칙어·없는 날짜 차단");

const r1 = await join(A, "에이");
assert.equal(r1.status, "verified");
const classId = r1.classId;
assert.equal((await user(A.uid)).cash, 10000);
step("개설자 자동 인증 + 10,000 코인");

for (const [u, n] of [[B, "비"], [C, "씨"], [D, "디"], [E, "이"]]) assert.equal((await join(u, n + "닉")).status, "pending");
await assert.rejects(join(A, "에이"), /이미/);

const pending = await call(A, "listPending");
assert.equal(pending.pending.length, 4);
assert.ok(pending.pending.every((p) => p.nickname && p.uid));
step("승인 대기 목록은 닉네임만");

// 승인 대기 중엔 반을 바꿀 수 있다
assert.equal((await join(E, "이닉", "4")).status, "verified"); // 4반 개설자가 됨
await assert.rejects(join(E, "이닉", "3"), /이미 정해/);
step("대기 중 반 변경 가능, 인증 후 1년 고정");

const [F] = await Promise.all([signUp("f@t.com")]);
await join(F, "에프");

await call(A, "approveMember", { targetUid: B.uid }); // count 1 → 1명 필요
assert.equal((await user(B.uid)).status, "verified");
await call(A, "approveMember", { targetUid: C.uid }); // count 2 → 1명 필요
let r = await call(A, "approveMember", { targetUid: D.uid }); // count 3 → 2명 필요
assert.equal(r.status, "pending");
await assert.rejects(call(A, "approveMember", { targetUid: D.uid }), /이미 승인/);
r = await call(B, "approveMember", { targetUid: D.uid });
assert.equal(r.status, "verified");
assert.equal((await cls(classId)).listed, false);
await call(A, "approveMember", { targetUid: F.uid });
r = await call(C, "approveMember", { targetUid: F.uid });
assert.equal(r.listed, true);
assert.equal((await cls(classId)).verifiedCount, 5);
step("승인 규칙(3명 미만 1명, 이후 2명) + 5명 상장");

// --- 출석
assert.equal((await call(A, "checkin")).reward, 500);
await assert.rejects(call(A, "checkin"), /이미 출석/);
assert.equal((await user(A.uid)).cash, 10500);
await call(B, "checkin");
await call(C, "checkin");
step("출석 하루 1회");

// --- 매매
const z = await call(Z, "joinClass", { nickname: "제트", birthDate: "2009-01-01", officeCode: "H10", schoolCode: "7480002", grade: "1", classNm: "1" });
assert.equal(z.status, "verified");
await assert.rejects(call(Z, "trade", { classId: z.classId, side: "buy", qty: 1 }), /상장되지/);
await assert.rejects(call(Y, "trade", { classId, side: "buy", qty: 1 }), /인증/);
await assert.rejects(call(Z, "trade", { classId, side: "buy", qty: 101 }), /1~100/);
await assert.rejects(call(A, "trade", { classId, side: "buy", qty: 31 }), /30주/);
step("미상장·미인증·수량·우리 반 30주 한도 차단");

const before = (await cls(classId)).price;
// 시작 코인 10,000 / 공모가 1,000 → 한 번에 살 수 있는 건 9주 남짓
await assert.rejects(call(Z, "trade", { classId, side: "buy", qty: 11 }), /코인이 부족/);
const buy = await call(Z, "trade", { classId, side: "buy", qty: 9 });
assert.ok(buy.price > before);
assert.equal(buy.qty, 9);
const sell = await call(Z, "trade", { classId, side: "sell", qty: 9 });
assert.ok(sell.cash < 10000, `왕복 매매 후 손해여야 함: ${sell.cash}`);
assert.equal((await db.doc(`holdings/${Z.uid}_${classId}`).get()).exists, false);
await assert.rejects(call(Z, "trade", { classId, side: "sell", qty: 1 }), /부족/);
step(`매수 시 가격 상승, 사고 바로 팔면 손해 (잔고 ${sell.cash})`);

await call(A, "trade", { classId, side: "buy", qty: 8 });
await call(Z, "trade", { classId, side: "buy", qty: 5 });
for (let i = 0; i < 10; i++) await call(Z, "trade", { classId, side: "buy", qty: 1 }).catch(() => {});
const after = await cls(classId);
assert.ok(after.price <= after.prevClose * 1.3 + 0.01);
assert.ok(Math.abs(after.change - (after.price / after.prevClose - 1)) < 0.0002);
step(`상한가 이내 + 등락률 필드 일치 (${after.price}, ${(after.change * 100).toFixed(2)}%)`);

// --- 마감
await fns.closeMarket.run({});
const closed = await cls(classId);
assert.equal(closed.prevClose, after.price);
assert.equal(closed.change, 0);
assert.equal(closed.volumeToday, 0);
assert.ok(closed.activity > 50, `5명 중 3명 출석 → 활동 점수 상승: ${closed.activity}`);
const latest = (await db.doc("rankings/latest").get()).data();
assert.ok(latest.people.length >= 6 && latest.classes[0].id === classId && latest.schools.length >= 1);
assert.ok(latest.people.every((p) => !("uid" in p)));
step(`마감: 종가·활동 점수(${closed.activity})·랭킹(uid 비공개)`);

// --- 평균 회귀: 내재가치 쪽으로 5%
const pBefore = closed.price;
await fns.tick.run({});
const ticked = await cls(classId);
const fv = 1000 * (0.5 + closed.activity / 100);
assert.ok(Math.abs(ticked.price - (pBefore + 0.05 * (fv - pBefore))) < 0.02, `${ticked.price}`);
step(`tick: ${pBefore} → ${ticked.price} (내재가치 ${fv})`);

// --- 신고 3건 → 보류
for (const u of [A, B, C]) await call(u, "reportMember", { targetUid: F.uid });
assert.equal((await user(F.uid)).status, "held");
assert.equal((await cls(classId)).verifiedCount, 4);
await assert.rejects(call(F, "trade", { classId, side: "buy", qty: 1 }), /인증/);
step("신고 3건 → 보류, 거래 차단");

// --- 학년도 전환: 지난 학년도 종목 청산
const ay = (await cls(classId)).ay;
await db.doc(`classes/${classId}`).update({ ay: ay - 1 });
const zCash = (await user(Z.uid)).cash;
const zQty = (await db.doc(`holdings/${Z.uid}_${classId}`).get()).data().qty;
const finalPrice = (await cls(classId)).price;
await fns.delistLastYear.run({});
const dl = await cls(classId);
assert.equal(dl.listed, false);
assert.equal(dl.delisted, true);
assert.equal((await user(Z.uid)).cash, zCash + Math.floor(zQty * finalPrice));
assert.equal((await db.doc(`holdings/${Z.uid}_${classId}`).get()).exists, false);
step("3월 상장폐지 → 최종가로 코인 정산");

console.log("\n모든 통합 테스트 통과");
process.exit(0);
