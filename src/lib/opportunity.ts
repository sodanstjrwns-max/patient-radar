// 검색 기회 = 월 검색수 × 순위별 노출 확률. "순위 평균"이 아니라 "사람이 몇 명이나 우리를 봤을 기회인가"로 바꾼다.
// 노출 확률 곡선은 시선 점유 추정치(클릭률이 아님). 기준은 '첫 화면'이 아니라 **통합검색 플레이스 블록**이다:
//  - 블록 안(키워드마다 실측한 자연 카드 수, 보통 3~5개): 같은 블록에 함께 보이므로 완만하게 줄어든다.
//  - 블록 밖('더보기'를 눌러야 보이는 순위): 크게 떨어진다.
// 2026-09-25 원장 지적("5위면 1페이지")으로 '상위 3개=첫 화면' 가정을 폐기했다.
export const VIS_IN_BLOCK: Record<number, number> = { 1: 1.0, 2: 0.85, 3: 0.75, 4: 0.65, 5: 0.55 };
export const VIS_IN_BLOCK_MIN = 0.35; // 블록이 5개보다 길 때 6번째부터 0.1씩 내려가되 이 밑으로는 안 간다
export const VIS_OUT_BLOCK = 0.15; // 블록 밖 10위까지
export const VIS_FAR = 0.05; // 10위 밖
export const VIS_ELSEWHERE = 0.1; // 순위 목록엔 없지만 블로그·카페 등 다른 섹션에 보임
export const DEFAULT_BLOCK = 5; // 블록 크기를 모르는 관측(옛 run·API 모드·구글·카카오)은 5로 본다
export function visibility(rank: number | null, shownElsewhere = false, blockSize: number | null = null): number {
  if (rank == null) return shownElsewhere ? VIS_ELSEWHERE : 0;
  const block = blockSize && blockSize > 0 ? blockSize : DEFAULT_BLOCK;
  if (rank <= block) return VIS_IN_BLOCK[rank] ?? Math.max(VIS_IN_BLOCK_MIN, 0.55 - (rank - 5) * 0.1);
  return rank <= 10 ? VIS_OUT_BLOCK : VIS_FAR;
}
/** 한 계단 올랐을 때의 순위: 미노출이면 블록 마지막 자리, 그 외엔 바로 위 */
export function nextRank(rank: number | null, blockSize: number | null): number {
  const block = blockSize && blockSize > 0 ? blockSize : DEFAULT_BLOCK;
  if (rank == null) return block;
  return Math.max(1, rank - 1);
}
export type KeywordRow = { keyword: string; volume: number | null; blockSize?: number | null; self: { rank: number | null; shown: boolean }; competitors: Record<string, { rank: number | null; shown: boolean; name: string }> };
export type Opportunity = {
  platform: string; pool: number; captured: number; coverage: number | null;
  lost: { keyword: string; volume: number; rank: number | null; blockSize: number | null; captured: number; lost: number; gainNext: number; nextRank: number; above: string[] }[];
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
    const block = r.blockSize ?? null;
    const cap = v * visibility(r.self.rank, r.self.shown, block);
    captured += cap;
    const above = Object.values(r.competitors).filter((c) => c.rank != null && (r.self.rank == null || c.rank < r.self.rank)).sort((a, b) => (a.rank as number) - (b.rank as number)).map((c) => `${c.name} ${c.rank}위`);
    const nr = nextRank(r.self.rank, block);
    lost.push({ keyword: r.keyword, volume: v, rank: r.self.rank, blockSize: block, captured: Math.round(cap), lost: Math.round(v - cap), gainNext: r.self.rank === 1 ? 0 : Math.round(Math.max(0, v * visibility(nr, false, block) - cap)), nextRank: nr, above });
    for (const [k, c] of Object.entries(r.competitors)) { comp[k] ||= { name: c.name, captured: 0, coverage: null }; comp[k].captured += v * visibility(c.rank, c.shown, block); }
  }
  for (const c of Object.values(comp)) { c.captured = Math.round(c.captured); c.coverage = pool ? Math.round((c.captured / pool) * 1000) / 1000 : null; }
  lost.sort((a, b) => b.lost - a.lost);
  return { platform, pool, captured: Math.round(captured), coverage: pool ? Math.round((captured / pool) * 1000) / 1000 : null, lost, competitors: comp };
}
