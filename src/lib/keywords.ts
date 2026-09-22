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
