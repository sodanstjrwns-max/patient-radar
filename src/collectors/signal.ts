// 시그널(AI 가시성) 반입 — PS Open API. 응답에 0~100 점수가 없으면 null(미측정).
export type SignalEnv = { SIGNAL_API_URL: string; SIGNAL_API_KEY: string };
export async function fetchSignalScore(hid: string, env: SignalEnv, fetchImpl: typeof fetch = fetch): Promise<{ score: number | null; raw: unknown }> {
  const base = env.SIGNAL_API_URL.replace(/\/$/, "");
  const res = await fetchImpl(`${base}/api/v1/signals`, {
    headers: { Authorization: `Bearer ${env.SIGNAL_API_KEY}`, "X-PS-Hospital-Id": hid },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { score: null, raw: { status: res.status } };
  const j = (await res.json()) as { signals?: Record<string, unknown>[] };
  const list = j.signals || [];
  // 점수형 신호 우선: type 에 score 가 들어가거나 data.score / value 가 0~100 숫자
  for (const s of list) {
    const d = (s.data as Record<string, unknown> | undefined) || {};
    const cand = [d.score, d.overall_score, s.value].find((v) => typeof v === "number");
    if (typeof cand === "number" && cand >= 0 && cand <= 100 && /score|aeo|visib/i.test(String(s.type || ""))) return { score: Math.round(cand * 10) / 10, raw: s };
  }
  return { score: null, raw: { count: list.length } };
}
