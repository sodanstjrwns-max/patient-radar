// 크론·공급·어드민 API. 인증: x-cron-secret / Bearer PS_SERVICE_KEY / ADMIN_SECRET.
import { Hono } from "hono";
import type { Bindings } from "../lib/config";
import { platformAvailability } from "../lib/config";
import { equalSecret, adminAuthorized, issueAdminSession } from "../lib/security";
import type { HospitalRow } from "../lib/session";
import { runHospital, syncReviews, loadEntities, computeOpportunities, syncPrescriptions, refreshPlaceSnapshots } from "../lib/measure";
import { limitsOf } from "../lib/plan-limits";
import { withHubPlan, clearHubEntitlement } from "../lib/hub-entitlement";
import { buildWeeklyReport, reportToText, sendMail, sendOpsAlert } from "../lib/report";
import { kstDate, kstIso, weekStart } from "../lib/time";
import { AdminLogin, AdminPage } from "../views-app";
import { setCookie } from "hono/cookie";

const api = new Hono<{ Bindings: Bindings }>();
const err = (c: { json: (o: unknown, s: number) => Response }, code: string, message: string, status: number) => c.json({ error: { code, message } }, status);

/* ── 크론 ── */
const cronAuth = async (c: { env: Bindings; req: { header: (n: string) => string | undefined } }) => !!c.env.CRON_SECRET && (await equalSecret(c.req.header("x-cron-secret") || "", c.env.CRON_SECRET));

api.get("/api/cron/due", async (c) => {
  if (!c.env.CRON_SECRET) return err(c, "CRON_NOT_CONFIGURED", "크론 시크릿이 필요합니다.", 503);
  if (!(await cronAuth(c))) return err(c, "UNAUTHORIZED", "크론 인증이 필요합니다.", 401);
  // 요일 분산: 월~금 = 0..4, 병원 id % 5. L 플랜은 목요일(3)에 한 번 더.
  const kst = new Date(Date.now() + 9 * 3600_000);
  const dow = (kst.getUTCDay() + 6) % 7; // 월=0
  const force = c.req.query("all") === "1";
  const raw = (await c.env.DB.prepare("SELECT id, plan, ps_hospital_id FROM hospitals WHERE status = 'active' AND onboarded_at IS NOT NULL ORDER BY id").all()).results as { id: number; plan: string; ps_hospital_id: string | null }[];
  // L 추가 측정 판정에 허브 올패스 유효 플랜을 쓴다(캐시 30분, 실패 시 로컬 플랜)
  const rows = dow === 3 && !force ? await Promise.all(raw.map((h) => withHubPlan(c.env, h))) : raw;
  const due = rows.filter((h) => force || (dow <= 4 && (h.id % 5 === dow || (h.plan === "L" && dow === 3)))).map((h) => h.id);
  return c.json({ date: kstDate(), weekday: dow, due });
});

api.post("/api/cron/run-hospital/:id", async (c) => {
  if (!c.env.CRON_SECRET) return err(c, "CRON_NOT_CONFIGURED", "크론 시크릿이 필요합니다.", 503);
  if (!(await cronAuth(c))) return err(c, "UNAUTHORIZED", "크론 인증이 필요합니다.", 401);
  const row = await c.env.DB.prepare("SELECT * FROM hospitals WHERE id = ? AND status = 'active'").bind(Number(c.req.param("id"))).first<HospitalRow>();
  if (!row) return err(c, "HOSPITAL_NOT_FOUND", "병원이 없습니다.", 404);
  const h = await withHubPlan(c.env, row);
  const kind = c.req.query("kind") === "manual" ? "manual" : "weekly";
  const batch = Math.min(Math.max(Number(c.req.query("batch") || 6), 1), 40);
  const r = await runHospital(c.env, h, { kind, batch });
  if (!r.ok && r.blocked) await sendOpsAlert(c.env, "네이버 차단 감지", `병원 #${h.id} ${h.name} run ${r.runId ?? "-"}: 오늘 수집을 중단했습니다.`);
  if (r.ok && r.done && r.blocked) await sendOpsAlert(c.env, "네이버 차단 감지(부분 완료)", `병원 #${h.id} ${h.name} run ${r.runId}`);
  return c.json(r, r.ok ? 200 : 200);
});

