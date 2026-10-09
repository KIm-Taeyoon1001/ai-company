"use client";

import Link from "next/link";
import { useState } from "react";
import { collection, orderBy, query, where } from "firebase/firestore";
import SchoolSearch from "@/components/SchoolSearch";
import { StockRow, ErrorBanner } from "@/components/ui";
import { fb } from "@/lib/firebase";
import { useQueryData } from "@/lib/hooks";
import { schoolYear } from "@/lib/engine";
import type { ClassDoc, School } from "@/lib/types";

export default function Landing() {
  const [school, setSchool] = useState<School | null>(null);
  const ay = schoolYear();
  const { rows, loading, error } = useQueryData<ClassDoc>(
    () => query(collection(fb().db, "classes"), where("schoolCode", "==", school!.schoolCode), where("ay", "==", ay), orderBy("price", "desc")),
    school ? `land:${school.schoolCode}` : null,
  );

  const joinHref = school
    ? `/join?o=${school.officeCode}&s=${school.schoolCode}&n=${encodeURIComponent(school.name)}`
    : "/join";

  return (
    <div className="pt-8">
      <p className="text-sm font-bold text-brand">반스닥 BANSDAQ</p>
      <h1 className="mt-2 text-[32px] font-extrabold leading-tight">
        너네 반<br />지금 몇 위?
      </h1>
      <p className="mt-3 text-sub">전국 중·고등학교 모든 반이 상장된 주식시장.<br />친구들이 출석할수록 우리 반 주가가 올라요.</p>

      <div className="mt-8">
        {school ? (
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">{school.name}</h2>
              <button className="text-sm text-sub" onClick={() => setSchool(null)}>다른 학교</button>
            </div>
            <ErrorBanner msg={error} />
            {loading ? (
              <p className="py-6 text-sub">불러오는 중…</p>
            ) : rows.length === 0 ? (
              <p className="py-6 text-sub">아직 상장된 반이 없어요. 첫 번째가 되어보세요.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">{rows.map((c) => <StockRow key={c.id} c={c} />)}</ul>
            )}
            <Link href={joinHref} className="mt-6 block rounded-2xl bg-brand py-4 text-center font-bold text-white">
              우리 반 상장시키기
            </Link>
          </div>
        ) : (
          <SchoolSearch onPick={setSchool} />
        )}
      </div>

      <Link href="/market" className="mt-6 block text-center text-sm text-sub underline">전국 시장 구경하기</Link>
      <p className="mt-10 text-center text-xs text-sub">만 14세 이상 · 코인은 현금으로 사거나 바꿀 수 없어요</p>
    </div>
  );
}
