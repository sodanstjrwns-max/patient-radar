// 네이버 플레이스 상세 — 방문자 리뷰·블로그 리뷰 수. 키 없이 m.place.naver.com/place/<id>/home (→ /hospital/<id>/home 리다이렉트).
// 1차 출처: og:description "방문자리뷰 8,153 · 블로그리뷰 3,481", 2차: __APOLLO_STATE__ 의 visitorReviewsTotal / cafeBlogReviewsTotal.
import { NAVER_MOBILE_UA } from "./naver-serp";
import { safeNaverFetch } from "./safe-fetch";
import type { NaverPlaceSnapshot } from "./types";

const num = (s: string | undefined | null) =>
  s == null ? null : Number(String(s).replace(/[^0-9]/g, "")) || 0;

export function parsePlaceHome(
  placeId: string,
  html: string,
): NaverPlaceSnapshot {
  const og =
    /property="og:description" content="([^"]*)"/.exec(html)?.[1] || "";
  const visitor =
    /방문자리뷰\s*([\d,]+)/.exec(og)?.[1] ??
    /"visitorReviewsTotal":(\d+)/.exec(html)?.[1];
  const blog =
    /블로그리뷰\s*([\d,]+)/.exec(og)?.[1] ??
    /"cafeBlogReviewsTotal":(\d+)/.exec(html)?.[1];
  const name =
    /property="og:title" content="([^"]*)"/
      .exec(html)?.[1]
      ?.replace(/\s*:\s*네이버.*$/, "") || null;
  const category = /"category":"([^"]{1,30})"/.exec(html)?.[1] || null;
  const road = /"roadAddress":"([^"]{1,120})"/.exec(html)?.[1] || null;
  return {
    placeId,
    name,
    category,
    roadAddress: road,
    visitorReviews: num(visitor),
    blogReviews: num(blog),
    fetchedAt: new Date().toISOString(),
  };
}

export async function collectNaverPlace(
  placeId: string,
  fetchImpl: typeof fetch = safeNaverFetch,
): Promise<NaverPlaceSnapshot> {
  if (!/^\d{1,20}$/.test(placeId)) throw new Error("INVALID_PLACE_ID");
  const res = await fetchImpl(
    `https://m.place.naver.com/place/${placeId}/home`,
    {
      headers: {
        "User-Agent": NAVER_MOBILE_UA,
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
      redirect: "follow",
    },
  );
  if (!res.ok) throw new Error(`naver place http ${res.status}`);
  return parsePlaceHome(placeId, await res.text());
}
