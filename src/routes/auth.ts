// 허브 SSO — 로그인은 이것 하나. 매칭: hub_user_id → email → hid 로 병원 합류/생성.
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import type { Bindings } from "../lib/config";
import { HUB_ORIGIN, HUB_SSO_SERVICE } from "../lib/config";
import { verifyHubSsoToken } from "../lib/hub-sso";
import { SESSION_COOKIE, clearSession } from "../lib/session";
import { kstIso } from "../lib/time";

const auth = new Hono<{ Bindings: Bindings }>();

auth.get("/api/auth/hub", (c) => {
  if (!c.env.PS_SSO_SECRET) return c.text("sso not configured", 503);
  const origin = new URL(c.req.url).origin;
  const next = c.req.query("next") || "";
  const state = next && next.startsWith("/") ? encodeURIComponent(next) : "";
  const cb = `${origin}/api/auth/hub/callback`;
  return c.redirect(`${HUB_ORIGIN}/sso/authorize?service=${HUB_SSO_SERVICE}&redirect_uri=${encodeURIComponent(cb)}${state ? `&state=${state}` : ""}`);
});

auth.get("/api/auth/hub/callback", async (c) => {
  const secret = c.env.PS_SSO_SECRET;
  const token = c.req.query("sso_token");
  if (!secret || !token) return c.redirect("/?auth=failed");
  const claims = await verifyHubSsoToken(secret, token, HUB_SSO_SERVICE);
  if (!claims) return c.redirect("/?auth=failed");
  const db = c.env.DB;
  const email = String(claims.email).toLowerCase();
  const hid = String(claims.hid);
  // ① hub_user_id  ② email  ③ hid → 병원
  let user = await db.prepare("SELECT hospital_id FROM hospital_users WHERE hub_user_id = ?").bind(claims.sub).first<{ hospital_id: number }>();
  if (!user) user = await db.prepare("SELECT hospital_id FROM hospital_users WHERE email = ?").bind(email).first<{ hospital_id: number }>();
  let hospitalId = user?.hospital_id ?? null;
  if (hospitalId == null) {
    let h = await db.prepare("SELECT id FROM hospitals WHERE ps_hospital_id = ?").bind(hid).first<{ id: number }>();
    if (!h) {
      const ins = await db.prepare("INSERT INTO hospitals (ps_hospital_id, name, plan, created_at, updated_at) VALUES (?, ?, 'S', ?, ?) RETURNING id").bind(hid, claims.hname || "", kstIso(), kstIso()).first<{ id: number }>();
      h = { id: ins!.id };
    }
    hospitalId = h.id;
  } else {
    // 허브 전역 ID 가 비어 있으면 채운다(다른 병원이 이미 가진 hid 는 건드리지 않음)
    await db.prepare("UPDATE hospitals SET ps_hospital_id = ? WHERE id = ? AND ps_hospital_id IS NULL AND NOT EXISTS (SELECT 1 FROM hospitals WHERE ps_hospital_id = ?)").bind(hid, hospitalId, hid).run();
  }
  await db.prepare("INSERT INTO hospital_users (hospital_id, hub_user_id, email, name, role, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(hospital_id, email) DO UPDATE SET hub_user_id = excluded.hub_user_id, name = excluded.name, role = excluded.role")
    .bind(hospitalId, claims.sub, email, claims.name || "", claims.role || "director", kstIso()).run();
  await setSignedCookie(c, SESSION_COOKIE, JSON.stringify({ userId: claims.sub, hospitalId, exp: Date.now() + 14 * 86400_000 }), secret, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 14 * 86400 });
  const state = c.req.query("state") || "";
  const h = await db.prepare("SELECT onboarded_at FROM hospitals WHERE id = ?").bind(hospitalId).first<{ onboarded_at: string | null }>();
  if (!h?.onboarded_at) return c.redirect("/app/onboarding");
  return c.redirect(state && state.startsWith("/") && !state.startsWith("//") ? state : "/app");
});

auth.post("/api/auth/logout", (c) => { clearSession(c); return c.redirect("/"); });
export default auth;
