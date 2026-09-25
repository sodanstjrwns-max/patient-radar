// 네이버 플레이스 상세 — 방문자 리뷰·블로그 리뷰 수. 키 없이 m.place.naver.com/place/<id>/home (→ /hospital/<id>/home 리다이렉트).
// 1차 출처: og:description "방문자리뷰 8,153 · 블로그리뷰 3,481", 2차: __APOLLO_STATE__ 의 visitorReviewsTotal / cafeBlogReviewsTotal.
import { NAVER_MOBILE_UA } from "./naver-serp";
import { safeNaverFetch } from "./safe-fetch";
import type { NaverPlaceSnapshot, PlaceCompleteness } from "./types";

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
    completeness: parseCompleteness(html),
  };
}

/** 플레이스 완성도 — __APOLLO_STATE__ 의 값만 읽는다. 못 읽는 항목은 null (0 으로 꾸미지 않음) */
export function parseCompleteness(html: string): PlaceCompleteness | undefined {
  if (!html.includes("__APOLLO_STATE__")) return undefined;
  const int = (re: RegExp) => { const m = re.exec(html); return m ? Number(m[1]) : null; };
  const bool = (re: RegExp) => { const m = re.exec(html); return m ? m[1] === "true" : null; };
  // 소개글: PlaceDetailBase 의 "description":"..." (JSON 문자열, 이스케이프 포함) — 가장 긴 description 을 소개글로 본다
  let descLen: number | null = null;
  const dm = html.matchAll(/"description":"((?:[^"\\]|\\.){0,4000})"/g);
  for (const m of dm) { const t = m[1].replace(/\\n/g, "\n").replace(/\\u[0-9a-fA-F]{4}/g, "?").replace(/\\./g, ""); if (descLen == null || t.length > descLen) descLen = t.length; }
  const kw = /"keywordList":\[([^\]]{0,600})\]/.exec(html)?.[1] || "";
  const keywordList = [...kw.matchAll(/"([^"]{1,40})"/g)].map((m) => m[1]);
  const homepages = /"homepages":\{[\s\S]{0,3000}?\}(?=,"[a-zA-Z]+":)/.exec(html)?.[0] || "";
  const conv = /"conveniences":\[([^\]]{0,800})\]/.exec(html)?.[1] || "";
  return {
    photos: int(/"topPhotos":\{"__typename":"PlaceDetailTopPhotos","total":(\d+)/),
    businessImages: int(/"totalImages":(\d+)/),
    descriptionLen: descLen,
    descriptionMissing: bool(/"isDescriptionMissing":(true|false)/),
    bizHourMissing: html.includes('"newBusinessHours":[') ? !/"newBusinessHours":\[\{[\s\S]{0,400}?"WorkingHoursInfo"/.test(html) : null, // MissingInfo.isBizHourMissing 은 등록된 병원도 true 라 쓰지 않음(2026-09-26 실측)
    booking: /"naverBookingUrl":"https?:/.test(html),
    talktalk: /"talktalkUrl":"https?:/.test(html),
    keywordList,
    blogLinked: /"recentBlogPost":\{"__typename":"RecentBlogPost","isPostExists":true/.test(html) || /"type":"블로그"/.test(homepages),
    homepage: /"type":"홈페이지"/.test(homepages) || /"type":"공식"/.test(homepages),
    imageReviews: int(/"imageReviewCount":(\d+)/),
    textReviews: int(/"visitorReviewsTextReviewTotal":(\d+)/),
    conveniences: conv ? conv.split(",").filter((x) => x.trim()).length : 0,
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
