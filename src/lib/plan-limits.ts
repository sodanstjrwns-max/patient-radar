// 플랜 게이트 — 가격표_최종본 규칙(S/M/L). 금액은 pricing.ts, 한도는 여기.
export type Plan = "FREE" | "S" | "M" | "L";
export const PLAN_LIMITS: Record<Plan, { keywords: number; competitors: number; monthlyRunDays: number; platforms: string[] }> = {
  FREE: { keywords: 3, competitors: 0, monthlyRunDays: 1, platforms: ["naver"] },
  S: { keywords: 10, competitors: 3, monthlyRunDays: 5, platforms: ["naver", "google"] },
  M: { keywords: 20, competitors: 5, monthlyRunDays: 5, platforms: ["naver", "google", "kakao", "signal"] },
  L: { keywords: 40, competitors: 10, monthlyRunDays: 10, platforms: ["naver", "google", "kakao", "signal"] },
};
export function planOf(v: string | null | undefined): Plan {
  return v === "FREE" || v === "S" || v === "M" || v === "L" ? v : "S";
}
export function limitsOf(v: string | null | undefined) {
  return PLAN_LIMITS[planOf(v)];
}
