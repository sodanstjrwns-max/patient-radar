// Draft weights from §6; change this file only after owner approval.
export const PLATFORM_WEIGHTS: Record<string, number> = {
  naver_serp: 35,
  naver_place: 25,
  google: 20,
  kakao: 10,
  signal_ai: 10,
};
export const RANK_SCORES = {
  first: 100,
  top3: 80,
  top5: 60,
  top10: 30,
  below10: 10,
  elsewhere: 15,
  absent: 0,
};
export function rankScore(
  rank: number | null,
  shownElsewhere = false,
  adOnly = false,
): number {
  if (adOnly) return 0;
  if (rank == null)
    return shownElsewhere ? RANK_SCORES.elsewhere : RANK_SCORES.absent;
  if (!Number.isInteger(rank) || rank < 1) throw new RangeError("INVALID_RANK");
  return rank === 1
    ? RANK_SCORES.first
    : rank <= 3
      ? RANK_SCORES.top3
      : rank <= 5
        ? RANK_SCORES.top5
        : rank <= 10
          ? RANK_SCORES.top10
          : RANK_SCORES.below10;
}
export type KeywordObs = {
  keyword: string;
  self: number;
  competitors: Record<string, number>;
};
const validScore = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100;
export function platformScore(rows: KeywordObs[]): {
  score: number | null;
  sov: number | null;
  shown: number;
} {
  if (!rows.length) return { score: null, sov: null, shown: 0 };
  const competitorKeys = Object.keys(rows[0].competitors).sort().join("|");
  for (const row of rows) {
    if (
      !validScore(row.self) ||
      !Object.values(row.competitors).every(validScore)
    )
      throw new RangeError("INVALID_SCORE");
    if (Object.keys(row.competitors).sort().join("|") !== competitorKeys)
      throw new Error("INCOMPARABLE_KEYWORD_SET");
  }
  const self = rows.reduce((sum, row) => sum + row.self, 0);
  const competitors = rows.reduce(
    (sum, row) =>
      sum + Object.values(row.competitors).reduce((a, b) => a + b, 0),
    0,
  );
  const sov =
    competitorKeys && self + competitors > 0
      ? self / (self + competitors)
      : null;
  return {
    score: Math.round((self / rows.length) * 10) / 10,
    sov: sov == null ? null : Math.round(sov * 1000) / 1000,
    shown: rows.filter((row) => row.self > 0).length,
  };
}
export function totalScore(
  byPlatform: Record<string, number | null | undefined>,
): number | null {
  let numerator = 0,
    denominator = 0;
  for (const [platform, score] of Object.entries(byPlatform)) {
    if (score == null) continue;
    if (!validScore(score)) throw new RangeError("INVALID_SCORE");
    const weight = PLATFORM_WEIGHTS[platform];
    if (!weight) throw new Error("UNKNOWN_PLATFORM");
    numerator += score * weight;
    denominator += weight;
  }
  return denominator ? Math.round((numerator / denominator) * 10) / 10 : null;
}
