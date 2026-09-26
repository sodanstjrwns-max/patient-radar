// 로그인 후 화면: 온보딩 3단계 → 첫 측정 → 대시보드 · 설정 · 리포트
import { Hono } from "hono";
import type { AppEnv, HospitalRow } from "../lib/session";
import { requireSession } from "../lib/session";
import { HUB_ORIGIN, platformAvailability } from "../lib/config";
import { generateKeywords, normalizeTreatments, rankCandidates, type Candidate } from "../lib/keywords";
import { fetchKeywordIdeas } from "../collectors/naver-searchad";
import { resolveChannel } from "../collectors/youtube";
import { limitsOf } from "../lib/plan-limits";
import { withHubPlan, hubPlanLine } from "../lib/hub-entitlement";
import { runHospital, loadEntities, obsScore, parseJsonArr, usablePlatforms, opportunityOfRun } from "../lib/measure";
import { htmlSerp } from "../collectors/naver-html";
import { collectNaverApi } from "../collectors/naver-api";
import { buildWeeklyReport, PLATFORM_LABEL } from "../lib/report";
import { buildInsights } from "../lib/insights";
import { kstIso, kstDate } from "../lib/time";
import { Step1, Step2, Step3, FirstRun, Dashboard, Settings, ReportList, ReportView, Evidence, type DashboardData } from "../views-app";

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

