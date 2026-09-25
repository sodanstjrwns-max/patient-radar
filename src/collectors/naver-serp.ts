// 네이버 모바일 통합검색 수집기 — 키 없이 plain fetch. 시그널 naver-ai-briefing.strategy.ts 와 같은 접근.
// 카드 마크업의 class 명은 난독화돼 바뀔 수 있으므로 'm.place.naver.com/place/<id>?entry=pll' 링크와
// 공유 버튼 data-title 속성처럼 비교적 안정적인 표식을 우선 사용한다.
import type { Entity, NaverSerpResult, SerpPlaceCard } from "./types";
import { safeNaverFetch } from "./safe-fetch";

export const NAVER_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

export function serpUrl(keyword: string): string {
  return `https://m.search.naver.com/search.naver?where=m&sm=mtp_hty.top&query=${encodeURIComponent(keyword)}`;
}

export async function fetchNaverSerp(
  keyword: string,
  fetchImpl: typeof fetch = safeNaverFetch,
): Promise<string> {
  const res = await fetchImpl(serpUrl(keyword), {
    headers: {
      "User-Agent": NAVER_MOBILE_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`naver serp http ${res.status}`);
  return await res.text();
}

export function isBlockedHtml(html: string): boolean {
  return (
    /captcha|자동입력\s*방지|비정상적인\s*(검색|접근)/i.test(html) &&
    html.length < 50000
  );
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const norm = (s: string) => s.replace(/\s+/g, "").replace(/의원|병원/g, "");

function matchesEntity(text: string, e: Entity): boolean {
  const t = norm(text);
  return [e.name, ...e.aliases]
    .map(norm)
    .filter(Boolean)
    .some((a) => t.includes(a));
}

/** 플레이스 섹션 카드 추출: 자연 카드는 직접 링크(entry=pll), 광고 카드는 ader 리다이렉트 안에 인코딩된 링크 + PLACE_AD */
export function parsePlaceCards(html: string): SerpPlaceCard[] {
  const cards: SerpPlaceCard[] = [];
  const seen = new Set<string>();
  // 자연 카드
  // 경로 세그먼트는 카테고리에 따라 /place/ /hospital/ /restaurant/ 등으로 바뀐다 (동 단위 검색은 /hospital/)
  const organic =
    /href="https:\/\/m\.place\.naver\.com\/[a-z]+\/(\d+)\?entry=pll[^"]*"[^>]*>(?:\s*<[^>]+>)*\s*([^<]{1,60})</g;
  let m: RegExpExecArray | null;
  while ((m = organic.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    cards.push({
      placeId: id,
      name: stripTags(m[2]),
      isAd: false,
      position: cards.length + 1,
    });
  }
  // 광고 카드(PLACE_AD): 순서는 자연 카드 앞에 나오지만 자연 순위 계산에서는 제외한다
  const ad =
    /m\.place\.naver\.com%2F[a-z]+%2F(\d+)%3Fentry%3Dpll%26from%3DPLACE_AD/g;
  const adSeen = new Set<string>();
  while ((m = ad.exec(html))) {
    const id = m[1];
    if (adSeen.has(id)) continue;
    adSeen.add(id);
    // 광고 카드 이름: 그 id 의 목록 링크(ader 리다이렉트, clid=list) 안 첫 span 이 상호 (2026-09-26 실측). 없으면 옛 data-title 방식
    const t2 = new RegExp(
      `href="https://ader\\.naver\\.com/[^"]*%2F${id}%3Fentry%3Dpll%26from%3DPLACE_AD[^"]*clid=list"[^>]*>\\s*<span[^>]*>([^<]{1,60})</span>`,
    ).exec(html);
    const t = t2 ? null : new RegExp(
      `data-title="([^"]{1,80})"[^>]*data-line-title="[^"]*"[\\s\\S]{0,4000}?${id}`,
    ).exec(html);
    cards.push({
      placeId: id,
      name: t2 ? stripTags(t2[1]) : t ? stripTags(t[1]).split(" ")[0] : "",
      isAd: true,
      position: 0,
    });
  }
  return cards;
}

export function detectSections(html: string): Record<string, boolean> {
  return {
    place: /m\.place\.naver\.com\/[a-z]+\/\d+\?entry=pll/.test(html),
    ad: /PLACE_AD/.test(html),
    blog: /blog\.naver\.com\//.test(html),
    cafe: /cafe\.naver\.com\//.test(html),
    influencer: /in\.naver\.com\//.test(html),
    kin: /kin\.naver\.com\//.test(html),
    ai_briefing: /"templateId":"aibAnswer"/.test(html),
  };
}

export function extractAiBriefingText(html: string): string {
  const i = html.indexOf('"templateId":"aibAnswer"');
  if (i < 0) return "";
  // 페이로드는 큰 JSON 이라 대략 앞뒤 20만자 창만 본다(정밀 파싱은 시그널 전략 참고)
  return html.slice(Math.max(0, i - 20000), i + 200000);
}

export function analyzeSerp(
  keyword: string,
  html: string,
  entities: Entity[],
): NaverSerpResult {
  const blocked = isBlockedHtml(html);
  const placeCards = blocked ? [] : parsePlaceCards(html);
  const sections = blocked ? {} : detectSections(html);
  const text = blocked ? "" : stripTags(html);
  const aib = blocked ? "" : extractAiBriefingText(html);
  const organic = placeCards.filter((c) => !c.isAd);
  const result: NaverSerpResult = {
    keyword,
    fetchedAt: new Date().toISOString(),
    blocked,
    htmlLength: html.length,
    sections,
    placeCards,
    aiBriefingShown: !!sections.ai_briefing,
    entities: {},
  };
  for (const e of entities) {
    const idx = organic.findIndex((c) =>
      e.placeId ? c.placeId === e.placeId : matchesEntity(c.name, e),
    );
    const adHit = placeCards.some(
      (c) =>
        c.isAd &&
        (e.placeId ? c.placeId === e.placeId : matchesEntity(c.name, e)),
    );
    const names = [e.name, ...e.aliases].filter(Boolean);
    let mentions = 0;
    for (const n of names) {
      const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      mentions += (text.match(re) || []).length;
    }
    result.entities[e.key] = {
      shown: idx >= 0 || mentions > 0,
      placeRank: idx >= 0 ? idx + 1 : null,
      placeAd: adHit,
      mentions,
      aiBriefingMentioned: !!aib && matchesEntity(aib, e),
    };
  }
  return result;
}

export async function collectNaverSerp(
  keyword: string,
  entities: Entity[],
  fetchImpl: typeof fetch = safeNaverFetch,
) {
  const html = await fetchNaverSerp(keyword, fetchImpl);
  return analyzeSerp(keyword, html, entities);
}
