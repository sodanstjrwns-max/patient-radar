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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
// 【2026-09-26】200병원 대비: 병원 1곳씩 호출 + 실행당 시간 예산(12분, 크론 한도 15분) + KV 커서로 다음 실행에 이어서.
const BUDGET_MS = 12 * 60_000;

type RunBody = { ok?: boolean; done?: boolean; remaining?: number; skipped?: string; error?: string; blocked?: boolean };
/** 병원 1곳 측정: done 이 올 때까지 run-hospital 반복(앱이 호출당 45초 예산으로 끊어 줌). 예산이 다하면 'budget' — 같은 날 다음 실행이 이어서 한다 */
async function measureOne(env: Env, id: number, log: Record<string, unknown>[], t0: number | null): Promise<"done" | "failed" | "budget"> {
  let guard = 0, transient = 0;
  for (;;) {
    if (t0 != null && Date.now() - t0 > BUDGET_MS) return "budget";
    const r = await callApp(env, `/api/cron/run-hospital/${id}?batch=6`);
    const b = (r.body || {}) as RunBody;
    log.push({ id, status: r.status, ok: b.ok, done: b.done, remaining: b.remaining, skipped: b.skipped, error: b.error, blocked: b.blocked });
    // 【2026-09-26】실패 재시도: 타임아웃·5xx 는 5초 쉬고 같은 병원 이어서(최대 2번). 측정은 날짜 단위로 재개 가능하다
    if (r.status === 599 || r.status >= 500) { if (++transient > 2) return "failed"; await sleep(5000); continue; }
    if (r.status !== 200) return "failed";
    if (!b.ok) return b.skipped ? "done" : "failed";
    if (b.done || b.blocked) return "done";
    if (++guard > 30) return "failed";
  }
}

/** 【2026-09-26】측정 큐: 하루 차례(due)를 KV 에 두고 15분마다 12분씩 이어서 돈다(크론은 00:00~07:45 KST 15분 간격).
 *  전날 못 끝낸 병원은 다음 날 맨 앞으로, 실패한 병원은 그날 맨 뒤에 한 번 더. 리뷰 수집이 도는 동안은 양보(네이버 동시 요청 방지). */
type MeasureQueue = { date: string; ids: number[]; i: number; carried: number; retried: number[] };
async function measure(env: Env, opts: { all?: boolean; hospital?: number } = {}) {
  const log: Record<string, unknown>[] = [];
  if (opts.hospital) {   // 수동: 한 곳만, 예산 없이 끝까지
    const res = await measureOne(env, opts.hospital, log, null);
    await env.STATE.put("last:measure", JSON.stringify({ at: new Date().toISOString(), manual: opts.hospital, result: res, log: log.slice(-50) }));
    return log;
  }
  const t0 = Date.now(); const today = kstDate();
  let q = JSON.parse((await env.STATE.get("measure:queue")) || "null") as MeasureQueue | null;
  if (!q || q.date !== today || opts.all) {
    const left = q && q.date !== today ? q.ids.slice(q.i) : [];
    const d = await callApp(env, `/api/cron/due${opts.all ? "?all=1" : ""}`, "GET");
    const due = (d.body as { due?: number[] } | null)?.due;
    if (d.status !== 200 || !Array.isArray(due)) {
      const summary = { at: new Date().toISOString(), error: `due ${d.status}`, log };
      await env.STATE.put("last:measure", JSON.stringify(summary));
      return summary;
    }
    q = { date: today, ids: [...new Set([...left, ...due])], i: 0, carried: left.length, retried: [] };
    await env.STATE.put("measure:queue", JSON.stringify(q));
  }
  let stopped: string | null = null, lastSave = Date.now();
  const save = async () => { try { await env.STATE.put("measure:queue", JSON.stringify(q)); lastSave = Date.now(); } catch { /* KV 한도(키당 초당 1회) — 다음에 */ } };
  while (q.i < q.ids.length) {
    if (Date.now() - t0 > BUDGET_MS) { stopped = "budget"; break; }
    if (await env.STATE.get("busy:reviews")) { stopped = "yield_reviews"; break; }
    const id = q.ids[q.i];
    const res = await measureOne(env, id, log, t0);
    if (res === "budget") { stopped = "budget"; break; }   // 같은 병원은 다음 실행에서 이어서(앱이 같은 날 run 을 재개)
    if (res === "failed" && !q.retried.includes(id)) { q.retried.push(id); q.ids.push(id); }
    q.i++;
    if (Date.now() - lastSave > 5000) await save();
  }
  await save();
  const summary = { at: new Date().toISOString(), date: q.date, total: q.ids.length, done: q.i, carried: q.carried, retried: q.retried.length, stopped, log: log.slice(-50) };
  await env.STATE.put("last:measure", JSON.stringify(summary));
  return summary;
}

