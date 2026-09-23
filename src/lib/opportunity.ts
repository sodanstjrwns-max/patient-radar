// 검색 기회 = 월 검색수 × 순위별 노출 확률. "순위 평균"이 아니라 "사람이 몇 명이나 우리를 봤을 기회인가"로 바꾼다.
// 노출 확률 곡선은 모바일 목록에서 위치별 시선 점유 추정치(클릭률이 아님). 근거: 상위 3개가 첫 화면, 4~5위는 스크롤, 6위 이하는 더보기.
export const VISIBILITY: Record<number, number> = { 1: 1.0, 2: 0.8, 3: 0.65, 4: 0.45, 5: 0.35, 6: 0.15, 7: 0.15, 8: 0.15, 9: 0.15, 10: 0.15 };
export const VIS_ELSEWHERE = 0.1; // 순위 목록엔 없지만 블로그·카페 등 다른 섹션에 보임
export function visibility(rank: number | null, shownElsewhere = false): number {
  if (rank == null) return shownElsewhere ? VIS_ELSEWHERE : 0;
  return VISIBILITY[rank] ?? 0.05;
}
export type KeywordRow = { keyword: string; volume: number | null; self: { rank: number | null; shown: boolean }; competitors: Record<string, { rank: number | null; shown: boolean; name: string }> };
export type Opportunity = {
  platform: string; pool: number; captured: number; coverage: number | null;
  lost: { keyword: string; volume: number; rank: number | null; captured: number; lost: number; gainTop3: number; above: string[] }[];
  competitors: Record<string, { name: string; captured: number; coverage: number | null }>;
};
export function computeOpportunity(platform: string, rows: KeywordRow[]): Opportunity {
  const withVol = rows.filter((r) => r.volume != null && r.volume > 0);
  const pool = withVol.reduce((a, r) => a + (r.volume as number), 0);
  let captured = 0;
  const comp: Record<string, { name: string; captured: number; coverage: number | null }> = {};
  const lost: Opportunity["lost"] = [];
  for (const r of withVol) {
    const v = r.volume as number;
    const cap = v * visibility(r.self.rank, r.self.shown);
    captured += cap;
    const above = Object.values(r.competitors).filter((c) => c.rank != null && (r.self.rank == null || c.rank < r.self.rank)).sort((a, b) => (a.rank as number) - (b.rank as number)).map((c) => `${c.name} ${c.rank}위`);
    lost.push({ keyword: r.keyword, volume: v, rank: r.self.rank, captured: Math.round(cap), lost: Math.round(v - cap), gainTop3: Math.round(Math.max(0, v * VISIBILITY[3] - cap)), above });
    for (const [k, c] of Object.entries(r.competitors)) { comp[k] ||= { name: c.name, captured: 0, coverage: null }; comp[k].captured += v * visibility(c.rank, c.shown); }
  }
  for (const c of Object.values(comp)) { c.captured = Math.round(c.captured); c.coverage = pool ? Math.round((c.captured / pool) * 1000) / 1000 : null; }
  lost.sort((a, b) => b.lost - a.lost);
  return { platform, pool, captured: Math.round(captured), coverage: pool ? Math.round((captured / pool) * 1000) / 1000 : null, lost, competitors: comp };
}
