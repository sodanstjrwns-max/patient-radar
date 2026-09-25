// 페이션트 폼 내원경로 주간 집계 반입 — GET /api/integration/arrival-stats (Bearer pfk_…). 건수만, 개인정보 없음.
export type ArrivalWeek = { week_start: string; first_visits: number; answered: number; declined: number; unanswered: number; primary: Record<string, number>; groups: Record<string, number>; secondary_groups: Record<string, number>; ad: Record<string, number> };
export async function fetchArrivalStats(baseUrl: string, apiKey: string, from: string, to: string, fetchImpl: typeof fetch = fetch): Promise<ArrivalWeek[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/integration/arrival-stats?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`FORM_HTTP_${res.status}`);
  const j = (await res.json()) as { weeks?: ArrivalWeek[] };
  return j.weeks || [];
}
