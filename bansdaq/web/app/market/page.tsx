"use client";

import { useState } from "react";
import { collection, documentId, limit, orderBy, query, QueryConstraint, startAfter, where } from "firebase/firestore";
import { ErrorBanner, MarketBadge, StockRow } from "@/components/ui";
import { fb } from "@/lib/firebase";
import { useMe, useNow, useQueryData } from "@/lib/hooks";
import { isMarketOpen, schoolYear } from "@/lib/engine";
import type { ClassDoc } from "@/lib/types";

const PAGE = 20;
const TABS = [
  { key: "school", label: "우리 학교" },
  { key: "top", label: "전국 TOP" },
  { key: "up", label: "급등" },
  { key: "down", label: "급락" },
] as const;
type Tab = (typeof TABS)[number]["key"];

// 무한 스크롤 없이 페이지 단위로만 넘긴다 (청소년 보호 설계)
export default function Market() {
  const { me } = useMe();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("top");
  // 각 페이지 시작 직전의 [정렬값, 문서ID]. 공모가 1000 처럼 같은 값이 많아 ID 로 순서를 확정한다
  const [cursors, setCursors] = useState<[number, string][]>([]);

  const school = me?.schoolCode;
  const cs: QueryConstraint[] = [];
  let key: string | null = null;
  if (tab === "school") {
    if (school) {
      cs.push(where("schoolCode", "==", school), where("ay", "==", schoolYear()), orderBy("price", "desc"), orderBy(documentId(), "desc"));
      key = `school:${school}`;
    }
  } else {
    const field = tab === "top" ? "price" : "change";
    const dir = tab === "down" ? "asc" : "desc";
    cs.push(where("listed", "==", true), orderBy(field, dir), orderBy(documentId(), dir));
    key = tab;
  }
  const cursor = cursors[cursors.length - 1];
  if (key && cursor) cs.push(startAfter(...cursor));
  cs.push(limit(PAGE));
  if (key) key += `:${cursors.length}:${cursor?.join("|") ?? ""}`;

  const { rows, loading, error } = useQueryData<ClassDoc>(() => query(collection(fb().db, "classes"), ...cs), key);
  const page = cursors.length;

  function cursorOf(c: ClassDoc): [number, string] {
    return [tab === "up" || tab === "down" ? c.change : c.price, c.id];
  }

  return (
    <div>
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold">시장</h1>
        <MarketBadge open={isMarketOpen(now)} />
      </header>

      <div className="mt-4 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => { setTab(t.key); setCursors([]); }}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${tab === t.key ? "bg-ink text-bg" : "bg-card text-sub"}`}>
            {t.label}
          </button>
        ))}
      </div>

      <ErrorBanner msg={error} />
      {tab === "school" && !school ? (
        <p className="py-10 text-center text-sub">가입하면 우리 학교 종목을 볼 수 있어요</p>
      ) : loading ? (
        <p className="py-10 text-center text-sub">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sub">종목이 없어요</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {rows.map((c, i) => <StockRow key={c.id} c={c} rank={page * PAGE + i + 1} />)}
        </ul>
      )}

      <div className="mt-4 flex gap-2">
        <button disabled={page === 0} onClick={() => setCursors(cursors.slice(0, -1))}
          className="flex-1 rounded-xl bg-card py-3 text-sm font-semibold disabled:opacity-30">이전</button>
        <span className="self-center px-2 text-sm text-sub">{page + 1}</span>
        <button disabled={rows.length < PAGE} onClick={() => setCursors([...cursors, cursorOf(rows[rows.length - 1])])}
          className="flex-1 rounded-xl bg-card py-3 text-sm font-semibold disabled:opacity-30">다음</button>
      </div>
    </div>
  );
}
