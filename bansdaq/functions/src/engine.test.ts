import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "./engine";

test("장 운영 시간: 평일 수업 시간은 닫힘", () => {
  // 2026-10-07 수요일. UTC = KST - 9h
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 7, h - 9, m));
  assert.equal(E.isMarketOpen(at(7, 0)), true);
  assert.equal(E.isMarketOpen(at(8, 30)), false);
  assert.equal(E.isMarketOpen(at(10, 0)), false);
  assert.equal(E.isMarketOpen(at(12, 30)), true);
  assert.equal(E.isMarketOpen(at(15, 59)), false);
  assert.equal(E.isMarketOpen(at(22, 59)), true);
  assert.equal(E.isMarketOpen(at(23, 0)), false);
});

test("주말은 09~23시", () => {
  const sat = (h: number) => new Date(Date.UTC(2026, 9, 10, h - 9, 0));
  assert.equal(E.isMarketOpen(sat(8)), false);
  assert.equal(E.isMarketOpen(sat(10)), true);
});

test("학년도는 3월에 바뀐다", () => {
  assert.equal(E.schoolYear(new Date(Date.UTC(2027, 1, 28, 3))), 2026);
  assert.equal(E.schoolYear(new Date(Date.UTC(2027, 2, 1, 3))), 2027);
});

test("나이 계산과 생일 검증", () => {
  const now = new Date(Date.UTC(2026, 9, 9, 3));
  assert.equal(E.ageFrom("2012-10-09", now), 14);
  assert.equal(E.ageFrom("2012-10-10", now), 13);
  assert.equal(E.validBirthDate("2011-02-30", now), false);
  assert.equal(E.validBirthDate("2030-01-01", now), false);
  assert.equal(E.validBirthDate("2010-05-05", now), true);
});

test("사고 바로 팔면 손해 (수수료 전에도 차익 없음)", () => {
  for (const q of [1, 10, 50, 100]) {
    const b = E.quote(E.IPO_PRICE, E.IPO_PRICE, "buy", q);
    const s = E.quote(b.newP, E.IPO_PRICE, "sell", q);
    assert.ok(b.cashDelta + s.cashDelta < 0, `qty ${q}`);
    assert.ok(s.exec <= b.exec, `qty ${q}`);
  }
});

test("상·하한가 ±30%", () => {
  assert.equal(E.clampPrice(200, 100), 130);
  assert.equal(E.clampPrice(10, 100), 70);
  assert.equal(E.quote(129, 100, "buy", 100).newP, 130);
});

test("활동 점수 EMA 와 내재가치", () => {
  assert.equal(E.nextActivity(50, 5, 5), 65);
  assert.equal(E.nextActivity(50, 0, 5), 35);
  assert.equal(E.nextActivity(50, 9, 5), 65);
  assert.equal(E.fairValue(0), 50);
  assert.equal(E.fairValue(100), 150);
});

test("승인 필요 수", () => {
  assert.equal(E.approvalsNeeded(1), 1);
  assert.equal(E.approvalsNeeded(2), 1);
  assert.equal(E.approvalsNeeded(3), 2);
});

test("시작 코인으로 보유 한도까지 살 수 있다", () => {
  const b = E.quote(E.IPO_PRICE, E.IPO_PRICE, "buy", 95);
  assert.ok(-b.cashDelta <= E.START_CASH);
  assert.ok(Math.abs(b.newP / E.IPO_PRICE - 1 - 0.0475) < 0.001); // 95주 → +4.75%
});

test("상한가는 6명이 100주씩이면 도달", () => {
  let p = E.IPO_PRICE;
  for (let i = 0; i < 6; i++) p = E.quote(p, E.IPO_PRICE, "buy", 100).newP;
  assert.equal(p, 130);
});

test("닉네임은 프리셋 조합만", () => {
  assert.equal(E.validNickname("용감한고양이07"), true);
  assert.equal(E.makeNickname("졸린", "쿼카", 3), "졸린쿼카03");
  assert.equal(E.validNickname("졸린쿼카03"), true);
  assert.equal(E.validNickname("용감한고양이"), false);
  assert.equal(E.validNickname("용감한김철수07"), false);
  assert.equal(E.validNickname("시발고양이07"), false);
  assert.equal(E.validNickname("용감한고양이123"), false);
  for (const a of E.NICK_ADJ) for (const n of E.NICK_NOUN) assert.ok(E.makeNickname(a, n, 99).length <= 12, a + n);
});
