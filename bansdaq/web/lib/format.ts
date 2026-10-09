import type { ClassDoc } from "./types";

export const coin = (n: number) => Math.floor(n).toLocaleString("ko-KR");
export const price = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

export function pct(r: number, sign = true) {
  const v = (r * 100).toFixed(2);
  return `${sign && r > 0 ? "+" : ""}${v}%`;
}

/** 한국 증시 관례: 상승 빨강, 하락 파랑 */
export function tone(r: number) {
  if (r > 0) return "text-up";
  if (r < 0) return "text-down";
  return "text-sub";
}

export function shortSchool(name: string) {
  return name.replace(/고등학교$/, "고").replace(/중학교$/, "중");
}

export function ticker(c: Pick<ClassDoc, "schoolName" | "grade" | "classNm">) {
  return `${shortSchool(c.schoolName)} ${c.grade}-${c.classNm}`;
}

export const isLimitUp = (change: number) => change >= 0.2999;