/** 【2026-09-26】크론 워커가 병원 1곳씩 부르도록 활성 병원 id 목록 (200병원 대비 — 한 요청에 전 병원을 돌지 않는다) */
api.get("/api/cron/active-hospitals", async (c) => {
  if (!c.env.CRON_SECRET) return err(c, "CRON_NOT_CONFIGURED", "크론 시크릿이 필요합니다.", 503);
  if (!(await cronAuth(c))) return err(c, "UNAUTHORIZED", "크론 인증이 필요합니다.", 401);
  const rows = (await c.env.DB.prepare("SELECT id FROM hospitals WHERE status = 'active' AND onboarded_at IS NOT NULL ORDER BY id").all()).results as { id: number }[];
  return c.json({ ids: rows.map((r) => r.id), naver_html: platformAvailability(c.env).naverMode === "html" });
});

/** 매일: 리뷰 본문 수집 + 부정 리뷰 즉시 메일 (네이버 HTML 모드일 때만) */
api.post("/api/cron/reviews", async (c) => {
  if (!c.env.CRON_SECRET) return err(c, "CRON_NOT_CONFIGURED", "크론 시크릿이 필요합니다.", 503);
  if (!(await cronAuth(c))) return err(c, "UNAUTHORIZED", "크론 인증이 필요합니다.", 401);
  if (platformAvailability(c.env).naverMode !== "html") return c.json({ skipped: "naver_html_mode_off" });
  const only = Number(c.req.query("hospital") || 0) || null;
  const hospitals = (await c.env.DB.prepare(`SELECT * FROM hospitals WHERE status = 'active' AND onboarded_at IS NOT NULL ${only ? "AND id = ?" : ""} ORDER BY id`).bind(...(only ? [only] : [])).all()).results as HospitalRow[];
  const out: Record<string, unknown>[] = [];
  for (const row of hospitals) {
    const h = await withHubPlan(c.env, row);
    try {
      const entities = (await loadEntities(c.env.DB, h, limitsOf(h.plan).competitors));
      const r = await syncReviews(c.env, h, entities);
      let mailed = false;
      if (r.newNegatives.length && c.env.RESEND_API_KEY) {
        const users = (await c.env.DB.prepare("SELECT email FROM hospital_users WHERE hospital_id = ?").bind(h.id).all()).results as { email: string }[];
        const s = await c.env.DB.prepare("SELECT report_email_enabled, report_recipients FROM hospital_settings WHERE hospital_id = ?").bind(h.id).first<{ report_email_enabled: number; report_recipients: string }>();
        const to = [...new Set([...users.map((u) => u.email), ...(JSON.parse(s?.report_recipients || "[]") as string[])])];
        if (to.length && (!s || s.report_email_enabled)) {
          const text = `${h.name} 네이버 방문자 리뷰에 부정 신호가 ${r.newNegatives.length}건 새로 올라왔습니다.\n\n` + r.newNegatives.map((n) => `- (${n.complaints.join("·")}) ${n.body}`).join("\n") + `\n\n48시간 안에 답글을 남기면 다음 방문자 리뷰 신뢰도에 도움이 됩니다.\n대시보드: ${c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin}/app`;
          mailed = (await sendMail(c.env, to, `[페이션트 레이더] ${h.name} 부정 리뷰 ${r.newNegatives.length}건`, text)).ok;
        }
      }
      out.push({ id: h.id, fetched: r.fetched, inserted: r.inserted, negative: r.negative, mailed });
    } catch (e) { out.push({ id: h.id, error: String(e).slice(0, 80), blocked: String(e).includes("NAVER_BLOCKED") }); if (String(e).includes("NAVER_BLOCKED")) break; }
    if (!only) await new Promise((res) => setTimeout(res, 2000));   // 병원 1곳 호출(워커 분할)이면 쉬는 건 워커가 한다
  }
  return c.json({ date: kstDate(), results: out });
});
api.post("/api/cron/weekly-reports", async (c) => {
  if (!c.env.CRON_SECRET) return err(c, "CRON_NOT_CONFIGURED", "크론 시크릿이 필요합니다.", 503);
  if (!(await cronAuth(c))) return err(c, "UNAUTHORIZED", "크론 인증이 필요합니다.", 401);
  // 월요일 아침 실행 → 지난주(월~일) 측정분. ?week=YYYY-MM-DD 로 지정 가능.
  const week = c.req.query("week") || weekStart(new Date(Date.now() - 7 * 86400_000));
  const send = c.req.query("send") !== "0";
  const onlyId = Number(c.req.query("hospital") || 0) || null;   // 【2026-09-26】워커가 병원별로 분할 호출
  const hospitals = (await c.env.DB.prepare(`SELECT h.id, h.name FROM hospitals h WHERE h.status = 'active' AND h.onboarded_at IS NOT NULL ${onlyId ? "AND h.id = ?" : ""}`).bind(...(onlyId ? [onlyId] : [])).all()).results as { id: number; name: string }[];
  const out: Record<string, unknown>[] = [];
  for (const h of hospitals) {
    const r = await buildWeeklyReport(c.env.DB, h.id, week);
    if (!r) { out.push({ id: h.id, skipped: "no_scores" }); continue; }
    await c.env.DB.prepare("INSERT INTO weekly_reports (hospital_id, week_start, content_json, created_at) VALUES (?,?,?,?) ON CONFLICT(hospital_id, week_start) DO UPDATE SET content_json = excluded.content_json").bind(h.id, week, JSON.stringify(r), kstIso()).run();
    const s = await c.env.DB.prepare("SELECT report_email_enabled, report_recipients FROM hospital_settings WHERE hospital_id = ?").bind(h.id).first<{ report_email_enabled: number; report_recipients: string }>();
    const already = await c.env.DB.prepare("SELECT sent_at FROM weekly_reports WHERE hospital_id = ? AND week_start = ?").bind(h.id, week).first<{ sent_at: string | null }>();
    if (!send || (s && !s.report_email_enabled) || already?.sent_at) { out.push({ id: h.id, built: true, sent: false }); continue; }
    const users = (await c.env.DB.prepare("SELECT email FROM hospital_users WHERE hospital_id = ?").bind(h.id).all()).results as { email: string }[];
    const to = [...new Set([...users.map((u) => u.email), ...(JSON.parse(s?.report_recipients || "[]") as string[])])].slice(0, 8);
    if (!to.length) { out.push({ id: h.id, built: true, sent: false, reason: "no_recipients" }); continue; }
    const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
    const subject = `[페이션트 레이더] ${h.name} 주간 가시성 — ${r.total ?? "—"}점${r.delta != null ? ` (${r.delta >= 0 ? "+" : ""}${r.delta})` : ""}`;
    const text = reportToText(r) + `\n\n대시보드: ${origin}/app/reports/${week}`;
    const m = await sendMail(c.env, to, subject, text, `<pre style="font:14px/1.6 Pretendard,Apple SD Gothic Neo,sans-serif">${text.replace(/</g, "&lt;")}</pre>`);
    if (m.ok) await c.env.DB.prepare("UPDATE weekly_reports SET sent_at = ?, sent_to = ? WHERE hospital_id = ? AND week_start = ?").bind(kstIso(), to.join(","), h.id, week).run();
    out.push({ id: h.id, built: true, sent: m.ok, error: m.error });
  }
  return c.json({ week, results: out });
});