/** 병원 목록을 1곳씩(또는 concurrency 곳씩) 호출. tag 가 다르면(예: 다른 주의 리포트) 커서를 버리고 처음부터 */
async function perHospital(env: Env, key: string, pathOf: (id: number) => string, pauseMs: number, only?: number, o: { concurrency?: number; tag?: string; retryPartial?: boolean } = {}) {
  const t0 = Date.now();
  const list = only ? { ids: [only], naver_html: true } : ((await callApp(env, "/api/cron/active-hospitals", "GET")).body as { ids?: number[]; naver_html?: boolean });
  const ids = list?.ids || [];
  const cur = only ? null : JSON.parse((await env.STATE.get(`cursor:${key}`)) || "null") as { next: number; tag?: string } | null;
  const valid = cur && (o.tag == null || cur.tag === o.tag) ? cur : null;
  const start = valid ? Math.max(0, ids.findIndex((x) => x >= valid.next)) : 0;
  const n = Math.max(1, o.concurrency || 1);
  const log: Record<string, unknown>[] = []; let i = start, stopped: string | null = null;
  const one = async (id: number) => {
    // 【2026-09-26】리뷰: 앱이 45초 예산으로 끊으면(partial) 같은 병원을 이어서(최대 3번)
    for (let k = 0; k < 3; k++) {
      const r = await callApp(env, pathOf(id));
      log.push({ id, status: r.status, body: r.body });
      const b = r.body as { results?: { blocked?: boolean; partial?: boolean }[]; skipped?: string } | null;
      if (!(o.retryPartial && b?.results?.some((x) => x.partial) && !b.results.some((x) => x.blocked))) return b;
    }
    return null;
  };
  for (; i < ids.length; i += n) {
    if (Date.now() - t0 > BUDGET_MS) { stopped = "budget"; break; }
    const bodies = await Promise.all(ids.slice(i, i + n).map(one));
    if (bodies.some((b) => b?.skipped)) { stopped = bodies.find((b) => b?.skipped)!.skipped!; i += n; break; }
    if (bodies.some((b) => b?.results?.some((x) => x.blocked))) { stopped = "naver_blocked"; i += n; break; }
    if (pauseMs) await sleep(pauseMs);
  }
  i = Math.min(i, ids.length);
  if (!only) {
    if (stopped === "budget" && i < ids.length) await env.STATE.put(`cursor:${key}`, JSON.stringify({ next: ids[i], tag: o.tag, at: new Date().toISOString() }));
    else await env.STATE.delete(`cursor:${key}`);
  }
  const summary = { at: new Date().toISOString(), total: ids.length, from: start, done: i - start, stopped, tag: o.tag, log: log.slice(-50) };
  await env.STATE.put(`last:${key}`, JSON.stringify(summary));
  return summary;
}
/** 지난주 월요일(KST) — 앱 기본값과 같은 주를 워커가 고정해서 넘긴다(커서가 다른 주로 넘어가지 않게) */
function lastWeekStart(): string {
  const d = new Date(Date.now() + 9 * 3600_000 - 7 * 86400_000);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dow * 86400_000).toISOString().slice(0, 10);
}
async function reports(env: Env, week?: string) {
  // 【2026-09-26】리포트는 네이버를 안 부르므로 2곳씩 동시(1,000곳 ≈ 13분). Resend 429 는 앱이 한 번 재시도
  const w = week || lastWeekStart();
  return perHospital(env, "reports", (id) => `/api/cron/weekly-reports?hospital=${id}&week=${w}`, 0, undefined, { concurrency: 2, tag: w });
}
async function reviews(env: Env, hospital?: number) {
  // 【2026-09-26】리뷰는 04:00~05:45 KST 15분마다 이어서 돈다. 목록을 끝까지 돈 날은 남은 실행을 건너뜀
  const today = kstDate();
  if (!hospital && (await env.STATE.get("reviews:done")) === today) return { skipped: "done_today", date: today };
  // 리뷰가 도는 동안 측정 큐는 양보한다(네이버 요청이 두 줄로 겹치지 않게)
  if (!hospital) await env.STATE.put("busy:reviews", new Date().toISOString(), { expirationTtl: 15 * 60 });
  try {
    const r = await perHospital(env, "reviews", (id) => `/api/cron/reviews?hospital=${id}`, 2000, hospital, { retryPartial: true });
    if (!hospital && r.stopped !== "budget") await env.STATE.put("reviews:done", today, { expirationTtl: 2 * 86400 });
    return r;
  }
  finally { if (!hospital) await env.STATE.delete("busy:reviews"); }
}
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "30 23 * * SUN") ctx.waitUntil(reports(env));
    // 두 번째는 예산 초과분 이어서 + 【2026-09-26】관측치 보관 정리(앱 OBS_RETENTION_DAYS 가 없으면 앱이 건너뜀)
    else if (event.cron === "0 0 * * MON") ctx.waitUntil(reports(env).then(async () => { const r = await callApp(env, "/api/cron/retention"); await env.STATE.put("last:retention", JSON.stringify({ at: new Date().toISOString(), status: r.status, body: r.body })); }));
    else if (event.cron === "0,15,30,45 19-20 * * *") ctx.waitUntil(reviews(env));
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
    return Response.json({ measure: JSON.parse((await env.STATE.get("last:measure")) || "null"), queue: JSON.parse((await env.STATE.get("measure:queue")) || "null"), reports: JSON.parse((await env.STATE.get("last:reports")) || "null"), reviews: JSON.parse((await env.STATE.get("last:reviews")) || "null") });
  },
};
