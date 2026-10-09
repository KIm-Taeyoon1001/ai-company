// 순수 게임 로직. Firestore 에 의존하지 않으므로 단위 테스트한다.

export const START_CASH = 10000;
export const CHECKIN_REWARD = 500;
export const SHARES_PER_CLASS = 1000;
// 공모가 100: 시작 코인 10,000 으로 100주를 살 수 있어 보유 한도(100주·우리 반 30주)가 실제로 의미를 갖는다.
// 가격 충격은 수량에만 비례(1주 0.05%)하므로 100주 매수 = +5%, 6명이 몰리면 상한가.
export const IPO_PRICE = 100;
export const LIST_MIN_MEMBERS = 5;
export const FEE_RATE = 0.005;
export const IMPACT = 0.5;
export const DAILY_LIMIT = 0.3;
export const MAX_ORDER_QTY = 100;
export const MAX_SHARES_PER_CLASS = 100;
export const MAX_OWN_CLASS_SHARES = 30;
export const REVERT = 0.05;
export const MIN_AGE = 14;
export const DIVIDEND_RATE = 0.02;
export const REPORTS_TO_HOLD = 3;

export function kst(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return {
    year: k.getUTCFullYear(),
    month: k.getUTCMonth() + 1,
    date: k.getUTCDate(),
    day: k.getUTCDay(),
    min: k.getUTCHours() * 60 + k.getUTCMinutes(),
    ymd: k.toISOString().slice(0, 10),
  };
}

export function schoolYear(d = new Date()): number {
  const { year, month } = kst(d);
  return month < 3 ? year - 1 : year;
}

export function isMarketOpen(d = new Date()): boolean {
  const { day, min } = kst(d);
  const weekend = day === 0 || day === 6;
  const windows: [number, number][] = weekend
    ? [[540, 1380]]
    : [[420, 510], [720, 810], [960, 1380]];
  return windows.some(([s, e]) => min >= s && min < e);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fairValue(activity: number): number {
  return IPO_PRICE * (0.5 + activity / 100);
}

export function clampPrice(p: number, prevClose: number): number {
  const lo = prevClose * (1 - DAILY_LIMIT);
  const hi = prevClose * (1 + DAILY_LIMIT);
  return round2(Math.min(hi, Math.max(lo, p)));
}

/** 실제로 존재하는 날짜인지까지 확인한다 (2월 30일 같은 입력 차단). */
export function validBirthDate(s: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return y >= 1900 && s <= kst(now).ymd;
}

export function ageFrom(birthDate: string, now = new Date()): number {
  const [y, m, d] = birthDate.split("-").map(Number);
  const k = kst(now);
  let age = k.year - y;
  if (k.month * 100 + k.date < m * 100 + d) age -= 1;
  return age;
}

export type Side = "buy" | "sell";

/** 매매 한 건의 체결 결과. 가격 충격은 수량에만 비례하고 체결은 중간가. */
export function quote(P: number, prevClose: number, side: Side, qty: number) {
  const sign = side === "buy" ? 1 : -1;
  const newP = clampPrice(P * (1 + sign * IMPACT * qty / SHARES_PER_CLASS), prevClose);
  const exec = (P + newP) / 2;
  const gross = exec * qty;
  const fee = Math.ceil(gross * FEE_RATE);
  const cashDelta = side === "buy" ? -(Math.ceil(gross) + fee) : Math.floor(gross) - fee;
  return { newP, exec: round2(exec), gross, fee, cashDelta };
}

export function nextActivity(prev: number, checkins: number, members: number): number {
  const rate = Math.min(1, checkins / Math.max(1, members));
  return round2(0.7 * prev + 0.3 * 100 * rate);
}

/** 반 인증 멤버가 3명 미만이면 1명, 그 이상이면 2명 승인. */
export function approvalsNeeded(verifiedCount: number): number {
  return verifiedCount < 3 ? 1 : 2;
}

export function changeRate(price: number, prevClose: number): number {
  return Math.round((price / prevClose - 1) * 10000) / 10000;
}

// 닉네임은 랭킹에 공개되므로 자유 입력을 받지 않는다. 프리셋 형용사 + 명사 조합만 허용.
// 친구 실명을 넣어 놀리는 용도로 쓸 수 없게 하는 것이 목적이다.
export const NICK_ADJ = [
  "용감한", "졸린", "배고픈", "신난", "느긋한", "빠른", "수상한", "반짝이는", "조용한", "엉뚱한",
  "똑똑한", "부지런한", "멋진", "귀여운", "씩씩한", "행복한", "든든한", "날쌘", "포근한", "당당한",
] as const;
export const NICK_NOUN = [
  "고양이", "강아지", "판다", "펭귄", "수달", "햄스터", "여우", "부엉이", "돌고래", "다람쥐",
  "호랑이", "토끼", "고래", "너구리", "알파카", "쿼카", "곰돌이", "병아리", "치타", "거북이",
] as const;

export function makeNickname(adj: string, noun: string, num: number): string {
  return `${adj}${noun}${String(num).padStart(2, "0")}`;
}

/** 형용사 + 명사 + 두 자리 숫자(00~99). 같은 닉네임이 겹쳐도 숫자로 구분된다. */
export function validNickname(s: string): boolean {
  const m = /^(.+?)(\d{2})$/.exec(s);
  if (!m) return false;
  const body = m[1];
  return NICK_ADJ.some((a) => body.startsWith(a) && (NICK_NOUN as readonly string[]).includes(body.slice(a.length)));
}
