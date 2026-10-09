import Link from "next/link";
import type { ClassDoc } from "@/lib/types";
import { pct, price, ticker, tone, isLimitUp } from "@/lib/format";

export function Button({ className = "", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`w-full rounded-2xl bg-brand py-4 text-base font-bold text-white active:scale-[0.98] transition disabled:opacity-40 ${className}`}
    />
  );
}

export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <section className={`rounded-3xl bg-card p-5 ${className}`}>{children}</section>;
}

export function ErrorBanner({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p className="my-3 rounded-xl bg-up/10 px-4 py-3 text-sm text-up">{msg}</p>;
}

export function StockRow({ c, rank }: { c: ClassDoc; rank?: number }) {
  return (
    <li>
      <Link href={`/stock/${encodeURIComponent(c.id)}`} className="flex items-center gap-3 py-3 active:bg-card rounded-xl">
        {rank !== undefined && <span className="w-6 text-center text-sm font-bold text-sub">{rank}</span>}
        <div className="flex-1 min-w-0">
          <p className="truncate font-semibold">{ticker(c)}</p>
          <p className="text-xs text-sub">
            {c.listed ? `활동 ${Math.round(c.activity)}점` : c.delisted ? "상장폐지" : `상장 대기 ${c.verifiedCount}/5`}
          </p>
        </div>
        {c.listed ? (
          <div className="text-right">
            <p className="font-bold">{price(c.price)}</p>
            <p className={`text-sm font-semibold ${tone(c.change)} ${isLimitUp(c.change) ? "limit-up" : ""}`}>
              {isLimitUp(c.change) ? "🔥상한가 " : ""}{pct(c.change)}
            </p>
          </div>
        ) : (
          <span className="text-xs text-sub">IPO 전</span>
        )}
      </Link>
    </li>
  );
}

export function MarketBadge({ open }: { open: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${open ? "bg-up/10 text-up" : "bg-line text-sub"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${open ? "bg-up" : "bg-sub"}`} />
      {open ? "장 열림" : "장 마감"}
    </span>
  );
}
