"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import SchoolSearch from "@/components/SchoolSearch";
import { Button, ErrorBanner } from "@/components/ui";
import { call, errMsg, fb } from "@/lib/firebase";
import { useMe } from "@/lib/hooks";
import { ageFrom, validBirthDate, validNickname, makeNickname, MIN_AGE, NICK_ADJ, NICK_NOUN, schoolYear } from "@/lib/engine";
import type { School } from "@/lib/types";

export default function JoinPage() {
  return <Suspense><Join /></Suspense>;
}

function Join() {
  const router = useRouter();
  const sp = useSearchParams();
  const { user, me, ready } = useMe();

  // 초대 링크로 들어오면 학교·학년·반이 미리 채워져 있다
  const [school, setSchool] = useState<School | null>(() =>
    sp.get("o") && sp.get("s")
      ? { officeCode: sp.get("o")!, schoolCode: sp.get("s")!, name: sp.get("n") ?? "", kind: "", address: "" }
      : null,
  );
  const [grade, setGrade] = useState(sp.get("g") ?? "");
  const [classNm, setClassNm] = useState(sp.get("c") ?? "");
  const [classes, setClasses] = useState<string[]>([]);
  const [birth, setBirth] = useState("");
  // 닉네임은 프리셋 조합만. 처음엔 무작위로 하나 골라 둔다
  const [adj, setAdj] = useState<string>(() => pick(NICK_ADJ));
  const [noun, setNoun] = useState<string>(() => pick(NICK_NOUN));
  const [num, setNum] = useState(() => Math.floor(Math.random() * 100));
  const nickname = makeNickname(adj, noun, num);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const already = me && me.ay === schoolYear() && me.status !== "pending";
  useEffect(() => { if (already) router.replace("/class"); }, [already, router]);

  useEffect(() => {
    if (!school || !grade) { setClasses([]); return; }
    fetch(`/api/neis/classes?officeCode=${school.officeCode}&schoolCode=${school.schoolCode}&grade=${grade}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) setError(j.error); else setClasses(j.classes); })
      .catch(() => setError("반 목록을 불러오지 못했습니다."));
  }, [school, grade]);

  const birthOk = validBirthDate(birth) && ageFrom(birth) >= MIN_AGE;
  const tooYoung = validBirthDate(birth) && ageFrom(birth) < MIN_AGE;

  async function login() {
    setError(null);
    try { await signInWithPopup(fb().auth, new GoogleAuthProvider()); } catch (e) { setError(errMsg(e)); }
  }

  async function submit() {
    if (!school) return;
    setBusy(true);
    setError(null);
    try {
      await call("joinClass", {
        nickname, birthDate: birth,
        officeCode: school.officeCode, schoolCode: school.schoolCode, grade, classNm,
      });
      router.replace("/class");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <p className="pt-10 text-sub">불러오는 중…</p>;

  if (!user) {
    return (
      <div className="pt-10">
        <h1 className="text-2xl font-extrabold">우리 반 상장시키기</h1>
        {school && <p className="mt-2 text-sub">{school.name} {grade && `${grade}학년`} {classNm && `${classNm}반`} 초대를 받았어요</p>}
        <ErrorBanner msg={error} />
        <Button className="mt-8 !bg-ink" onClick={login}>Google 로 시작하기</Button>
        <p className="mt-4 text-center text-xs text-sub">이름·전화번호·사진은 받지 않아요</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 pt-6">
      <h1 className="text-2xl font-extrabold">{me?.status === "pending" ? "반 다시 고르기" : "가입하기"}</h1>

      <Step n={1} title="생년월일">
        <input type="date" value={birth} onChange={(e) => setBirth(e.target.value)}
          className="w-full rounded-2xl bg-card px-5 py-4 text-base outline-none" />
        {tooYoung && <p className="mt-2 text-sm text-up">만 14세 이상만 가입할 수 있어요.</p>}
        <p className="mt-2 text-xs text-sub">나이 확인에만 쓰고 출생연도만 저장해요.</p>
      </Step>

      {birthOk && (
        <Step n={2} title="학교">
          {school ? (
            <div className="flex items-center justify-between rounded-2xl bg-card px-5 py-4">
              <span className="font-semibold">{school.name}</span>
              <button className="text-sm text-sub" onClick={() => { setSchool(null); setGrade(""); setClassNm(""); }}>변경</button>
            </div>
          ) : (
            <SchoolSearch onPick={(s) => { setSchool(s); setGrade(""); setClassNm(""); }} />
          )}
        </Step>
      )}

      {birthOk && school && (
        <Step n={3} title="학년">
          <div className="grid grid-cols-3 gap-2">
            {["1", "2", "3"].map((g) => (
              <Chip key={g} on={grade === g} onClick={() => { setGrade(g); setClassNm(""); }}>{g}학년</Chip>
            ))}
          </div>
        </Step>
      )}

      {birthOk && school && grade && (
        <Step n={4} title="반">
          {classes.length === 0 ? (
            <p className="text-sm text-sub">반 목록을 불러오는 중…</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {classes.map((c) => <Chip key={c} on={classNm === c} onClick={() => setClassNm(c)}>{c}반</Chip>)}
            </div>
          )}
        </Step>
      )}

      {birthOk && school && grade && classNm && (
        <Step n={5} title="닉네임">
          <div className="flex items-center justify-between rounded-2xl bg-card px-5 py-4">
            <span className="text-lg font-bold">{nickname}</span>
            <button className="text-sm font-semibold text-brand"
              onClick={() => { setAdj(pick(NICK_ADJ)); setNoun(pick(NICK_NOUN)); setNum(Math.floor(Math.random() * 100)); }}>
              🎲 랜덤
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <select value={adj} onChange={(e) => setAdj(e.target.value)} className="rounded-xl bg-card px-3 py-3 outline-none">
              {NICK_ADJ.map((a) => <option key={a}>{a}</option>)}
            </select>
            <select value={noun} onChange={(e) => setNoun(e.target.value)} className="rounded-xl bg-card px-3 py-3 outline-none">
              {NICK_NOUN.map((n) => <option key={n}>{n}</option>)}
            </select>
          </div>
          <p className="mt-2 text-xs text-sub">랭킹에 공개돼요. 놀림에 쓰이지 않게 정해진 단어만 고를 수 있어요.</p>
          <ErrorBanner msg={error} />
          <Button className="mt-6" disabled={busy || !validNickname(nickname)} onClick={submit}>
            {busy ? "확인 중…" : "참여하기"}
          </Button>
        </Step>
      )}
      {!(birthOk && school && grade && classNm) && <ErrorBanner msg={error} />}
    </div>
  );
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-3 text-sm font-bold text-sub">{n}. {title}</p>
      {children}
    </section>
  );
}

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`rounded-xl py-3 text-sm font-semibold transition ${on ? "bg-brand text-white" : "bg-card"}`}>
      {children}
    </button>
  );
}
