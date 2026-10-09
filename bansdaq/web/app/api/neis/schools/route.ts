import { NextRequest, NextResponse } from "next/server";
import { neis } from "@/lib/neis";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2 || q.length > 30) return NextResponse.json({ schools: [] });

  try {
    const rows = await neis("schoolInfo", { pSize: "30", SCHUL_NM: q });
    const schools = rows
      .filter((s) => s.SCHUL_KND_SC_NM === "중학교" || s.SCHUL_KND_SC_NM === "고등학교")
      .map((s) => ({
        officeCode: s.ATPT_OFCDC_SC_CODE,
        schoolCode: s.SD_SCHUL_CODE,
        name: s.SCHUL_NM,
        kind: s.SCHUL_KND_SC_NM,
        address: s.ORG_RDNMA,
      }));
    return NextResponse.json({ schools });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "검색 실패" }, { status: 502 });
  }
}
