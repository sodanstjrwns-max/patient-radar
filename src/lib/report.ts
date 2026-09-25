// 주간 리포트: content_json 한 원천으로 화면과 메일을 만든다. 해석 문구는 규칙 템플릿만(LLM 없음).
import type { Bindings } from "./config";
import { kstIso } from "./time";

export type ReportContent = {
  week: string; hospital: string; total: number | null; prevTotal: number | null; delta: number | null; weighted: number | null;
  platforms: { platform: string; label: string; score: number | null; prev: number | null; sov: number | null }[];
  up: { keyword: string; platform: string; from: number | null; to: number | null }[];
  down: { keyword: string; platform: string; from: number | null; to: number | null }[];
  reputation: { platform: string; entity: string; reviews: number | null; prevReviews: number | null }[];
  alerts: { severity: string; message: string }[];
  notes: string[];
  nextRun: string;
  reviewNote?: string | null;
  content?: { label: string; followers: number | null; views: number | null }[];
  arrivals?: { week_start: string; first_visits: number; search: number; ai: number; sns: number; content: number; referral: number }[];
  opportunity?: { pool: number; captured: number; coverage: number | null; prevCoverage: number | null; lost: { keyword: string; volume: number; rank: number | null; lost: number; gainNext: number; nextRank?: number; above: string[]; actions?: string[] }[]; competitors: { name: string; captured: number }[] } | null;
};
export const PLATFORM_LABEL: Record<string, string> = { naver_serp: "네이버 통합검색", naver_place: "네이버 플레이스", google: "구글", kakao: "카카오맵", signal_ai: "AI (시그널)", total: "온라인 가시성" };

function next7(week: string): string { const d = new Date(week + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); }
function prevWeek(week: string): string {
  const d = new Date(week + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10);
}

