// Patient Radar 크론 워커 — 앱의 /api/cron/* 을 병원 1곳씩 순차 호출한다. 수집 로직은 앱에만 있다.
export interface Env { RADAR_ORIGIN: string; CRON_SECRET: string; STATE: KVNamespace }

async function callApp(env: Env, path: string, method = "POST"): Promise<{ status: number; body: unknown }> {
  const res = await fetch(env.RADAR_ORIGIN + path, { method, headers: { "x-cron-secret": env.CRON_SECRET } });
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
async function reports(env: Env, week?: string) {
  const r = await callApp(env, `/api/cron/weekly-reports${week ? `?week=${week}` : ""}`);
  await env.STATE.put("last:reports", JSON.stringify({ at: new Date().toISOString(), ...r }));
  return r;
}

async function reviews(env: Env, hospital?: number) {
  const r = await callApp(env, `/api/cron/reviews${hospital ? `?hospital=${hospital}` : ""}`);
  await env.STATE.put("last:reviews", JSON.stringify({ at: new Date().toISOString(), ...r }));
  return r;
}
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "30 23 * * SUN") ctx.waitUntil(reports(env));
    else if (event.cron === "0 19 * * *") ctx.waitUntil(reviews(env));
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
