// 구글: Custom Search JSON API(자연 검색 TOP 10) + Places API(New)(비즈니스 프로필 순서·평점). 공식 API만.
import type { Entity } from "./types";
import { matchesEntity } from "./naver-api";

export type GoogleCseEnv = { GOOGLE_CSE_KEY: string; GOOGLE_CSE_CX: string };
export type GoogleSerpResult = {
  keyword: string;
  items: { title: string; link: string; position: number }[];
  entities: Record<string, { rank: number | null }>;
};

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export async function collectGoogleSerp(keyword: string, entities: (Entity & { website?: string | null })[], env: GoogleCseEnv, fetchImpl: typeof fetch = fetch): Promise<GoogleSerpResult> {
  const u = new URL("https://www.googleapis.com/customsearch/v1");
  u.searchParams.set("key", env.GOOGLE_CSE_KEY);
  u.searchParams.set("cx", env.GOOGLE_CSE_CX);
  u.searchParams.set("q", keyword);
  u.searchParams.set("gl", "kr");
  u.searchParams.set("hl", "ko");
  u.searchParams.set("num", "10");
  const res = await fetchImpl(u.href, { signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw new Error("GOOGLE_CSE_QUOTA");
  if (!res.ok) throw new Error(`GOOGLE_CSE_HTTP_${res.status}`);
  const j = (await res.json()) as { items?: { title: string; link: string; snippet?: string }[] };
  const items = (j.items || []).map((it, i) => ({ title: it.title, link: it.link, position: i + 1, snippet: it.snippet || "" }));
  const out: GoogleSerpResult = { keyword, items: items.map(({ title, link, position }) => ({ title, link, position })), entities: {} };
  for (const e of entities) {
    const host = e.website ? hostOf(e.website) : "";
    const idx = items.findIndex((it) => (host && hostOf(it.link) === host) || matchesEntity(it.title + " " + it.snippet, e));
    out.entities[e.key] = { rank: idx >= 0 ? idx + 1 : null };
  }
  return out;
}

export type PlacesEnv = { GOOGLE_PLACES_KEY: string };
export type GooglePlacesResult = {
  keyword: string;
  places: { id: string; name: string; rating: number | null; ratingCount: number | null; position: number }[];
  entities: Record<string, { rank: number | null; rating: number | null; ratingCount: number | null; placeId: string | null }>;
};

export async function collectGooglePlaces(keyword: string, entities: (Entity & { googlePlaceId?: string | null })[], env: PlacesEnv, fetchImpl: typeof fetch = fetch): Promise<GooglePlacesResult> {
  const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({ textQuery: keyword, languageCode: "ko", regionCode: "KR", pageSize: 10 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GOOGLE_PLACES_HTTP_${res.status}`);
  const j = (await res.json()) as { places?: { id: string; displayName?: { text: string }; rating?: number; userRatingCount?: number }[] };
  const places = (j.places || []).map((p, i) => ({ id: p.id, name: p.displayName?.text || "", rating: p.rating ?? null, ratingCount: p.userRatingCount ?? null, position: i + 1 }));
  const out: GooglePlacesResult = { keyword, places, entities: {} };
  for (const e of entities) {
    const idx = places.findIndex((p) => (e.googlePlaceId && p.id === e.googlePlaceId) || matchesEntity(p.name, e));
    const p = idx >= 0 ? places[idx] : null;
    out.entities[e.key] = { rank: idx >= 0 ? idx + 1 : null, rating: p?.rating ?? null, ratingCount: p?.ratingCount ?? null, placeId: p?.id ?? null };
  }
  return out;
}
