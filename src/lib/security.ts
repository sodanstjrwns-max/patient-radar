import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Bindings } from "./config";
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}
export async function adminAuthorized(
  c: Context<{ Bindings: Bindings }>,
): Promise<boolean> {
  const secret = c.env.ADMIN_SECRET;
  if (!secret) return false;
  const header = c.req.header("Authorization");
  if (
    header?.startsWith("Bearer ") &&
    (await equalSecret(header.slice(7), secret))
  )
    return true;
  const cookie = await getSignedCookie(c, secret, "__Host-radar_admin");
  if (typeof cookie !== "string") return false;
  try {
    const value = JSON.parse(cookie);
    return (
      value.role === "admin" &&
      Number.isFinite(value.exp) &&
      value.exp > Date.now() &&
      value.exp <= Date.now() + 3600_000
    );
  } catch {
    return false;
  }
}
export async function issueAdminSession(c: Context<{ Bindings: Bindings }>) {
  await setSignedCookie(
    c,
    "__Host-radar_admin",
    JSON.stringify({ role: "admin", exp: Date.now() + 3600_000 }),
    c.env.ADMIN_SECRET!,
    {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      maxAge: 3600,
    },
  );
}
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header("Origin");
  return !!origin && origin === new URL(c.req.url).origin;
}
// Prepared for hub-sso integration; identity must come from the original verifier, never a decoded-only token.
export async function issueHospitalSession(
  c: Context<{ Bindings: Bindings }>,
  userId: number,
  hospitalId: number,
) {
  if (!c.env.PS_SSO_SECRET) throw new Error("SSO_NOT_CONFIGURED");
  await setSignedCookie(
    c,
    "radar_session",
    JSON.stringify({ userId, hospitalId, exp: Date.now() + 14 * 86400_000 }),
    c.env.PS_SSO_SECRET,
    {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 14 * 86400,
    },
  );
}