type HubBasic = { clinic_type?: string | null; region?: string | null; key_treatments?: string[] };
type HubCompetitor = { name: string; aliases: string[]; naver_place_id: string | null; region: string | null };
/** 허브 프로필(기본 정보 + 경쟁 병원 정본). 허브가 없거나 실패하면 null */
async function hubProfile(c: { env: AppEnv["Bindings"] }, hid: string | null): Promise<{ basic: HubBasic | null; competitors: HubCompetitor[] } | null> {
  if (!hid || !c.env.HUB_API_KEY) return null;
  try {
    const res = await fetch(`${HUB_ORIGIN}/api/v1/hospital-profile`, { headers: { Authorization: `Bearer ${c.env.HUB_API_KEY}`, "X-PS-Hospital-Id": hid }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { hospital_profile?: { basic?: HubBasic; competitors?: Partial<HubCompetitor>[] } };
    const competitors = (j.hospital_profile?.competitors || []).filter((x) => x && typeof x.name === "string" && x.name.trim())
      .map((x) => ({ name: x.name!.trim(), aliases: Array.isArray(x.aliases) ? x.aliases.filter((a): a is string => typeof a === "string") : [], naver_place_id: x.naver_place_id ? String(x.naver_place_id) : null, region: x.region || null }));
    return { basic: j.hospital_profile?.basic || null, competitors };
  } catch { return null; }
}
const normName = (s: string) => s.replace(/\s+/g, "").toLowerCase();
/** 허브 정본 → 레이더. 허브에만 있는 경쟁 병원을 추가(한도 안이면 활성)하고, 비어 있던 플레이스 ID·별칭을 채운다 */
async function pullHubCompetitors(c: { env: AppEnv["Bindings"] }, h: HospitalRow): Promise<{ hubCount: number; added: number }> {
  const hub = await hubProfile(c, h.ps_hospital_id);
  const list = hub?.competitors || [];
  if (!list.length) return { hubCount: 0, added: 0 };
  const db = c.env.DB;
  const rows = (await db.prepare("SELECT id, name, name_aliases, naver_place_id, is_active FROM competitors WHERE hospital_id = ?").bind(h.id).all()).results as { id: number; name: string; name_aliases: string | null; naver_place_id: string | null; is_active: number }[];
  const limit = limitsOf(h.plan).competitors;
  let active = rows.filter((r) => r.is_active).length;
  const stmts: D1PreparedStatement[] = [];
  let added = 0;
  for (const hc of list) {
    if (normName(hc.name) === normName(h.name) || (hc.naver_place_id && hc.naver_place_id === h.naver_place_id)) continue; // 우리 병원은 제외
    const keys = [hc.name, ...hc.aliases].map(normName);
    const hit = rows.find((r) => (hc.naver_place_id && r.naver_place_id === hc.naver_place_id) || [r.name, ...parseJsonArr(r.name_aliases)].map(normName).some((k) => keys.includes(k)));
    if (hit) {
      const aliases = parseJsonArr(hit.name_aliases);
      const merged = [...new Set([...aliases, ...hc.aliases.filter((a) => normName(a) !== normName(hit.name))])].slice(0, 5);
      if ((!hit.naver_place_id && hc.naver_place_id) || merged.length !== aliases.length) stmts.push(db.prepare("UPDATE competitors SET naver_place_id = COALESCE(naver_place_id, ?), name_aliases = ? WHERE id = ?").bind(hc.naver_place_id, JSON.stringify(merged), hit.id));
      continue;
    }
    const on = active < limit ? 1 : 0; if (on) active++;
    stmts.push(db.prepare("INSERT INTO competitors (hospital_id, name, name_aliases, naver_place_id, is_auto, is_active, created_at) VALUES (?,?,?,?,0,?,?) ON CONFLICT(hospital_id, name) DO UPDATE SET naver_place_id = COALESCE(competitors.naver_place_id, excluded.naver_place_id)").bind(h.id, hc.name.slice(0, 60), JSON.stringify(hc.aliases.slice(0, 5)), hc.naver_place_id, on, kstIso()));
    added++;
  }
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  return { hubCount: list.length, added };
}
/** 레이더 → 허브. 활성 경쟁 병원(이름·별칭·플레이스 ID)을 정본에 병합한다(허브 쪽이 빈 칸만 채움). 실패해도 흐름을 막지 않는다 */
async function pushHubCompetitors(env: AppEnv["Bindings"], h: HospitalRow): Promise<boolean> {
  if (!h.ps_hospital_id || !env.HUB_API_KEY) return false;
  const rows = (await env.DB.prepare("SELECT name, name_aliases, naver_place_id FROM competitors WHERE hospital_id = ? AND is_active = 1 ORDER BY id").bind(h.id).all()).results as { name: string; name_aliases: string | null; naver_place_id: string | null }[];
  if (!rows.length) return false;
  try {
    const res = await fetch(`${HUB_ORIGIN}/api/v1/hospital-profile/competitors`, {
      method: "PUT", headers: { Authorization: `Bearer ${env.HUB_API_KEY}`, "X-PS-Hospital-Id": h.ps_hospital_id, "Content-Type": "application/json" },
      body: JSON.stringify({ competitors: rows.map((r) => ({ name: r.name, aliases: parseJsonArr(r.name_aliases), naver_place_id: r.naver_place_id, region: null })) }), signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.log("[radar] hub competitors push failed", res.status);
    return res.ok;
  } catch (e) { console.log("[radar] hub competitors push error", String(e).slice(0, 120)); return false; }
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
    const basic = !h.clinic_type ? (await hubProfile(c, h.ps_hospital_id))?.basic || null : null;
    return c.html(Step1({ h: hv(h), prefill: {
      name: h.name, aliases: parseJsonArr(h.name_aliases).join(", "), clinic_type: h.clinic_type || basic?.clinic_type || "치과",
      region: regionOf(h) || basic?.region || "", treatments: parseJsonArr(h.key_treatments).join(", ") || (basic?.key_treatments || []).join(", "),
      naver_place_id: h.naver_place_id || "", website_url: h.website_url || "", fromHub: !!basic } }));
  }
  if (step === 2) {
    const kws = (await c.env.DB.prepare("SELECT id, text, is_active, source, monthly_pc, monthly_mobile, volume_low FROM keywords WHERE hospital_id = ? ORDER BY sort_order, id").bind(h.id).all()).results as { id: number; text: string; is_active: number; source: string; monthly_pc: number | null; monthly_mobile: number | null; volume_low: number }[];
    return c.html(Step2({ h: hv(h), keywords: kws, limit: limits.keywords, withVolume: kws.some((k) => k.monthly_pc != null) }));
  }
  // step 3: 허브 프로필의 경쟁 병원 정본을 먼저 채우고, 없을 때만 상위 키워드 3개로 플레이스 추천을 만든다
  const pulled = limits.competitors > 0 ? await pullHubCompetitors(c, h) : { hubCount: 0, added: 0 };
  const existing = (await c.env.DB.prepare("SELECT id, name FROM competitors WHERE hospital_id = ? AND is_active = 1").bind(h.id).all()).results as { id: number; name: string }[];
  const kws = (await c.env.DB.prepare("SELECT text FROM keywords WHERE hospital_id = ? AND is_active = 1 ORDER BY sort_order, id LIMIT 3").bind(h.id).all()).results as { text: string }[];
  const counts = new Map<string, { count: number; placeId: string | null }>();
  const self = (await loadEntities(c.env.DB, h))[0];
  const avail = platformAvailability(c.env);
  let note: string | undefined;
  if (pulled.hubCount) note = `허브 프로필에 적어 둔 경쟁 병원 ${pulled.hubCount}곳을 가져왔습니다. 더 비교할 곳만 아래에 적어 주세요.`;
  else if (limits.competitors > 0 && avail.naver) {
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
  if (str(b.youtube) && c.env.YOUTUBE_API_KEY) { const ch = await resolveChannel(str(b.youtube), { YOUTUBE_API_KEY: c.env.YOUTUBE_API_KEY }).catch(() => null); if (ch) await c.env.DB.prepare("UPDATE hospitals SET youtube_channel_id = ?, youtube_channel_title = ? WHERE id = ?").bind(ch.id, ch.title, h.id).run(); }
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
  await pushHubCompetitors(c.env, h); // 플레이스에서 찾은 이름·ID를 허브 정본으로 되돌린다
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
  const d: DashboardData = { week, total: { score: null, prev: null, sov: null, weighted: null, series: [] }, platforms: [], matrix: [], matrixPlatforms: [], competitors: [], selfScore: null, reputation: [], alerts: [], runs: [], compare, onboarded: !!h.onboarded_at, hasVolume: false, history: { runs: [], rankTable: [], dates: [], reviews: [], content: [], changes: [], prevDate: null }, insights: [], reviews: null, content: [], arrivals: [], opportunity: null, measuredAt: null, runId: null, weekPick: null, rx: { open: [], done: [], checked: [] }, goals: [], ads: null, completeness: null, newCompetitors: [] };
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
    const run = await db.prepare("SELECT id, run_date, started_at, finished_at FROM crawl_runs WHERE hospital_id = ? AND status IN ('completed','blocked') ORDER BY run_date DESC, id DESC LIMIT 1").bind(h.id).first<{ id: number; run_date: string; started_at: string | null; finished_at: string | null }>();
    if (run) {
      d.runId = run.id; d.measuredAt = (run.started_at || run.finished_at || run.run_date).slice(0, 16).replace("T", " ");
      const obs = (await db.prepare("SELECT o.platform, o.entity_type, o.entity_id, o.shown, o.rank, o.detail, k.id AS kid, k.text, k.monthly_pc, k.monthly_mobile, k.volume_low, k.target_rank, k.goal_base_rank, k.goal_set_at FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? ORDER BY k.sort_order, k.id").bind(run.id).all()).results as { platform: string; entity_type: string; entity_id: number | null; shown: number; rank: number | null; detail: string; kid: number; text: string; monthly_pc: number | null; monthly_mobile: number | null; volume_low: number; target_rank: number | null; goal_base_rank: number | null; goal_set_at: string | null }[];
      const plats = ["naver_place", "naver_serp", "google_serp", "google_business", "kakao_map", "youtube"].filter((p) => obs.some((o) => o.platform === p));
      d.matrixPlatforms = plats.map((p) => ({ key: p, label: p === "google_serp" ? "구글 검색" : p === "google_business" ? "구글 비즈니스" : p === "kakao_map" ? "카카오맵" : p === "youtube" ? "유튜브 검색" : PLATFORM_LABEL[p] }));
      const byKw = new Map<string, DashboardData["matrix"][number]>();
      const compScore: Record<string, number[]> = {}; const selfScores: number[] = [];
      const adRows: Record<string, { name: string; placeId: string | null }[]> = {}; const entNames: Record<string, string> = { self: h.name };
      for (const o of obs) {
        let row = byKw.get(o.text); if (!row) { const vol = o.monthly_pc == null && o.monthly_mobile == null ? null : (o.monthly_pc ?? 0) + (o.monthly_mobile ?? 0); if (vol != null) d.hasVolume = true; row = { keyword: o.text, keywordId: o.kid, volume: vol, volumeLow: !!o.volume_low, cells: {}, competitors: {}, range: null, goal: o.target_rank ? { target: o.target_rank, base: o.goal_base_rank, setAt: o.goal_set_at } : null }; byKw.set(o.text, row); }
        const det = (() => { try { return JSON.parse(o.detail || "{}"); } catch { return {}; } })();
        if (o.entity_type === "self") { row.cells[o.platform] = { rank: o.rank, shown: !!o.shown, ad: !!det.placeAd, note: o.platform === "youtube" && det.videoTitle ? String(det.videoTitle).slice(0, 40) : undefined }; if (o.platform === "naver_place" || o.platform === "google_serp" || o.platform === "google_business" || o.platform === "kakao_map") selfScores.push(obsScore(o.platform, o.shown, o.rank, det)); }
        else if (o.platform === "naver_place") { row.competitors[`c${o.entity_id}`] = { rank: o.rank, shown: !!o.shown }; (compScore[`c${o.entity_id}`] ||= []).push(obsScore(o.platform, o.shown, o.rank, det)); }
        if (o.platform === "naver_serp" && o.entity_type === "self" && Array.isArray(det.block)) { const ads = (det.block as { name: string; placeId: string | null; ad: boolean }[]).filter((b) => b.ad); if (ads.length) adRows[o.text] = ads.map((b) => ({ name: b.name, placeId: b.placeId })); }
      }
      d.matrix = [...byKw.values()];
      // 경쟁사 광고 키워드 표 (통합검색 플레이스 광고 카드에 이름이 있는 곳)
      const compsForAds = (await db.prepare("SELECT id, name FROM competitors WHERE hospital_id = ? AND is_active = 1 ORDER BY id").bind(h.id).all()).results as { id: number; name: string }[];
      for (const x of compsForAds) entNames[`c${x.id}`] = x.name;
      if (Object.keys(adRows).length) {
        const compIds = new Map(compsForAds.map((x) => [x.id, x.name])); const compPids = new Map<string, string>();
        for (const x of (await db.prepare("SELECT name, naver_place_id FROM competitors WHERE hospital_id = ? AND is_active = 1 AND naver_place_id IS NOT NULL").bind(h.id).all()).results as { name: string; naver_place_id: string }[]) compPids.set(x.naver_place_id, x.name);
        void compIds; void entNames;
        const nm = (s: string) => s.replace(/\s/g, "");
        d.ads = { rows: Object.entries(adRows).map(([keyword, ads]) => ({ keyword, advertisers: ads.map((a) => ({ name: a.name || "(이름 미확인)", placeId: a.placeId, self: !!(h.naver_place_id && a.placeId === h.naver_place_id) || (!!a.name && nm(a.name).includes(nm(h.name).slice(0, 4))), tracked: !!(a.placeId && compPids.has(a.placeId)) || compsForAds.some((c) => a.name && nm(a.name).includes(nm(c.name))) })) })) };
      }
      // 목표 진행률
      d.goals = d.matrix.filter((r) => r.goal).map((r) => { const cur = r.cells.naver_place?.rank ?? null; const g = r.goal!; const v = (x: number | null) => (x == null ? (r.cells.naver_place?.shown ? 12 : 15) : x); const total = v(g.base) - g.target; const done = v(g.base) - v(cur); return { keywordId: r.keywordId, keyword: r.keyword, target: g.target, base: g.base, current: cur, setAt: g.setAt, progress: total <= 0 ? (v(cur) <= g.target ? 1 : 0) : Math.max(0, Math.min(1, done / total)), reached: v(cur) <= g.target }; });
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
    // 리뷰: review_stats 최신 + 방문자 리뷰 수 4주 증가분 + 부정 리뷰
    const rs = (await db.prepare("SELECT entity_type, entity_id, count_30d, negative_30d, replied_30d, treatments, complaints, avg_len, long_count, photo_count, stat_date FROM review_stats WHERE hospital_id = ? AND platform = 'naver_place' AND stat_date = (SELECT MAX(stat_date) FROM review_stats WHERE hospital_id = ? AND platform = 'naver_place')").bind(h.id, h.id).all()).results as { entity_type: string; entity_id: number | null; count_30d: number; negative_30d: number; replied_30d: number; treatments: string; complaints: string; avg_len: number | null; long_count: number; photo_count: number }[];
    if (rs.length) {
      const names: Record<string, string> = {}; for (const x of d.competitors) names[`c${x.id}`] = x.name;
      const snaps = (await db.prepare("SELECT entity_type, entity_id, snapshot_date, review_count FROM reputation_snapshots WHERE hospital_id = ? AND platform = 'naver_place' ORDER BY snapshot_date DESC").bind(h.id).all()).results as { entity_type: string; entity_id: number | null; snapshot_date: string; review_count: number | null }[];
      const velocity = (et: string, id: number | null) => { const list = snaps.filter((x) => x.entity_type === et && (x.entity_id ?? 0) === (id ?? 0)); if (list.length < 2 || list[0].review_count == null) return null; const cutoff = new Date(new Date(list[0].snapshot_date).getTime() - 28 * 86400_000).toISOString().slice(0, 10); const old = list.find((x) => x.snapshot_date <= cutoff) || list[list.length - 1]; return old.review_count == null || old.snapshot_date === list[0].snapshot_date ? null : list[0].review_count - old.review_count; };
      const top = (j: string) => (Object.entries(JSON.parse(j || "{}")) as [string, number][]).sort((a, b) => b[1] - a[1]);
      d.reviews = {
        rows: rs.sort((a) => (a.entity_type === "self" ? -1 : 1)).map((r) => ({ entity: r.entity_type === "self" ? h.name : names[`c${r.entity_id}`] || "경쟁사", self: r.entity_type === "self", velocity30: velocity(r.entity_type, r.entity_id), analyzed: r.count_30d, negative: r.negative_30d, replied: r.replied_30d, avgLen: r.avg_len, longCount: r.long_count, photoCount: r.photo_count, treatments: top(r.treatments), complaints: top(r.complaints) })).filter((r) => r.self || r.entity !== "경쟁사"),
        recentNegative: ((await db.prepare("SELECT entity_type, entity_id, body, complaints, written_at FROM reviews WHERE hospital_id = ? AND negative = 1 ORDER BY written_at DESC, id DESC LIMIT 6").bind(h.id).all()).results as { entity_type: string; entity_id: number | null; body: string; complaints: string; written_at: string | null }[]).map((n) => ({ entity: n.entity_type === "self" ? h.name : names[`c${n.entity_id}`] || "경쟁사", body: n.body, complaints: JSON.parse(n.complaints || "[]"), written_at: n.written_at })),
        latest: ((await db.prepare("SELECT body, written_at, treatments FROM reviews WHERE hospital_id = ? AND entity_type = 'self' ORDER BY written_at DESC, id DESC LIMIT 5").bind(h.id).all()).results as { body: string; written_at: string | null; treatments: string }[]).map((r) => ({ body: r.body, written_at: r.written_at, treatments: JSON.parse(r.treatments || "[]") })),
      };
    }
    // 콘텐츠 도달(유튜브·인스타·스레드): 최신 스냅샷 + 직전 스냅샷
    const soc = (await db.prepare("SELECT platform, followers, views_30d, snapshot_date, detail FROM reputation_snapshots WHERE hospital_id = ? AND entity_type = 'self' AND (platform LIKE 'youtube%' OR platform IN ('instagram','threads')) ORDER BY snapshot_date DESC LIMIT 120").bind(h.id).all()).results as { platform: string; followers: number | null; views_30d: number | null; snapshot_date: string; detail: string }[];
    const labelS: Record<string, string> = { instagram: "인스타그램", threads: "스레드" };
    const plats = [...new Set(soc.map((x) => x.platform))].sort((a, b) => (a.startsWith("youtube") ? 1 : 0) - (b.startsWith("youtube") ? 1 : 0));
    for (const p of plats) {
      if (p === "youtube") continue; // 구형 단일 채널 스냅샷은 건너뜀
      const list = soc.filter((x) => x.platform === p); if (!list.length) continue;
      const cur = list[0], prev = list.find((x) => x.snapshot_date < cur.snapshot_date) || null; const det = JSON.parse(cur.detail || "{}");
      d.content.push({ platform: p, label: p.startsWith("youtube:") ? `유튜브 · ${det.title || ""}` : labelS[p], followers: cur.followers, prevFollowers: prev?.followers ?? null, views: cur.views_30d, prevViews: prev?.views_30d ?? null, date: cur.snapshot_date, manual: !!det.manual, top: (det.top || []).map((t: { title?: string; caption?: string; views: number }) => ({ title: t.title || t.caption || "", views: t.views })) });
    }
    // 실제 신환 경로(폼) × 같은 주 플레이스 기회 커버율
    const arr = (await db.prepare("SELECT week_start, first_visits, answered, groups, primary_paths FROM weekly_arrivals WHERE hospital_id = ? ORDER BY week_start DESC LIMIT 10").bind(h.id).all()).results as { week_start: string; first_visits: number; answered: number; groups: string; primary_paths: string }[];
    if (arr.length) {
      const cov = (await db.prepare("SELECT week_start, coverage FROM weekly_opportunity WHERE hospital_id = ? AND platform = 'naver_place'").bind(h.id).all()).results as { week_start: string; coverage: number }[];
      d.arrivals = arr.map((a) => { const g = JSON.parse(a.groups || "{}"), p = JSON.parse(a.primary_paths || "{}"); return { week_start: a.week_start, first_visits: a.first_visits, answered: a.answered, search: g.search || 0, naver: p["search.naver"] || 0, google: p["search.google"] || 0, ai: g.ai || 0, sns: g.sns || 0, content: g.content || 0, referral: g.referral || 0, sign: g.sign || 0, nearby: g.nearby || 0, other: (g.other || 0) + (g.agreement || 0), coverage: cov.find((c) => c.week_start === a.week_start)?.coverage ?? null }; });
    }
    // 처방 실행 추적
    const rxRows = (await db.prepare("SELECT id, keyword, code, text, evidence, gain, status, first_seen, last_seen, done_at, check_after, baseline, result FROM prescriptions WHERE hospital_id = ? AND status IN ('open','done','checked') ORDER BY gain DESC, id").bind(h.id).all()).results as { id: number; keyword: string; code: string; text: string; evidence: string; gain: number; status: string; first_seen: string; last_seen: string; done_at: string | null; check_after: string | null; baseline: string | null; result: string | null }[];
    const pj = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
    const today = kstDate();
    for (const r of rxRows) {
      const item = { id: r.id, keyword: r.keyword, code: r.code, text: r.text, evidence: r.evidence, gain: r.gain, status: r.status, firstSeen: r.first_seen, doneAt: r.done_at, checkAfter: r.check_after, daysLeft: r.check_after ? Math.max(0, Math.ceil((Date.parse(r.check_after) - Date.parse(today)) / 86400_000)) : null, baseline: pj(r.baseline), result: pj(r.result) };
      if (r.status === "open") d.rx.open.push(item); else if (r.status === "done") d.rx.done.push(item); else d.rx.checked.push(item);
    }
    d.weekPick = d.rx.open[0] ?? null; // 기대 이득(gain) 최대 = 이번 주 한 가지
    // 플레이스 완성도 (최신 스냅샷의 completeness, 본원 + 경쟁사) + 30일 답글 비율
    const compRows = (await db.prepare("SELECT entity_type, entity_id, detail FROM reputation_snapshots WHERE hospital_id = ? AND platform = 'naver_place' AND snapshot_date = (SELECT MAX(snapshot_date) FROM reputation_snapshots WHERE hospital_id = ? AND platform = 'naver_place' AND detail LIKE '%completeness%')").bind(h.id, h.id).all()).results as { entity_type: string; entity_id: number | null; detail: string }[];
    if (compRows.length) {
      const names: Record<string, string> = {}; for (const x of d.competitors) names[`c${x.id}`] = x.name;
      const rows = compRows.map((r) => { const key = r.entity_type === "self" ? "self" : `c${r.entity_id}`; const c = (pj(r.detail) || {}).completeness; if (!c || (key !== "self" && !names[key])) return null; const rv = d.reviews?.rows.find((x) => (key === "self" ? x.self : x.entity === names[key])); return { entity: key === "self" ? h.name : names[key], self: key === "self", ...c, replied: rv ? rv.replied : null, analyzed: rv ? rv.analyzed : null }; }).filter(Boolean) as NonNullable<DashboardData["completeness"]>["rows"];
      if (rows.length) d.completeness = { rows: rows.sort((a) => (a.self ? -1 : 1)) };
    }
    // 새 경쟁사 후보(미해결 경보)
    d.newCompetitors = ((await db.prepare("SELECT id, detail FROM alerts WHERE hospital_id = ? AND code LIKE 'new_competitor:%' AND resolved_at IS NULL ORDER BY id DESC LIMIT 5").bind(h.id).all()).results as { id: number; detail: string }[]).map((a) => { const x = pj(a.detail) || {}; return { alertId: a.id, name: String(x.name || ""), placeId: x.placeId ? String(x.placeId) : null, keywords: Array.isArray(x.keywords) ? x.keywords.map(String) : [] }; }).filter((x) => x.name);
    d.alerts = (await db.prepare("SELECT severity, message, created_at FROM alerts WHERE hospital_id = ? AND resolved_at IS NULL AND code NOT LIKE 'new_competitor:%' ORDER BY id DESC LIMIT 8").bind(h.id).all()).results as DashboardData["alerts"];
    d.runs = (await db.prepare("SELECT run_date, status, kind, error FROM crawl_runs WHERE hospital_id = ? ORDER BY run_date DESC, id DESC LIMIT 8").bind(h.id).all()).results as DashboardData["runs"];
  }
  // ── 추이·변화: 최근 run 최대 10개
  if (week) {
    const runs = ((await db.prepare("SELECT id, run_date, summary FROM crawl_runs WHERE hospital_id = ? AND status IN ('completed','blocked') ORDER BY run_date DESC, id DESC LIMIT 10").bind(h.id).all()).results as { id: number; run_date: string; summary: string }[]).reverse();
    const compNames: Record<string, string> = {}; for (const x of d.competitors) compNames[`c${x.id}`] = x.name;
    for (const r of runs) {
      const sm = (() => { try { return JSON.parse(r.summary || "{}"); } catch { return {}; } })() as { total?: number; platforms?: Record<string, { score: number | null }> };
      const op = await opportunityOfRun(db, h.id, r.id);
      const wk = await db.prepare("SELECT weighted_score FROM weekly_scores WHERE hospital_id = ? AND platform = 'total' AND detail LIKE ?").bind(h.id, `%"runId":${r.id}%`).first<{ weighted_score: number | null }>();
      d.history.runs.push({ date: r.run_date, runId: r.id, total: sm.total ?? null, weighted: wk?.weighted_score ?? null, platforms: Object.fromEntries(Object.entries(sm.platforms || {}).map(([k, v]) => [k, v.score])), coverage: Object.fromEntries(Object.entries(op).map(([k, v]) => [k, v.coverage])), selfCaptured: op.naver_place?.captured ?? null, competitors: Object.fromEntries(Object.entries(op.naver_place?.competitors || {}).map(([k, v]) => [compNames[k] || k, v])) });
    }
    d.history.dates = d.history.runs.map((r) => r.date);
    // 키워드 순위 표 (플레이스, run 별)
    if (runs.length) {
      const ids = runs.map((r) => r.id);
      const rows = (await db.prepare(`SELECT o.run_id, o.rank, o.shown, k.id AS kid, k.text, (COALESCE(k.monthly_pc,0)+COALESCE(k.monthly_mobile,0)) AS vol, k.monthly_pc IS NULL AND k.monthly_mobile IS NULL AS novol FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.hospital_id = ? AND o.entity_type = 'self' AND o.platform = 'naver_place' AND o.run_id IN (${ids.map(() => "?").join(",")}) AND k.is_active = 1`).bind(h.id, ...ids).all()).results as { run_id: number; rank: number | null; shown: number; kid: number; text: string; vol: number; novol: number }[];
      const byKw = new Map<string, { keywordId: number; volume: number | null; ranks: (number | null)[]; shown: boolean[] }>();
      for (const r of rows) { let e = byKw.get(r.text); if (!e) { e = { keywordId: r.kid, volume: r.novol ? null : r.vol, ranks: ids.map(() => null), shown: ids.map(() => false) }; byKw.set(r.text, e); } const i = ids.indexOf(r.run_id); e.ranks[i] = r.rank; e.shown[i] = !!r.shown; }
      const val = (x: number | null) => (x == null ? 99 : x);
      d.history.rankTable = [...byKw.entries()].map(([keyword, e]) => { const n = e.ranks.length; const cur = e.ranks[n - 1], prev = n > 1 ? e.ranks[n - 2] : undefined; return { keyword, keywordId: e.keywordId, volume: e.volume, ranks: e.ranks, shown: e.shown, change: prev === undefined ? null : val(prev) - val(cur) }; }).sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
      d.history.runIds = ids;
      // 측정 편차: 최근 4회 순위 범위 → 매트릭스에 표시
      for (const m of d.matrix) { const e = byKw.get(m.keyword); if (!e) continue; const last = e.ranks.slice(-4).filter((x): x is number => x != null); if (last.length >= 2) m.range = { min: Math.min(...last), max: Math.max(...last), n: e.ranks.slice(-4).length }; }
    }
    // 리뷰 수 추이 (플레이스 방문자 리뷰, 본원·경쟁사)
    const rs = (await db.prepare("SELECT entity_type, entity_id, snapshot_date, review_count FROM reputation_snapshots WHERE hospital_id = ? AND platform = 'naver_place' ORDER BY snapshot_date").bind(h.id).all()).results as { entity_type: string; entity_id: number | null; snapshot_date: string; review_count: number | null }[];
    const groups = new Map<string, { x: string; y: number | null }[]>();
    for (const r of rs) { const k = r.entity_type === "self" ? "self" : `c${r.entity_id}`; if (k !== "self" && !compNames[k]) continue; (groups.get(k) || groups.set(k, []).get(k)!).push({ x: r.snapshot_date, y: r.review_count }); }
    d.history.reviews = [...groups.entries()].map(([k, pts]) => ({ entity: k === "self" ? h.name : compNames[k], self: k === "self", points: pts }));
    // 콘텐츠 추이
    const cs = (await db.prepare("SELECT platform, snapshot_date, followers, views_30d, detail FROM reputation_snapshots WHERE hospital_id = ? AND entity_type = 'self' AND (platform LIKE 'youtube:%' OR platform IN ('instagram','threads')) ORDER BY snapshot_date").bind(h.id).all()).results as { platform: string; snapshot_date: string; followers: number | null; views_30d: number | null; detail: string }[];
    const cg = new Map<string, { label: string; followers: { x: string; y: number | null }[]; views: { x: string; y: number | null }[] }>();
    for (const r of cs) { const label = r.platform === "instagram" ? "인스타그램" : r.platform === "threads" ? "스레드" : "유튜브 · " + ((JSON.parse(r.detail || "{}") as { title?: string }).title || ""); const e = cg.get(r.platform) || cg.set(r.platform, { label, followers: [], views: [] }).get(r.platform)!; e.followers.push({ x: r.snapshot_date, y: r.followers }); e.views.push({ x: r.snapshot_date, y: r.views_30d }); }
    d.history.content = [...cg.values()];
    // 변화 목록: 최근 run vs 직전 run
    const H = d.history.runs; const cur = H[H.length - 1], prevR = H.length > 1 ? H[H.length - 2] : null;
    if (cur && prevR) {
      d.history.prevDate = prevR.date;
      const ch = d.history.changes; const f = (v: number | null | undefined, dgt = 0) => (v == null ? "—" : v.toFixed(dgt));
      if (cur.coverage.naver_place != null && prevR.coverage.naver_place != null && Math.round((cur.coverage.naver_place - prevR.coverage.naver_place) * 100) !== 0) ch.push({ kind: "coverage", label: "네이버 플레이스 커버율", before: Math.round(prevR.coverage.naver_place * 100) + "%", after: Math.round(cur.coverage.naver_place * 100) + "%", delta: Math.round((cur.coverage.naver_place - prevR.coverage.naver_place) * 100), unit: "%p", good: cur.coverage.naver_place >= prevR.coverage.naver_place });
      if (cur.total != null && prevR.total != null && Math.round((cur.total - prevR.total) * 10) !== 0) { const dropped = Object.keys(prevR.platforms).filter((p) => prevR.platforms[p] != null && cur.platforms[p] == null); ch.push({ kind: "score", label: "온라인 가시성 점수", before: f(prevR.total, 1), after: f(cur.total, 1), delta: Math.round((cur.total - prevR.total) * 10) / 10, unit: "점", good: cur.total >= prevR.total, causes: dropped.length ? [`이번 측정에 ${dropped.map((p) => PLATFORM_LABEL[p] || p).join("·")} 결과가 없음(수집 오류) — 점수 비교 무효`] : [] }); }
      for (const k of ["google", "kakao"]) if (cur.coverage[k] != null && prevR.coverage[k] != null && Math.round((cur.coverage[k]! - prevR.coverage[k]!) * 100) !== 0) ch.push({ kind: "coverage", label: (k === "google" ? "구글" : "카카오맵") + " 커버율", before: Math.round(prevR.coverage[k]! * 100) + "%", after: Math.round(cur.coverage[k]! * 100) + "%", delta: Math.round((cur.coverage[k]! - prevR.coverage[k]!) * 100), unit: "%p", good: cur.coverage[k]! >= prevR.coverage[k]! });
      // 순위 변동 원인 진단 재료: 두 run 의 통합검색 블록·광고 수, 경쟁사 리뷰 증가
      const serpTwo = (await db.prepare("SELECT o.run_id, k.text, o.detail FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id IN (?, ?) AND o.platform = 'naver_serp' AND o.entity_type = 'self'").bind(cur.runId, prevR.runId).all()).results as { run_id: number; text: string; detail: string }[];
      const serpOf = (rid: number, kw: string) => { const r = serpTwo.find((x) => x.run_id === rid && x.text === kw); try { return JSON.parse(r?.detail || "{}") as { block?: { name: string; ad: boolean }[]; top5?: string[]; adCards?: number }; } catch { return {}; } };
      const revGrowth: Record<string, number> = {}; for (const rv of d.history.reviews) { const pts = rv.points.filter((p) => p.y != null); const a = pts[pts.length - 1], b = pts.find((p) => p.x >= prevR.date) || pts[pts.length - 2]; if (a && b && a.x !== b.x) revGrowth[rv.entity] = a.y! - b.y!; }
      const nm = (s: string) => s.replace(/\s+/g, "");
      const diagnose = (kw: string, before: number | null, after: number | null): string[] => {
        const out: string[] = []; const c = serpOf(cur.runId, kw), p = serpOf(prevR.runId, kw);
        const cb = (c.block ? c.block.filter((x) => !x.ad).map((x) => x.name) : c.top5) || [], pb = (p.block ? p.block.filter((x) => !x.ad).map((x) => x.name) : p.top5) || [];
        const aboveNow = after == null ? cb : cb.slice(0, after - 1); const newcomers = aboveNow.filter((n) => !pb.map(nm).includes(nm(n)));
        if (newcomers.length) out.push(`위로 새로 들어온 병원: ${newcomers.slice(0, 2).join(", ")}`);
        if (c.adCards != null && p.adCards != null && c.adCards > p.adCards) out.push(`광고 카드 ${p.adCards}→${c.adCards}개`);
        const grew = aboveNow.map((n) => { const k = Object.keys(revGrowth).find((e) => nm(e) === nm(n) || nm(n).includes(nm(e))); return k && revGrowth[k] >= 10 ? `${k} 리뷰 +${revGrowth[k]}` : null; }).filter(Boolean) as string[];
        if (grew.length) out.push(grew.slice(0, 2).join(" · "));
        if (!out.length && before != null && after != null && Math.abs(before - after) === 1) out.push("한 계단 변동 — 측정 시각 편차 범위일 수 있음");
        return out;
      };
      for (const r of d.history.rankTable.filter((x) => x.change != null && x.change !== 0).sort((a, b) => Math.abs(b.change!) * (b.volume ?? 1) - Math.abs(a.change!) * (a.volume ?? 1)).slice(0, 6)) { const n = r.ranks.length; const b = r.ranks[n - 2], a = r.ranks[n - 1]; ch.push({ kind: "rank", label: `「${r.keyword}」 플레이스 순위`, before: b == null ? "미노출" : b + "위", after: a == null ? "미노출" : a + "위", delta: r.change!, unit: "계단", good: r.change! > 0, causes: r.change! < 0 ? diagnose(r.keyword, b, a) : [] }); }
      for (const [name, v] of Object.entries(cur.competitors)) { const pv = prevR.competitors[name]; if (pv != null && v !== pv) ch.push({ kind: "competitor", label: `${name} 기회 점유`, before: pv.toLocaleString(), after: v.toLocaleString(), delta: v - pv, unit: "명", good: v < pv }); }
      for (const rv of d.history.reviews) { const pts = rv.points.filter((p) => p.y != null); if (pts.length >= 2) { const a = pts[pts.length - 1], b = pts.find((p) => p.x <= prevR.date) || pts[0]; if (a.y! !== b.y! && a.x !== b.x) ch.push({ kind: "review", label: `${rv.entity} 방문자 리뷰 수`, before: b.y!.toLocaleString(), after: a.y!.toLocaleString(), delta: a.y! - b.y!, unit: "건", good: rv.self ? a.y! >= b.y! : null }); } }
      for (const c of d.history.content) { const pts = c.followers.filter((p) => p.y != null); if (pts.length >= 2) { const a = pts[pts.length - 1], b = pts[pts.length - 2]; if (a.y !== b.y) ch.push({ kind: "content", label: `${c.label} 팔로워`, before: b.y!.toLocaleString(), after: a.y!.toLocaleString(), delta: a.y! - b.y!, unit: "명", good: a.y! >= b.y! }); } }
      if (d.arrivals.length >= 2) { const a = d.arrivals[0], b = d.arrivals[1]; ch.push({ kind: "arrival", label: "주간 신환(검색)", before: `${b.first_visits}명(검색 ${b.search})`, after: `${a.first_visits}명(검색 ${a.search})`, delta: a.search - b.search, unit: "명", good: a.search >= b.search }); }
    }
  }
  d.insights = buildInsights(d, h.name, parseJsonArr(h.key_treatments));
  return c.html(Dashboard({ h: hv(h), d }));
});

/* ── 처방 실행 추적 ── */
app.post("/app/rx/:id/:act", async (c) => {
  const h = c.get("hospital"); const id = Number(c.req.param("id")); const act = c.req.param("act");
  const rx = await c.env.DB.prepare("SELECT id, keyword, status FROM prescriptions WHERE id = ? AND hospital_id = ?").bind(id, h.id).first<{ id: number; keyword: string; status: string }>();
  if (!rx) return c.notFound();
  const today = kstDate();
  if (act === "done") {
    // baseline = 마지막 측정의 그 키워드 순위·기회
    const run = await c.env.DB.prepare("SELECT id, run_date FROM crawl_runs WHERE hospital_id = ? AND status IN ('completed','blocked') ORDER BY run_date DESC, id DESC LIMIT 1").bind(h.id).first<{ id: number; run_date: string }>();
    const ob = run ? await c.env.DB.prepare("SELECT o.rank, o.detail FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? AND o.entity_type = 'self' AND o.platform = 'naver_place' AND k.text = ?").bind(run.id, rx.keyword).first<{ rank: number | null; detail: string }>() : null;
    const opp = await c.env.DB.prepare("SELECT detail FROM weekly_opportunity WHERE hospital_id = ? AND platform = 'naver_place' ORDER BY week_start DESC LIMIT 1").bind(h.id).first<{ detail: string }>();
    const lostRow = (() => { try { return (JSON.parse(opp?.detail || "{}").lost || []).find((l: { keyword: string }) => l.keyword === rx.keyword); } catch { return null; } })() as { captured?: number; blockSize?: number | null } | null;
    const bs = (() => { try { return JSON.parse(ob?.detail || "{}").blockSize ?? null; } catch { return null; } })();
    const checkAfter = new Date(Date.parse(today) + 21 * 86400_000).toISOString().slice(0, 10);
    await c.env.DB.prepare("UPDATE prescriptions SET status = 'done', done_at = ?, baseline = ?, check_after = ?, result = NULL, result_at = NULL WHERE id = ?").bind(today, JSON.stringify({ date: run?.run_date ?? today, rank: ob?.rank ?? null, captured: lostRow?.captured ?? null, blockSize: lostRow?.blockSize ?? bs }), checkAfter, id).run();
  } else if (act === "undo") await c.env.DB.prepare("UPDATE prescriptions SET status = 'open', done_at = NULL, baseline = NULL, check_after = NULL, result = NULL, result_at = NULL WHERE id = ?").bind(id).run();
  else if (act === "dismiss") await c.env.DB.prepare("UPDATE prescriptions SET status = 'dismissed' WHERE id = ?").bind(id).run();
  else if (act === "reopen") await c.env.DB.prepare("UPDATE prescriptions SET status = 'open' WHERE id = ?").bind(id).run();
  return c.redirect("/app#rx");
});
/* ── 키워드 목표 ── */
app.post("/app/settings/goals", async (c) => {
  const h = c.get("hospital"); const b = await c.req.parseBody();
  const kws = (await c.env.DB.prepare("SELECT id, target_rank FROM keywords WHERE hospital_id = ? AND is_active = 1").bind(h.id).all()).results as { id: number; target_rank: number | null }[];
  const run = await c.env.DB.prepare("SELECT id FROM crawl_runs WHERE hospital_id = ? AND status IN ('completed','blocked') ORDER BY run_date DESC, id DESC LIMIT 1").bind(h.id).first<{ id: number }>();
  const stmts: D1PreparedStatement[] = [];
  for (const k of kws) {
    const raw = str(b[`target_${k.id}`]); const t = raw ? Math.max(1, Math.min(10, Math.round(Number(raw)))) : null;
    if (!raw || !Number.isFinite(t as number)) { if (k.target_rank != null) stmts.push(c.env.DB.prepare("UPDATE keywords SET target_rank = NULL, goal_set_at = NULL, goal_base_rank = NULL WHERE id = ?").bind(k.id)); continue; }
    if (t === k.target_rank) continue;
    const ob = run ? await c.env.DB.prepare("SELECT rank FROM observations WHERE run_id = ? AND keyword_id = ? AND entity_type = 'self' AND platform = 'naver_place'").bind(run.id, k.id).first<{ rank: number | null }>() : null;
    stmts.push(c.env.DB.prepare("UPDATE keywords SET target_rank = ?, goal_set_at = ?, goal_base_rank = ? WHERE id = ?").bind(t, kstDate(), ob?.rank ?? null, k.id));
  }
  for (let i = 0; i < stmts.length; i += 40) await c.env.DB.batch(stmts.slice(i, i + 40));
  return c.redirect("/app/settings?ok=1#goals");
});
/* ── 새 경쟁사 후보 채택·무시 ── */
app.post("/app/competitors/:act", async (c) => {
  const h = c.get("hospital"); const act = c.req.param("act"); const b = await c.req.parseBody();
  const alertId = Number(b.alert); const al = await c.env.DB.prepare("SELECT id, detail FROM alerts WHERE id = ? AND hospital_id = ? AND code LIKE 'new_competitor:%'").bind(alertId, h.id).first<{ id: number; detail: string }>();
  if (!al) return c.redirect("/app");
  const x = (() => { try { return JSON.parse(al.detail || "{}"); } catch { return {}; } })() as { name?: string; placeId?: string | null };
  if (act === "adopt" && x.name) {
    const limit = limitsOf(h.plan).competitors;
    const on = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM competitors WHERE hospital_id = ? AND is_active = 1").bind(h.id).first<{ n: number }>();
    await c.env.DB.prepare("INSERT INTO competitors (hospital_id, name, name_aliases, naver_place_id, is_auto, is_active, created_at) VALUES (?,?,?,?,1,?,?) ON CONFLICT(hospital_id, name) DO UPDATE SET is_active = excluded.is_active, naver_place_id = COALESCE(competitors.naver_place_id, excluded.naver_place_id)").bind(h.id, x.name.slice(0, 60), "[]", x.placeId || null, (on?.n ?? 0) < limit ? 1 : 0, kstIso()).run();
    await pushHubCompetitors(c.env, h);
  } else if (act === "ignore") {
    const st = await c.env.DB.prepare("SELECT ignored_competitors FROM hospital_settings WHERE hospital_id = ?").bind(h.id).first<{ ignored_competitors: string }>();
    const list = (() => { try { return JSON.parse(st?.ignored_competitors || "[]") as string[]; } catch { return []; } })();
    for (const v of [x.name, x.placeId]) if (v && !list.includes(v)) list.push(String(v));
    await c.env.DB.prepare("INSERT INTO hospital_settings (hospital_id, ignored_competitors, updated_at) VALUES (?,?,?) ON CONFLICT(hospital_id) DO UPDATE SET ignored_competitors = excluded.ignored_competitors, updated_at = excluded.updated_at").bind(h.id, JSON.stringify(list.slice(0, 50)), kstIso()).run();
  }
  await c.env.DB.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ?").bind(kstIso(), al.id).run();
  return c.redirect(act === "adopt" ? "/app/settings#competitors" : "/app");
});
/* ── 증거: 그날 그 키워드의 블록 ── */
app.get("/app/evidence/:runId/:keywordId", async (c) => {
  const h = c.get("hospital"); const runId = Number(c.req.param("runId")), kid = Number(c.req.param("keywordId"));
  const run = await c.env.DB.prepare("SELECT id, run_date, started_at, finished_at, kind FROM crawl_runs WHERE id = ? AND hospital_id = ?").bind(runId, h.id).first<{ id: number; run_date: string; started_at: string | null; finished_at: string | null; kind: string }>();
  const kw = await c.env.DB.prepare("SELECT id, text FROM keywords WHERE id = ? AND hospital_id = ?").bind(kid, h.id).first<{ id: number; text: string }>();
  if (!run || !kw) return c.notFound();
  const obs = (await c.env.DB.prepare("SELECT platform, entity_type, entity_id, shown, rank, detail, observed_at FROM observations WHERE run_id = ? AND keyword_id = ? ORDER BY platform, entity_type").bind(runId, kid).all()).results as { platform: string; entity_type: string; entity_id: number | null; shown: number; rank: number | null; detail: string; observed_at: string }[];
  const names: Record<string, string> = { self: h.name };
  for (const x of (await c.env.DB.prepare("SELECT id, name FROM competitors WHERE hospital_id = ?").bind(h.id).all()).results as { id: number; name: string }[]) names[`c${x.id}`] = x.name;
  const pj = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
  const serp = pj(obs.find((o) => o.platform === "naver_serp" && o.entity_type === "self")?.detail || "") as { block?: { name: string; placeId: string | null; ad: boolean }[]; top5?: string[]; sections?: Record<string, boolean>; blockSize?: number; adCards?: number; mentions?: number; aib?: boolean };
  const selfPlace = obs.find((o) => o.platform === "naver_place" && o.entity_type === "self");
  const others = ["google_business", "google_serp", "kakao_map", "youtube"].map((p) => { const o = obs.find((x) => x.platform === p && x.entity_type === "self"); if (!o) return null; const d = pj(o.detail) as { top?: (string | { channel: string; title: string })[]; videoTitle?: string }; return { platform: p, label: p === "google_business" ? "구글 비즈니스(Places)" : p === "google_serp" ? "구글 검색" : p === "kakao_map" ? "카카오맵" : "유튜브 검색", rank: o.rank, shown: !!o.shown, top: (d.top || []).map((t) => (typeof t === "string" ? t : `${t.channel} · ${t.title}`)), note: d.videoTitle || null }; }).filter(Boolean) as { platform: string; label: string; rank: number | null; shown: boolean; top: string[]; note: string | null }[];
  const entityRanks = obs.filter((o) => o.platform === "naver_place").map((o) => ({ name: o.entity_type === "self" ? h.name : names[`c${o.entity_id}`] || "경쟁사", self: o.entity_type === "self", rank: o.rank, shown: !!o.shown }));
  const observedAt = (obs[0]?.observed_at || run.started_at || run.run_date).slice(0, 16).replace("T", " ");
  return c.html(Evidence({ h: hv(h), keyword: kw.text, keywordId: kw.id, run: { id: run.id, date: run.run_date, kind: run.kind, observedAt }, block: serp.block || (serp.top5 || []).map((n) => ({ name: n, placeId: null, ad: false })), hasFullBlock: !!serp.block, sections: serp.sections || {}, blockSize: serp.blockSize ?? null, adCards: serp.adCards ?? null, mentions: serp.mentions ?? null, aib: !!serp.aib, selfRank: selfPlace?.rank ?? null, selfPlaceId: h.naver_place_id, entityRanks, others }));
});

/* ── 설정 ── */
async function renderSettings(c: { env: AppEnv["Bindings"]; get: (k: "hospital") => HospitalRow }, flash?: string | null, flashErr?: string | null) {
  const h = await withHubPlan(c.env, await c.env.DB.prepare("SELECT * FROM hospitals WHERE id = ?").bind(c.get("hospital").id).first<HospitalRow>() as HospitalRow);
  const db = c.env.DB;
  const keywords = (await db.prepare("SELECT id, text, is_active, source, monthly_pc, monthly_mobile, volume_low, target_rank FROM keywords WHERE hospital_id = ? ORDER BY sort_order, id").bind(h.id).all()).results as { id: number; text: string; is_active: number; source: string; monthly_pc: number | null; monthly_mobile: number | null; volume_low: number; target_rank: number | null }[];
  const competitors = (await db.prepare("SELECT id, name, is_active, naver_place_id FROM competitors WHERE hospital_id = ? ORDER BY id").bind(h.id).all()).results as { id: number; name: string; is_active: number; naver_place_id: string | null }[];
  const settings = (await db.prepare("SELECT report_email_enabled, report_recipients FROM hospital_settings WHERE hospital_id = ?").bind(h.id).first<{ report_email_enabled: number; report_recipients: string }>()) || { report_email_enabled: 1, report_recipients: "[]" };
  const users = (await db.prepare("SELECT email, name, role FROM hospital_users WHERE hospital_id = ?").bind(h.id).all()).results as { email: string; name: string | null; role: string }[];
  const u = usablePlatforms(c.env, h); const a = platformAvailability(c.env); const lim = limitsOf(h.plan);
  const st = (ok: boolean, inPlan: boolean, keyed: boolean) => (ok ? "측정 중" : !inPlan ? "플랜 미포함" : keyed ? "설정됨" : "키 필요(운영자)");
  const snaps = (await db.prepare("SELECT platform, followers, views_30d, snapshot_date, detail FROM reputation_snapshots WHERE hospital_id = ? AND entity_type = 'self' AND platform IN ('youtube','instagram','threads') ORDER BY snapshot_date DESC LIMIT 30").bind(h.id).all()).results as { platform: string; followers: number | null; views_30d: number | null; snapshot_date: string; detail: string }[];
  const latest: Record<string, { followers: number | null; views: number | null; date: string; manual?: boolean }> = {};
  for (const x of snaps) if (!latest[x.platform]) latest[x.platform] = { followers: x.followers, views: x.views_30d, date: x.snapshot_date, manual: !!(JSON.parse(x.detail || "{}") as { manual?: boolean }).manual };
  const ytList: { id: string; title: string }[] = (() => { try { return JSON.parse(h.youtube_channels || "[]"); } catch { return []; } })();
  const social = { youtube: { input: ytList.map((x) => `https://www.youtube.com/channel/${x.id}`).join("\n"), title: ytList.map((x) => x.title).join(" · ") || null, enabled: a.youtube, channels: ytList }, instagram: { username: h.ig_username, enabled: a.instagram }, threads: { username: h.threads_username, enabled: a.threads }, latest };
  return Settings({ h: hv(h), social, err: flashErr, hospital: { name: h.name, aliases: parseJsonArr(h.name_aliases).join(", "), clinic_type: h.clinic_type || "치과", region: regionOf(h), treatments: parseJsonArr(h.key_treatments).join(", "), naver_place_id: h.naver_place_id || "", website_url: h.website_url || "" },
    keywords, competitors, settings, users, limits: lim, flash, hubLine: hubPlanLine(h.hub_ent),
    platform: { naver: st(u.naver, lim.platforms.includes("naver"), a.naver) + (a.naverMode ? ` · ${a.naverMode === "api" ? "공식 API" : "HTML"}` : ""), google: st(u.google, lim.platforms.includes("google"), a.google), kakao: st(u.kakao, lim.platforms.includes("kakao"), a.kakao), signal: st(u.signal, lim.platforms.includes("signal"), a.signal), mail: a.mail ? "설정됨" : "키 필요(운영자)" } });
}
app.get("/app/settings", async (c) => { if (limitsOf(c.get("hospital").plan).competitors > 0) await pullHubCompetitors(c, c.get("hospital")); return c.html(await renderSettings(c, c.req.query("ok") ? "저장했습니다." : null, c.req.query("err") || null)); });
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
app.post("/app/settings/competitors", async (c) => { const h = c.get("hospital"); await saveCompetitors(c, h, await c.req.parseBody({ all: true }), "active"); await pushHubCompetitors(c.env, h); return c.redirect("/app/settings?ok=1"); });
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
