// 로그인 후 화면: 온보딩 3단계 → 첫 측정 → 대시보드 · 설정 · 리포트
import { Hono } from "hono";
import type { AppEnv, HospitalRow } from "../lib/session";
import { requireSession } from "../lib/session";
import { HUB_ORIGIN, platformAvailability } from "../lib/config";
import { generateKeywords, normalizeTreatments, rankCandidates, type Candidate } from "../lib/keywords";
import { fetchKeywordIdeas } from "../collectors/naver-searchad";
import { limitsOf } from "../lib/plan-limits";
import { runHospital, loadEntities, obsScore, parseJsonArr, usablePlatforms } from "../lib/measure";
import { htmlSerp } from "../collectors/naver-html";
import { collectNaverApi } from "../collectors/naver-api";
import { buildWeeklyReport, PLATFORM_LABEL } from "../lib/report";
import { kstIso } from "../lib/time";
import { Step1, Step2, Step3, FirstRun, Dashboard, Settings, ReportList, ReportView, type DashboardData } from "../views-app";

const app = new Hono<AppEnv>();
app.use("/app", requireSession);
app.use("/app/*", requireSession);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const lines = (v: unknown) => str(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const csv = (v: unknown) => str(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
const placeIdOf = (v: string) => { const m = /(\d{5,15})/.exec(v); return m ? m[1] : null; };
const hv = (h: HospitalRow) => ({ name: h.name, plan: h.plan });
const regionOf = (h: HospitalRow) => [h.region_sido, h.region_sigungu, h.region_dong].filter(Boolean).join(" ");
function splitRegion(region: string) {
  const p = region.split(/\s+/).filter(Boolean);
  return { sido: p[0] || null, sigungu: p.slice(1, -1).join(" ") || (p.length === 2 ? p[1] : null), dong: p.length >= 3 ? p[p.length - 1] : null };
}

async function hubProfile(c: { env: AppEnv["Bindings"] }, hid: string | null) {
  if (!hid || !c.env.HUB_API_KEY) return null;
  try {
    const res = await fetch(`${HUB_ORIGIN}/api/v1/hospital-profile`, { headers: { Authorization: `Bearer ${c.env.HUB_API_KEY}`, "X-PS-Hospital-Id": hid }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { hospital_profile?: { basic?: { clinic_type?: string | null; region?: string | null; key_treatments?: string[] } } };
    return j.hospital_profile?.basic || null;
  } catch { return null; }
}

/** 「지역 × 진료」 생성 후, 검색광고 API가 있으면 검색량과 연관 키워드로 재정렬한다 */
async function buildCandidates(env: AppEnv["Bindings"], region: string, clinicType: string | null, treatments: string[], limit: number): Promise<{ list: Candidate[]; withVolume: boolean }> {
  const generated = generateKeywords({ region, clinicType, treatments, limit: limit + 10 });
  if (!platformAvailability(env).searchVolume || !generated.length) return { list: generated.map((t) => ({ text: t, volume: null, pc: null, mobile: null, low: false, source: "auto" as const })), withVolume: false };
  try {
    const ideas = await fetchKeywordIdeas(generated, { NAVER_SEARCHAD_KEY: env.NAVER_SEARCHAD_KEY!, NAVER_SEARCHAD_SECRET: env.NAVER_SEARCHAD_SECRET!, NAVER_SEARCHAD_CUSTOMER: env.NAVER_SEARCHAD_CUSTOMER! });
    return { list: rankCandidates(generated, ideas, region), withVolume: true };
  } catch (e) {
    console.log("[radar] keyword ideas failed", String(e).slice(0, 120));
    return { list: generated.map((t) => ({ text: t, volume: null, pc: null, mobile: null, low: false, source: "auto" as const })), withVolume: false };
  }
}
async function insertCandidates(db: D1Database, hospitalId: number, list: Candidate[], limit: number, activateTop: boolean, orderBase = 0) {
  const stmts = list.map((c, i) => db.prepare(
    "INSERT INTO keywords (hospital_id, text, source, is_active, sort_order, monthly_pc, monthly_mobile, volume_low, volume_updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(hospital_id, text) DO UPDATE SET sort_order = excluded.sort_order, monthly_pc = COALESCE(excluded.monthly_pc, keywords.monthly_pc), monthly_mobile = COALESCE(excluded.monthly_mobile, keywords.monthly_mobile), volume_low = excluded.volume_low, volume_updated_at = COALESCE(excluded.volume_updated_at, keywords.volume_updated_at)")
    .bind(hospitalId, c.text, c.source, activateTop && i < limit ? 1 : 0, orderBase + i, c.pc, c.mobile, c.low ? 1 : 0, c.volume == null ? null : kstIso(), kstIso()));
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
}

/* ── 온보딩 ── */
app.get("/app/onboarding", async (c) => {
  const h = c.get("hospital");
  const step = Number(c.req.query("step") || 0) || (!h.clinic_type || !h.region_sigungu ? 1 : 2);
  const limits = limitsOf(h.plan);
  if (step === 1) {
    const basic = !h.clinic_type ? await hubProfile(c, h.ps_hospital_id) : null;
    return c.html(Step1({ h: hv(h), prefill: {
      name: h.name, aliases: parseJsonArr(h.name_aliases).join(", "), clinic_type: h.clinic_type || basic?.clinic_type || "치과",
      region: regionOf(h) || basic?.region || "", treatments: parseJsonArr(h.key_treatments).join(", ") || (basic?.key_treatments || []).join(", "),
      naver_place_id: h.naver_place_id || "", website_url: h.website_url || "", fromHub: !!basic } }));
  }
  if (step === 2) {
    const kws = (await c.env.DB.prepare("SELECT id, text, is_active, source, monthly_pc, monthly_mobile, volume_low FROM keywords WHERE hospital_id = ? ORDER BY sort_order, id").bind(h.id).all()).results as { id: number; text: string; is_active: number; source: string; monthly_pc: number | null; monthly_mobile: number | null; volume_low: number }[];
    return c.html(Step2({ h: hv(h), keywords: kws, limit: limits.keywords, withVolume: kws.some((k) => k.monthly_pc != null) }));
  }
  // step 3: 추천 후보 — 상위 키워드 3개 즉석 조회(가능한 네이버 경로로)
  const existing = (await c.env.DB.prepare("SELECT id, name FROM competitors WHERE hospital_id = ? AND is_active = 1").bind(h.id).all()).results as { id: number; name: string }[];
  const kws = (await c.env.DB.prepare("SELECT text FROM keywords WHERE hospital_id = ? AND is_active = 1 ORDER BY sort_order, id LIMIT 3").bind(h.id).all()).results as { text: string }[];
  const counts = new Map<string, { count: number; placeId: string | null }>();
  const self = (await loadEntities(c.env.DB, h))[0];
  const avail = platformAvailability(c.env);
  let note: string | undefined;
  if (limits.competitors > 0 && avail.naver) {
    try {
      for (const k of kws) {
        const names: { name: string; placeId: string | null }[] = [];
        if (avail.naverMode === "html") { const r = await htmlSerp(k.text, [self]); for (const card of r.placeCards.filter((x) => !x.isAd).slice(0, 5)) names.push({ name: card.name, placeId: card.placeId }); await new Promise((r) => setTimeout(r, 2500)); }
        else { const r = await collectNaverApi(k.text, [self], { NAVER_CLIENT_ID: c.env.NAVER_CLIENT_ID!, NAVER_CLIENT_SECRET: c.env.NAVER_CLIENT_SECRET! }); for (const it of r.local) names.push({ name: it.name, placeId: null }); }
        for (const n of names) {
          if (!n.name || (self.placeId && n.placeId === self.placeId) || n.name.replace(/\s/g, "").includes(h.name.replace(/\s/g, ""))) continue;
          const cur = counts.get(n.name) || { count: 0, placeId: n.placeId };
          counts.set(n.name, { count: cur.count + 1, placeId: cur.placeId || n.placeId });
        }
      }
    } catch (e) { note = "추천 조회에 실패했습니다(" + String(e).slice(0, 40) + "). 직접 입력해 주세요."; }
  } else if (limits.competitors > 0) note = "네이버 수집 설정이 아직 없어 추천을 만들 수 없습니다. 직접 입력해 주세요.";
  const suggestions = [...counts.entries()].filter(([n]) => !existing.some((e) => e.name === n)).map(([name, v]) => ({ name, count: v.count, placeId: v.placeId })).sort((a, b) => b.count - a.count).slice(0, 8);
  return c.html(Step3({ h: hv(h), suggestions, existing, limit: limits.competitors, note }));
});

app.post("/app/onboarding/step1", async (c) => {
  const h = c.get("hospital");
  const b = await c.req.parseBody();
  const name = str(b.name), region = str(b.region);
  if (!name || !region) return c.html(Step1({ h: hv(h), prefill: { name, aliases: str(b.aliases), clinic_type: str(b.clinic_type), region, treatments: str(b.treatments), naver_place_id: str(b.naver_place_id), website_url: str(b.website_url), fromHub: false }, error: "병원 이름과 지역은 필수입니다." }), 400);
  const r = splitRegion(region);
  const treatments = normalizeTreatments(csv(b.treatments)).slice(0, 6);
  const website = str(b.website_url); const websiteOk = !website || /^https?:\/\//.test(website);
  await c.env.DB.prepare("UPDATE hospitals SET name = ?, name_aliases = ?, clinic_type = ?, region_sido = ?, region_sigungu = ?, region_dong = ?, key_treatments = ?, naver_place_id = ?, website_url = ?, updated_at = ? WHERE id = ?")
    .bind(name, JSON.stringify(csv(b.aliases).slice(0, 8)), str(b.clinic_type) || null, r.sido, r.sigungu, r.dong, JSON.stringify(treatments), placeIdOf(str(b.naver_place_id)), websiteOk ? website || null : null, kstIso(), h.id).run();
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM keywords WHERE hospital_id = ?").bind(h.id).first<{ n: number }>();
  if (!n?.n) {
    const limit = limitsOf(h.plan).keywords;
    const { list } = await buildCandidates(c.env, region, str(b.clinic_type) || null, treatments, limit);
    await insertCandidates(c.env.DB, h.id, list, limit, true);
  }
  return c.redirect("/app/onboarding?step=2");
});

async function saveKeywords(c: { env: AppEnv["Bindings"] }, h: HospitalRow, b: Record<string, unknown>) {
  const limit = limitsOf(h.plan).keywords;
  const active = new Set(([] as unknown[]).concat(b.active ?? []).map(String));
  const all = (await c.env.DB.prepare("SELECT id FROM keywords WHERE hospital_id = ?").bind(h.id).all()).results as { id: number }[];
  const stmts = all.map((k) => c.env.DB.prepare("UPDATE keywords SET is_active = ? WHERE id = ?").bind(active.has(String(k.id)) ? 1 : 0, k.id));
  let order = all.length;
  for (const t of lines(b.extra).slice(0, 40)) stmts.push(c.env.DB.prepare("INSERT INTO keywords (hospital_id, text, source, is_active, sort_order, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(hospital_id, text) DO UPDATE SET is_active = 1").bind(h.id, t.slice(0, 40), "manual", 1, order++, kstIso()));
  for (let i = 0; i < stmts.length; i += 40) await c.env.DB.batch(stmts.slice(i, i + 40));
  // 한도 초과분은 뒤에서부터 끈다
  // 한도 초과 시 직접 추가한 키워드를 먼저 남기고 자동 생성분부터 끈다
  const on = (await c.env.DB.prepare("SELECT id FROM keywords WHERE hospital_id = ? AND is_active = 1 ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, sort_order, id").bind(h.id).all()).results as { id: number }[];
  if (on.length > limit) await c.env.DB.batch(on.slice(limit).map((k) => c.env.DB.prepare("UPDATE keywords SET is_active = 0 WHERE id = ?").bind(k.id)));
  return on.length > limit;
}
app.post("/app/onboarding/step2", async (c) => {
  const h = c.get("hospital");
  await saveKeywords(c, h, await c.req.parseBody({ all: true }));
  return c.redirect("/app/onboarding?step=3");
});

async function saveCompetitors(c: { env: AppEnv["Bindings"] }, h: HospitalRow, b: Record<string, unknown>, keepKey = "active") {
  const limit = limitsOf(h.plan).competitors;
  const keep = new Set(([] as unknown[]).concat(b[keepKey] ?? []).map(String));
  const all = (await c.env.DB.prepare("SELECT id FROM competitors WHERE hospital_id = ?").bind(h.id).all()).results as { id: number }[];
  const stmts = all.map((x) => c.env.DB.prepare("UPDATE competitors SET is_active = ? WHERE id = ?").bind(keep.has(String(x.id)) ? 1 : 0, x.id));
  const picks = ([] as unknown[]).concat(b.pick ?? []).map(String).map((s) => { const [name, pid] = s.split("|"); return { name: name.trim(), placeId: pid?.trim() || null, auto: 1 }; });
  const extra = lines(b.extra).map((s) => { const [name, pid] = s.split("|"); return { name: name.trim().slice(0, 60), placeId: placeIdOf(pid || ""), auto: 0 }; });
  for (const p of [...picks, ...extra]) if (p.name) stmts.push(c.env.DB.prepare("INSERT INTO competitors (hospital_id, name, name_aliases, naver_place_id, is_auto, is_active, created_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(hospital_id, name) DO UPDATE SET is_active = 1, naver_place_id = COALESCE(excluded.naver_place_id, competitors.naver_place_id)").bind(h.id, p.name, "[]", p.placeId, p.auto, kstIso()));
  for (let i = 0; i < stmts.length; i += 40) await c.env.DB.batch(stmts.slice(i, i + 40));
  const on = (await c.env.DB.prepare("SELECT id FROM competitors WHERE hospital_id = ? AND is_active = 1 ORDER BY id").bind(h.id).all()).results as { id: number }[];
  if (on.length > limit) await c.env.DB.batch(on.slice(limit).map((x) => c.env.DB.prepare("UPDATE competitors SET is_active = 0 WHERE id = ?").bind(x.id)));
}
app.post("/app/onboarding/step3", async (c) => {
  const h = c.get("hospital");
  await saveCompetitors(c, h, await c.req.parseBody({ all: true }), "keep");
  await c.env.DB.prepare("UPDATE hospitals SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE id = ?").bind(kstIso(), kstIso(), h.id).run();
  return c.redirect("/app/first-run");
});

/* ── 첫 측정 ── */
function readiness(env: AppEnv["Bindings"], h: HospitalRow) {
  const u = usablePlatforms(env, h);
  const reasons: string[] = [];
  if (!u.naver) reasons.push("네이버: 공식 검색 API 키(NAVER_CLIENT_ID/SECRET) 또는 HTML 모드가 설정되지 않았습니다.");
  if (!u.google && !u.googlePlaces) reasons.push("구글: Places API 키가 없거나 플랜에 포함되지 않습니다.");
  if (!u.kakao) reasons.push("카카오맵: 로컬 REST 키가 없거나 플랜에 포함되지 않습니다.");
  return { ready: u.naver || u.google || u.googlePlaces || u.kakao, reasons };
}
app.get("/app/first-run", (c) => { const h = c.get("hospital"); const r = readiness(c.env, h); return c.html(FirstRun({ h: hv(h), ready: r.ready, reasons: r.reasons })); });
app.post("/app/first-run", async (c) => {
  const h = c.get("hospital");
  const r = readiness(c.env, h);
  if (!r.ready) return c.html(FirstRun({ h: hv(h), ready: false, reasons: r.reasons }), 409);
  const out: string[] = [];
  const res = await runHospital(c.env, h, { kind: "first", batch: 5, finalizeEarly: true, onProgress: (l) => out.push(l) });
  if (!res.ok) { out.push("측정을 시작하지 못했습니다: " + (res.skipped || res.error || (res.blocked ? "차단" : ""))); return c.html(FirstRun({ h: hv(h), ready: true, reasons: [], result: { total: null, platforms: {} }, lines: out })); }
  if (res.done) return c.html(FirstRun({ h: hv(h), ready: true, reasons: [], result: { total: res.total, platforms: res.platforms }, lines: out }));
  return c.redirect("/app");
});

/* ── 대시보드 ── */
app.get("/app", async (c) => {
  const h = c.get("hospital");
  const db = c.env.DB;
  const compare = c.req.query("compare") === "1";
  const u = usablePlatforms(c.env, h);
  const limits = limitsOf(h.plan);
  const weeks = (await db.prepare("SELECT DISTINCT week_start FROM weekly_scores WHERE hospital_id = ? ORDER BY week_start DESC LIMIT 2").bind(h.id).all()).results as { week_start: string }[];
  const week = weeks[0]?.week_start ?? null;
  const prevWeek = weeks[1]?.week_start ?? null;
  const d: DashboardData = { week, total: { score: null, prev: null, sov: null, weighted: null, series: [] }, platforms: [], matrix: [], matrixPlatforms: [], competitors: [], selfScore: null, reputation: [], alerts: [], runs: [], compare, onboarded: !!h.onboarded_at, hasVolume: false, opportunity: null };
  if (week) {
    const cur = (await db.prepare("SELECT platform, score, sov, weighted_score FROM weekly_scores WHERE hospital_id = ? AND week_start = ?").bind(h.id, week).all()).results as { platform: string; score: number; sov: number | null; weighted_score: number | null }[];
    const prev = prevWeek ? ((await db.prepare("SELECT platform, score FROM weekly_scores WHERE hospital_id = ? AND week_start = ?").bind(h.id, prevWeek).all()).results as { platform: string; score: number }[]) : [];
    const pm = Object.fromEntries(prev.map((r) => [r.platform, r.score]));
    const t = cur.find((r) => r.platform === "total");
    d.total = { score: t?.score ?? null, prev: pm.total ?? null, sov: t?.sov ?? null, weighted: t?.weighted_score ?? null, series: ((await db.prepare("SELECT week_start, score FROM weekly_scores WHERE hospital_id = ? AND platform = 'total' ORDER BY week_start DESC LIMIT 8").bind(h.id).all()).results as { week_start: string; score: number }[]).reverse().map((r) => ({ week: r.week_start, score: r.score })) };
    const state = (key: string): "ok" | "unmeasured" | "needs_key" | "plan" => {
      if (cur.some((r) => r.platform === key)) return "ok";
      if (key === "naver_serp" || key === "naver_place") return limits.platforms.includes("naver") ? (u.naver ? "unmeasured" : "needs_key") : "plan";
      if (key === "google") return limits.platforms.includes("google") ? (u.google || u.googlePlaces ? "unmeasured" : "needs_key") : "plan";
      if (key === "kakao") return limits.platforms.includes("kakao") ? (u.kakao ? "unmeasured" : "needs_key") : "plan";
      return limits.platforms.includes("signal") ? (u.signal ? "unmeasured" : "needs_key") : "plan";
    };
    d.platforms = ["naver_serp", "naver_place", "google", "kakao", "signal_ai"].map((key) => { const r = cur.find((x) => x.platform === key); return { key, label: PLATFORM_LABEL[key], score: r?.score ?? null, prev: pm[key] ?? null, sov: r?.sov ?? null, state: state(key) }; });
    // 최신 run 관측치 → 매트릭스·경쟁사 점수
    const run = await db.prepare("SELECT id FROM crawl_runs WHERE hospital_id = ? AND status IN ('completed','blocked') ORDER BY run_date DESC, id DESC LIMIT 1").bind(h.id).first<{ id: number }>();
    if (run) {
      const obs = (await db.prepare("SELECT o.platform, o.entity_type, o.entity_id, o.shown, o.rank, o.detail, k.text, k.monthly_pc, k.monthly_mobile, k.volume_low FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? ORDER BY k.sort_order, k.id").bind(run.id).all()).results as { platform: string; entity_type: string; entity_id: number | null; shown: number; rank: number | null; detail: string; text: string; monthly_pc: number | null; monthly_mobile: number | null; volume_low: number }[];
      const plats = ["naver_place", "naver_serp", "google_serp", "google_business", "kakao_map"].filter((p) => obs.some((o) => o.platform === p));
      d.matrixPlatforms = plats.map((p) => ({ key: p, label: p === "google_serp" ? "구글 검색" : p === "google_business" ? "구글 비즈니스" : p === "kakao_map" ? "카카오맵" : PLATFORM_LABEL[p] }));
      const byKw = new Map<string, DashboardData["matrix"][number]>();
      const compScore: Record<string, number[]> = {}; const selfScores: number[] = [];
      for (const o of obs) {
        let row = byKw.get(o.text); if (!row) { const vol = o.monthly_pc == null && o.monthly_mobile == null ? null : (o.monthly_pc ?? 0) + (o.monthly_mobile ?? 0); if (vol != null) d.hasVolume = true; row = { keyword: o.text, volume: vol, volumeLow: !!o.volume_low, cells: {}, competitors: {} }; byKw.set(o.text, row); }
        const det = (() => { try { return JSON.parse(o.detail || "{}"); } catch { return {}; } })();
        if (o.entity_type === "self") { row.cells[o.platform] = { rank: o.rank, shown: !!o.shown, ad: !!det.placeAd }; if (o.platform === "naver_place" || o.platform === "google_serp" || o.platform === "google_business" || o.platform === "kakao_map") selfScores.push(obsScore(o.platform, o.shown, o.rank, det)); }
        else if (o.platform === "naver_place") { row.competitors[`c${o.entity_id}`] = { rank: o.rank, shown: !!o.shown }; (compScore[`c${o.entity_id}`] ||= []).push(obsScore(o.platform, o.shown, o.rank, det)); }
      }
      d.matrix = [...byKw.values()];
      d.selfScore = selfScores.length ? Math.round((selfScores.reduce((a, b) => a + b, 0) / selfScores.length) * 10) / 10 : null;
      const comps = (await db.prepare("SELECT id, name FROM competitors WHERE hospital_id = ? AND is_active = 1 ORDER BY id").bind(h.id).all()).results as { id: number; name: string }[];
      d.competitors = comps.map((x) => { const s = compScore[`c${x.id}`]; return { id: x.id, name: x.name, score: s?.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null }; });
    }
    const rep = (await db.prepare("SELECT entity_type, entity_id, platform, snapshot_date, review_count, blog_review_count, rating FROM reputation_snapshots WHERE hospital_id = ? ORDER BY snapshot_date DESC LIMIT 200").bind(h.id).all()).results as { entity_type: string; entity_id: number | null; platform: string; snapshot_date: string; review_count: number | null; blog_review_count: number | null; rating: number | null }[];
    if (rep.length) {
      const names: Record<string, string> = {}; for (const x of d.competitors) names[`c${x.id}`] = x.name;
      const dates = [...new Set(rep.map((r) => r.snapshot_date))].sort().slice(-8);
      const groups = new Map<string, typeof rep>();
      for (const r of rep) { const k = `${r.entity_type === "self" ? "self" : "c" + r.entity_id}|${r.platform}`; (groups.get(k) || groups.set(k, []).get(k)!).push(r); }
      for (const [k, list] of groups) { const [ent, plat] = k.split("|"); if (ent !== "self" && !names[ent]) continue; d.reputation.push({ entity: ent === "self" ? h.name : names[ent], platform: PLATFORM_LABEL[plat === "google_business" ? "google" : plat] || plat, points: dates.map((dt) => { const p = list.find((x) => x.snapshot_date === dt); return { date: dt, reviews: p?.review_count ?? null, blog: p?.blog_review_count ?? null, rating: p?.rating ?? null }; }) }); }
    }
    // 검색 기회
    const opp = (await db.prepare("SELECT platform, pool, captured, coverage, detail FROM weekly_opportunity WHERE hospital_id = ? AND week_start = ?").bind(h.id, week).all()).results as { platform: string; pool: number; captured: number; coverage: number; detail: string }[];
    if (opp.length) {
      const prevOpp = prevWeek ? ((await db.prepare("SELECT platform, coverage FROM weekly_opportunity WHERE hospital_id = ? AND week_start = ?").bind(h.id, prevWeek).all()).results as { platform: string; coverage: number }[]) : [];
      const label: Record<string, string> = { naver_place: "네이버 플레이스", google: "구글", kakao: "카카오맵" };
      const np = opp.find((o) => o.platform === "naver_place") || opp[0];
      const det = JSON.parse(np.detail || "{}") as { lost?: DashboardData["opportunity"] extends infer T ? T extends { lost: infer L } ? L : never : never; competitors?: Record<string, { name: string; captured: number; coverage: number | null }> };
      d.opportunity = {
        pool: np.pool,
        platforms: ["naver_place", "google", "kakao"].filter((k) => opp.some((o) => o.platform === k)).map((k) => { const o = opp.find((x) => x.platform === k)!; return { key: k, label: label[k], captured: o.captured, coverage: o.coverage, prev: prevOpp.find((x) => x.platform === k)?.coverage ?? null }; }),
        lost: (det.lost || []).slice(0, 8),
        competitors: Object.values(det.competitors || {}).sort((a, b) => b.captured - a.captured),
        selfCaptured: np.captured,
      };
    }
    d.alerts = (await db.prepare("SELECT severity, message, created_at FROM alerts WHERE hospital_id = ? ORDER BY id DESC LIMIT 8").bind(h.id).all()).results as DashboardData["alerts"];
    d.runs = (await db.prepare("SELECT run_date, status, kind, error FROM crawl_runs WHERE hospital_id = ? ORDER BY run_date DESC, id DESC LIMIT 8").bind(h.id).all()).results as DashboardData["runs"];
  }
  return c.html(Dashboard({ h: hv(h), d }));
});

/* ── 설정 ── */
async function renderSettings(c: { env: AppEnv["Bindings"]; get: (k: "hospital") => HospitalRow }, flash?: string | null) {
  const h = await c.env.DB.prepare("SELECT * FROM hospitals WHERE id = ?").bind(c.get("hospital").id).first<HospitalRow>() as HospitalRow;
  const db = c.env.DB;
  const keywords = (await db.prepare("SELECT id, text, is_active, source, monthly_pc, monthly_mobile, volume_low FROM keywords WHERE hospital_id = ? ORDER BY sort_order, id").bind(h.id).all()).results as { id: number; text: string; is_active: number; source: string; monthly_pc: number | null; monthly_mobile: number | null; volume_low: number }[];
  const competitors = (await db.prepare("SELECT id, name, is_active, naver_place_id FROM competitors WHERE hospital_id = ? ORDER BY id").bind(h.id).all()).results as { id: number; name: string; is_active: number; naver_place_id: string | null }[];
  const settings = (await db.prepare("SELECT report_email_enabled, report_recipients FROM hospital_settings WHERE hospital_id = ?").bind(h.id).first<{ report_email_enabled: number; report_recipients: string }>()) || { report_email_enabled: 1, report_recipients: "[]" };
  const users = (await db.prepare("SELECT email, name, role FROM hospital_users WHERE hospital_id = ?").bind(h.id).all()).results as { email: string; name: string | null; role: string }[];
  const u = usablePlatforms(c.env, h); const a = platformAvailability(c.env); const lim = limitsOf(h.plan);
  const st = (ok: boolean, inPlan: boolean, keyed: boolean) => (ok ? "측정 중" : !inPlan ? "플랜 미포함" : keyed ? "설정됨" : "키 필요(운영자)");
  return Settings({ h: hv(h), hospital: { name: h.name, aliases: parseJsonArr(h.name_aliases).join(", "), clinic_type: h.clinic_type || "치과", region: regionOf(h), treatments: parseJsonArr(h.key_treatments).join(", "), naver_place_id: h.naver_place_id || "", website_url: h.website_url || "" },
    keywords, competitors, settings, users, limits: lim, flash,
    platform: { naver: st(u.naver, lim.platforms.includes("naver"), a.naver) + (a.naverMode ? ` · ${a.naverMode === "api" ? "공식 API" : "HTML"}` : ""), google: st(u.google, lim.platforms.includes("google"), a.google), kakao: st(u.kakao, lim.platforms.includes("kakao"), a.kakao), signal: st(u.signal, lim.platforms.includes("signal"), a.signal), mail: a.mail ? "설정됨" : "키 필요(운영자)" } });
}
app.get("/app/settings", async (c) => c.html(await renderSettings(c, c.req.query("ok") ? "저장했습니다." : null)));
app.post("/app/settings/hospital", async (c) => {
  const h = c.get("hospital"); const b = await c.req.parseBody();
  const r = splitRegion(str(b.region)); const website = str(b.website_url);
  await c.env.DB.prepare("UPDATE hospitals SET name = ?, name_aliases = ?, clinic_type = ?, region_sido = ?, region_sigungu = ?, region_dong = ?, key_treatments = ?, naver_place_id = ?, website_url = ?, updated_at = ? WHERE id = ?")
    .bind(str(b.name) || h.name, JSON.stringify(csv(b.aliases).slice(0, 8)), str(b.clinic_type) || null, r.sido, r.sigungu, r.dong, JSON.stringify(normalizeTreatments(csv(b.treatments)).slice(0, 6)), placeIdOf(str(b.naver_place_id)), /^https?:\/\//.test(website) ? website : null, kstIso(), h.id).run();
  return c.redirect("/app/settings?ok=1");
});
app.post("/app/settings/keywords", async (c) => {
  const h = c.get("hospital"); const b = await c.req.parseBody({ all: true });
  if (b.regen) {
    const limit = limitsOf(h.plan).keywords;
    const { list } = await buildCandidates(c.env, regionOf(h), h.clinic_type, parseJsonArr(h.key_treatments), limit);
    await insertCandidates(c.env.DB, h.id, list, limit, false); // 새 후보는 OFF, 기존 ON/OFF 유지, 검색량·순서만 갱신
    return c.redirect("/app/settings?ok=1#keywords");
  }
  const over = await saveKeywords(c, h, b);
  return c.redirect(over ? "/app/settings?ok=1&over=1" : "/app/settings?ok=1");
});
app.post("/app/settings/competitors", async (c) => { const h = c.get("hospital"); await saveCompetitors(c, h, await c.req.parseBody({ all: true }), "active"); return c.redirect("/app/settings?ok=1"); });
app.post("/app/settings/report", async (c) => {
  const h = c.get("hospital"); const b = await c.req.parseBody();
  const rec = csv(b.recipients).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 5);
  await c.env.DB.prepare("INSERT INTO hospital_settings (hospital_id, report_email_enabled, report_recipients, updated_at) VALUES (?,?,?,?) ON CONFLICT(hospital_id) DO UPDATE SET report_email_enabled = excluded.report_email_enabled, report_recipients = excluded.report_recipients, updated_at = excluded.updated_at").bind(h.id, b.enabled ? 1 : 0, JSON.stringify(rec), kstIso()).run();
  return c.redirect("/app/settings?ok=1");
});

/* ── 리포트 ── */
app.get("/app/reports", async (c) => { const h = c.get("hospital"); const weeks = (await c.env.DB.prepare("SELECT week_start, score FROM weekly_scores WHERE hospital_id = ? AND platform = 'total' ORDER BY week_start DESC LIMIT 26").bind(h.id).all()).results as { week_start: string; score: number }[]; return c.html(ReportList({ h: hv(h), weeks })); });
app.get("/app/reports/:week", async (c) => {
  const h = c.get("hospital"); const week = c.req.param("week");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return c.notFound();
  const r = await buildWeeklyReport(c.env.DB, h.id, week);
  if (!r) return c.notFound();
  return c.html(ReportView({ h: hv(h), r }));
});
export default app;
