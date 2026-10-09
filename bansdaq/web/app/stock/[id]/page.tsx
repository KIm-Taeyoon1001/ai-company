"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { collection, limit, orderBy, query } from "firebase/firestore";
import Chart from "@/components/Chart";
import { Button, Card, ErrorBanner, MarketBadge } from "@/components/ui";
import { call, errMsg, fb } from "@/lib/firebase";
import { useClass, useDocData, useMe, useNow, useQueryData } from "@/lib/hooks";
import { isMarketOpen, quote, MAX_ORDER_QTY, MAX_OWN_CLASS_SHARES, MAX_SHARES_PER_CLASS, FEE_RATE, type Side } from "@/lib/engine";
import { coin, isLimitUp, pct, price, ticker, tone } from "@/lib/format";
import type { Holding } from "@/lib/types";

export default function Stock() {
  const id = decodeURIComponent(useParams<{ id: string }>().id);
  const { user, me } = useMe();
  const { data: c, loading } = useClass(id);
  const { data: hold } = useDocData<Holding>(user ? `holdings/${user.uid}_${id}` : null);
  // 최근 30일을 내림차순으로 받아 뒤집는다 (문서 ID 역순 스캔은 Firestore 가 지원하지 않음)
  const days = useQueryData<{ close: number }>(
    () => query(collection(fb().db, `classes/${id}/days`), orderBy("date", "desc"), limit(30)),
    `days:${id}`,
  );
  const now = useNow();
  const open = isMarketOpen(now);

  const [side, setSide] = useState<Side>("buy");
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  if (loading) return <p className="pt-10 text-sub">불러오는 중…</p>;
  if (!c) return <p className="pt-10 text-sub">없는 종목이에요. <Link href="/market" className="underline">시장으로</Link></p>;

  const held = hold?.qty ?? 0;
  const own = me?.classId === id;
  const cap = own ? MAX_OWN_CLASS_SHARES : MAX_SHARES_PER_CLASS;
  const maxQty = side === "buy" ? Math.min(MAX_ORDER_QTY, cap - held) : held;
  const est = c.listed ? quote(c.price, c.prevClose, side, Math.max(1, qty)) : null;
  const closes = [...days.rows.map((d) => d.close).reverse(), c.price];
  const limitUp = isLimitUp(c.change);

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await call<{ executedPrice: number; cash: number }>("trade", { classId: id, side, qty });
      setDone(`${qty}주 ${side === "buy" ? "매수" : "매도"} · 체결가 ${price(r.executedPrice)} · 잔고 ${coin(r.cash)}`);
      setQty(1);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    setSharing(true);
    try {
      const url = `/api/og?c=${encodeURIComponent(id)}`;
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], "bansdaq.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: `${location.origin}/stock/${encodeURIComponent(id)}` });
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "bansdaq.png";
        a.click();
      }
    } catch { /* 공유 취소 */ } finally {
      setSharing(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <div className="flex items-center justify-between">
          <p className="text-sm text-sub">{c.schoolName}{own && " · 우리 반"}</p>
          <MarketBadge open={open} />
        </div>
        <h1 className="text-xl font-bold">{ticker(c)}</h1>
        {c.listed ? (
          <>
            <p className={`mt-1 text-4xl font-extrabold ${limitUp ? "limit-up text-up" : ""}`}>{price(c.price)}</p>
            <p className={`font-semibold ${tone(c.change)}`}>
              {limitUp && "🔥 상한가 "}{c.price - c.prevClose >= 0 ? "+" : ""}{price(Math.round((c.price - c.prevClose) * 100) / 100)} ({pct(c.change)})
            </p>
          </>
        ) : (
          <p className="mt-2 text-sub">{c.delisted ? "상장폐지된 종목이에요" : `상장 대기 중 (${c.verifiedCount}/5명)`}</p>
        )}
      </header>

      {c.listed && <Chart points={closes} up={c.price >= (closes[0] ?? c.price)} />}
      <ErrorBanner msg={days.error} />

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="활동 점수" value={`${Math.round(c.activity)}점`} />
        <Stat label="오늘 거래량" value={`${coin(c.volumeToday)}주`} />
        <Stat label="내 보유" value={`${held}주`} />
      </div>

      {c.listed && me?.status === "verified" && (
        <Card>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-line p-1">
            {(["buy", "sell"] as const).map((s) => (
              <button key={s} onClick={() => { setSide(s); setQty(1); }}
                className={`rounded-lg py-2 text-sm font-bold ${side === s ? (s === "buy" ? "bg-up text-white" : "bg-down text-white") : "text-sub"}`}>
                {s === "buy" ? "사기" : "팔기"}
              </button>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button onClick={() => setQty(Math.max(1, qty - 1))} className="h-12 w-12 rounded-full bg-line text-xl font-bold">−</button>
            <input type="number" inputMode="numeric" value={qty} min={1} max={Math.max(1, maxQty)}
              onChange={(e) => setQty(Math.max(1, Math.min(MAX_ORDER_QTY, Math.floor(Number(e.target.value) || 1))))}
              className="w-24 bg-transparent text-center text-3xl font-extrabold outline-none" />
            <button onClick={() => setQty(Math.min(Math.max(1, maxQty), qty + 1))} className="h-12 w-12 rounded-full bg-line text-xl font-bold">+</button>
          </div>
          <p className="mt-1 text-center text-xs text-sub">
            {side === "buy" ? `최대 ${cap}주 보유 가능${own ? " (우리 반)" : ""}` : `보유 ${held}주`}
          </p>

          {est && (
            <dl className="mt-4 space-y-1 text-sm">
              <Row k="예상 체결가" v={price(est.exec)} />
              <Row k={`수수료 (${FEE_RATE * 100}%, 소각)`} v={`${coin(est.fee)}`} />
              <Row k={side === "buy" ? "필요 코인" : "받을 코인"} v={coin(Math.abs(est.cashDelta))} strong />
              <Row k="내 코인" v={coin(me.cash)} />
            </dl>
          )}

          <ErrorBanner msg={error} />
          {done && <p className="mt-3 rounded-xl bg-down/10 px-4 py-3 text-sm text-down">{done}</p>}
          <Button className={`mt-4 ${side === "sell" ? "!bg-down" : ""}`}
            disabled={!open || busy || maxQty < 1 || qty > maxQty}
            onClick={submit}>
            {!open ? "장 마감 시간이에요" : busy ? "주문 중…" : `${qty}주 ${side === "buy" ? "사기" : "팔기"}`}
          </Button>
        </Card>
      )}

      {c.listed && !me && (
        <Link href="/join" className="block rounded-2xl bg-brand py-4 text-center font-bold text-white">가입하고 거래하기</Link>
      )}

      {c.listed && (
        <button onClick={share} disabled={sharing} className="w-full rounded-2xl bg-card py-4 text-sm font-bold">
          {sharing ? "카드 만드는 중…" : "📸 인스타 스토리로 자랑하기"}
        </button>
      )}

      <p className="text-center text-xs text-sub">
        장 시간 · 평일 07:00–08:30 / 12:00–13:30 / 16:00–23:00 · 주말 09:00–23:00
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-card py-3">
      <p className="text-xs text-sub">{label}</p>
      <p className="mt-1 font-bold">{value}</p>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-sub">{k}</dt>
      <dd className={strong ? "font-bold" : ""}>{v}</dd>
    </div>
  );
}
