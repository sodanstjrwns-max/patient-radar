import { getSignedCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { Bindings } from "./config";

export const SESSION_COOKIE = "radar_session";
export type Session = { userId: number; hospitalId: number; exp: number };
export type AppEnv = { Bindings: Bindings; Variables: { session: Session; hospital: HospitalRow } };

export type HospitalRow = {
  id: number;
  ps_hospital_id: string | null;
  name: string;
  name_aliases: string;
  region_sido: string | null;
  region_sigungu: string | null;
  region_dong: string | null;
  naver_place_id: string | null;
  google_place_id: string | null;
  kakao_place_id: string | null;
  plan: string;
  status: string;
  website_url: string | null;
  onboarded_at: string | null;
  clinic_type: string | null;
  key_treatments: string;
  youtube_channel_id: string | null; youtube_channel_title: string | null; youtube_channels: string;
  ig_user_id: string | null; ig_username: string | null; ig_token_enc: string | null; ig_token_expires_at: string | null;
  threads_user_id: string | null; threads_username: string | null; threads_token_enc: string | null; threads_token_expires_at: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = Context<any, any, any>;
export async function readSession(c: AnyCtx): Promise<Session | null> {
  if (!c.env.PS_SSO_SECRET) return null;
  const raw = await getSignedCookie(c, c.env.PS_SSO_SECRET, SESSION_COOKIE);
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Session;
    if (!Number.isFinite(v.userId) || !Number.isFinite(v.hospitalId) || !Number.isFinite(v.exp)) return null;
    if (v.exp < Date.now()) return null;
    return v;
  } catch {
    return null;
  }
}

export function clearSession(c: AnyCtx) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** 병원 세션 필수. 없으면 로그인(허브 SSO)으로. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = await readSession(c);
  if (!s) return c.redirect("/api/auth/hub?next=" + encodeURIComponent(c.req.path));
  const h = await c.env.DB.prepare("SELECT * FROM hospitals WHERE id = ? AND status = 'active'").bind(s.hospitalId).first<HospitalRow>();
  if (!h) {
    clearSession(c);
    return c.redirect("/?auth=hospital_missing");
  }
  c.set("session", s);
  c.set("hospital", h);
  await next();
};
