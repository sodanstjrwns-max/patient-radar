// 허브 올패스 → 레이더 권한 연동 (규약: pflive/허브_올패스_권한연동_규약_2026-09-26.md)
// - 유효 권한 = services.radar 가 있으면 그것, 없으면 allpass. status active|cancel_at_period_end 이고 ends_at 이 미래일 때만.
// - 올려주기만 한다: 로컬 plan 보다 높은 티어일 때만 판정 시점에 합성(hospitals.plan 은 덮어쓰지 않음).
// - 허브 실패·키 없음·테이블 없음 = 지금 동작 그대로(null). 캐시 30분(D1 hub_entitlement_cache), 타임아웃 3초.
import { HUB_ORIGIN, type Bindings } from "./config";
import { planOf, type Plan } from "./plan-limits";
import { kstDate } from "./time";

export const HUB_SLUG = "radar";
const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 3000;

export type HubEntitlement = { tier: "S" | "M" | "L"; status: string; source: string; ends_at: string; trial: boolean; via: "service" | "allpass" };
type RawEnt = { tier?: unknown; status?: unknown; source?: unknown; ends_at?: unknown; trial?: unknown } | null | undefined;

function validEnt(e: RawEnt, via: HubEntitlement["via"], now = Date.now()): HubEntitlement | null {
  if (!e || typeof e !== "object") return null;
  const tier = e.tier === "S" || e.tier === "M" || e.tier === "L" ? e.tier : null;
  const status = String(e.status || "");
  const ends = typeof e.ends_at === "string" ? Date.parse(e.ends_at) : NaN;
  if (!tier || (status !== "active" && status !== "cancel_at_period_end") || !Number.isFinite(ends) || ends <= now) return null;
  return { tier, status, source: String(e.source || "card"), ends_at: String(e.ends_at), trial: e.trial === true, via };
}

/** 응답 → 유효 권한. services[radar] 가 있으면 그것만 본다(없을 때만 allpass) */
export function pickEntitlement(body: { allpass?: RawEnt; services?: Record<string, RawEnt> } | null, now = Date.now()): HubEntitlement | null {
  if (!body) return null;
  const svc = body.services?.[HUB_SLUG];
  if (svc) return validEnt(svc, "service", now);
  return validEnt(body.allpass, "allpass", now);
}

/** 병원의 유효 허브 권한. 없거나 실패하면 null */
export async function getHubEntitlement(env: Bindings, psHospitalId: string | null | undefined): Promise<HubEntitlement | null> {
  const hid = (psHospitalId || "").trim();
  if (!hid || !env.HUB_API_KEY) return null;
  try {
    const row = await env.DB.prepare("SELECT payload, fetched_at FROM hub_entitlement_cache WHERE ps_hospital_id = ?").bind(hid).first<{ payload: string; fetched_at: number }>();
    if (row && Date.now() - Number(row.fetched_at) < TTL_MS) {
      const cached = JSON.parse(row.payload) as HubEntitlement | null;
      // 캐시 안에서 기간이 끝났을 수 있으니 다시 검사
      return cached ? validEnt(cached, cached.via) : null;
    }
  } catch { /* 테이블 없음(마이그레이션 전) → 캐시 없이 진행 */ }
  let ent: HubEntitlement | null;
  try {
    const res = await fetch(`${HUB_ORIGIN}/api/v1/entitlements`, { headers: { Authorization: `Bearer ${env.HUB_API_KEY}`, "X-PS-Hospital-Id": hid }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) ent = null; // 허브에 없는 병원 = 권한 없음(캐시해도 됨)
    else if (!res.ok) { console.log("[radar] hub entitlements failed", res.status); return null; }
    else ent = pickEntitlement((await res.json()) as Parameters<typeof pickEntitlement>[0]);
  } catch (e) { console.log("[radar] hub entitlements error", String(e).slice(0, 120)); return null; }
  try {
    await env.DB.prepare("INSERT INTO hub_entitlement_cache (ps_hospital_id, payload, fetched_at) VALUES (?,?,?) ON CONFLICT(ps_hospital_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at").bind(hid, JSON.stringify(ent), Date.now()).run();
  } catch { /* ignore */ }
  return ent;
}

export async function clearHubEntitlement(env: Bindings, psHospitalId: string): Promise<void> {
  try { await env.DB.prepare("DELETE FROM hub_entitlement_cache WHERE ps_hospital_id = ?").bind(psHospitalId).run(); } catch { /* ignore */ }
}

const RANK: Record<Plan, number> = { FREE: 0, S: 1, M: 2, L: 3 };
/** 올려주기만: 허브 티어가 로컬보다 높을 때만 허브 티어 */
export function effectivePlan(local: string | null | undefined, ent: HubEntitlement | null): Plan {
  const p = planOf(local);
  return ent && RANK[ent.tier] > RANK[p] ? ent.tier : p;
}

/** 판정용 병원 행: plan 을 유효 플랜으로 바꾼 사본(DB 는 그대로). local_plan·hub_ent 를 함께 싣는다 */
export type EffectiveHospital<T extends { plan: string; ps_hospital_id: string | null }> = T & { local_plan: string; hub_ent: HubEntitlement | null };
export async function withHubPlan<T extends { plan: string; ps_hospital_id: string | null }>(env: Bindings, h: T): Promise<EffectiveHospital<T>> {
  const ent = await getHubEntitlement(env, h.ps_hospital_id);
  return { ...h, local_plan: h.plan, plan: effectivePlan(h.plan, ent), hub_ent: ent };
}

/** 설정 화면 한 줄. 권한이 없으면 null */
export function hubPlanLine(ent: HubEntitlement | null): string | null {
  if (!ent) return null;
  const d = kstDate(new Date(ent.ends_at));
  const who = ent.via === "allpass" ? `허브 올패스 ${ent.tier}` : `허브 레이더 ${ent.tier}`;
  return `${who} 적용 중 · ${d}까지${ent.source === "grant" ? " · 올인원 수강생 무료 제공" : ""}`;
}
