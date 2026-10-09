import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

// 인스타 스토리 1080x1920 카드. 문구를 쿼리로 받지 않고 classId 로 실제 시세를 읽는다
// → 남의 반 이름으로 가짜 카드를 만드는 장난을 막는다.

type FsValue = { stringValue?: string; integerValue?: string; doubleValue?: number; booleanValue?: boolean };

async function readClass(id: string) {
  const pid = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/classes/${encodeURIComponent(id)}`,
    { next: { revalidate: 60 } },
  );
  if (!res.ok) return null;
  const { fields } = (await res.json()) as { fields: Record<string, FsValue> };
  const s = (k: string) => fields[k]?.stringValue ?? "";
  const n = (k: string) => Number(fields[k]?.doubleValue ?? fields[k]?.integerValue ?? 0);
  return { schoolName: s("schoolName"), grade: s("grade"), classNm: s("classNm"), price: n("price"), prevClose: n("prevClose") || 100, listed: fields.listed?.booleanValue === true };
}

async function font(text: string) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@900&text=${encodeURIComponent(text)}`)).text();
  const url = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/)?.[1];
  if (!url) throw new Error("폰트를 불러오지 못했습니다.");
  return (await fetch(url)).arrayBuffer();
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("c") ?? "";
  const c = id && !id.includes("/") ? await readClass(id) : null;
  if (!c || !c.listed) return new Response("not found", { status: 404 });

  const change = c.price / c.prevClose - 1;
  const up = change >= 0;
  const limit = change >= 0.2999;
  const name = `${c.schoolName.replace(/고등학교$/, "고").replace(/중학교$/, "중")} ${c.grade}-${c.classNm}`;
  const headline = limit ? "상한가 🔥" : up ? "상승 중 📈" : "줍줍 찬스 📉";
  const pctText = `${up ? "+" : ""}${(change * 100).toFixed(2)}%`;
  const priceText = `${Math.round(c.price).toLocaleString("ko-KR")} 코인`;
  const sub = "너네 반 지금 몇 위인지 봐 👀";
  const text = `반스닥${name}${headline}${pctText}${priceText}${sub}가상게임코인이며실제돈과무관합니다`;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", background: limit ? "linear-gradient(180deg,#1a0000,#f04452)" : "#191f28", color: "white", fontFamily: "NotoKR" }}>
        <div style={{ fontSize: 56, opacity: 0.8 }}>반스닥</div>
        <div style={{ fontSize: 110, marginTop: 40 }}>{name}</div>
        <div style={{ fontSize: 140, marginTop: 40, color: limit ? "#ffe066" : up ? "#ff6b77" : "#6ea8ff" }}>{headline}</div>
        <div style={{ fontSize: 120, marginTop: 30 }}>{pctText}</div>
        <div style={{ fontSize: 64, marginTop: 20, opacity: 0.85 }}>{priceText}</div>
        <div style={{ fontSize: 56, marginTop: 160 }}>{sub}</div>
        <div style={{ fontSize: 30, marginTop: 40, opacity: 0.6 }}>가상 게임 코인이며 실제 돈과 무관합니다</div>
      </div>
    ),
    { width: 1080, height: 1920, fonts: [{ name: "NotoKR", data: await font(text), weight: 900 }], emoji: "twemoji" },
  );
}
