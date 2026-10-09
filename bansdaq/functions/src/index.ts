import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference } from "firebase-admin/firestore";
import * as E from "./engine";

initializeApp();
const db = getFirestore();
const REGION = "asia-northeast3";
const NEIS_KEY = defineSecret("NEIS_KEY");

// 로컬 에뮬레이터 전용 우회. 실제 배포에선 FUNCTIONS_EMULATOR 가 없으므로 절대 켜지지 않는다.
const EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";
const marketOpen = () => (EMULATOR && process.env.MARKET_ALWAYS_OPEN === "1") || E.isMarketOpen();

function requireAuth(uid?: string): string {
  if (!uid) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  return uid;
}

// ===== 나이스: 클라이언트가 보낸 학교·반을 믿지 않고 서버에서 다시 확인 =====
async function neis(path: string, params: Record<string, string>) {
  const url = new URL(`https://open.neis.go.kr/hub/${path}`);
  url.search = new URLSearchParams({ KEY: NEIS_KEY.value(), Type: "json", pIndex: "1", pSize: "100", ...params }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new HttpsError("unavailable", "학교 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
  const json = await res.json();
  return (json[path]?.[1]?.row ?? []) as Record<string, string>[];
}

async function verifySchool(officeCode: string, schoolCode: string, ay: number, grade: string, classNm: string) {
  if (EMULATOR && NEIS_KEY.value() === "emulator") return { schoolName: `테스트${schoolCode}고등학교`, kind: "고등학교" };
  const [school] = await neis("schoolInfo", { ATPT_OFCDC_SC_CODE: officeCode, SD_SCHUL_CODE: schoolCode });
  if (!school || !["중학교", "고등학교"].includes(school.SCHUL_KND_SC_NM)) {
    throw new HttpsError("not-found", "중·고등학교만 참여할 수 있습니다.");
  }
  const rows = await neis("classInfo", {
    ATPT_OFCDC_SC_CODE: officeCode, SD_SCHUL_CODE: schoolCode, AY: String(ay), GRADE: grade,
  });
  if (!rows.some((r) => r.CLASS_NM === classNm)) throw new HttpsError("not-found", "존재하지 않는 반입니다.");
  return { schoolName: school.SCHUL_NM, kind: school.SCHUL_KND_SC_NM };
}

/** 첫 인증 때만 시작 코인을 준다. 새 학년도 재인증 땐 기존 코인 유지. */
function grantOnVerify(u: FirebaseFirestore.DocumentSnapshot) {
  if (u.get("startGranted") === true) return {};
  return {
    startGranted: true,
    cash: FieldValue.increment(E.START_CASH),
    principal: FieldValue.increment(E.START_CASH),
  };
}

function listingFields() {
  return { listed: true, price: E.IPO_PRICE, prevClose: E.IPO_PRICE, change: 0, activity: 50 };
}

// ===== 가입 + 반 참여 =====
export const joinClass = onCall({ region: REGION, secrets: [NEIS_KEY] }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const d = (req.data ?? {}) as Record<string, unknown>;
  const nickname = String(d.nickname ?? "").trim();
  const birthDate = String(d.birthDate ?? "");
  const officeCode = String(d.officeCode ?? "");
  const schoolCode = String(d.schoolCode ?? "");
  const grade = String(d.grade ?? "");
  const classNm = String(d.classNm ?? "");

  if (!E.validBirthDate(birthDate)) throw new HttpsError("invalid-argument", "생년월일 형식이 잘못됐습니다.");
  if (E.ageFrom(birthDate) < E.MIN_AGE) throw new HttpsError("permission-denied", "만 14세 이상만 가입할 수 있습니다.");
  if (!E.validNickname(nickname)) throw new HttpsError("invalid-argument", "닉네임은 주어진 단어 중에서 골라야 합니다.");
  if (!/^[A-Z0-9]{2,10}$/.test(officeCode) || !/^\d{5,10}$/.test(schoolCode) || !/^[1-3]$/.test(grade) || !/^[^/_]{1,10}$/.test(classNm)) {
    throw new HttpsError("invalid-argument", "학교와 반을 선택하세요.");
  }

  const ay = E.schoolYear();
  const { schoolName, kind } = await verifySchool(officeCode, schoolCode, ay, grade, classNm);
  const classId = `${officeCode}_${schoolCode}_${ay}_${grade}_${classNm}`;
  const userRef = db.doc(`users/${uid}`);
  const classRef = db.doc(`classes/${classId}`);

  return db.runTransaction(async (tx) => {
    const [u, c] = await Promise.all([tx.get(userRef), tx.get(classRef)]);
    if (u.exists && u.get("ay") === ay) {
      if (u.get("classId") === classId) throw new HttpsError("already-exists", "이미 이 반에 참여했습니다.");
      // 승인 대기 중엔 반을 잘못 고른 경우 바꿀 수 있다. 인증 후엔 1년 고정.
      if (u.get("status") !== "pending") throw new HttpsError("failed-precondition", "올해 반은 이미 정해졌습니다.");
    }

    const base = {
      nickname,
      birthYear: Number(birthDate.slice(0, 4)),
      officeCode, schoolCode, schoolName, kind, ay, grade, classNm, classId,
      approvals: [] as string[],
      reports: [] as string[],
      ...(u.exists ? {} : { cash: 0, principal: 0, lastCheckin: null, createdAt: FieldValue.serverTimestamp() }),
    };

    if (!c.exists) {
      tx.set(classRef, {
        officeCode, schoolCode, schoolName, ay, grade, classNm,
        verifiedCount: 1, listed: false, delisted: false,
        price: E.IPO_PRICE, prevClose: E.IPO_PRICE, change: 0, activity: 50, volumeToday: 0,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(userRef, { ...base, status: "verified", ...grantOnVerify(u) }, { merge: true });
      return { status: "verified", classId };
    }

    tx.set(userRef, { ...base, status: "pending" }, { merge: true });
    return { status: "pending", classId };
  });
});

// ===== 같은 반 승인 대기 목록 (닉네임만) =====
export const listPending = onCall({ region: REGION }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const me = await db.doc(`users/${uid}`).get();
  if (!me.exists || me.get("status") !== "verified") return { pending: [] };
  const snap = await db.collection("users")
    .where("classId", "==", me.get("classId"))
    .where("status", "==", "pending")
    .limit(50)
    .get();
  return {
    pending: snap.docs.map((d) => ({
      uid: d.id,
      nickname: d.get("nickname") as string,
      approvals: (d.get("approvals") ?? []).length as number,
      approvedByMe: ((d.get("approvals") ?? []) as string[]).includes(uid),
    })),
  };
});

// ===== 같은 반 멤버 승인 =====
export const approveMember = onCall({ region: REGION }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const targetUid = String((req.data ?? {}).targetUid ?? "");
  if (!targetUid || targetUid === uid) throw new HttpsError("invalid-argument", "잘못된 요청입니다.");

  const meRef = db.doc(`users/${uid}`);
  const targetRef = db.doc(`users/${targetUid}`);

  return db.runTransaction(async (tx) => {
    const [me, t] = await Promise.all([tx.get(meRef), tx.get(targetRef)]);
    if (!me.exists || me.get("status") !== "verified") throw new HttpsError("permission-denied", "인증된 멤버만 승인할 수 있습니다.");
    if (!t.exists || t.get("status") !== "pending") throw new HttpsError("failed-precondition", "승인 대기 중인 사용자가 아닙니다.");
    if (t.get("classId") !== me.get("classId")) throw new HttpsError("permission-denied", "같은 반만 승인할 수 있습니다.");

    const classRef = db.doc(`classes/${me.get("classId")}`);
    const c = await tx.get(classRef);
    const approvals: string[] = t.get("approvals") ?? [];
    if (approvals.includes(uid)) throw new HttpsError("already-exists", "이미 승인했습니다.");

    const next = [...approvals, uid];
    const verifiedCount: number = c.get("verifiedCount");
    const needed = E.approvalsNeeded(verifiedCount);

    if (next.length < needed) {
      tx.update(targetRef, { approvals: next });
      return { status: "pending", approvals: next.length, needed };
    }

    const newCount = verifiedCount + 1;
    tx.update(targetRef, { approvals: next, status: "verified", ...grantOnVerify(t) });
    const classUpdate: Record<string, unknown> = { verifiedCount: newCount, updatedAt: FieldValue.serverTimestamp() };
    const listing = !c.get("listed") && !c.get("delisted") && newCount >= E.LIST_MIN_MEMBERS;
    if (listing) Object.assign(classUpdate, listingFields());
    tx.update(classRef, classUpdate);
    return { status: "verified", listed: listing };
  });
});

// ===== "우리 반 아님" 신고: 3건이면 보류 → 운영자 검토 =====
export const reportMember = onCall({ region: REGION }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const targetUid = String((req.data ?? {}).targetUid ?? "");
  if (!targetUid || targetUid === uid) throw new HttpsError("invalid-argument", "잘못된 요청입니다.");

  const meRef = db.doc(`users/${uid}`);
  const targetRef = db.doc(`users/${targetUid}`);

  return db.runTransaction(async (tx) => {
    const [me, t] = await Promise.all([tx.get(meRef), tx.get(targetRef)]);
    if (!me.exists || me.get("status") !== "verified") throw new HttpsError("permission-denied", "인증된 멤버만 신고할 수 있습니다.");
    if (!t.exists || t.get("classId") !== me.get("classId")) throw new HttpsError("permission-denied", "같은 반만 신고할 수 있습니다.");
    if (t.get("status") === "held") return { status: "held" };

    const reports: string[] = t.get("reports") ?? [];
    if (reports.includes(uid)) throw new HttpsError("already-exists", "이미 신고했습니다.");
    const next = [...reports, uid];
    if (next.length < E.REPORTS_TO_HOLD) {
      tx.update(targetRef, { reports: next });
      return { status: t.get("status"), reports: next.length };
    }

    const classRef = db.doc(`classes/${t.get("classId")}`);
    if (t.get("status") === "verified") {
      // 인증 멤버였다면 반 인원에서 뺀다. 상장은 유지 (이미 다른 사람들이 보유 중).
      const c = await tx.get(classRef);
      tx.update(classRef, { verifiedCount: Math.max(1, (c.get("verifiedCount") ?? 1) - 1) });
    }
    tx.update(targetRef, { reports: next, status: "held", heldAt: FieldValue.serverTimestamp() });
    return { status: "held" };
  });
});

