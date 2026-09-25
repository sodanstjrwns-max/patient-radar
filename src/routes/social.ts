// 콘텐츠 계정: 유튜브 채널 등록, 인스타·스레드 OAuth 연결/해제, 수동 입력(다리)
import { Hono } from "hono";
import type { AppEnv } from "../lib/session";
import { requireSession } from "../lib/session";
import { platformAvailability } from "../lib/config";
import { resolveChannel } from "../collectors/youtube";
import { instagramAuthUrl, instagramExchange, threadsAuthUrl, threadsExchange } from "../collectors/meta";
import { encryptToken } from "../lib/crypto";
import { kstDate, kstIso } from "../lib/time";

const social = new Hono<AppEnv>();
social.use("/app/*", requireSession);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => { const n = Number(str(v).replace(/[^0-9.]/g, "")); return str(v) && Number.isFinite(n) ? Math.round(n) : null; };

social.post("/app/settings/youtube", async (c) => {
  const h = c.get("hospital"); const b = await c.req.parseBody();
  const lines = str(b.channels).split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
  if (!lines.length) { await c.env.DB.prepare("UPDATE hospitals SET youtube_channels = '[]', youtube_channel_id = NULL, youtube_channel_title = NULL WHERE id = ?").bind(h.id).run(); return c.redirect("/app/settings?ok=1#content"); }
  if (!c.env.YOUTUBE_API_KEY) return c.redirect("/app/settings?err=" + encodeURIComponent("유튜브 API 키가 없습니다(운영자)"));
  const found: { id: string; title: string }[] = []; const missed: string[] = [];
  for (const l of lines) { const ch = await resolveChannel(l, { YOUTUBE_API_KEY: c.env.YOUTUBE_API_KEY }).catch(() => null); if (ch && !found.some((f) => f.id === ch.id)) found.push(ch); else if (!ch) missed.push(l); }
  await c.env.DB.prepare("UPDATE hospitals SET youtube_channels = ?, youtube_channel_id = ?, youtube_channel_title = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(found), found[0]?.id ?? null, found[0]?.title ?? null, kstIso(), h.id).run();
  return c.redirect(missed.length ? "/app/settings?err=" + encodeURIComponent(`찾지 못한 채널: ${missed.join(", ")} (나머지는 저장됨)`) + "#content" : "/app/settings?ok=1#content");
});

/* ── OAuth 연결 ── */
async function newState(c: { env: AppEnv["Bindings"] }, hospitalId: number, provider: string) {
  const state = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO oauth_states (state, hospital_id, provider, created_at) VALUES (?,?,?,?)").bind(state, hospitalId, provider, kstIso()).run();
  return state;
}
async function takeState(c: { env: AppEnv["Bindings"] }, state: string, provider: string) {
  const row = await c.env.DB.prepare("SELECT hospital_id, created_at FROM oauth_states WHERE state = ? AND provider = ?").bind(state, provider).first<{ hospital_id: number; created_at: string }>();
  if (row) await c.env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  if (!row || Date.now() - new Date(row.created_at).getTime() > 15 * 60_000) return null;
  return row.hospital_id;
}
const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;

social.get("/app/connect/instagram", async (c) => {
  if (!platformAvailability(c.env).instagram) return c.redirect("/app/settings?err=" + encodeURIComponent("인스타그램 연결은 Meta 앱 등록 후 열립니다") + "#content");
  const state = await newState(c, c.get("hospital").id, "instagram");
  return c.redirect(instagramAuthUrl(c.env, `${origin(c)}/app/connect/instagram/callback`, state));
});
social.get("/app/connect/instagram/callback", async (c) => {
  const hid = await takeState(c, c.req.query("state") || "", "instagram"); const code = c.req.query("code");
  if (!hid || !code || hid !== c.get("hospital").id) return c.redirect("/app/settings?err=" + encodeURIComponent("인스타그램 연결 실패(상태 불일치)") + "#content");
  try {
    const r = await instagramExchange(c.env, `${origin(c)}/app/connect/instagram/callback`, code);
    await c.env.DB.prepare("UPDATE hospitals SET ig_user_id = ?, ig_username = ?, ig_token_enc = ?, ig_token_expires_at = ?, updated_at = ? WHERE id = ?").bind(r.igUserId, r.username, await encryptToken(c.env.PS_SSO_SECRET!, r.token), r.expiresAt, kstIso(), hid).run();
    return c.redirect("/app/settings?ok=1#content");
  } catch (e) { return c.redirect("/app/settings?err=" + encodeURIComponent("인스타그램 연결 실패: " + String(e).slice(0, 80)) + "#content"); }
});
social.get("/app/connect/threads", async (c) => {
  if (!platformAvailability(c.env).threads) return c.redirect("/app/settings?err=" + encodeURIComponent("스레드 연결은 Meta 앱 등록 후 열립니다") + "#content");
  const state = await newState(c, c.get("hospital").id, "threads");
  return c.redirect(threadsAuthUrl(c.env, `${origin(c)}/app/connect/threads/callback`, state));
});
social.get("/app/connect/threads/callback", async (c) => {
  const hid = await takeState(c, c.req.query("state") || "", "threads"); const code = c.req.query("code");
  if (!hid || !code || hid !== c.get("hospital").id) return c.redirect("/app/settings?err=" + encodeURIComponent("스레드 연결 실패(상태 불일치)") + "#content");
  try {
    const r = await threadsExchange(c.env, `${origin(c)}/app/connect/threads/callback`, code);
    await c.env.DB.prepare("UPDATE hospitals SET threads_user_id = ?, threads_username = ?, threads_token_enc = ?, threads_token_expires_at = ?, updated_at = ? WHERE id = ?").bind(r.userId, r.username, await encryptToken(c.env.PS_SSO_SECRET!, r.token), r.expiresAt, kstIso(), hid).run();
    return c.redirect("/app/settings?ok=1#content");
  } catch (e) { return c.redirect("/app/settings?err=" + encodeURIComponent("스레드 연결 실패: " + String(e).slice(0, 80)) + "#content"); }
});
social.post("/app/disconnect/:provider", async (c) => {
  const h = c.get("hospital"); const p = c.req.param("provider");
  if (p === "instagram") await c.env.DB.prepare("UPDATE hospitals SET ig_user_id = NULL, ig_username = NULL, ig_token_enc = NULL, ig_token_expires_at = NULL WHERE id = ?").bind(h.id).run();
  else if (p === "threads") await c.env.DB.prepare("UPDATE hospitals SET threads_user_id = NULL, threads_username = NULL, threads_token_enc = NULL, threads_token_expires_at = NULL WHERE id = ?").bind(h.id).run();
  return c.redirect("/app/settings?ok=1#content");
});

/* ── 수동 입력(다리): 이번 주 인스타·스레드 숫자를 실장이 옮겨 적는다 ── */
social.post("/app/settings/social-manual", async (c) => {
  const h = c.get("hospital"); const b = await c.req.parseBody(); const date = kstDate();
  for (const p of ["instagram", "threads"]) {
    const followers = num(b[`${p}_followers`]), views = num(b[`${p}_views`]), reach = num(b[`${p}_reach`]);
    if (followers == null && views == null && reach == null) continue;
    await c.env.DB.prepare("INSERT OR REPLACE INTO reputation_snapshots (hospital_id, entity_type, entity_id, platform, snapshot_date, followers, views_30d, detail, created_at) VALUES (?, 'self', NULL, ?, ?, ?, ?, ?, ?)")
      .bind(h.id, p, date, followers, views ?? reach, JSON.stringify({ manual: true, reach30d: reach, views30d: views }), kstIso()).run();
  }
  return c.redirect("/app/settings?ok=1#content");
});
/* ── Meta 콜백(앱 제거·데이터 삭제 요청): 연결 해제 처리. signed_request 는 앱 시크릿으로 검증한다. */
async function verifySignedRequest(secret: string, sr: string): Promise<Record<string, unknown> | null> {
  const [sig, payload] = sr.split(".");
  if (!sig || !payload) return null;
  const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, b64(sig), new TextEncoder().encode(payload));
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(b64(payload))); } catch { return null; }
}
for (const kind of ["uninstall", "delete"]) social.post(`/api/meta/${kind}`, async (c) => {
  const b = await c.req.parseBody(); const sr = String(b.signed_request || "");
  const secrets = [c.env.META_APP_SECRET, c.env.THREADS_APP_SECRET].filter(Boolean) as string[];
  let data: Record<string, unknown> | null = null;
  for (const s of secrets) { data = await verifySignedRequest(s, sr); if (data) break; }
  if (!data) return c.json({ error: { code: "BAD_SIGNATURE", message: "signed_request 검증 실패" } }, 400);
  const uid = String(data.user_id || "");
  if (uid) await c.env.DB.batch([
    c.env.DB.prepare("UPDATE hospitals SET ig_user_id = NULL, ig_username = NULL, ig_token_enc = NULL, ig_token_expires_at = NULL WHERE ig_user_id = ?").bind(uid),
    c.env.DB.prepare("UPDATE hospitals SET threads_user_id = NULL, threads_username = NULL, threads_token_enc = NULL, threads_token_expires_at = NULL WHERE threads_user_id = ?").bind(uid),
  ]);
  const code = crypto.randomUUID().slice(0, 8);
  return c.json({ url: `${new URL(c.req.url).origin}/privacy#deletion-${code}`, confirmation_code: code });
});
export default social;
