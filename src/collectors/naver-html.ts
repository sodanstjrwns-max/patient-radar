// 네이버 HTML 모드 — 원장이 NAVER_HTML_MODE=true 로 명시적으로 켤 때만 쓰인다.
// m.search.naver.com / m.place.naver.com 의 robots.txt 는 일반 봇에 Disallow: / 이다(2026-09-23 확인).
// 시그널의 네이버 AI 브리핑 전략이 같은 페이지를 매일 읽고 있으며, 이 모드는 그 관행과 동일한 방식이다.
// 캡차·차단 감지 시 즉시 중단, 요청 간 3~7초 지연, 프록시·IP 위장 없음.
import { NAVER_MOBILE_UA, serpUrl, analyzeSerp, isBlockedHtml } from "./naver-serp";
import { parsePlaceHome } from "./naver-place";
import type { Entity, NaverSerpResult, NaverPlaceSnapshot } from "./types";

export class NaverBlockedError extends Error {
  constructor(public status: number | null) { super("NAVER_BLOCKED"); }
}

async function getHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": NAVER_MOBILE_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "ko-KR,ko;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  if ([401, 403, 429].includes(res.status)) throw new NaverBlockedError(res.status);
  if (!res.ok) throw new Error(`NAVER_HTML_HTTP_${res.status}`);
  const html = await res.text();
  if (isBlockedHtml(html)) throw new NaverBlockedError(res.status);
  return html;
}

export async function htmlSerp(keyword: string, entities: Entity[], fetchImpl: typeof fetch = fetch): Promise<NaverSerpResult> {
  return analyzeSerp(keyword, await getHtml(serpUrl(keyword), fetchImpl), entities);
}
export async function htmlPlace(placeId: string, fetchImpl: typeof fetch = fetch): Promise<NaverPlaceSnapshot> {
  if (!/^\d{5,15}$/.test(placeId)) throw new Error("INVALID_PLACE_ID");
  return parsePlaceHome(placeId, await getHtml(`https://m.place.naver.com/place/${placeId}/home`, fetchImpl));
}
