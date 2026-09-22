// 카카오맵: 카카오 로컬 REST API(공식·무료). 키워드 검색 결과 순서 = 순위. 평점·리뷰 수는 공식 API에 없음(미측정).
import type { Entity } from "./types";
import { matchesEntity } from "./naver-api";

export type KakaoEnv = { KAKAO_REST_KEY: string };
export type KakaoResult = {
  keyword: string;
  places: { id: string; name: string; category: string; address: string; position: number }[];
  entities: Record<string, { rank: number | null; placeId: string | null }>;
};

export async function collectKakao(keyword: string, entities: (Entity & { kakaoPlaceId?: string | null })[], env: KakaoEnv, fetchImpl: typeof fetch = fetch): Promise<KakaoResult> {
  const u = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
  u.searchParams.set("query", keyword);
  u.searchParams.set("size", "15");
  const res = await fetchImpl(u.href, { headers: { Authorization: `KakaoAK ${env.KAKAO_REST_KEY}` }, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw new Error("KAKAO_RATE_LIMIT");
  if (!res.ok) throw new Error(`KAKAO_HTTP_${res.status}`);
  const j = (await res.json()) as { documents?: { id: string; place_name: string; category_name: string; road_address_name: string; address_name: string }[] };
  const places = (j.documents || []).map((d, i) => ({ id: d.id, name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name, position: i + 1 }));
  const out: KakaoResult = { keyword, places, entities: {} };
  for (const e of entities) {
    const idx = places.findIndex((p) => (e.kakaoPlaceId && p.id === e.kakaoPlaceId) || matchesEntity(p.name, e));
    out.entities[e.key] = { rank: idx >= 0 ? idx + 1 : null, placeId: idx >= 0 ? places[idx].id : null };
  }
  return out;
}