/* ── 허브 → 레이더 이벤트 웹훅: POST /api/v1/hub-events (Bearer PS_SSO_SECRET, 형제 서비스와 같은 방식) ──
   subscription_updated = 올패스·단품 구독 변경 → 그 병원 권한 캐시 삭제(다음 판정 때 허브에서 다시 읽음).
   profile_updated 등 그 밖의 type 은 레이더가 허브 프로필을 캐시하지 않으므로 수신 확인만. */
api.post("/api/v1/hub-events", async (c) => {
  const secret = c.env.PS_SSO_SECRET?.trim();
  const bearer = c.req.header("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  if (!secret || !token || !(await equalSecret(token, secret))) return err(c, "UNAUTHORIZED", "유효하지 않은 인증입니다.", 401);
  const body = (await c.req.json().catch(() => null)) as { type?: unknown; ps_hospital_id?: unknown } | null;
  const hid = typeof body?.ps_hospital_id === "string" ? body.ps_hospital_id.trim() : "";
  if (!hid || hid.length > 200) return err(c, "INVALID_BODY", "ps_hospital_id가 필요합니다.", 400);
  const type = typeof body?.type === "string" ? body.type : "profile_updated";
  if (type === "subscription_updated") await clearHubEntitlement(c.env, hid);
  return c.json({ ok: true, type, cleared: type === "subscription_updated" });
});

/* ── 공급 API (PS Open API v1) ── */
api.get("/api/v1/signals", async (c) => {
  if (!c.env.PS_SERVICE_KEY) return err(c, "SERVICE_KEY_NOT_CONFIGURED", "공급 API 키가 설정되지 않았습니다.", 503);
  const bearer = c.req.header("Authorization") || "";
  if (!bearer.startsWith("Bearer ") || !(await equalSecret(bearer.slice(7), c.env.PS_SERVICE_KEY))) return err(c, "UNAUTHORIZED", "유효한 공급 API 인증이 필요합니다.", 401);
  const hid = c.req.header("X-PS-Hospital-Id")?.trim();
  if (!hid) return err(c, "MISSING_HOSPITAL_ID", "병원 ID 헤더가 필요합니다.", 400);
  if (hid.length > 200) return err(c, "INVALID_HOSPITAL_ID", "병원 ID 길이가 올바르지 않습니다.", 400);
  const h = await c.env.DB.prepare("SELECT id, name FROM hospitals WHERE ps_hospital_id = ?").bind(hid).first<{ id: number; name: string }>();
  if (!h) return err(c, "HOSPITAL_NOT_MAPPED", "연결된 병원이 없습니다.", 404);
  const since = c.req.query("since") || "";
  const weeks = (await c.env.DB.prepare("SELECT week_start, score, sov FROM weekly_scores WHERE hospital_id = ? AND platform = 'total' ORDER BY week_start DESC LIMIT 8").bind(h.id).all()).results as { week_start: string; score: number; sov: number | null }[];
  const signals: Record<string, unknown>[] = [];
  if (weeks.length) {
    const w = weeks[0]; const prev = weeks[1];
    const occurred = `${w.week_start}T09:00:00+09:00`;
    if (!since || occurred >= since) signals.push({
      signal_id: `radar:${hid}:${w.week_start}:score`, type: "visibility_score", severity: "info",
      title: `온라인 가시성 ${w.score}점${prev ? ` (${w.score - prev.score >= 0 ? "+" : ""}${Math.round((w.score - prev.score) * 10) / 10})` : ""}`,
      summary: `${w.week_start} 주 · 플랫폼 가시성 점수${w.sov != null ? ` · 점유율 ${Math.round(w.sov * 100)}%` : ""}`,
      occurred_at: occurred, value: w.score,
      data: { metric: "visibility_score", score: w.score, sov: w.sov, series: [...weeks].reverse().map((x) => ({ date: x.week_start, value: x.score })) },
    });
    const alerts = (await c.env.DB.prepare("SELECT code, severity, message, created_at FROM alerts WHERE hospital_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 10").bind(h.id, since || "2000-01-01").all()).results as { code: string; severity: string; message: string; created_at: string }[];
    for (const a of alerts) signals.push({ signal_id: `radar:${hid}:${a.code}`, type: a.code.startsWith("rank_drop") ? "keyword_rank_drop" : a.code === "naver_blocked" ? "measurement_blocked" : "score_drop", severity: a.severity, title: a.message, summary: a.message, occurred_at: a.created_at });
  }
  return c.json({ service: "radar", signals });
});

/* ── 【2026-09-25】공급 API: PFM 퍼널 1단계(인지)용 요약 — 가시성 점수·점유율·검색 기회 커버율·놓친 키워드·내원 경로 ── */
api.get("/api/v1/funnel-stats", async (c) => {
  if (!c.env.PS_SERVICE_KEY) return err(c, "SERVICE_KEY_NOT_CONFIGURED", "공급 API 키가 설정되지 않았습니다.", 503);
  const bearer = c.req.header("Authorization") || "";
  if (!bearer.startsWith("Bearer ") || !(await equalSecret(bearer.slice(7), c.env.PS_SERVICE_KEY))) return err(c, "UNAUTHORIZED", "유효한 공급 API 인증이 필요합니다.", 401);
  const hid = c.req.header("X-PS-Hospital-Id")?.trim();
  if (!hid || hid.length > 200) return err(c, "MISSING_HOSPITAL_ID", "병원 ID 헤더가 필요합니다.", 400);
  const h = await c.env.DB.prepare("SELECT id, name FROM hospitals WHERE ps_hospital_id = ?").bind(hid).first<{ id: number; name: string }>();
  if (!h) return err(c, "HOSPITAL_NOT_MAPPED", "연결된 병원이 없습니다.", 404);
  const w = await c.env.DB.prepare("SELECT week_start, score, weighted_score, sov, keyword_count, shown_count FROM weekly_scores WHERE hospital_id = ? AND platform = 'total' ORDER BY week_start DESC LIMIT 1").bind(h.id).first<Record<string, unknown>>();
  const prev = w ? await c.env.DB.prepare("SELECT score, weighted_score FROM weekly_scores WHERE hospital_id = ? AND platform = 'total' AND week_start < ? ORDER BY week_start DESC LIMIT 1").bind(h.id, w.week_start).first<Record<string, unknown>>() : null;
  const plats = w ? (await c.env.DB.prepare("SELECT platform, score FROM weekly_scores WHERE hospital_id = ? AND week_start = ? AND platform <> 'total'").bind(h.id, w.week_start).all()).results as { platform: string; score: number }[] : [];
  const op = await c.env.DB.prepare("SELECT week_start, platform, pool, captured, coverage, detail FROM weekly_opportunity WHERE hospital_id = ? AND platform = 'naver_place' ORDER BY week_start DESC LIMIT 1").bind(h.id).first<Record<string, unknown>>();
  let opportunity: Record<string, unknown> | null = null;
  if (op) {
    let d: Record<string, unknown> = {}; try { d = JSON.parse(String(op.detail || "{}")); } catch {}
    const lost = (Array.isArray(d.lost) ? d.lost as Record<string, unknown>[] : []).slice().sort((a, b) => Number(b.lost || 0) - Number(a.lost || 0)).slice(0, 3)
      .map((x) => ({ keyword: x.keyword, volume: x.volume, rank: x.rank ?? null, lost: x.lost, action: Array.isArray(x.actions) && x.actions.length ? String((x.actions[0] as { text?: string }).text ?? x.actions[0]).slice(0, 160) : null }));
    const comps = d.competitors && typeof d.competitors === "object" ? Object.values(d.competitors as Record<string, { name?: string; coverage?: number }>) : [];
    const best = comps.reduce<{ name?: string; coverage?: number } | null>((m, x) => (!m || Number(x.coverage || 0) > Number(m.coverage || 0) ? x : m), null);
    opportunity = { week_start: op.week_start, platform: op.platform, pool: op.pool, captured: op.captured, coverage: op.coverage, top_lost: lost, best_competitor: best ? { name: best.name, coverage: best.coverage } : null };
  }
  const ar = await c.env.DB.prepare("SELECT week_start, first_visits, answered, groups FROM weekly_arrivals WHERE hospital_id = ? ORDER BY week_start DESC LIMIT 1").bind(h.id).first<Record<string, unknown>>();
  let arrivals: Record<string, unknown> | null = null;
  if (ar) { let g: Record<string, number> = {}; try { g = JSON.parse(String(ar.groups || "{}")); } catch {} arrivals = { week_start: ar.week_start, first_visits: ar.first_visits, answered: ar.answered, groups: g }; }
  return c.json({
    service: "radar", hospital: h.name,
    score: w ? { week_start: w.week_start, score: w.score, weighted_score: w.weighted_score ?? null, sov: w.sov, prev_score: prev?.score ?? null, prev_weighted: prev?.weighted_score ?? null, keyword_count: w.keyword_count, shown_count: w.shown_count, platforms: Object.fromEntries(plats.map((p) => [p.platform, p.score])) } : null,
    opportunity, arrivals, as_of: new Date().toISOString(),
  });
});

/* ── 어드민 ── */
api.get("/admin", async (c) => {
  if (!c.env.ADMIN_SECRET) return c.text("admin not configured", 503);
  if (!(await adminAuthorized(c))) return c.html(AdminLogin({}));
  const db = c.env.DB;
  const week = weekStart();
  const hospitals = (await db.prepare(`SELECT h.id, h.name, h.ps_hospital_id, h.plan, h.onboarded_at,
      (SELECT COUNT(*) FROM keywords k WHERE k.hospital_id = h.id AND k.is_active = 1) AS keywords,
      (SELECT run_date FROM crawl_runs r WHERE r.hospital_id = h.id ORDER BY run_date DESC, id DESC LIMIT 1) AS last_run,
      (SELECT status FROM crawl_runs r WHERE r.hospital_id = h.id ORDER BY run_date DESC, id DESC LIMIT 1) AS last_status,
      (SELECT score FROM weekly_scores w WHERE w.hospital_id = h.id AND w.platform = 'total' AND w.week_start = ?) AS week_score,
      (SELECT form_api_key IS NOT NULL FROM hospital_settings s WHERE s.hospital_id = h.id) AS has_form_key
    FROM hospitals h ORDER BY h.id`).bind(week).all()).results as Record<string, unknown>[];
  const runs = (await db.prepare("SELECT hospital_id, run_date, status, kind, error FROM crawl_runs ORDER BY id DESC LIMIT 15").all()).results as Record<string, unknown>[];
  const alerts = (await db.prepare("SELECT hospital_id, severity, message, created_at FROM alerts ORDER BY id DESC LIMIT 15").all()).results as Record<string, unknown>[];
  const a = platformAvailability(c.env);
  const pause = await db.prepare("SELECT until_date, reason FROM collection_pauses WHERE scope = 'naver'").bind().first<{ until_date: string; reason: string }>();
  return c.html(AdminPage({ hospitals, runs, alerts, flash: c.req.query("msg") || null, config: { naver: a.naverMode || "off", google: a.google, places: a.googlePlaces, kakao: a.kakao, signal: a.signal, mail: a.mail, sso: !!c.env.PS_SSO_SECRET, supply: !!c.env.PS_SERVICE_KEY, cron: !!c.env.CRON_SECRET, naverPause: pause ? `${pause.until_date}(${pause.reason})` : "none" } }));
});
api.post("/admin/login", async (c) => {
  if (!c.env.ADMIN_SECRET) return c.text("admin not configured", 503);
  const b = await c.req.parseBody();
  if (!(await equalSecret(String(b.secret || ""), c.env.ADMIN_SECRET))) return c.html(AdminLogin({ error: "일치하지 않습니다." }), 401);
  await issueAdminSession(c);
  return c.redirect("/admin");
});
api.post("/admin/run/:id", async (c) => {
  if (!(await adminAuthorized(c))) return c.text("forbidden", 403);
  const row = await c.env.DB.prepare("SELECT * FROM hospitals WHERE id = ?").bind(Number(c.req.param("id"))).first<HospitalRow>();
  if (!row) return c.text("no hospital", 404);
  const h = await withHubPlan(c.env, row);
  const r = await runHospital(c.env, h, { kind: "manual", batch: 40, finalizeEarly: true });
  return c.redirect("/admin?msg=" + encodeURIComponent(r.ok ? (r.done ? `#${h.id} 측정 완료 · 총점 ${r.total ?? "—"}` : `#${h.id} 부분 처리`) : `#${h.id} 실패: ${r.skipped || r.error || "blocked"}`));
});
/** 마지막 완료 run 의 관측치로 검색 기회·처방만 다시 계산(재수집 없음) — 곡선·처방 규칙을 바꿨을 때 */
api.post("/admin/recompute/:id", async (c) => {
  if (!(await adminAuthorized(c))) return c.text("forbidden", 403);
  const row = await c.env.DB.prepare("SELECT * FROM hospitals WHERE id = ?").bind(Number(c.req.param("id"))).first<HospitalRow>();
  if (!row) return c.text("no hospital", 404);
  const h = await withHubPlan(c.env, row);
  const run = await c.env.DB.prepare("SELECT id, run_date FROM crawl_runs WHERE hospital_id = ? AND status = 'completed' ORDER BY run_date DESC, id DESC LIMIT 1").bind(h.id).first<{ id: number; run_date: string }>();
  if (!run) return c.redirect("/admin?msg=" + encodeURIComponent(`#${h.id} 완료된 측정이 없습니다`));
  const week = weekStart(new Date(run.run_date + "T12:00:00+09:00"));
  try {
    if (c.req.query("snapshots") !== "0") await refreshPlaceSnapshots(c.env, h, run.run_date);
    await computeOpportunities(c.env.DB, h.id, run.id, week);
    await syncPrescriptions(c.env.DB, h.id, run.id, week, run.run_date);
  } catch (e) { return c.redirect("/admin?msg=" + encodeURIComponent(`#${h.id} 재계산 실패: ${String(e).slice(0, 80)}`)); }
  return c.redirect("/admin?msg=" + encodeURIComponent(`#${h.id} run ${run.id}(${run.run_date}) 기회·처방 재계산 완료`));
});
api.post("/admin/plan/:id", async (c) => {
  if (!(await adminAuthorized(c))) return c.text("forbidden", 403);
  const b = await c.req.parseBody(); const plan = String(b.plan || "");
  if (!["FREE", "S", "M", "L"].includes(plan)) return c.text("bad plan", 400);
  await c.env.DB.prepare("UPDATE hospitals SET plan = ?, updated_at = ? WHERE id = ?").bind(plan, kstIso(), Number(c.req.param("id"))).run();
  return c.redirect("/admin?msg=" + encodeURIComponent("플랜 저장"));
});
api.post("/admin/form-key/:id", async (c) => {
  if (!(await adminAuthorized(c))) return c.text("forbidden", 403);
  const b = await c.req.parseBody(); const key = String(b.key || "").trim();
  if (!/^pfk_[A-Za-z0-9]{32,}$/.test(key)) return c.redirect("/admin?msg=" + encodeURIComponent("폼 키 형식 오류(pfk_…)"));
  const id = Number(c.req.param("id"));
  await c.env.DB.prepare("INSERT INTO hospital_settings (hospital_id, form_api_key, updated_at) VALUES (?,?,?) ON CONFLICT(hospital_id) DO UPDATE SET form_api_key = excluded.form_api_key, updated_at = excluded.updated_at").bind(id, key, kstIso()).run();
  return c.redirect("/admin?msg=" + encodeURIComponent(`#${id} 폼 키 저장`));
});
api.post("/admin/clear-pause", async (c) => {
  if (!(await adminAuthorized(c))) return c.text("forbidden", 403);
  await c.env.DB.prepare("DELETE FROM collection_pauses WHERE scope = 'naver'").run();
  return c.redirect("/admin?msg=" + encodeURIComponent("네이버 일시중단 해제"));
});
api.get("/api/admin/summary", async (c) => {
  if (!c.env.ADMIN_SECRET) return err(c, "ADMIN_NOT_CONFIGURED", "운영 인증 설정이 필요합니다.", 503);
  if (!(await adminAuthorized(c))) return err(c, "UNAUTHORIZED", "운영자 인증이 필요합니다.", 401);
  const db = c.env.DB;
  const hospitals = await db.prepare("SELECT COUNT(*) AS n FROM hospitals").first<{ n: number }>();
  const runs = (await db.prepare("SELECT status, COUNT(*) AS n FROM crawl_runs WHERE run_date >= date('now', '-7 days') GROUP BY status").all()).results;
  const alerts = (await db.prepare("SELECT hospital_id, severity, code, message, created_at FROM alerts ORDER BY id DESC LIMIT 20").all()).results;
  const a = platformAvailability(c.env);
  return c.json({ data: { hospitals: hospitals?.n ?? 0, runs7d: runs, alerts, configuration: { ...a, sso: !!c.env.PS_SSO_SECRET, serviceKey: !!c.env.PS_SERVICE_KEY, cron: !!c.env.CRON_SECRET } } });
});
// 쿠키 헬퍼 참조 유지(향후 어드민 세션 만료 처리)
void setCookie;
export default api;
