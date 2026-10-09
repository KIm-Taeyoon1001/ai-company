"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, limit, orderBy, query, where, documentId } from "firebase/firestore";
import { Card, ErrorBanner } from "@/components/ui";
import { fb } from "@/lib/firebase";
import { useMe, useQueryData } from "@/lib/hooks";
import { coin, pct, price, ticker, tone } from "@/lib/format";
import type { ClassDoc, Holding, Trade } from "@/lib/types";

export default function Account() {
  const router = useRouter();
  const { user, me, ready } = useMe();
  const uid = user?.uid ?? null;
  const holds = useQueryData<Holding>(() => query(collection(fb().db, "holdings"), where("uid", "==", uid)), uid && `holds:${uid}`);
  const trades = useQueryData<Trade>(
    () => query(collection(fb().db, "trades"), where("uid", "==", uid), orderBy("ts", "desc"), limit(20)),
    uid && `trades:${uid}`,
  );
  const [classes, setClasses] = useState<Record<string, ClassDoc>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (ready && !user) router.replace("/join"); }, [ready, user, router]);

  // 보유 종목 현재가: in 쿼리는 30개씩
  const ids = holds.rows.map((h) => h.classId).sort().join(",");
  useEffect(() => {
    if (!ids) { setClasses({}); return; }
    const list = ids.split(",");
    (async () => {
      const out: Record<string, ClassDoc> = {};
      for (let i = 0; i < list.length; i += 30) {
        const snap = await getDocs(query(collection(fb().db, "classes"), where(documentId(), "in", list.slice(i, i + 30))));
        snap.forEach((d) => { out[d.id] = { id: d.id, ...(d.data() as Omit<ClassDoc, "id">) }; });
      }
      setClasses(out);
    })().catch((e) => setError(e.message));
  }, [ids]);

  if (!ready || !me) return <p className="pt-10 text-sub">불러오는 중…</p>;

  const stockValue = holds.rows.reduce((s, h) => s + h.qty * (classes[h.classId]?.price ?? h.avgCost), 0);
  const total = me.cash + stockValue;
  const principal = me.principal || 1;
  const ret = (total - principal) / principal;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">내 계좌</h1>
      <Card>
        <p className="text-sm text-sub">총 자산</p>
        <p className="mt-1 text-3xl font-extrabold">{coin(total)} <span className="text-base">코인</span></p>
        <p className={`font-semibold ${tone(ret)}`}>수익률 {pct(ret)}</p>
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div><p className="text-sub">보유 코인</p><p className="font-bold">{coin(me.cash)}</p></div>
          <div><p className="text-sub">주식 평가액</p><p className="font-bold">{coin(stockValue)}</p></div>
        </div>
        <p className="mt-3 text-xs text-sub">수익률 = (총 자산 − 받은 코인 {coin(principal)}) ÷ 받은 코인</p>
      </Card>

      <ErrorBanner msg={error ?? holds.error ?? trades.error} />

      <section>
        <h2 className="mb-2 font-bold">보유 종목</h2>
        {holds.rows.length === 0 ? (
          <p className="py-4 text-sm text-sub">아직 산 종목이 없어요. <Link href="/market" className="underline">시장 보기</Link></p>
        ) : (
          <ul className="divide-y divide-line">
            {holds.rows.map((h) => {
              const c = classes[h.classId];
              const now = c?.price ?? h.avgCost;
              const r = (now - h.avgCost) / h.avgCost;
              return (
                <li key={h.id}>
                  <Link href={`/stock/${encodeURIComponent(h.classId)}`} className="flex items-center py-3">
                    <div className="flex-1">
                      <p className="font-semibold">{c ? ticker(c) : h.classId}</p>
                      <p className="text-xs text-sub">{h.qty}주 · 평단 {price(h.avgCost)}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold">{coin(now * h.qty)}</p>
                      <p className={`text-sm ${tone(r)}`}>{pct(r)}</p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-bold">최근 거래</h2>
        {trades.rows.length === 0 ? (
          <p className="py-4 text-sm text-sub">거래 내역이 없어요</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {trades.rows.map((t) => (
              <li key={t.id} className="flex justify-between py-2">
                <span>
                  <b className={t.side === "buy" ? "text-up" : "text-down"}>{t.side === "buy" ? "매수" : "매도"}</b>{" "}
                  {ticker(t)} {t.qty}주
                </span>
                <span className="text-sub">{price(t.price)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
