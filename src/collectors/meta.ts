// 인스타그램(Graph API) · 스레드(Threads API) — 병원이 OAuth 로 연결한 계정만. Meta 앱(META_APP_ID/SECRET, THREADS_APP_ID/SECRET) 필요.
export type MetaEnv = { META_APP_ID?: string; META_APP_SECRET?: string; THREADS_APP_ID?: string; THREADS_APP_SECRET?: string };
const G = "https://graph.facebook.com/v21.0", T = "https://graph.threads.net/v1.0";
async function j<T>(res: Response): Promise<T> { const b = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }; if (!res.ok) throw new Error(`META_${res.status}_${(b as { error?: { message?: string } }).error?.message || ""}`.slice(0, 120)); return b; }

/* ── Instagram (Instagram 로그인이 포함된 API: 페이스북 페이지 없이 IG 프로페셔널 계정만으로 연결) ──
   META_APP_ID/SECRET = 콘솔의 "Instagram 앱 ID / Instagram 앱 시크릿 코드" */
const IG_API = "https://api.instagram.com", IG_GRAPH = "https://graph.instagram.com/v21.0";
export function instagramAuthUrl(env: MetaEnv, redirectUri: string, state: string) {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", env.META_APP_ID!); u.searchParams.set("redirect_uri", redirectUri); u.searchParams.set("state", state);
  u.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_insights"); u.searchParams.set("response_type", "code"); u.searchParams.set("force_reauth", "true");
  return u.href;
}
export async function instagramExchange(env: MetaEnv, redirectUri: string, code: string, fetchImpl: typeof fetch = fetch) {
  const body = new URLSearchParams({ client_id: env.META_APP_ID!, client_secret: env.META_APP_SECRET!, grant_type: "authorization_code", redirect_uri: redirectUri, code });
  const short = await j<{ access_token: string; user_id: number | string }>(await fetchImpl(`${IG_API}/oauth/access_token`, { method: "POST", body }));
  const long = await j<{ access_token: string; expires_in?: number }>(await fetchImpl(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${env.META_APP_SECRET}&access_token=${short.access_token}`));
  const me = await j<{ id: string; user_id?: string; username: string }>(await fetchImpl(`${IG_GRAPH}/me?fields=id,user_id,username&access_token=${long.access_token}`));
  return { igUserId: me.user_id || me.id, username: me.username, token: long.access_token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null };
}
/** 장기 토큰 갱신(60일) — 만료 7일 전이면 갱신 */
export async function instagramRefresh(token: string, fetchImpl: typeof fetch = fetch) {
  const r = await j<{ access_token: string; expires_in?: number }>(await fetchImpl(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`));
  return { token: r.access_token, expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null };
}
export type InstagramSnapshot = { followers: number | null; mediaCount: number | null; reach30d: number | null; views30d: number | null; posts30d: number; top: { id: string; caption: string; views: number; permalink: string }[] };
export async function collectInstagram(igUserId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<InstagramSnapshot> {
  const acc = await j<{ followers_count?: number; media_count?: number }>(await fetchImpl(`${IG_GRAPH}/me?fields=followers_count,media_count&access_token=${token}`));
  const since = Math.floor((Date.now() - 30 * 86400_000) / 1000), until = Math.floor(Date.now() / 1000);
  let reach: number | null = null, views: number | null = null;
  try {
    const ins = await j<{ data?: { name: string; total_value?: { value: number }; values?: { value: number }[] }[] }>(await fetchImpl(`${IG_GRAPH}/me/insights?metric=reach,views&period=day&metric_type=total_value&since=${since}&until=${until}&access_token=${token}`));
    for (const m of ins.data || []) { const v = m.total_value?.value ?? (m.values || []).reduce((a, x) => a + (x.value || 0), 0); if (m.name === "reach") reach = v; if (m.name === "views") views = v; }
  } catch { /* 권한 없으면 도달·조회는 null */ }
  const media = await j<{ data?: { id: string; caption?: string; timestamp: string; permalink: string }[] }>(await fetchImpl(`${IG_GRAPH}/me/media?fields=id,caption,timestamp,permalink&limit=30&access_token=${token}`));
  const recent = (media.data || []).filter((m) => new Date(m.timestamp).getTime() >= since * 1000);
  const top: InstagramSnapshot["top"] = [];
  for (const m of recent.slice(0, 15)) {
    try { const mi = await j<{ data?: { name: string; values: { value: number }[] }[] }>(await fetchImpl(`${IG_GRAPH}/${m.id}/insights?metric=views&access_token=${token}`)); top.push({ id: m.id, caption: (m.caption || "").slice(0, 60), views: mi.data?.[0]?.values?.[0]?.value ?? 0, permalink: m.permalink }); } catch { /* skip */ }
  }
  top.sort((a, b) => b.views - a.views);
  void igUserId;
  return { followers: acc.followers_count ?? null, mediaCount: acc.media_count ?? null, reach30d: reach, views30d: views, posts30d: recent.length, top: top.slice(0, 5) };
}

/* ── Threads ── */
export function threadsAuthUrl(env: MetaEnv, redirectUri: string, state: string) {
  const u = new URL("https://threads.net/oauth/authorize");
  u.searchParams.set("client_id", env.THREADS_APP_ID!); u.searchParams.set("redirect_uri", redirectUri); u.searchParams.set("state", state);
  u.searchParams.set("scope", "threads_basic,threads_manage_insights"); u.searchParams.set("response_type", "code");
  return u.href;
}
export async function threadsExchange(env: MetaEnv, redirectUri: string, code: string, fetchImpl: typeof fetch = fetch) {
  const body = new URLSearchParams({ client_id: env.THREADS_APP_ID!, client_secret: env.THREADS_APP_SECRET!, grant_type: "authorization_code", redirect_uri: redirectUri, code });
  const short = await j<{ access_token: string; user_id: number }>(await fetchImpl(`${T}/oauth/access_token`, { method: "POST", body }));
  const long = await j<{ access_token: string; expires_in?: number }>(await fetchImpl(`${T}/access_token?grant_type=th_exchange_token&client_secret=${env.THREADS_APP_SECRET}&access_token=${short.access_token}`));
  const me = await j<{ id: string; username: string }>(await fetchImpl(`${T}/me?fields=id,username&access_token=${long.access_token}`));
  return { userId: me.id, username: me.username, token: long.access_token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null };
}
export async function threadsRefresh(token: string, fetchImpl: typeof fetch = fetch) {
  const r = await j<{ access_token: string; expires_in?: number }>(await fetchImpl(`${T}/refresh_access_token?grant_type=th_refresh_token&access_token=${token}`));
  return { token: r.access_token, expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null };
}
export type ThreadsSnapshot = { followers: number | null; views30d: number | null; likes30d: number | null; posts30d: number };
export async function collectThreads(userId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ThreadsSnapshot> {
  const since = Math.floor((Date.now() - 30 * 86400_000) / 1000), until = Math.floor(Date.now() / 1000);
  const ins = await j<{ data?: { name: string; total_value?: { value: number }; values?: { value: number }[] }[] }>(await fetchImpl(`${T}/${userId}/threads_insights?metric=views,likes,followers_count&since=${since}&until=${until}&access_token=${token}`));
  const val = (n: string) => { const m = (ins.data || []).find((x) => x.name === n); return m ? (m.total_value?.value ?? (m.values || []).reduce((a, x) => a + (x.value || 0), 0)) : null; };
  const posts = await j<{ data?: { id: string; timestamp: string }[] }>(await fetchImpl(`${T}/${userId}/threads?fields=id,timestamp&limit=50&access_token=${token}`));
  return { followers: val("followers_count"), views30d: val("views"), likes30d: val("likes"), posts30d: (posts.data || []).filter((p) => new Date(p.timestamp).getTime() >= since * 1000).length };
}
