// 네이버 공식 검색 API(개발자센터 등록, 무료 25,000회/일). robots 정책과 무관한 정식 경로.
//  - 지역(local): 키워드별 상위 5개 장소 → 플레이스 순위 근사(1~5위, 그 밖은 '5위 밖')
//  - 블로그·카페: 상위 10건 제목/요약에 병원명 등장 여부 → '다른 섹션 노출'
import type { Entity } from "./types";

export type NaverApiEnv = { NAVER_CLIENT_ID: string; NAVER_CLIENT_SECRET: string };
type LocalItem = { title: string; category: string; address: string; roadAddress: string; link: string; mapx: string; mapy: string };
type TextItem = { title: string; description: string; link: string };

const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
const norm = (s: string) => s.replace(/\s+/g, "").replace(/의원|병원/g, "");
export function matchesEntity(text: string, e: Entity): boolean {
  const t = norm(text);
  return [e.name, ...e.aliases].filter(Boolean).some((a) => norm(a).length >= 2 && t.includes(norm(a)));
}

async function call<T>(env: NaverApiEnv, path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<{ items: T[]; total: number }> {
  const u = new URL(`https://openapi.naver.com/v1/search/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetchImpl(u.href, {
    headers: { "X-Naver-Client-Id": env.NAVER_CLIENT_ID, "X-Naver-Client-Secret": env.NAVER_CLIENT_SECRET },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) throw new Error("NAVER_API_RATE_LIMIT");
  if (!res.ok) throw new Error(`NAVER_API_HTTP_${res.status}`);
  const j = (await res.json()) as { items?: T[]; total?: number };
  return { items: j.items || [], total: j.total || 0 };
}

export type NaverApiKeywordResult = {
  keyword: string;
  local: { name: string; category: string; address: string; position: number }[];
  blogHits: Record<string, number>;
  cafeHits: Record<string, number>;
  entities: Record<string, { localRank: number | null; blog: boolean; cafe: boolean }>;
};

export async function collectNaverApi(keyword: string, entities: Entity[], env: NaverApiEnv, fetchImpl: typeof fetch = fetch): Promise<NaverApiKeywordResult> {
  const local = await call<LocalItem>(env, "local.json", { query: keyword, display: "5", sort: "random" }, fetchImpl);
  const blog = await call<TextItem>(env, "blog.json", { query: keyword, display: "10", sort: "sim" }, fetchImpl);
  const cafe = await call<TextItem>(env, "cafearticle.json", { query: keyword, display: "10", sort: "sim" }, fetchImpl);
  const localList = local.items.map((it, i) => ({ name: strip(it.title), category: it.category, address: it.roadAddress || it.address, position: i + 1 }));
  const result: NaverApiKeywordResult = { keyword, local: localList, blogHits: {}, cafeHits: {}, entities: {} };
  for (const e of entities) {
    const idx = localList.findIndex((it) => matchesEntity(it.name, e));
    const blogN = blog.items.filter((it) => matchesEntity(strip(it.title) + " " + strip(it.description), e)).length;
    const cafeN = cafe.items.filter((it) => matchesEntity(strip(it.title) + " " + strip(it.description), e)).length;
    result.blogHits[e.key] = blogN;
    result.cafeHits[e.key] = cafeN;
    result.entities[e.key] = { localRank: idx >= 0 ? idx + 1 : null, blog: blogN > 0, cafe: cafeN > 0 };
  }
  return result;
}
