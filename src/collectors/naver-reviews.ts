// 네이버 플레이스 방문자 리뷰 본문 — /review/visitor 페이지의 __APOLLO_STATE__ (HTML 모드). 작성자 정보는 버린다.
import { NAVER_MOBILE_UA } from "./naver-serp";
import { NaverBlockedError } from "./naver-html";
import { isBlockedHtml } from "./naver-serp";

export type NaverReview = { key: string; body: string; reply: string | null; visitCount: number | null; writtenAt: string | null; keywords: string[]; photoCount: number };

/** "9.23.수" / "2025.12.3.수" → YYYY-MM-DD (연도 없으면 최근 날짜로 추정) */
export function parseNaverDate(s: string | null | undefined, now = new Date()): string | null {
  if (!s) return null;
  const m = /^(?:(\d{4})\.)?(\d{1,2})\.(\d{1,2})\./.exec(s.trim());
  if (!m) return null;
  let y = m[1] ? Number(m[1]) : now.getFullYear();
  const mo = Number(m[2]), d = Number(m[3]);
  if (!m[1]) { const cand = new Date(Date.UTC(y, mo - 1, d)); if (cand.getTime() > now.getTime() + 86400_000) y -= 1; }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseVisitorReviews(html: string): NaverReview[] {
  const m = /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html);
  if (!m) return [];
  let st: Record<string, Record<string, unknown>>;
  try { st = JSON.parse(m[1]); } catch { return []; }
  const out: NaverReview[] = [];
  for (const v of Object.values(st)) {
    if (!v || typeof v !== "object" || typeof (v as { body?: unknown }).body !== "string" || !("visitCount" in v)) continue;
    const r = v as Record<string, unknown>;
    const reply = r.reply && typeof r.reply === "object" ? ((r.reply as { body?: string }).body ?? null) : null;
    const kws = Array.isArray(r.votedKeywords) ? (r.votedKeywords as { name?: string }[]).map((k) => k?.name || "").filter(Boolean) : [];
    const photoCount = Array.isArray(r.media) ? (r.media as unknown[]).length : 0;
    out.push({ key: String(r.id || r.reviewId || ""), body: String(r.body).trim(), reply, photoCount, visitCount: typeof r.visitCount === "number" ? r.visitCount : Number(r.visitCount) || null, writtenAt: parseNaverDate(String(r.created || r.visited || "")), keywords: kws });
  }
  return out.filter((r) => r.key && r.body);
}

export async function collectNaverReviews(placeId: string, fetchImpl: typeof fetch = fetch): Promise<NaverReview[]> {
  if (!/^\d{5,15}$/.test(placeId)) throw new Error("INVALID_PLACE_ID");
  const res = await fetchImpl(`https://m.place.naver.com/hospital/${placeId}/review/visitor`, { headers: { "User-Agent": NAVER_MOBILE_UA, Accept: "text/html", "Accept-Language": "ko-KR,ko;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
  if ([401, 403, 429].includes(res.status)) throw new NaverBlockedError(res.status);
  if (!res.ok) throw new Error(`NAVER_REVIEW_HTTP_${res.status}`);
  const html = await res.text();
  if (isBlockedHtml(html)) throw new NaverBlockedError(res.status);
  return parseVisitorReviews(html);
}
