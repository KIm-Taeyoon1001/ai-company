/** 일봉 종가 라인 차트. 데이터가 적어 라이브러리 없이 SVG 로 그린다. */
export default function Chart({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) {
    return <div className="flex h-40 items-center justify-center text-sm text-sub">차트는 이틀치 종가가 쌓이면 보여요</div>;
  }
  const W = 320, H = 140, pad = 6;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((p, i) => [
    pad + (i * (W - pad * 2)) / (points.length - 1),
    pad + (1 - (p - min) / span) * (H - pad * 2),
  ]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const color = up ? "var(--color-up)" : "var(--color-down)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label="일봉 종가 차트">
      <path d={`${line} L${W - pad},${H} L${pad},${H} Z`} fill={color} opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" />
    </svg>
  );
}
