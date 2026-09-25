// 유튜브 Data API v3 — 공개 데이터, 로그인 불필요. 채널 통계 + 최근 30일 업로드 영상 조회수.
export type YoutubeEnv = { YOUTUBE_API_KEY: string };
const BASE = "https://www.googleapis.com/youtube/v3";
async function get<T>(env: YoutubeEnv, path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<T> {
  const u = new URL(`${BASE}/${path}`); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); u.searchParams.set("key", env.YOUTUBE_API_KEY);
  const res = await fetchImpl(u.href, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`YOUTUBE_HTTP_${res.status}`);
  return (await res.json()) as T;
}
type ChannelResp = { items?: { id: string; snippet: { title: string }; statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string }; contentDetails: { relatedPlaylists: { uploads: string } } }[] };

/** 채널 주소·핸들·ID → 채널 ID/제목 */
export async function resolveChannel(input: string, env: YoutubeEnv, fetchImpl: typeof fetch = fetch): Promise<{ id: string; title: string } | null> {
  const s = input.trim();
  let params: Record<string, string> | null = null;
  const m1 = /channel\/(UC[0-9A-Za-z_-]{20,})/.exec(s) || /^(UC[0-9A-Za-z_-]{20,})$/.exec(s);
  const m2 = /@([A-Za-z0-9._-]{3,})/.exec(s);
  const m3 = /\/user\/([A-Za-z0-9._-]+)/.exec(s) || /\/c\/([A-Za-z0-9._-]+)/.exec(s);
  if (m1) params = { id: m1[1] }; else if (m2) params = { forHandle: "@" + m2[1] }; else if (m3) params = { forUsername: m3[1] }; else if (/^[A-Za-z0-9._-]{3,}$/.test(s)) params = { forHandle: "@" + s };
  if (!params) return null;
  const r = await get<ChannelResp>(env, "channels", { part: "snippet", ...params }, fetchImpl);
  const it = r.items?.[0]; return it ? { id: it.id, title: it.snippet.title } : null;
}

export type YoutubeSnapshot = { channelId: string; title: string; subscribers: number | null; totalViews: number | null; videoCount: number | null; uploads30d: number; views30d: number; likes30d: number; comments30d: number; top: { id: string; title: string; views: number; publishedAt: string }[] };
export async function collectYoutube(channelId: string, env: YoutubeEnv, fetchImpl: typeof fetch = fetch): Promise<YoutubeSnapshot> {
  const ch = (await get<ChannelResp>(env, "channels", { part: "snippet,statistics,contentDetails", id: channelId }, fetchImpl)).items?.[0];
  if (!ch) throw new Error("YOUTUBE_CHANNEL_NOT_FOUND");
  const n = (v?: string) => (v == null ? null : Number(v));
  const since = Date.now() - 30 * 86400_000;
  const pl = await get<{ items?: { contentDetails: { videoId: string; videoPublishedAt: string } }[] }>(env, "playlistItems", { part: "contentDetails", playlistId: ch.contentDetails.relatedPlaylists.uploads, maxResults: "50" }, fetchImpl);
  const recent = (pl.items || []).filter((i) => new Date(i.contentDetails.videoPublishedAt).getTime() >= since).map((i) => i.contentDetails.videoId);
  let views = 0, likes = 0, comments = 0; const top: YoutubeSnapshot["top"] = [];
  if (recent.length) {
    const vr = await get<{ items?: { id: string; snippet: { title: string; publishedAt: string }; statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(env, "videos", { part: "snippet,statistics", id: recent.slice(0, 50).join(",") }, fetchImpl);
    for (const v of vr.items || []) { const vc = Number(v.statistics.viewCount || 0); views += vc; likes += Number(v.statistics.likeCount || 0); comments += Number(v.statistics.commentCount || 0); top.push({ id: v.id, title: v.snippet.title, views: vc, publishedAt: v.snippet.publishedAt.slice(0, 10) }); }
    top.sort((a, b) => b.views - a.views);
  }
  return { channelId, title: ch.snippet.title, subscribers: n(ch.statistics.subscriberCount), totalViews: n(ch.statistics.viewCount), videoCount: n(ch.statistics.videoCount), uploads30d: recent.length, views30d: views, likes30d: likes, comments30d: comments, top: top.slice(0, 5) };
}
