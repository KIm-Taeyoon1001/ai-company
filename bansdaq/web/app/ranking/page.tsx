"use client";

import Link from "next/link";
import { useState } from "react";
import { useDocData } from "@/lib/hooks";
import { coin, pct, shortSchool, tone } from "@/lib/format";
import type { Rankings } from "@/lib/types";

const TABS = [
  { key: "people", label: "개인 수익률" },
  { key: "classes", label: "반 시총" },
  { key: "schools", label: "학교 시총" },
] as const;

// 고정 페이지. 마감(23:10) 때 1회 계산된 결과만 보여준다.
export default function Ranking() {
  const { data, loading, error } = useDocData<Rankings>("rankings/latest");
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("people");

  return (
    <div>
      <h1 className="text-2xl font-extrabold">랭킹</h1>
      <p className="mt-1 text-xs text-sub">{data ? `${data.date} 마감 기준` : "매일 23:10 마감 때 갱신"}</p>

      <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-card p-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-lg py-2 text-sm font-semibold ${tab === t.key ? "bg-bg shadow-sm" : "text-sub"}`}>{t.label}</button>
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-up">{error}</p>}
      {loading ? (
        <p className="py-10 text-center text-sub">불러오는 중…</p>
      ) : !data ? (
        <p className="py-10 text-center text-sub">첫 마감 후에 랭킹이 나와요</p>
      ) : (
        <ol className="mt-3 divide-y divide-line">
          {tab === "people" && data.people.map((p, i) => (
            <Item key={i} rank={i + 1} title={p.nickname} sub={`${shortSchool(p.school)} ${p.cls}`}
              right={<span className={`font-bold ${tone(p.ret)}`}>{pct(p.ret)}</span>} />
          ))}
          {tab === "classes" && data.classes.map((c, i) => (
            <Item key={c.id} href={`/stock/${encodeURIComponent(c.id)}`} rank={i + 1} title={`${shortSchool(c.school)} ${c.cls}`}
              sub={<span className={tone(c.change)}>{pct(c.change)}</span>} right={<span className="font-bold">{coin(c.cap)}</span>} />
          ))}
          {tab === "schools" && data.schools.map((s, i) => (
            <Item key={s.id} rank={i + 1} title={s.school} sub={`상장 ${s.classes}개 반`}
              right={<span className="font-bold">{coin(s.cap)}</span>} />
          ))}
        </ol>
      )}
    </div>
  );
}

type ItemProps = { rank: number; title: string; sub: React.ReactNode; right: React.ReactNode; href?: string };

function Item({ rank, title, sub, right, href }: ItemProps) {
  const medal = ["🥇", "🥈", "🥉"][rank - 1];
  const body = (
    <>
      <span className="w-7 text-center font-bold text-sub">{medal ?? rank}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{title}</p>
        <p className="text-xs text-sub">{sub}</p>
      </div>
      {right}
    </>
  );
  const cls = "flex items-center gap-3 py-3";
  return <li>{href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>}</li>;
}
