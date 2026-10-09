import { NextRequest, NextResponse } from "next/server";
import { neis, schoolYear } from "@/lib/neis";

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const officeCode = p.get("officeCode");
  const schoolCode = p.get("schoolCode");
  const grade = p.get("grade");
  if (!officeCode || !schoolCode || !grade) return NextResponse.json({ classes: [] });

  try {
    const rows = await neis("classInfo", {
      pSize: "100",
      ATPT_OFCDC_SC_CODE: officeCode,
      SD_SCHUL_CODE: schoolCode,
      AY: String(schoolYear()),
      GRADE: grade,
    });
    const classes = Array.from(new Set(rows.map((r) => r.CLASS_NM))).sort(
      (a, b) => Number(a) - Number(b) || a.localeCompare(b),
    );
    return NextResponse.json({ classes, ay: schoolYear() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "조회 실패" }, { status: 502 });
  }
}