export async function buildWeeklyReport(db: D1Database, hospitalId: number, week: string): Promise<ReportContent | null> {
  const h = await db.prepare("SELECT name FROM hospitals WHERE id = ?").bind(hospitalId).first<{ name: string }>();
  if (!h) return null;
  const pw = prevWeek(week);
  const cur = (await db.prepare("SELECT platform, score, sov, weighted_score FROM weekly_scores WHERE hospital_id = ? AND week_start = ?").bind(hospitalId, week).all()).results as { platform: string; score: number; sov: number | null; weighted_score: number | null }[];
  if (!cur.length) return null;
  const prev = (await db.prepare("SELECT platform, score FROM weekly_scores WHERE hospital_id = ? AND week_start = ?").bind(hospitalId, pw).all()).results as { platform: string; score: number }[];
  const pmap = Object.fromEntries(prev.map((r) => [r.platform, r.score]));
  const total = cur.find((r) => r.platform === "total")?.score ?? null;
  const prevTotal = pmap.total ?? null;
  const platforms = cur.filter((r) => r.platform !== "total").map((r) => ({ platform: r.platform, label: PLATFORM_LABEL[r.platform] || r.platform, score: r.score, prev: pmap[r.platform] ?? null, sov: r.sov }));
  // 키워드 순위 변화: 이번 주 run 과 지난 주 run 의 self 관측치 비교(플레이스·구글·카카오)
  const runs = (await db.prepare("SELECT id, run_date FROM crawl_runs WHERE hospital_id = ? AND status IN ('completed','blocked') AND run_date >= ? ORDER BY run_date DESC").bind(hospitalId, pw).all()).results as { id: number; run_date: string }[];
  const curRun = runs.find((r) => r.run_date >= week);
  const prevRun = runs.find((r) => r.run_date < week);
  const up: ReportContent["up"] = [], down: ReportContent["down"] = [];
  if (curRun && prevRun) {
    const q = "SELECT o.platform, o.rank, k.text FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? AND o.entity_type = 'self' AND o.platform IN ('naver_place','google_serp','kakao_map')";
    const a = (await db.prepare(q).bind(curRun.id).all()).results as { platform: string; rank: number | null; text: string }[];
    const b = (await db.prepare(q).bind(prevRun.id).all()).results as { platform: string; rank: number | null; text: string }[];
    for (const x of a) {
      const y = b.find((z) => z.platform === x.platform && z.text === x.text);
      if (!y) continue;
      const from = y.rank, to = x.rank;
      const val = (r: number | null) => (r == null ? 99 : r);
      if (val(to) < val(from)) up.push({ keyword: x.text, platform: PLATFORM_LABEL[x.platform === "google_serp" ? "google" : x.platform === "kakao_map" ? "kakao" : x.platform] || x.platform, from, to });
      if (val(to) > val(from)) down.push({ keyword: x.text, platform: PLATFORM_LABEL[x.platform === "google_serp" ? "google" : x.platform === "kakao_map" ? "kakao" : x.platform] || x.platform, from, to });
    }
  }
  const rep = (await db.prepare("SELECT platform, entity_type, entity_id, review_count, snapshot_date FROM reputation_snapshots WHERE hospital_id = ? AND snapshot_date >= ? ORDER BY snapshot_date DESC").bind(hospitalId, pw).all()).results as { platform: string; entity_type: string; entity_id: number | null; review_count: number | null; snapshot_date: string }[];
  const reputation: ReportContent["reputation"] = [];
  const names: Record<string, string> = {};
  for (const c of (await db.prepare("SELECT id, name FROM competitors WHERE hospital_id = ?").bind(hospitalId).all()).results as { id: number; name: string }[]) names[String(c.id)] = c.name;
  const seen = new Set<string>();
  for (const r of rep) {
    const key = `${r.platform}:${r.entity_type}:${r.entity_id ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const older = rep.find((z) => `${z.platform}:${z.entity_type}:${z.entity_id ?? 0}` === key && z.snapshot_date < r.snapshot_date);
    reputation.push({ platform: PLATFORM_LABEL[r.platform] || r.platform, entity: r.entity_type === "self" ? h.name : names[String(r.entity_id)] || "경쟁사", reviews: r.review_count, prevReviews: older?.review_count ?? null });
  }
  const alerts = (await db.prepare("SELECT severity, message FROM alerts WHERE hospital_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 5").bind(hospitalId, week).all()).results as { severity: string; message: string }[];
  const notes: string[] = [];
  const naverPlace = platforms.find((p) => p.platform === "naver_place"), naverSerp = platforms.find((p) => p.platform === "naver_serp");
  if (naverPlace && naverSerp && naverPlace.prev != null && naverPlace.score >= naverPlace.prev && naverSerp.prev != null && naverSerp.score < naverSerp.prev) notes.push("플레이스 순위는 지켰지만 블로그·카페 노출이 빠졌습니다.");
  if (total != null && prevTotal != null && total - prevTotal >= 10) notes.push("가시성이 크게 올랐습니다. 이번 주에 바뀐 것(리뷰·콘텐츠·광고)을 기록해 두세요.");
  if (down.length > up.length) notes.push(`내려간 키워드가 올라간 키워드보다 많습니다 (${down.length} vs ${up.length}).`);
  if (!prev.length) notes.push("첫 주 측정입니다. 증감과 추세는 다음 주부터 표시됩니다.");
  const oppRow = await db.prepare("SELECT pool, captured, coverage, detail FROM weekly_opportunity WHERE hospital_id = ? AND week_start = ? AND platform = 'naver_place'").bind(hospitalId, week).first<{ pool: number; captured: number; coverage: number; detail: string }>();
  const oppPrev = await db.prepare("SELECT coverage FROM weekly_opportunity WHERE hospital_id = ? AND week_start = ? AND platform = 'naver_place'").bind(hospitalId, pw).first<{ coverage: number }>();
  let opportunity: ReportContent["opportunity"] = null;
  if (oppRow) {
    const det = JSON.parse(oppRow.detail || "{}") as { lost?: ReportContent["opportunity"] extends infer T ? T extends { lost: infer L } ? L : never : never; competitors?: Record<string, { name: string; captured: number }> };
    opportunity = { pool: oppRow.pool, captured: oppRow.captured, coverage: oppRow.coverage, prevCoverage: oppPrev?.coverage ?? null, lost: (det.lost || []).slice(0, 5), competitors: Object.values(det.competitors || {}).sort((a, b) => b.captured - a.captured) };
    if (opportunity.lost[0]) notes.unshift(`이번 주 가장 큰 기회는 「${opportunity.lost[0].keyword}」(월 ${opportunity.lost[0].volume.toLocaleString()}회, 현재 ${opportunity.lost[0].rank ?? "미노출"}${opportunity.lost[0].rank ? "위" : ""}) ${opportunity.lost[0].gainNext > 0 ? ` — ${opportunity.lost[0].rank == null ? "플레이스 블록에 들어가면" : `${opportunity.lost[0].nextRank ?? opportunity.lost[0].rank - 1}위로 오르면`} 월 약 ${opportunity.lost[0].gainNext.toLocaleString()}회 더 보입니다.` : "."}`);
  }
  const arrivals = ((await db.prepare("SELECT week_start, first_visits, groups FROM weekly_arrivals WHERE hospital_id = ? AND week_start <= ? ORDER BY week_start DESC LIMIT 4").bind(hospitalId, week).all()).results as { week_start: string; first_visits: number; groups: string }[]).map((a) => { const g = JSON.parse(a.groups || "{}"); return { week_start: a.week_start, first_visits: a.first_visits, search: g.search || 0, ai: g.ai || 0, sns: g.sns || 0, content: g.content || 0, referral: g.referral || 0 }; });
  const rvSelf = await db.prepare("SELECT count_30d, negative_30d, replied_30d, treatments, complaints, avg_len, long_count, photo_count FROM review_stats WHERE hospital_id = ? AND platform = 'naver_place' AND entity_type = 'self' ORDER BY stat_date DESC LIMIT 1").bind(hospitalId).first<{ count_30d: number; negative_30d: number; replied_30d: number; treatments: string; complaints: string; avg_len: number | null; long_count: number; photo_count: number }>();
  let reviewNote: string | null = null;
  if (rvSelf) { const tt = (Object.entries(JSON.parse(rvSelf.treatments || "{}")) as [string, number][]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(", "); reviewNote = `최근 리뷰 ${rvSelf.count_30d}건 분석: 평균 ${rvSelf.avg_len ?? "—"}자, 100자 이상 ${rvSelf.long_count}건, 사진 ${rvSelf.photo_count}건, 부정 신호 ${rvSelf.negative_30d}건, 답글 ${rvSelf.replied_30d}건${tt ? `, 많이 언급된 진료 ${tt}` : ""}.`; }
  const soc = (await db.prepare("SELECT platform, followers, views_30d, snapshot_date FROM reputation_snapshots WHERE hospital_id = ? AND entity_type = 'self' AND (platform LIKE 'youtube:%' OR platform IN ('instagram','threads')) AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 30").bind(hospitalId, next7(week)).all()).results as { platform: string; followers: number | null; views_30d: number | null }[];
  const seenP = new Set<string>(); const content: ReportContent["content"] = [];
  for (const x of soc) { if (seenP.has(x.platform)) continue; seenP.add(x.platform); content.push({ label: x.platform.startsWith("youtube:") ? "유튜브" : ({ instagram: "인스타그램", threads: "스레드" } as Record<string, string>)[x.platform], followers: x.followers, views: x.views_30d }); }
  const next = new Date(week + "T00:00:00Z"); next.setUTCDate(next.getUTCDate() + 7);
  return { week, hospital: h.name, reviewNote, content, arrivals, opportunity, total, prevTotal, weighted: cur.find((r) => r.platform === "total")?.weighted_score ?? null, delta: total != null && prevTotal != null ? Math.round((total - prevTotal) * 10) / 10 : null, platforms, up: up.slice(0, 3), down: down.slice(0, 3), reputation, alerts, notes, nextRun: next.toISOString().slice(0, 10) };
}

export function reportToText(r: ReportContent): string {
  const l: string[] = [];
  l.push(`${r.hospital} 주간 가시성 리포트 (${r.week} 주)`);
  l.push(`온라인 가시성 점수: ${r.total ?? "—"}${r.delta != null ? ` (${r.delta >= 0 ? "+" : ""}${r.delta})` : ""}`);
  if (r.weighted != null) l.push(`수요 가중 점수(검색량 반영): ${r.weighted}`);
  if (r.opportunity) {
    const o = r.opportunity;
    l.push(""); l.push(`검색 기회 (네이버 플레이스): 월 ${o.pool.toLocaleString()}회 검색 중 우리가 보인 기회 ${o.captured.toLocaleString()}회 (${o.coverage != null ? Math.round(o.coverage * 100) + "%" : "—"}${o.prevCoverage != null && o.coverage != null ? `, 지난주 ${Math.round(o.prevCoverage * 100)}%` : ""})`);
    l.push("놓친 기회 순위");
    for (const x of o.lost) l.push(`- ${x.keyword} · 월 ${x.volume.toLocaleString()}회 · 우리 ${x.rank ?? "미노출"}${x.rank ? "위" : ""} · 놓침 ${x.lost.toLocaleString()}회${x.gainNext > 0 ? ` · 한 계단 오르면 +${x.gainNext.toLocaleString()}` : ""}${x.above.length ? ` · 위: ${x.above.join(", ")}` : ""}`);
    for (const x of o.lost.slice(0, 3)) if (x.actions?.length) { l.push(`  → ${x.keyword}: ${x.actions[0]}`); }
    if (r.reviewNote) { l.push(""); l.push("리뷰: " + r.reviewNote); }
    if (r.content?.length) { l.push(""); l.push("콘텐츠 도달 (최근 30일): " + r.content.map((x) => `${x.label} 구독·팔로워 ${x.followers?.toLocaleString() ?? "—"} · 조회 ${x.views?.toLocaleString() ?? "—"}`).join(" / ")); }
    if (r.arrivals?.length) { l.push(""); l.push("실제 신환 경로 (페이션트 폼, 최근 주)"); for (const a of r.arrivals) l.push(`- ${a.week_start} 주: 신환 ${a.first_visits} · 검색 ${a.search} · AI ${a.ai} · SNS ${a.sns} · 콘텐츠 ${a.content} · 소개 ${a.referral}`); }
    if (o.competitors.length) l.push("경쟁 병원이 잡은 기회: " + o.competitors.map((c) => `${c.name} ${c.captured.toLocaleString()}회`).join(" · "));
  }
  l.push("");
  l.push("플랫폼별");
  for (const p of r.platforms) l.push(`- ${p.label}: ${p.score}${p.prev != null ? ` (지난주 ${p.prev})` : ""}${p.sov != null ? ` · 점유율 ${Math.round(p.sov * 100)}%` : ""}`);
  if (r.up.length) { l.push(""); l.push("올라간 키워드"); for (const k of r.up) l.push(`- ${k.keyword} (${k.platform}) ${k.from ?? "—"}위 → ${k.to ?? "—"}위`); }
  if (r.down.length) { l.push(""); l.push("내려간 키워드"); for (const k of r.down) l.push(`- ${k.keyword} (${k.platform}) ${k.from ?? "—"}위 → ${k.to ?? "—"}위`); }
  if (r.reputation.length) { l.push(""); l.push("평판"); for (const x of r.reputation) l.push(`- ${x.entity} · ${x.platform} 리뷰 ${x.reviews ?? "—"}${x.prevReviews != null && x.reviews != null ? ` (${x.reviews - x.prevReviews >= 0 ? "+" : ""}${x.reviews - x.prevReviews})` : ""}`); }
  if (r.alerts.length) { l.push(""); l.push("경보"); for (const a of r.alerts) l.push(`- [${a.severity}] ${a.message}`); }
  if (r.notes.length) { l.push(""); for (const n of r.notes) l.push(`※ ${n}`); }
  l.push(""); l.push(`다음 측정 예정: ${r.nextRun} 주`);
  return l.join("\n");
}

export async function sendMail(env: Bindings, to: string[], subject: string, text: string, html?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: "MAIL_NOT_CONFIGURED" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || "Patient Radar <radar@patientsignal.kr>", to, subject, text, html }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok || !j.id) return { ok: false, error: j.message || `HTTP_${res.status}` };
  return { ok: true, id: j.id };
}

export async function sendOpsAlert(env: Bindings, subject: string, text: string) {
  if (!env.OPS_EMAIL) return { ok: false, error: "OPS_EMAIL_NOT_SET" };
  return sendMail(env, [env.OPS_EMAIL], `[레이더 운영] ${subject}`, `${text}\n\n${kstIso()}`);
}
