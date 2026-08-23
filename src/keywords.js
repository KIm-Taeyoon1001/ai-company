// keywords.js — 무엇을 쓸지 찾는다. 의존성 0.
//
// 실시간 트렌드(연예·스포츠·주식)는 블로그가 못 이긴다. 뉴스 사이트가 즉시 상위를 먹고
// 이틀이면 아무도 안 찾는다. 우리가 이기는 건 "꾸준히 검색되는 질문"이다.
//
// 그 질문을 어디서 얻는가: 검색창 자동완성. 사람이 실제로 타이핑한 것만 나온다.
// 구글과 네이버 둘 다 본다 — 50대는 네이버를, 구글은 정보성 질의를 더 많이 담는다.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * 블로그의 축. 넓게 가되 무작위로 흩어지지 않게 한다.
 * 글이 쌓일수록 검색엔진은 "이 블로그가 뭘 다루는 곳인지"를 본다.
 */
export const PILLARS = {
  건강: [
    '건강검진', '혈압', '당뇨', '콜레스테롤', '관절염', '허리디스크',
    '갱년기', '수면', '눈 건강', '치과 임플란트', '위내시경', '골다공증',
  ],
  돈: [
    '국민연금', '퇴직연금', '기초연금', '건강보험료', '연말정산', '종합소득세',
    '실비보험', '주택연금', '상속세', '증여세', '예금 금리', '퇴직금',
  ],
  생활행정: [
    '주민센터', '자동차 보험', '운전면허 갱신', '여권 발급', '전입신고',
    '재산세', '전기요금', '실업급여', '기초생활수급', '장기요양등급',
  ],
  가족: [
    '자녀 결혼', '혼수', '축의금', '상견례', '장례식', '제사',
    '손주 돌잔치', '부모님 요양원', '가족관계증명서',
  ],
  여가: [
    '등산', '텃밭', '캠핑', '국내 여행', '온천', '골프 입문',
    '스마트폰 사용법', '카카오톡 기능', '유튜브 보는 법',
  ],
};

/** 검색해도 우리가 못 이기는 것들. 공식 사이트·사전이 먹는 질의다. */
const LOSING = [
  /홈페이지|사이트|바로가기|로그인|앱 다운|다운로드/,
  /고객센터|전화번호|콜센터|주소|위치|가는 ?길/,
  /영어로|뜻$|무슨 ?뜻|한자/,
  /^[가-힣]{1,3}$/, // 너무 짧은 단일어 — 경쟁이 과열돼 있다
];

/** 정보를 찾는 질의인가. 이런 건 잘 쓴 글이 이길 수 있다. */
const WINNING = [
  /방법|하는 ?법|어떻게|절차|순서/,
  /비용|가격|얼마|요금|수수료/,
  /기준|조건|자격|대상|나이/,
  /차이|비교|vs|어느 ?것/,
  /증상|원인|예방|관리|주의/,
  /준비물|서류|신청/,
  /후기|경험/,
];

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' } });
  if (!res.ok) throw new Error(`${res.status}`);
  return JSON.parse(await res.text());
}

/** 구글 검색창이 제안하는 것 */
export async function googleSuggest(seed) {
  try {
    const j = await getJSON(
      `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=kr&q=${encodeURIComponent(seed)}`
    );
    return Array.isArray(j?.[1]) ? j[1] : [];
  } catch {
    return [];
  }
}

/** 네이버 검색창이 제안하는 것. 50대 독자는 여기서 검색하는 비율이 높다. */
export async function naverSuggest(seed) {
  try {
    const j = await getJSON(
      `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(seed)}&st=100&r_format=json&r_enc=UTF-8&q_enc=UTF-8&frm=nv`
    );
    return (j?.items?.[0] || []).map((x) => x?.[0]).filter(Boolean);
  } catch {
    return [];
  }
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function score(q) {
  let s = 0;
  for (const re of WINNING) if (re.test(q)) s += 2;
  const words = q.split(/\s+/).length;
  if (words >= 3) s += 2; // 긴 질의일수록 경쟁이 옅다
  else if (words === 2) s += 1;
  if (q.length >= 10) s += 1;
  return s;
}

function usable(q) {
  const t = norm(q);
  if (t.length < 4) return false;
  return !LOSING.some((re) => re.test(t));
}

/**
 * 씨앗 하나를 실제 검색 질의들로 넓힌다.
 * 씨앗 + 한글자씩 붙여 자동완성을 여러 번 부르면 훨씬 깊이 들어간다.
 */
export async function expand(seed, { deep = true } = {}) {
  const probes = [seed];
  if (deep) for (const suffix of ['', ' 방법', ' 비용', ' 기준', ' 나이', ' 증상']) probes.push(`${seed}${suffix}`);

  const found = new Map();
  for (const p of probes) {
    const [g, n] = await Promise.all([googleSuggest(p), naverSuggest(p)]);
    for (const [list, where] of [[g, 'google'], [n, 'naver']]) {
      for (const raw of list) {
        const q = norm(raw);
        if (!usable(q)) continue;
        const hit = found.get(q) || { query: q, seed, sources: new Set() };
        hit.sources.add(where);
        found.set(q, hit);
      }
    }
  }

  return [...found.values()]
    .map((h) => ({
      query: h.query,
      seed,
      sources: [...h.sources],
      // 양쪽 검색엔진이 모두 제안하면 수요가 확실하다
      score: score(h.query) + (h.sources.size > 1 ? 3 : 0),
    }))
    .sort((a, b) => b.score - a.score);
}

/** 축 하나를 통째로 훑는다. */
export async function surveyPillar(name, { perSeed = 6, seeds } = {}) {
  const list = seeds || PILLARS[name] || [];
  const out = [];
  for (const seed of list) {
    const rows = await expand(seed);
    out.push(...rows.slice(0, perSeed));
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 오늘 무엇이 뜨는가. 계절·이슈 감지용 보조 신호다. 이걸로 글을 쓰지는 않는다. */
export async function todayTrends() {
  try {
    const res = await fetch('https://trends.google.com/trending/rss?geo=KR', { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const xml = await res.text();
    const out = [];
    const re = /<title>([^<]*)<\/title>[\s\S]*?<ht:approx_traffic>([^<]*)<\/ht:approx_traffic>/g;
    let m;
    while ((m = re.exec(xml))) {
      const title = norm(m[1]);
      if (title === 'Daily Search Trends') continue;
      out.push({ query: title, traffic: norm(m[2]) });
    }
    return out;
  } catch {
    return [];
  }
}
