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
  const h = c.get("hospital"); const b = await c.req.parseBody(); const input = str(b.channel);
  if (!input) { await c.env.DB.prepare("UPDATE hospitals SET youtube_channel_id = NULL, youtube_channel_title = NULL WHERE id = ?").bind(h.id).run(); return c.redirect("/app/settings?ok=1#content"); }
  if (!c.env.YOUTUBE_API_KEY) return c.redirect("/app/settings?err=" + encodeURIComponent("유튜브 API 키가 없습니다(운영자)"));
  const ch = await resolveChannel(input, { YOUTUBE_API_KEY: c.env.YOUTUBE_API_KEY }).catch(() => null);
  if (!ch) return c.redirect("/app/settings?err=" + encodeURIComponent("채널을 찾지 못했습니다. 채널 주소(@핸들 또는 /channel/UC…)를 확인해 주세요") + "#content");
  await c.env.DB.prepare("UPDATE hospitals SET youtube_channel_id = ?, youtube_channel_title = ?, updated_at = ? WHERE id = ?").bind(ch.id, ch.title, kstIso(), h.id).run();
  return c.redirect("/app/settings?ok=1#content");
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
export default social;
