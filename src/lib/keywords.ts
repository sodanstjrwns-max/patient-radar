import { PROCEDURES } from "../data/procedures";

/** 허브 프로필 region("충청남도 천안시 서북구 불당동", "서울 송파구") → 키워드용 지역명 후보 */
export function localityCandidates(region: string | null | undefined): string[] {
  if (!region) return [];
  const parts = region.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const metro = /^(서울|부산|대구|인천|광주|대전|울산|세종)(특별시|광역시|특별자치시)?$/;
  const isMetro = parts.length > 0 && metro.test(parts[0]);
  for (const p of parts) {
    if (/(특별시|광역시|특별자치시|특별자치도|도)$/.test(p) && !/(동|읍|면|리)$/.test(p) && p.length <= 5) continue; // 시/도
    if (/(시|군)$/.test(p) && p.length >= 3) {
      out.push(p.replace(/(시|군)$/, ""));
      continue;
    }
    if (/구$/.test(p)) {
      if (isMetro) out.push(p); // 서울 송파구 → 송파구
      continue; // 천안시 서북구 → 구는 생략
    }
    if (/(동|읍|면)$/.test(p)) out.push(p);
  }
  return [...new Set(out)];
}

export function normalizeTreatments(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 20))];
}

/** 「지역 × 진료」 조합 생성. 우선순위: 주력 시술 > 진료과 > 진료과 기본 시술 */
export function generateKeywords(opts: { region: string | null; clinicType: string | null; treatments: string[]; limit: number }): string[] {
  const locs = localityCandidates(opts.region);
  if (!locs.length) return [];
  const clinic = (opts.clinicType || "").trim();
  const primary = normalizeTreatments(opts.treatments);
  const defaults = clinic && PROCEDURES[clinic] ? PROCEDURES[clinic].filter((p) => !primary.includes(p)) : [];
  const terms: string[] = [];
  for (const t of primary) terms.push(t);
  if (clinic) terms.push(clinic);
  for (const t of defaults) terms.push(t);
  const out: string[] = [];
  // 시술 우선순위 순으로, 각 시술마다 지역(시·군 → 동)을 번갈아 — 한도가 작아도 동 단위 키워드가 포함되게
  for (const t of terms) for (const loc of locs) {
    const kw = `${loc} ${t}`;
    if (!out.includes(kw)) out.push(kw);
  }
  return out.slice(0, Math.max(0, opts.limit));
}

/** 키워드 안의 동·읍·면 토큰 중 우리 지역 목록에 없는 것이 있으면 true */
export function hasOtherDong(squashed: string, ourLocalities: string[]): boolean {
  const tokens = squashed.match(/[가-힣]{1,4}?(동|읍|면)(?=치과|병원|의원|[가-힣]|$)/g) || [];
  return tokens.some((t) => !ourLocalities.some((l) => l.includes(t) || t.includes(l)));
}

export type Candidate = { text: string; volume: number | null; pc: number | null; mobile: number | null; low: boolean; source: "auto" | "related" };
const squash = (s: string) => s.replace(/\s+/g, "");

/**
 * 검색량 기준 후보 정렬. ideas(검색광고 연관 키워드)에서 지역명이 들어간 것을 추가 후보로 합치고,
 * 월 검색수(PC+모바일) 내림차순으로 정렬한다. 검색수가 없는 후보는 뒤로.
 */
export function rankCandidates(generated: string[], ideas: { keyword: string; pc: number | null; mobile: number | null; low: boolean }[], region: string | null, opts: { maxRelated?: number; minVolume?: number; excludeWords?: string[] } = {}): Candidate[] {
  const locs = localityCandidates(region).map(squash);
  const byKey = new Map<string, Candidate>();
  const ideaMap = new Map(ideas.map((i) => [squash(i.keyword), i]));
  for (const g of generated) {
    const k = squash(g); const i = ideaMap.get(k);
    byKey.set(k, { text: g, volume: i ? (i.pc ?? 0) + (i.mobile ?? 0) : null, pc: i?.pc ?? null, mobile: i?.mobile ?? null, low: !!i?.low, source: "auto" });
  }
  const bad = (opts.excludeWords || ["가격", "비용", "후기", "추천", "잘하는곳", "잘하는", "순위", "유명한", "싼", "저렴"]).map(squash);
  let related = 0;
  for (const i of ideas.sort((a, b) => ((b.pc ?? 0) + (b.mobile ?? 0)) - ((a.pc ?? 0) + (a.mobile ?? 0)))) {
    const k = squash(i.keyword);
    if (byKey.has(k) || k.length > 12 || !locs.some((l) => k.includes(l))) continue;
    const vol = (i.pc ?? 0) + (i.mobile ?? 0);
    if (vol < (opts.minVolume ?? 100)) continue;
    if (bad.some((b) => k.includes(b))) continue; // 비교·가격형 키워드는 광고성 노출이라 순위 측정 대상에서 뺀다
    if (hasOtherDong(k, locs)) continue; // 다른 동·읍·면 이름이 들어간 키워드(천안신부동치과 등)는 우리 병원 상권이 아니다
    byKey.set(k, { text: i.keyword, volume: vol, pc: i.pc, mobile: i.mobile, low: i.low, source: "related" });
    if (++related >= (opts.maxRelated ?? 15)) break;
  }
  return [...byKey.values()].sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
}
