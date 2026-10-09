// 나이스 교육정보 개방 포털. 키는 서버에만 둔다.
export function schoolYear(): number {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const y = now.getUTCFullYear();
  return now.getUTCMonth() + 1 < 3 ? y - 1 : y;
}

export async function neis(path: string, params: Record<string, string>) {
  const key = process.env.NEIS_KEY;
  if (!key) throw new Error("NEIS_KEY 가 설정되지 않았습니다.");
  const url = new URL(`https://open.neis.go.kr/hub/${path}`);
  url.search = new URLSearchParams({ KEY: key, Type: "json", pIndex: "1", ...params }).toString();
  const res = await fetch(url, { next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`나이스 응답 오류 ${res.status}`);
  const json = await res.json();
  // 결과 0건이면 { RESULT: { CODE: "INFO-200" } } 만 온다
  return (json[path]?.[1]?.row ?? []) as Record<string, string>[];
}