// ===== 출석 =====
export const checkin = onCall({ region: REGION }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const { ymd } = E.kst();
  const userRef = db.doc(`users/${uid}`);

  return db.runTransaction(async (tx) => {
    const u = await tx.get(userRef);
    if (!u.exists || u.get("status") !== "verified") throw new HttpsError("permission-denied", "반 인증 후 출석할 수 있습니다.");
    if (u.get("lastCheckin") === ymd) throw new HttpsError("already-exists", "오늘은 이미 출석했습니다.");

    const actRef = db.doc(`classes/${u.get("classId")}/activity/${ymd}`);
    tx.update(userRef, {
      cash: FieldValue.increment(E.CHECKIN_REWARD),
      principal: FieldValue.increment(E.CHECKIN_REWARD),
      lastCheckin: ymd,
    });
    tx.set(actRef, { checkins: FieldValue.increment(1) }, { merge: true });
    return { reward: E.CHECKIN_REWARD };
  });
});

// ===== 매매 =====
export const trade = onCall({ region: REGION }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const d = (req.data ?? {}) as Record<string, unknown>;
  const classId = String(d.classId ?? "");
  const side = d.side as E.Side;
  const qty = d.qty as number;

  if (!classId || classId.includes("/") || (side !== "buy" && side !== "sell")) throw new HttpsError("invalid-argument", "잘못된 주문입니다.");
  if (!Number.isInteger(qty) || qty < 1 || qty > E.MAX_ORDER_QTY) throw new HttpsError("invalid-argument", "수량은 1~100주입니다.");
  if (!marketOpen()) throw new HttpsError("failed-precondition", "지금은 장이 열려 있지 않습니다.");

  const userRef = db.doc(`users/${uid}`);
  const classRef = db.doc(`classes/${classId}`);
  const holdRef = db.doc(`holdings/${uid}_${classId}`);
  const tradeRef = db.collection("trades").doc();

  return db.runTransaction(async (tx) => {
    const [u, c, h] = await Promise.all([tx.get(userRef), tx.get(classRef), tx.get(holdRef)]);
    if (!u.exists || u.get("status") !== "verified") throw new HttpsError("permission-denied", "반 인증 후 거래할 수 있습니다.");
    if (!c.exists || !c.get("listed")) throw new HttpsError("not-found", "상장되지 않은 종목입니다.");

    const cash: number = u.get("cash");
    const held: number = h.exists ? h.get("qty") : 0;
    const avgCost: number = h.exists ? h.get("avgCost") : 0;
    const P: number = c.get("price");
    const prevClose: number = c.get("prevClose");

    if (side === "buy") {
      const cap = u.get("classId") === classId ? E.MAX_OWN_CLASS_SHARES : E.MAX_SHARES_PER_CLASS;
      if (held + qty > cap) throw new HttpsError("failed-precondition", `이 종목은 최대 ${cap}주까지 보유할 수 있습니다.`);
    } else if (held < qty) {
      throw new HttpsError("failed-precondition", "보유 수량이 부족합니다.");
    }

    const q = E.quote(P, prevClose, side, qty);
    const newCash = cash + q.cashDelta;
    if (newCash < 0) throw new HttpsError("failed-precondition", "코인이 부족합니다.");
    const newQty = side === "buy" ? held + qty : held - qty;
    const newAvg = side === "buy" ? (held * avgCost + q.gross) / newQty : newQty === 0 ? 0 : avgCost;

    tx.update(userRef, { cash: newCash });
    if (newQty === 0) tx.delete(holdRef);
    else tx.set(holdRef, { uid, classId, qty: newQty, avgCost: E.round2(newAvg) }, { merge: true });
    tx.update(classRef, {
      price: q.newP,
      change: E.changeRate(q.newP, prevClose),
      volumeToday: FieldValue.increment(qty),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(tradeRef, {
      uid, classId, schoolName: c.get("schoolName"), grade: c.get("grade"), classNm: c.get("classNm"),
      side, qty, price: q.exec, fee: q.fee, ts: FieldValue.serverTimestamp(),
    });

    return { executedPrice: q.exec, price: q.newP, cash: newCash, qty: newQty };
  });
});

// ===== 10분마다 평균 회귀 (increment 로 매매와 충돌 방지) =====
export const tick = onSchedule(
  { schedule: "every 10 minutes", region: REGION, timeZone: "Asia/Seoul" },
  async () => {
    if (!marketOpen()) return;
    const snap = await db.collection("classes").where("listed", "==", true).get();
    let batch = db.batch();
    let n = 0;
    for (const doc of snap.docs) {
      const P: number = doc.get("price");
      const prevClose: number = doc.get("prevClose");
      const target = E.clampPrice(P + E.REVERT * (E.fairValue(doc.get("activity") ?? 50) - P), prevClose);
      const delta = E.round2(target - P);
      if (Math.abs(delta) < 0.01) continue;
      batch.update(doc.ref, {
        price: FieldValue.increment(delta),
        change: FieldValue.increment(Math.round((delta / prevClose) * 10000) / 10000),
      });
      if (++n % 450 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    await batch.commit();
  }
);

// 배치 500건 제한을 신경 쓰지 않고 쓰기 위한 작은 도우미
function writer() {
  let batch = db.batch();
  let n = 0;
  return {
    async add(fn: (b: FirebaseFirestore.WriteBatch) => void, ops = 1) {
      fn(batch);
      n += ops;
      if (n >= 450) {
        await batch.commit();
        batch = db.batch();
        n = 0;
      }
    },
    async flush() {
      if (n > 0) await batch.commit();
      batch = db.batch();
      n = 0;
    },
  };
}

// ===== 랭킹: 마감 때 1회만 계산 =====
async function buildRankings(ymd: string, prices: Map<string, { price: number; doc: FirebaseFirestore.QueryDocumentSnapshot }>) {
  const [users, holds] = await Promise.all([
    db.collection("users").where("status", "==", "verified").select("nickname", "schoolName", "grade", "classNm", "cash", "principal").get(),
    db.collection("holdings").select("uid", "classId", "qty").get(),
  ]);

  const stock = new Map<string, number>();
  for (const h of holds.docs) {
    const p = prices.get(h.get("classId"))?.price ?? 0;
    stock.set(h.get("uid"), (stock.get(h.get("uid")) ?? 0) + p * h.get("qty"));
  }

  // uid 는 공개하지 않는다. 닉네임과 소속만.
  const people = users.docs
    .map((u) => {
      const principal: number = u.get("principal") || E.START_CASH;
      const asset = (u.get("cash") ?? 0) + (stock.get(u.id) ?? 0);
      return {
        nickname: u.get("nickname"), school: u.get("schoolName"), cls: `${u.get("grade")}-${u.get("classNm")}`,
        asset: Math.floor(asset), ret: Math.round(((asset - principal) / principal) * 10000) / 10000,
      };
    })
    .sort((a, b) => b.ret - a.ret || b.asset - a.asset)
    .slice(0, 100);

  const classes = [...prices.entries()]
    .map(([id, { price, doc }]) => ({
      id, school: doc.get("schoolName"), cls: `${doc.get("grade")}-${doc.get("classNm")}`,
      cap: Math.floor(price * E.SHARES_PER_CLASS), change: E.changeRate(price, doc.get("prevClose")),
    }))
    .sort((a, b) => b.cap - a.cap)
    .slice(0, 100);

  const schoolMap = new Map<string, { school: string; cap: number; classes: number }>();
  for (const [, { price, doc }] of prices) {
    const key = `${doc.get("officeCode")}_${doc.get("schoolCode")}`;
    const s = schoolMap.get(key) ?? { school: doc.get("schoolName"), cap: 0, classes: 0 };
    s.cap += Math.floor(price * E.SHARES_PER_CLASS);
    s.classes += 1;
    schoolMap.set(key, s);
  }
  const schools = [...schoolMap.entries()]
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => b.cap - a.cap)
    .slice(0, 100);

  const data = { date: ymd, people, classes, schools, updatedAt: FieldValue.serverTimestamp() };
  await Promise.all([db.doc(`rankings/${ymd}`).set(data), db.doc("rankings/latest").set(data)]);
}

// ===== 매일 23:10 마감: 활동 점수·종가·랭킹·주간 배당 =====
export const closeMarket = onSchedule(
  { schedule: "10 23 * * *", region: REGION, timeZone: "Asia/Seoul", timeoutSeconds: 540, memory: "1GiB" },
  async () => {
    const { ymd, day } = E.kst();
    const snap = await db.collection("classes").where("listed", "==", true).get();
    const acts = await db.getAll(...snap.docs.map((d) => d.ref.collection("activity").doc(ymd)));
    const checkinsOf = new Map(acts.map((a) => [a.ref.parent.parent!.id, a.exists ? (a.get("checkins") ?? 0) : 0]));

    const scored: { id: string; activity: number; price: number }[] = [];
    const prices = new Map<string, { price: number; doc: FirebaseFirestore.QueryDocumentSnapshot }>();
    const w = writer();
    for (const doc of snap.docs) {
      const activity = E.nextActivity(doc.get("activity") ?? 50, checkinsOf.get(doc.id) ?? 0, doc.get("verifiedCount") ?? 1);
      const price: number = doc.get("price");
      await w.add((b) => {
        b.update(doc.ref, { activity, prevClose: price, change: 0, volumeToday: 0 });
        b.set(doc.ref.collection("days").doc(ymd), { date: ymd, close: price, volume: doc.get("volumeToday") ?? 0, activity });
      }, 2);
      scored.push({ id: doc.id, activity, price });
      prices.set(doc.id, { price, doc });
    }
    await w.flush();

    await buildRankings(ymd, prices);

    // 금요일: 활동 상위 10% 반 보유자에게 2% 배당
    if (day !== 5 || scored.length === 0) return;
    scored.sort((a, b) => b.activity - a.activity);
    const top = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.1)));
    const priceOf = new Map(top.map((t) => [t.id, t.price]));
    const ids = top.map((t) => t.id);

    for (let i = 0; i < ids.length; i += 30) {
      const holds = await db.collection("holdings").where("classId", "in", ids.slice(i, i + 30)).get();
      for (const h of holds.docs) {
        const payout = Math.floor(h.get("qty") * (priceOf.get(h.get("classId")) ?? 0) * E.DIVIDEND_RATE);
        if (payout <= 0) continue;
        await w.add((b) => b.update(db.doc(`users/${h.get("uid")}`), { cash: FieldValue.increment(payout) }));
      }
    }
    await w.flush();
  }
);

// ===== 3월 1일 00:05: 지난 학년도 종목 상장폐지·최종가 청산 =====
// 반 문서는 지우지 않는다 → 그대로 명예의 전당으로 쓸 수 있다.
export const delistLastYear = onSchedule(
  { schedule: "5 0 1 3 *", region: REGION, timeZone: "Asia/Seoul", timeoutSeconds: 540, memory: "1GiB" },
  async () => {
    const ay = E.schoolYear();
    const snap = await db.collection("classes").where("ay", "<", ay).get();
    const w = writer();
    for (const c of snap.docs) {
      if (c.get("delisted")) continue;
      const price: number = c.get("price");
      const holds = await db.collection("holdings").where("classId", "==", c.id).get();
      for (const h of holds.docs) {
        const payout = Math.floor(h.get("qty") * price);
        const userRef: DocumentReference = db.doc(`users/${h.get("uid")}`);
        await w.add((b) => {
          b.update(userRef, { cash: FieldValue.increment(payout) });
          b.delete(h.ref);
        }, 2);
      }
      await w.add((b) => b.update(c.ref, { listed: false, delisted: true, finalPrice: price }));
    }
    await w.flush();
  }
);
