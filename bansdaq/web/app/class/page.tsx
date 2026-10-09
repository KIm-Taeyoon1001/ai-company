"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, ErrorBanner } from "@/components/ui";
import { call, errMsg } from "@/lib/firebase";
import { useClass, useMe } from "@/lib/hooks";
import { approvalsNeeded, kst, LIST_MIN_MEMBERS, CHECKIN_REWARD, schoolYear } from "@/lib/engine";
import { pct, price, ticker, tone } from "@/lib/format";

type Pending = { uid: string; nickname: string; approvals: number; approvedByMe: boolean };

export default function ClassPage() {
  const router = useRouter();
  const { user, me, ready } = useMe();
  const { data: c } = useClass(me?.classId ?? null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (ready && (!user || !me || me.ay !== schoolYear())) router.replace("/join");
  }, [ready, user, me, router]);

  const loadPending = useCallback(async () => {
    try { setPending((await call<{ pending: Pending[] }>("listPending")).pending); } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { if (me?.status === "verified") loadPending(); }, [me?.status, loadPending]);

  if (!ready || !me) return <p className="pt-10 text-sub">불러오는 중…</p>;

  const today = kst().ymd;
  const checked = me.lastCheckin === today;
  const inviteUrl = typeof window === "undefined" ? "" :
    `${location.origin}/join?o=${me.officeCode}&s=${me.schoolCode}&n=${encodeURIComponent(me.schoolName)}&g=${me.grade}&c=${encodeURIComponent(me.classNm)}`;

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setError(null);
    try {
      const msg = await fn();
      if (msg) { setToast(msg); setTimeout(() => setToast(null), 2500); }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function invite() {
    const text = `${me!.schoolName} ${me!.grade}-${me!.classNm} 반스닥 상장까지 같이 가자 👀`;
    if (navigator.share) {
      try { await navigator.share({ title: "반스닥", text, url: inviteUrl }); return; } catch { /* 취소 */ }
    }
    await navigator.clipboard.writeText(`${text}\n${inviteUrl}`);
    setToast("초대 링크를 복사했어요");
    setTimeout(() => setToast(null), 2500);
  }

  const count = c?.verifiedCount ?? 1;

  return (
    <div className="space-y-4">
      <header>
        <p className="text-sm text-sub">{me.nickname}</p>
        <h1 className="text-2xl font-extrabold">{c ? ticker(c) : `${me.schoolName} ${me.grade}-${me.classNm}`}</h1>
      </header>

      {me.status === "pending" && (
        <Card>
          <p className="font-bold">반 친구 승인을 기다리는 중</p>
          <p className="mt-1 text-sm text-sub">
            같은 반 인증 멤버 {approvalsNeeded(count)}명이 승인하면 인증돼요. ({me.approvals.length}명 승인)
          </p>
          <Button className="mt-4" onClick={invite}>반 친구에게 승인 요청하기</Button>
          <Link href="/join" className="mt-3 block text-center text-sm text-sub underline">반을 잘못 골랐어요</Link>
        </Card>
      )}

      {me.status === "held" && (
        <Card><p className="font-bold text-up">신고가 접수돼 계정이 보류됐어요</p><p className="mt-1 text-sm text-sub">운영자 확인 후 풀려요.</p></Card>
      )}

      {c && !c.listed && (
        <Card>
          <p className="font-bold">상장 대기 {count}/{LIST_MIN_MEMBERS}</p>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.min(100, (count / LIST_MIN_MEMBERS) * 100)}%` }} />
          </div>
          <p className="mt-2 text-sm text-sub">{Math.max(0, LIST_MIN_MEMBERS - count)}명만 더 모이면 우리 반이 상장돼요</p>
          {me.status === "verified" && <Button className="mt-4" onClick={invite}>친구 초대하기</Button>}
        </Card>
      )}

      {c?.listed && (
        <Link href={`/stock/${encodeURIComponent(c.id)}`}>
          <Card>
            <p className="text-sm text-sub">우리 반 주가</p>
            <p className="mt-1 text-3xl font-extrabold">{price(c.price)}</p>
            <p className={`font-semibold ${tone(c.change)}`}>{pct(c.change)} · 활동 {Math.round(c.activity)}점</p>
          </Card>
        </Link>
      )}

      {me.status === "verified" && (
        <>
          <Card>
            <p className="font-bold">오늘 출석</p>
            <p className="mt-1 text-sm text-sub">출석하면 {CHECKIN_REWARD} 코인 + 우리 반 활동 점수가 올라요</p>
            <Button className="mt-4" disabled={checked || busy === "checkin"}
              onClick={() => run("checkin", async () => { await call("checkin"); return `+${CHECKIN_REWARD} 코인`; })}>
              {checked ? "오늘 출석 완료 ✓" : "출석하기"}
            </Button>
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <p className="font-bold">승인 대기 {pending.length}명</p>
              <button className="text-sm text-sub" onClick={loadPending}>새로고침</button>
            </div>
            {pending.length === 0 ? (
              <p className="mt-2 text-sm text-sub">대기 중인 친구가 없어요</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {pending.map((p) => (
                  <li key={p.uid} className="flex items-center gap-2 py-3">
                    <span className="flex-1 font-semibold">{p.nickname}</span>
                    <button disabled={busy !== null}
                      onClick={() => run(`report:${p.uid}`, async () => { await call("reportMember", { targetUid: p.uid }); await loadPending(); return "신고했어요"; })}
                      className="rounded-lg px-3 py-2 text-xs text-sub">우리 반 아님</button>
                    <button disabled={p.approvedByMe || busy !== null}
                      onClick={() => run(`ok:${p.uid}`, async () => { await call("approveMember", { targetUid: p.uid }); await loadPending(); return "승인했어요"; })}
                      className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
                      {p.approvedByMe ? "승인함" : "승인"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <ErrorBanner msg={error} />
      {toast && (
        <div className="fixed inset-x-0 bottom-24 z-30 mx-auto w-fit rounded-full bg-ink px-5 py-3 text-sm font-semibold text-bg">{toast}</div>
      )}
    </div>
  );
}
