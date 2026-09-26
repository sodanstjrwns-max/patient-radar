// Patient Radar 크론 워커 — 앱의 /api/cron/* 을 병원 1곳씩 순차 호출한다. 수집 로직은 앱에만 있다.
export interface Env { RADAR_ORIGIN: string; CRON_SECRET: string; STATE: KVNamespace }

async function callApp(env: Env, path: string, method = "POST"): Promise<{ status: number; body: unknown }> {
  // 【2026-09-26】앱 호출 60초 타임아웃 — 한 병원이 걸려도 크론 전체가 멈추지 않게
  let res: Response;
  try { res = await fetch(env.RADAR_ORIGIN + path, { method, headers: { "x-cron-secret": env.CRON_SECRET }, signal: AbortSignal.timeout(60_000) }); }
  catch (e) { return { status: 599, body: { error: String(e).slice(0, 120) } }; }
  let body: unknown = null; try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  return { status: res.status, body };
}

async function measure(env: Env, opts: { all?: boolean; hospital?: number } = {}) {
  const log: Record<string, unknown>[] = [];
  const due = opts.hospital ? { due: [opts.hospital] } : ((await callApp(env, `/api/cron/due${opts.all ? "?all=1" : ""}`, "GET")).body as { due?: number[] });
  for (const id of due?.due || []) {
    let guard = 0;
    for (;;) {
      const r = await callApp(env, `/api/cron/run-hospital/${id}?batch=6`);
      const b = r.body as { ok?: boolean; done?: boolean; remaining?: number; skipped?: string; error?: string; blocked?: boolean };
      log.push({ id, status: r.status, ...b });
      if (r.status !== 200 || !b.ok || b.done || b.blocked || ++guard > 20) break;
    }
  }
  await env.STATE.put("last:measure", JSON.stringify({ at: new Date().toISOString(), log }));
  return log;
}
// 【2026-09-26】200병원 대비: 병원 1곳씩 호출 + 실행당 시간 예산(12분, 크론 한도 15분) + KV 커서로 다음 실행에 이어서.
const BUDGET_MS = 12 * 60_000;
async function perHospital(env: Env, key: string, pathOf: (id: number) => string, pauseMs: number, only?: number) {
  const t0 = Date.now();
  const list = only ? { ids: [only], naver_html: true } : ((await callApp(env, "/api/cron/active-hospitals", "GET")).body as { ids?: number[]; naver_html?: boolean });
  const ids = list?.ids || [];
  const cur = only ? null : JSON.parse((await env.STATE.get(`cursor:${key}`)) || "null") as { next: number } | null;
  const start = cur ? Math.max(0, ids.findIndex((x) => x >= cur.next)) : 0;
  const log: Record<string, unknown>[] = []; let i = start, stopped: string | null = null;
  for (; i < ids.length; i++) {
    if (Date.now() - t0 > BUDGET_MS) { stopped = "budget"; break; }
    const r = await callApp(env, pathOf(ids[i]));
    log.push({ id: ids[i], status: r.status, body: r.body });
    const b = r.body as { results?: { blocked?: boolean }[]; skipped?: string } | null;
    if (b?.skipped) { stopped = b.skipped; break; }
    if (b?.results?.some((x) => x.blocked)) { stopped = "naver_blocked"; break; }
    if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
  }
  if (!only) {
    if (stopped === "budget" && i < ids.length) await env.STATE.put(`cursor:${key}`, JSON.stringify({ next: ids[i], at: new Date().toISOString() }));
    else await env.STATE.delete(`cursor:${key}`);
  }
  const summary = { at: new Date().toISOString(), total: ids.length, from: start, done: i - start, stopped, log: log.slice(-50) };
  await env.STATE.put(`last:${key}`, JSON.stringify(summary));
  return summary;
}
async function reports(env: Env, week?: string) {
  return perHospital(env, "reports", (id) => `/api/cron/weekly-reports?hospital=${id}${week ? `&week=${week}` : ""}`, 0);
}
async function reviews(env: Env, hospital?: number) {
  return perHospital(env, "reviews", (id) => `/api/cron/reviews?hospital=${id}`, 2000, hospital);
}
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "30 23 * * SUN" || event.cron === "0 0 * * MON") ctx.waitUntil(reports(env));   // 두 번째는 예산 초과분 이어서
    else if (event.cron === "0 19 * * *" || event.cron === "0 20 * * *") ctx.waitUntil(reviews(env));
    else ctx.waitUntil(measure(env));
  },
  async fetch(req: Request, env: Env) {
    const u = new URL(req.url);
    if (u.pathname !== "/run") return new Response("patient-radar-cron", { status: 200 });
    if (req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) return new Response("forbidden", { status: 403 });
    const job = u.searchParams.get("job") || "status";
    if (job === "measure") return Response.json(await measure(env, { all: u.searchParams.get("all") === "1", hospital: Number(u.searchParams.get("hospital")) || undefined }));
    if (job === "reports") return Response.json(await reports(env, u.searchParams.get("week") || undefined));
    if (job === "reviews") return Response.json(await reviews(env, Number(u.searchParams.get("hospital")) || undefined));
    return Response.json({ measure: JSON.parse((await env.STATE.get("last:measure")) || "null"), reports: JSON.parse((await env.STATE.get("last:reports")) || "null"), reviews: JSON.parse((await env.STATE.get("last:reviews")) || "null") });
  },
};
