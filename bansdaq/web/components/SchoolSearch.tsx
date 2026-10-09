"use client";

import { useEffect, useState } from "react";
import type { School } from "@/lib/types";

export default function SchoolSearch({ onPick, autoFocus }: { onPick: (s: School) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<School[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setList([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/neis/schools?q=${encodeURIComponent(term)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "학교 검색에 실패했습니다.");
        setList(json.schools);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "학교 검색에 실패했습니다.");
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus={autoFocus}
        placeholder="학교 이름 (예: 울산과학고)"
        className="w-full rounded-2xl bg-card px-5 py-4 text-base outline-none ring-brand focus:ring-2"
      />
      {error && <p className="mt-2 text-sm text-up">{error}</p>}
      {loading && <p className="mt-3 text-sm text-sub">찾는 중…</p>}
      <ul className="mt-2 divide-y divide-line">
        {list.map((s) => (
          <li key={s.schoolCode}>
            <button onClick={() => onPick(s)} className="w-full py-3 text-left">
              <p className="font-semibold">{s.name}</p>
              <p className="text-xs text-sub">{s.address}</p>
            </button>
          </li>
        ))}
        {!loading && q.trim().length >= 2 && list.length === 0 && !error && (
          <li className="py-3 text-sm text-sub">검색 결과가 없어요</li>
        )}
      </ul>
    </div>
  );
}
