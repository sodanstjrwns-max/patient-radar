// 측정 오케스트레이터 — 병원 1곳의 하루 측정 = crawl_run 1건(재개 가능).
// 크론 워커는 batch 단위로 여러 번 호출하고, 남은 키워드가 없을 때 마무리(평판·시그널·주간 점수·경보)한다.
// 원칙: 미노출도 저장(shown=0, rank NULL) · 키 없는 플랫폼은 미측정(분모 제외) · 월 상한은 날짜 수 · 차단 시 즉시 중단.
import type { Bindings } from "./config";
import { platformAvailability } from "./config";
import { kstDate, kstIso, weekStart } from "./time";
import { rankScore, platformScore, totalScore, type KeywordObs } from "./scoring";
import { limitsOf } from "./plan-limits";
import type { Entity } from "../collectors/types";
import { htmlSerp, htmlPlace, NaverBlockedError } from "../collectors/naver-html";
import { collectNaverApi } from "../collectors/naver-api";
import { collectGoogleSerp, collectGooglePlaces } from "../collectors/google";
import { collectKakao } from "../collectors/kakao";
import { fetchSignalScore } from "../collectors/signal";
import { fetchVolumes } from "../collectors/naver-searchad";
import { computeOpportunity, type KeywordRow } from "./opportunity";
import { prescribe } from "./playbook";
import { fetchArrivalStats } from "../collectors/form";
import { collectYoutube } from "../collectors/youtube";
import { collectInstagram, collectThreads, instagramRefresh, threadsRefresh } from "../collectors/meta";
import { decryptToken, encryptToken } from "./crypto";
import { collectNaverReviews } from "../collectors/naver-reviews";
import { analyzeReview, isNegative } from "./review-analysis";
import { localityCandidates } from "./keywords";
import type { HospitalRow } from "./session";

export type RunKind = "first" | "weekly" | "manual";
export type RunOptions = {
  kind: RunKind;
  batch?: number;                 // 이번 호출에서 처리할 키워드 수 (기본 전부)
  finalizeEarly?: boolean;        // 남은 키워드가 있어도 마무리(첫 측정 5개 미리보기)
  delayMs?: () => number;
  fetchImpl?: typeof fetch;
  onProgress?: (line: string) => void;
};
export type PlatformSummary = Record<string, { score: number | null; sov: number | null; shown: number }>;
export type RunResult =
  | { ok: true; done: true; runId: number; keywords: number; remaining: 0; platforms: PlatformSummary; total: number | null; weekStart: string; blocked: boolean }
  | { ok: true; done: false; runId: number; processed: number; remaining: number }
  | { ok: false; skipped?: "monthly_limit" | "already_ran_today" | "no_keywords" | "no_platform" | "paused"; blocked?: boolean; error?: string; runId?: number };

export type EntityX = Entity & { website?: string | null; googlePlaceId?: string | null; kakaoPlaceId?: string | null; competitorId: number | null };
type Obs = { platform: string; entityKey: string; shown: boolean; rank: number | null; section: string | null; detail: Record<string, unknown> };

export const SCORE_PLATFORM: Record<string, string> = { naver_serp: "naver_serp", naver_place: "naver_place", google_serp: "google", kakao_map: "kakao" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const parseJsonArr = (s: string | null | undefined): string[] => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

/** 관측치 → 키워드 점수 (저장된 관측치에서 언제든 다시 계산할 수 있어야 한다) */
export function obsScore(platform: string, shown: number | boolean, rank: number | null, detail: Record<string, unknown> | string | null): number {
  const d: Record<string, unknown> = typeof detail === "string" ? (() => { try { return JSON.parse(detail); } catch { return {}; } })() : detail || {};
  const adOnly = !!d.placeAd && rank == null && !shown;
  if (platform === "naver_place") return rankScore(rank, false, adOnly);
  return rankScore(rank, !!shown && rank == null, adOnly);
}

export async function loadEntities(db: D1Database, h: HospitalRow, maxCompetitors = 99): Promise<EntityX[]> {
  const comps = (await db.prepare("SELECT id, name, name_aliases, naver_place_id, google_place_id, kakao_place_id, website_url FROM competitors WHERE hospital_id = ? AND is_active = 1 ORDER BY id LIMIT ?").bind(h.id, maxCompetitors).all()).results as Record<string, string | number | null>[];
  const self: EntityX = { key: "self", name: h.name, aliases: parseJsonArr(h.name_aliases), placeId: h.naver_place_id, website: h.website_url, googlePlaceId: h.google_place_id, kakaoPlaceId: h.kakao_place_id, competitorId: null };
  return [self, ...comps.map((c) => ({ key: `c${c.id}`, name: String(c.name), aliases: parseJsonArr(c.name_aliases as string), placeId: c.naver_place_id as string | null, website: c.website_url as string | null, googlePlaceId: c.google_place_id as string | null, kakaoPlaceId: c.kakao_place_id as string | null, competitorId: Number(c.id) }))];
}

/** 이번 달 수집한 날짜 수(잡 개수 아님). weekly 종류만 상한에 센다. */
export async function monthlyRunDays(db: D1Database, hospitalId: number, month: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(DISTINCT run_date) AS n FROM crawl_runs WHERE hospital_id = ? AND status = 'completed' AND kind = 'weekly' AND substr(run_date,1,7) = ?").bind(hospitalId, month).first<{ n: number }>();
  return r?.n ?? 0;
}

export function usablePlatforms(env: Bindings, h: HospitalRow) {
  const avail = platformAvailability(env);
  const limits = limitsOf(h.plan);
  return {
    naver: avail.naver && limits.platforms.includes("naver"),
    naverMode: avail.naverMode,
    google: avail.google && limits.platforms.includes("google"),
    googlePlaces: avail.googlePlaces && limits.platforms.includes("google"),
    kakao: avail.kakao && limits.platforms.includes("kakao"),
    signal: avail.signal && limits.platforms.includes("signal") && !!h.ps_hospital_id,
  };
}

export async function runHospital(env: Bindings, h: HospitalRow, opts: RunOptions): Promise<RunResult> {
  const db = env.DB;
  const limits = limitsOf(h.plan);
  const use = usablePlatforms(env, h);
  const fetchImpl = opts.fetchImpl || fetch;
  const delay = opts.delayMs || (() => 3000 + Math.random() * 4000);
  const log = opts.onProgress || (() => {});
  const runDate = kstDate();
  const week = weekStart();
  if (!use.naver && !use.google && !use.kakao && !use.signal) return { ok: false, skipped: "no_platform" };
  const pause = await db.prepare("SELECT reason FROM collection_pauses WHERE scope = 'naver' AND until_date >= ?").bind(runDate).first<{ reason: string }>();
  const naverPaused = !!pause;
  if (naverPaused && !use.google && !use.kakao && !use.signal) return { ok: false, skipped: "paused" };

  // ── 오늘의 run 찾기/만들기 (하루 1건)
  let run = await db.prepare("SELECT id, status, kind FROM crawl_runs WHERE hospital_id = ? AND run_date = ?").bind(h.id, runDate).first<{ id: number; status: string; kind: string }>();
  if (run && run.status !== "running") {
    if (opts.kind === "manual") {
      await db.batch([db.prepare("DELETE FROM observations WHERE run_id = ?").bind(run.id), db.prepare("DELETE FROM crawl_runs WHERE id = ?").bind(run.id)]);
      run = null;
    } else return { ok: false, skipped: "already_ran_today", runId: run.id };
  }
  if (!run) {
    if (opts.kind === "weekly" && (await monthlyRunDays(db, h.id, runDate.slice(0, 7))) >= limits.monthlyRunDays) return { ok: false, skipped: "monthly_limit" };
    const planned = [use.naver && !naverPaused ? `naver:${use.naverMode}` : null, use.google ? "google" : null, use.googlePlaces ? "google_places" : null, use.kakao ? "kakao" : null, use.signal ? "signal" : null].filter(Boolean);
    const ins = await db.prepare("INSERT INTO crawl_runs (hospital_id, run_date, platforms, kind, started_at) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(h.id, runDate, JSON.stringify(planned), opts.kind, kstIso()).first<{ id: number }>();
    run = { id: ins!.id, status: "running", kind: opts.kind };
  }
  const runId = run.id;

  const all = (await db.prepare("SELECT id, text FROM keywords WHERE hospital_id = ? AND is_active = 1 ORDER BY sort_order, id LIMIT ?").bind(h.id, limits.keywords).all()).results as { id: number; text: string }[];
  if (!all.length) { await db.prepare("UPDATE crawl_runs SET status = 'failed', finished_at = ?, error = 'no_keywords' WHERE id = ?").bind(kstIso(), runId).run(); return { ok: false, skipped: "no_keywords", runId }; }
  const done = new Set(((await db.prepare("SELECT DISTINCT keyword_id FROM observations WHERE run_id = ? AND entity_type = 'self'").bind(runId).all()).results as { keyword_id: number }[]).map((r) => r.keyword_id));
  const pending = all.filter((k) => !done.has(k.id));
  const batch = opts.batch && opts.batch > 0 ? pending.slice(0, opts.batch) : pending;
  const entities = await loadEntities(db, h, limits.competitors);
  const errors: string[] = [];
  let blocked = false;

  try {
    for (const kw of batch) {
      const obs: Obs[] = [];
      if (use.naver && !naverPaused && !blocked) {
        try {
          if (use.naverMode === "html") {
            const r = await htmlSerp(kw.text, entities, fetchImpl);
            for (const e of entities) {
              const m = r.entities[e.key];
              const organic = r.placeCards.filter((c) => !c.isAd);
              obs.push({ platform: "naver_serp", entityKey: e.key, shown: m.shown, rank: m.placeRank, section: m.placeRank ? "place" : m.aiBriefingMentioned ? "ai_briefing" : m.mentions ? "other" : null, detail: { placeAd: m.placeAd, mentions: m.mentions, aib: m.aiBriefingMentioned, sections: r.sections, blockSize: organic.length, adCards: r.placeCards.length - organic.length, top5: organic.slice(0, 5).map((c) => c.name) } });
              obs.push({ platform: "naver_place", entityKey: e.key, shown: m.placeRank != null, rank: m.placeRank, section: m.placeRank ? "place" : null, detail: { placeAd: m.placeAd, blockSize: organic.length } });
            }
            await sleep(delay());
          } else {
            const r = await collectNaverApi(kw.text, entities, { NAVER_CLIENT_ID: env.NAVER_CLIENT_ID!, NAVER_CLIENT_SECRET: env.NAVER_CLIENT_SECRET! }, fetchImpl);
            for (const e of entities) {
              const m = r.entities[e.key];
              const elsewhere = m.blog || m.cafe;
              obs.push({ platform: "naver_serp", entityKey: e.key, shown: m.localRank != null || elsewhere, rank: m.localRank, section: m.localRank ? "place" : m.blog ? "blog" : m.cafe ? "cafe" : null, detail: { blogHits: r.blogHits[e.key], cafeHits: r.cafeHits[e.key], top5: r.local.map((x) => x.name), source: "naver_api" } });
              obs.push({ platform: "naver_place", entityKey: e.key, shown: m.localRank != null, rank: m.localRank, section: m.localRank ? "place" : null, detail: { source: "naver_api", top5only: true, blockSize: 5 } });
            }
            await sleep(300);
          }
          log(`${kw.text} · 네이버 플레이스 ${(() => { const r = obs.find((o) => o.platform === "naver_place" && o.entityKey === "self")?.rank; return r == null ? "미노출" : r + "위"; })()}`);
        } catch (e) {
          if (e instanceof NaverBlockedError) { blocked = true; errors.push(`naver blocked ${e.status}`); log(`${kw.text} · 네이버 차단 감지, 중단`); }
          else { errors.push(`naver ${String(e).slice(0, 80)}`); log(`${kw.text} · 네이버 오류`); }
        }
      }
      if (use.google) {
        try {
          const r = await collectGoogleSerp(kw.text, entities, { GOOGLE_CSE_KEY: env.GOOGLE_CSE_KEY!, GOOGLE_CSE_CX: env.GOOGLE_CSE_CX! }, fetchImpl);
          for (const e of entities) obs.push({ platform: "google_serp", entityKey: e.key, shown: r.entities[e.key].rank != null, rank: r.entities[e.key].rank, section: r.entities[e.key].rank ? "organic" : null, detail: { top: r.items.slice(0, 5).map((x) => x.title) } });
          log(`${kw.text} · 구글 ${r.entities.self.rank ?? "—"}위`);
        } catch (e) { errors.push(`google ${String(e).slice(0, 80)}`); }
      }
      if (use.googlePlaces) {
        try {
          const r = await collectGooglePlaces(kw.text, entities, { GOOGLE_PLACES_KEY: env.GOOGLE_PLACES_KEY! }, fetchImpl);
          for (const e of entities) {
            const m = r.entities[e.key];
            obs.push({ platform: "google_business", entityKey: e.key, shown: m.rank != null, rank: m.rank, section: m.rank ? "map_pack" : null, detail: { proxy: true, rating: m.rating, ratingCount: m.ratingCount, placeId: m.placeId, top: r.places.slice(0, 5).map((x) => x.name) } });
          }
        } catch (e) { errors.push(`places ${String(e).slice(0, 80)}`); }
      }
      if (use.kakao) {
        try {
          const r = await collectKakao(kw.text, entities, { KAKAO_REST_KEY: env.KAKAO_REST_KEY! }, fetchImpl);
          for (const e of entities) obs.push({ platform: "kakao_map", entityKey: e.key, shown: r.entities[e.key].rank != null, rank: r.entities[e.key].rank, section: r.entities[e.key].rank ? "list" : null, detail: { top: r.places.slice(0, 5).map((x) => x.name) } });
          log(`${kw.text} · 카카오맵 ${r.entities.self.rank ?? "—"}위`);
        } catch (e) { errors.push(`kakao ${String(e).slice(0, 80)}`); }
      }
      if (obs.length) {
        const stmts = obs.map((o) => {
          const ent = entities.find((e) => e.key === o.entityKey)!;
          return db.prepare("INSERT OR REPLACE INTO observations (run_id, hospital_id, keyword_id, platform, entity_type, entity_id, shown, rank, section, detail, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind(runId, h.id, kw.id, o.platform, o.entityKey === "self" ? "self" : "competitor", ent.competitorId, o.shown ? 1 : 0, o.rank, o.section, JSON.stringify(o.detail), kstIso());
        });
        for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
      }
      if (blocked) break;
    }

    const remaining = blocked ? 0 : pending.length - batch.length;
    if (remaining > 0 && !opts.finalizeEarly) return { ok: true, done: false, runId, processed: batch.length, remaining };

    // ── 마무리: 평판 스냅샷 · 시그널 반입 · 주간 점수 · 경보
    const reputation: { entityKey: string; platform: string; review_count: number | null; blog_review_count: number | null; rating: number | null; detail: Record<string, unknown> }[] = [];
    if (use.naver && use.naverMode === "html" && !naverPaused && !blocked) {
      for (const e of entities) {
        if (!e.placeId) continue;
        try {
          const p = await htmlPlace(e.placeId, fetchImpl);
          reputation.push({ entityKey: e.key, platform: "naver_place", review_count: p.visitorReviews, blog_review_count: p.blogReviews, rating: null, detail: { name: p.name, category: p.category } });
          log(`${e.name} · 방문자리뷰 ${p.visitorReviews ?? "—"} · 블로그리뷰 ${p.blogReviews ?? "—"}`);
          await sleep(2000);
        } catch (err) {
          if (err instanceof NaverBlockedError) { blocked = true; break; }
          errors.push(`place ${String(err).slice(0, 60)}`);
        }
      }
    }
    if (use.googlePlaces) {
      const gb = (await db.prepare("SELECT entity_type, entity_id, detail FROM observations WHERE run_id = ? AND platform = 'google_business' AND shown = 1").bind(runId).all()).results as { entity_type: string; entity_id: number | null; detail: string }[];
      const seen = new Set<string>();
      for (const g of gb) {
        const key = g.entity_type === "self" ? "self" : `c${g.entity_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = JSON.parse(g.detail || "{}");
        reputation.push({ entityKey: key, platform: "google_business", review_count: d.ratingCount ?? null, blog_review_count: null, rating: d.rating ?? null, detail: { placeId: d.placeId } });
      }
    }
    for (const r of reputation) {
      const ent = entities.find((e) => e.key === r.entityKey);
      if (!ent) continue;
      await db.prepare("INSERT OR REPLACE INTO reputation_snapshots (hospital_id, entity_type, entity_id, platform, snapshot_date, review_count, blog_review_count, rating, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(h.id, r.entityKey === "self" ? "self" : "competitor", ent.competitorId, r.platform, runDate, r.review_count, r.blog_review_count, r.rating, JSON.stringify(r.detail), kstIso()).run();
    }
    // ── 검색량 갱신 (30일 지난 것만, 검색광고 API 키 있을 때)
    if (platformAvailability(env).searchVolume) {
      try {
        const stale = (await db.prepare("SELECT id, text FROM keywords WHERE hospital_id = ? AND is_active = 1 AND (volume_updated_at IS NULL OR volume_updated_at < ?)").bind(h.id, new Date(Date.now() - 30 * 86400_000).toISOString()).all()).results as { id: number; text: string }[];
        if (stale.length) {
          const vols = await fetchVolumes(stale.map((k) => k.text), { NAVER_SEARCHAD_KEY: env.NAVER_SEARCHAD_KEY!, NAVER_SEARCHAD_SECRET: env.NAVER_SEARCHAD_SECRET!, NAVER_SEARCHAD_CUSTOMER: env.NAVER_SEARCHAD_CUSTOMER! }, fetchImpl);
          await db.batch(vols.map((v, i) => db.prepare("UPDATE keywords SET monthly_pc = ?, monthly_mobile = ?, volume_low = ?, volume_updated_at = ? WHERE id = ?").bind(v.found ? v.pc : 0, v.found ? v.mobile : 0, v.low ? 1 : 0, kstIso(), stale[i].id)));
          log(`검색량 갱신 ${vols.length}개`);
        }
      } catch (e) { errors.push(`searchad ${String(e).slice(0, 60)}`); }
    }
    let signalScore: number | null = null;
    if (use.signal) {
      try { signalScore = (await fetchSignalScore(h.ps_hospital_id!, { SIGNAL_API_URL: env.SIGNAL_API_URL!, SIGNAL_API_KEY: env.SIGNAL_API_KEY! }, fetchImpl)).score; }
      catch (e) { errors.push(`signal ${String(e).slice(0, 60)}`); }
    }
    // ── 리뷰 본문(네이버 방문자 리뷰, 본원+경쟁사) → 분석·통계·부정 리뷰 경보
    if (use.naver && use.naverMode === "html" && !naverPaused && !blocked) {
      try { const r = await syncReviews(env, h, entities, fetchImpl); log(`리뷰 ${r.fetched}건 확인 · 새 리뷰 ${r.inserted}건 · 부정 ${r.negative}건`); } catch (e) { errors.push(`reviews ${String(e).slice(0, 60)}`); }
    }
    // ── 콘텐츠 도달(3층): 유튜브·인스타·스레드 스냅샷
    try { const r = await syncSocial(env, h, fetchImpl); for (const line of r) log(line); } catch (e) { errors.push(`social ${String(e).slice(0, 60)}`); }
    // ── 페이션트 폼 내원경로 반입(병원별 키가 있을 때, 최근 8주)
    try { await syncArrivals(env, h.id, fetchImpl); } catch (e) { errors.push(`form ${String(e).slice(0, 60)}`); }
    const { platforms, total } = await computeWeeklyScores(db, h.id, runId, week, signalScore);
    try { await computeOpportunities(db, h.id, runId, week); } catch (e) { errors.push(`opportunity ${String(e).slice(0, 60)}`); }
    const status = blocked ? "blocked" : "completed";
    await db.prepare("UPDATE crawl_runs SET status = ?, finished_at = ?, error = ?, summary = ? WHERE id = ?")
      .bind(status, kstIso(), errors.length ? errors.join("; ").slice(0, 500) : null, JSON.stringify({ total, platforms, keywords: all.length - remaining, competitors: entities.length - 1 }), runId).run();
    if (blocked) {
      await db.prepare("INSERT INTO alerts (hospital_id, severity, code, message, detail, created_at) VALUES (?,?,?,?,?,?)").bind(h.id, "critical", "naver_blocked", "네이버 차단 감지로 오늘 수집을 중단했습니다.", JSON.stringify({ runId }), kstIso()).run();
      await db.prepare("INSERT INTO collection_pauses (scope, until_date, reason, updated_at) VALUES ('naver', ?, 'blocked', ?) ON CONFLICT(scope) DO UPDATE SET until_date = excluded.until_date, reason = excluded.reason, updated_at = excluded.updated_at").bind(runDate, kstIso()).run();
    }
    await evaluateAlerts(db, h.id, week);
    return { ok: true, done: true, runId, keywords: all.length - remaining, remaining: 0, platforms, total, weekStart: week, blocked };
  } catch (e) {
    await db.prepare("UPDATE crawl_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").bind(kstIso(), String(e).slice(0, 500), runId).run();
    return { ok: false, error: String(e).slice(0, 200), runId };
  }
}

/** run 의 관측치 전체에서 플랫폼 점수·SOV·통합 점수를 계산해 weekly_scores 에 쓴다 */
export async function computeWeeklyScores(db: D1Database, hospitalId: number, runId: number, week: string, signalScore: number | null) {
  const obs = (await db.prepare("SELECT o.platform, o.entity_type, o.entity_id, o.shown, o.rank, o.detail, k.text, k.monthly_pc, k.monthly_mobile FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ?").bind(runId).all()).results as { platform: string; entity_type: string; entity_id: number | null; shown: number; rank: number | null; detail: string; text: string; monthly_pc: number | null; monthly_mobile: number | null }[];
  // 키워드별 월 검색수 (없으면 null → 가중 점수 계산에서 제외)
  const volume: Record<string, number | null> = {};
  for (const o of obs) volume[o.text] = o.monthly_pc == null && o.monthly_mobile == null ? null : (o.monthly_pc ?? 0) + (o.monthly_mobile ?? 0);
  const compKeys = [...new Set(obs.filter((o) => o.entity_type === "competitor").map((o) => `c${o.entity_id}`))];
  const rows: Record<string, KeywordObs[]> = {};
  // 구글 자연검색(CSE)이 없으면 비즈니스 프로필(Places) 순위를 구글 점수로 쓴다 (2026-09-23: CSE 전체 웹 검색 지원 중단)
  const hasSerp = obs.some((o) => o.platform === "google_serp");
  for (const o of obs) {
    const sp = o.platform === "google_business" && !hasSerp ? "google" : SCORE_PLATFORM[o.platform];
    if (!sp) continue;
    rows[sp] ||= [];
    let row = rows[sp].find((r) => r.keyword === o.text);
    if (!row) { row = { keyword: o.text, self: 0, competitors: Object.fromEntries(compKeys.map((k) => [k, 0])) }; rows[sp].push(row); }
    const s = obsScore(o.platform, o.shown, o.rank, o.detail);
    if (o.entity_type === "self") row.self = s; else row.competitors[`c${o.entity_id}`] = s;
  }
  const platforms: PlatformSummary = {};
  for (const [p, list] of Object.entries(rows)) platforms[p] = platformScore(list);
  if (signalScore != null) platforms.signal_ai = { score: signalScore, sov: null, shown: 0 };
  const total = totalScore(Object.fromEntries(Object.entries(platforms).map(([p, v]) => [p, v.score])));
  // 수요 가중 점수: Σ(키워드 점수 × 월 검색수) ÷ Σ(월 검색수). 검색수 없는 키워드는 제외, 전부 없으면 null.
  const weighted: Record<string, number | null> = {};
  for (const [p, list] of Object.entries(rows)) {
    let num = 0, den = 0;
    for (const r of list) { const v = volume[r.keyword]; if (v == null) continue; const w = Math.max(v, 10); num += r.self * w; den += w; }
    weighted[p] = den ? Math.round((num / den) * 10) / 10 : null;
  }
  if (signalScore != null) weighted.signal_ai = signalScore;
  const totalWeighted = Object.values(weighted).some((v) => v != null) ? totalScore(weighted) : null;
  const stmts = Object.entries(platforms).map(([p, v]) =>
    db.prepare("INSERT OR REPLACE INTO weekly_scores (hospital_id, week_start, platform, score, sov, keyword_count, shown_count, detail, weighted_score, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(hospitalId, week, p, v.score ?? 0, v.sov, rows[p]?.length ?? 0, v.shown, JSON.stringify({ runId }), weighted[p] ?? null, kstIso()));
  if (total != null) stmts.push(db.prepare("INSERT OR REPLACE INTO weekly_scores (hospital_id, week_start, platform, score, sov, keyword_count, shown_count, detail, weighted_score, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(hospitalId, week, "total", total, platforms.naver_place?.sov ?? platforms.naver_serp?.sov ?? platforms.google?.sov ?? null, rows.naver_serp?.length ?? rows.google?.length ?? 0, platforms.naver_serp?.shown ?? platforms.google?.shown ?? 0, JSON.stringify({ runId, platforms: Object.keys(platforms) }), totalWeighted, kstIso()));
  if (stmts.length) await db.batch(stmts);
  return { platforms, total };
}

/** 주간 경보: 총점 −15 이상 하락, 키워드 1위→5위 밖 */
export async function evaluateAlerts(db: D1Database, hospitalId: number, week: string) {
  const cur = await db.prepare("SELECT score FROM weekly_scores WHERE hospital_id = ? AND week_start = ? AND platform = 'total'").bind(hospitalId, week).first<{ score: number }>();
  const prev = await db.prepare("SELECT score, week_start FROM weekly_scores WHERE hospital_id = ? AND week_start < ? AND platform = 'total' ORDER BY week_start DESC LIMIT 1").bind(hospitalId, week).first<{ score: number; week_start: string }>();
  const add = async (severity: string, code: string, message: string, detail: Record<string, unknown>) => {
    const dup = await db.prepare("SELECT id FROM alerts WHERE hospital_id = ? AND code = ?").bind(hospitalId, code).first();
    if (!dup) await db.prepare("INSERT INTO alerts (hospital_id, severity, code, message, detail, created_at) VALUES (?,?,?,?,?,?)").bind(hospitalId, severity, code, message, JSON.stringify(detail), kstIso()).run();
  };
  if (cur && prev && prev.score - cur.score >= 15) await add("warn", `score_drop:${week}`, `온라인 가시성 점수가 전주 대비 ${Math.round(prev.score - cur.score)}점 내렸습니다 (${prev.score} → ${cur.score}).`, { prev: prev.week_start });
  // 키워드 1위 → 5위 밖 (플레이스)
  const runs = (await db.prepare("SELECT id, run_date FROM crawl_runs WHERE hospital_id = ? AND status IN ('completed','blocked') ORDER BY run_date DESC LIMIT 2").bind(hospitalId).all()).results as { id: number; run_date: string }[];
  if (runs.length === 2 && runs[0].run_date >= week && runs[1].run_date < week) {
    const q = "SELECT o.rank, k.id AS kid, k.text FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? AND o.entity_type = 'self' AND o.platform = 'naver_place'";
    const a = (await db.prepare(q).bind(runs[0].id).all()).results as { rank: number | null; kid: number; text: string }[];
    const b = (await db.prepare(q).bind(runs[1].id).all()).results as { rank: number | null; kid: number; text: string }[];
    for (const x of a) {
      const y = b.find((z) => z.kid === x.kid);
      if (y && y.rank === 1 && (x.rank == null || x.rank > 5)) await add("warn", `rank_drop:${week}:${x.kid}`, `「${x.text}」 플레이스 1위에서 5위 밖으로 내려갔습니다.`, { from: 1, to: x.rank });
    }
  }
}

/** 검색 기회 집계: 플랫폼별(네이버 플레이스·구글·카카오) 수요 풀, 잡은 기회, 놓친 기회 순위, 경쟁사 기회 점유 */
export async function computeOpportunities(db: D1Database, hospitalId: number, runId: number, week: string) {
  const obs = (await db.prepare("SELECT o.platform, o.entity_type, o.entity_id, o.shown, o.rank, o.detail, k.text, k.monthly_pc, k.monthly_mobile FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? AND o.platform IN ('naver_place','google_business','google_serp','kakao_map')").bind(runId).all()).results as { platform: string; entity_type: string; entity_id: number | null; shown: number; rank: number | null; detail: string | null; text: string; monthly_pc: number | null; monthly_mobile: number | null }[];
  if (!obs.length) return;
  const names: Record<string, string> = {};
  for (const c of (await db.prepare("SELECT id, name FROM competitors WHERE hospital_id = ?").bind(hospitalId).all()).results as { id: number; name: string }[]) names[`c${c.id}`] = c.name;
  const hasSerp = obs.some((o) => o.platform === "google_serp");
  const byPlat: Record<string, Map<string, KeywordRow>> = {};
  for (const o of obs) {
    const p = o.platform === "naver_place" ? "naver_place" : o.platform === "kakao_map" ? "kakao" : o.platform === "google_serp" || (o.platform === "google_business" && !hasSerp) ? "google" : null;
    if (!p) continue;
    byPlat[p] ||= new Map();
    let row = byPlat[p].get(o.text);
    if (!row) { row = { keyword: o.text, volume: o.monthly_pc == null && o.monthly_mobile == null ? null : (o.monthly_pc ?? 0) + (o.monthly_mobile ?? 0), blockSize: null, self: { rank: null, shown: false }, competitors: {} }; byPlat[p].set(o.text, row); }
    if (o.entity_type === "self") row.self = { rank: o.rank, shown: !!o.shown };
    else row.competitors[`c${o.entity_id}`] = { rank: o.rank, shown: !!o.shown, name: names[`c${o.entity_id}`] || "경쟁사" };
    if (p === "naver_place" && row.blockSize == null) row.blockSize = blockSizeOf(o.detail);
  }
  // 처방 재료: 통합검색 상세(섹션·언급), 평판(리뷰 수), 지역명
  const hosp = await db.prepare("SELECT region_sido, region_sigungu, region_dong FROM hospitals WHERE id = ?").bind(hospitalId).first<{ region_sido: string | null; region_sigungu: string | null; region_dong: string | null }>();
  const locs = localityCandidates([hosp?.region_sido, hosp?.region_sigungu, hosp?.region_dong].filter(Boolean).join(" "));
  const serp = (await db.prepare("SELECT k.text, o.detail FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? AND o.platform = 'naver_serp' AND o.entity_type = 'self'").bind(runId).all()).results as { text: string; detail: string }[];
  const serpMap = new Map(serp.map((r) => [r.text, (() => { try { return JSON.parse(r.detail || "{}"); } catch { return {}; } })() as Record<string, unknown>]));
  const rep = (await db.prepare("SELECT entity_type, entity_id, review_count, blog_review_count FROM reputation_snapshots WHERE hospital_id = ? AND platform = 'naver_place' AND snapshot_date = (SELECT MAX(snapshot_date) FROM reputation_snapshots WHERE hospital_id = ? AND platform = 'naver_place')").bind(hospitalId, hospitalId).all()).results as { entity_type: string; entity_id: number | null; review_count: number | null; blog_review_count: number | null }[];
  const repOf = (key: string) => rep.find((r) => (r.entity_type === "self" ? "self" : `c${r.entity_id}`) === key);
  const termOf = (kw: string) => { let t = kw; for (const l of locs) t = t.replace(l, ""); return t.replace(/\s+/g, " ").trim() || kw; };
  const stmts = [];
  for (const [p, m] of Object.entries(byPlat)) {
    const op = computeOpportunity(p, [...m.values()]);
    if (!op.pool) continue;
    const lost = op.lost.slice(0, 20).map((l) => {
      if (p !== "naver_place") return l;
      const row = m.get(l.keyword)!;
      const d = serpMap.get(l.keyword) || {};
      const sections = (d.sections as Record<string, boolean>) || {};
      const above = Object.entries(row.competitors).filter(([, c]) => c.rank != null && (row.self.rank == null || (c.rank as number) < row.self.rank)).sort((a, b) => (a[1].rank as number) - (b[1].rank as number)).map(([k, c]) => ({ name: c.name, rank: c.rank as number, visitorReviews: repOf(k)?.review_count ?? null, blogReviews: repOf(k)?.blog_review_count ?? null }));
      const actions = prescribe({ keyword: l.keyword, term: termOf(l.keyword), placeRank: row.self.rank, blockSize: row.blockSize ?? null, placeAd: !!d.placeAd, mentions: Number(d.mentions || 0), blogSection: !!sections.blog, cafeSection: !!sections.cafe, aib: !!d.aib,
        googleRank: byPlat.google?.get(l.keyword)?.self.rank, kakaoRank: byPlat.kakao?.get(l.keyword)?.self.rank, above, selfVisitorReviews: repOf("self")?.review_count ?? null, selfBlogReviews: repOf("self")?.blog_review_count ?? null });
      return { ...l, actions };
    });
    stmts.push(db.prepare("INSERT OR REPLACE INTO weekly_opportunity (hospital_id, week_start, platform, pool, captured, coverage, detail, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(hospitalId, week, p, op.pool, op.captured, op.coverage ?? 0, JSON.stringify({ lost, competitors: op.competitors }), kstIso()));
  }
  if (stmts.length) await db.batch(stmts);
}

/** 페이션트 폼에서 신환 내원경로 주간 집계를 가져와 weekly_arrivals 에 저장 */
export async function syncArrivals(env: Bindings, hospitalId: number, fetchImpl: typeof fetch = fetch) {
  const st = await env.DB.prepare("SELECT form_api_key FROM hospital_settings WHERE hospital_id = ?").bind(hospitalId).first<{ form_api_key: string | null }>();
  if (!st?.form_api_key) return { skipped: "no_key" };
  const to = kstDate();
  const from = new Date(Date.now() - 63 * 86400_000).toISOString().slice(0, 10);
  const weeks = await fetchArrivalStats(env.FORM_API_URL || "https://form.patientfunnel.kr", st.form_api_key, from, to, fetchImpl);
  if (!weeks.length) return { weeks: 0 };
  await env.DB.batch(weeks.map((w) => env.DB.prepare("INSERT OR REPLACE INTO weekly_arrivals (hospital_id, week_start, first_visits, answered, declined, unanswered, groups, primary_paths, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(hospitalId, w.week_start, w.first_visits, w.answered, w.declined, w.unanswered, JSON.stringify(w.groups || {}), JSON.stringify(w.primary || {}), kstIso())));
  return { weeks: weeks.length };
}

/** 유튜브(공개 API)·인스타·스레드(OAuth 연결분) 30일 스냅샷 → reputation_snapshots(platform youtube|instagram|threads) */
export async function syncSocial(env: Bindings, h: HospitalRow, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = []; const date = kstDate();
  const put = (platform: string, followers: number | null, views30d: number | null, detail: Record<string, unknown>) =>
    env.DB.prepare("INSERT OR REPLACE INTO reputation_snapshots (hospital_id, entity_type, entity_id, platform, snapshot_date, review_count, blog_review_count, rating, save_count, followers, views_30d, detail, created_at) VALUES (?, 'self', NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)")
      .bind(h.id, platform, date, followers, views30d, JSON.stringify(detail), kstIso()).run();
  const channels: { id: string; title: string }[] = (() => { try { const a = JSON.parse(h.youtube_channels || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })();
  if (!channels.length && h.youtube_channel_id) channels.push({ id: h.youtube_channel_id, title: h.youtube_channel_title || "" });
  if (env.YOUTUBE_API_KEY) for (const ch of channels) {
    try { const y = await collectYoutube(ch.id, { YOUTUBE_API_KEY: env.YOUTUBE_API_KEY }, fetchImpl); await put(`youtube:${ch.id}`, y.subscribers, y.views30d, { title: y.title, channelId: ch.id, totalViews: y.totalViews, videoCount: y.videoCount, uploads30d: y.uploads30d, likes30d: y.likes30d, comments30d: y.comments30d, top: y.top }); out.push(`유튜브 ${y.title}: 구독자 ${y.subscribers ?? "—"} · 30일 조회 ${y.views30d.toLocaleString()} (영상 ${y.uploads30d}편)`); }
    catch (e) { out.push(`유튜브 ${ch.title} 오류 ${String(e).slice(0, 40)}`); }
  }
  const nearExpiry = (iso: string | null) => !iso || new Date(iso).getTime() - Date.now() < 7 * 86400_000;
  if (h.ig_user_id && h.ig_token_enc && env.PS_SSO_SECRET) {
    try {
      let tok = await decryptToken(env.PS_SSO_SECRET, h.ig_token_enc);
      if (nearExpiry(h.ig_token_expires_at)) { try { const r = await instagramRefresh(tok, fetchImpl); tok = r.token; await env.DB.prepare("UPDATE hospitals SET ig_token_enc = ?, ig_token_expires_at = ? WHERE id = ?").bind(await encryptToken(env.PS_SSO_SECRET, tok), r.expiresAt, h.id).run(); } catch { /* 갱신 실패 시 기존 토큰으로 시도 */ } }
      const ig = await collectInstagram(h.ig_user_id, tok, fetchImpl); await put("instagram", ig.followers, ig.views30d ?? ig.reach30d, { username: h.ig_username, mediaCount: ig.mediaCount, reach30d: ig.reach30d, views30d: ig.views30d, posts30d: ig.posts30d, top: ig.top }); out.push(`인스타그램 팔로워 ${ig.followers ?? "—"} · 30일 도달 ${ig.reach30d ?? "—"}`); }
    catch (e) { out.push(`인스타그램 오류 ${String(e).slice(0, 40)}`); }
  }
  if (h.threads_user_id && h.threads_token_enc && env.PS_SSO_SECRET) {
    try {
      let tok = await decryptToken(env.PS_SSO_SECRET, h.threads_token_enc);
      if (nearExpiry(h.threads_token_expires_at)) { try { const r = await threadsRefresh(tok, fetchImpl); tok = r.token; await env.DB.prepare("UPDATE hospitals SET threads_token_enc = ?, threads_token_expires_at = ? WHERE id = ?").bind(await encryptToken(env.PS_SSO_SECRET, tok), r.expiresAt, h.id).run(); } catch { /* ignore */ } }
      const th = await collectThreads(h.threads_user_id, tok, fetchImpl); await put("threads", th.followers, th.views30d, { username: h.threads_username, likes30d: th.likes30d, posts30d: th.posts30d }); out.push(`스레드 팔로워 ${th.followers ?? "—"} · 30일 조회 ${th.views30d ?? "—"}`); }
    catch (e) { out.push(`스레드 오류 ${String(e).slice(0, 40)}`); }
  }
  return out;
}

/** 네이버 방문자 리뷰 수집(플레이스 ID 있는 본원·경쟁사) → reviews(중복 제외) → review_stats(30일) → 부정 리뷰 경보 */
export async function syncReviews(env: Bindings, h: HospitalRow, entities: EntityX[], fetchImpl: typeof fetch = fetch) {
  const db = env.DB; const today = kstDate(); const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  let fetched = 0, inserted = 0, negative = 0;
  const newNegatives: { entity: string; body: string; complaints: string[] }[] = [];
  for (const e of entities) {
    if (!e.placeId) continue;
    let list;
    try { list = await collectNaverReviews(e.placeId, fetchImpl); } catch (err) { if (err instanceof NaverBlockedError) throw err; continue; }
    fetched += list.length;
    for (const r of list) {
      const a = analyzeReview(r.body, h.clinic_type);
      const neg = isNegative(null, a.complaints);
      const res = await db.prepare("INSERT OR IGNORE INTO reviews (hospital_id, entity_type, entity_id, platform, review_key, rating, body, reply, visit_count, written_at, treatments, complaints, negative, photo_count, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(h.id, e.key === "self" ? "self" : "competitor", e.competitorId, "naver_place", r.key, null, r.body.slice(0, 2000), r.reply ? r.reply.slice(0, 1000) : null, r.visitCount, r.writtenAt, JSON.stringify(a.treatments), JSON.stringify(a.complaints), neg ? 1 : 0, r.photoCount, kstIso()).run();
      if (res.meta.changes) { inserted++; if (neg) { negative++; if (e.key === "self") newNegatives.push({ entity: e.name, body: r.body.slice(0, 120), complaints: a.complaints }); } }
    }
    // 30일 통계
    const rows = (await db.prepare("SELECT negative, reply, treatments, complaints, body, photo_count FROM reviews WHERE hospital_id = ? AND platform = 'naver_place' AND entity_type = ? AND COALESCE(entity_id, 0) = ? AND written_at >= ?").bind(h.id, e.key === "self" ? "self" : "competitor", e.competitorId ?? 0, since30).all()).results as { negative: number; reply: string | null; treatments: string; complaints: string; body: string; photo_count: number }[];
    const lens = rows.map((r) => r.body.replace(/\s+/g, "").length);
    const avgLen = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : null;
    const longCount = lens.filter((l) => l >= 100).length, photoCount = rows.filter((r) => r.photo_count > 0).length;
    const tc: Record<string, number> = {}, cc: Record<string, number> = {};
    for (const r of rows) { for (const t of JSON.parse(r.treatments || "[]")) tc[t] = (tc[t] || 0) + 1; for (const c of JSON.parse(r.complaints || "[]")) cc[c] = (cc[c] || 0) + 1; }
    await db.prepare("INSERT OR REPLACE INTO review_stats (hospital_id, entity_type, entity_id, platform, stat_date, count_30d, negative_30d, replied_30d, treatments, complaints, avg_len, long_count, photo_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(h.id, e.key === "self" ? "self" : "competitor", e.competitorId, "naver_place", today, rows.length, rows.filter((r) => r.negative).length, rows.filter((r) => r.reply).length, JSON.stringify(tc), JSON.stringify(cc), avgLen, longCount, photoCount, kstIso()).run();
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (newNegatives.length) {
    await db.prepare("INSERT INTO alerts (hospital_id, severity, code, message, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(h.id, "warn", `negative_review:${today}:${newNegatives.length}`, `부정 신호 리뷰 ${newNegatives.length}건이 새로 올라왔습니다: ${newNegatives.map((n) => `「${n.body.slice(0, 40)}…」(${n.complaints.join("·")})`).join(" / ").slice(0, 300)}`, JSON.stringify(newNegatives), kstIso()).run();
  }
  // 90일 지난 본문 파기(통계는 남음)
  await db.prepare("DELETE FROM reviews WHERE hospital_id = ? AND fetched_at < ?").bind(h.id, new Date(Date.now() - 90 * 86400_000).toISOString()).run();
  return { fetched, inserted, negative, newNegatives };
}

/** 관측 detail 의 blockSize(통합검색 플레이스 블록의 자연 카드 수). 옛 run 에는 없다 → null(=기본 5) */
function blockSizeOf(detail: string | null): number | null {
  if (!detail) return null;
  try { const d = JSON.parse(detail) as { blockSize?: unknown }; const n = Number(d.blockSize); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
}
/** 특정 run 의 관측치로 검색 기회 요약(플랫폼별 커버율·본원/경쟁사 기회)을 계산만 한다(저장 안 함) — 추이용 */
export async function opportunityOfRun(db: D1Database, hospitalId: number, runId: number) {
  const obs = (await db.prepare("SELECT o.platform, o.entity_type, o.entity_id, o.shown, o.rank, o.detail, k.text, k.monthly_pc, k.monthly_mobile FROM observations o JOIN keywords k ON k.id = o.keyword_id WHERE o.run_id = ? AND o.platform IN ('naver_place','google_business','google_serp','kakao_map')").bind(runId).all()).results as { platform: string; entity_type: string; entity_id: number | null; shown: number; rank: number | null; detail: string | null; text: string; monthly_pc: number | null; monthly_mobile: number | null }[];
  const hasSerp = obs.some((o) => o.platform === "google_serp");
  const byPlat: Record<string, Map<string, KeywordRow>> = {};
  for (const o of obs) {
    const p = o.platform === "naver_place" ? "naver_place" : o.platform === "kakao_map" ? "kakao" : o.platform === "google_serp" || (o.platform === "google_business" && !hasSerp) ? "google" : null;
    if (!p) continue;
    byPlat[p] ||= new Map();
    let row = byPlat[p].get(o.text);
    if (!row) { row = { keyword: o.text, volume: o.monthly_pc == null && o.monthly_mobile == null ? null : (o.monthly_pc ?? 0) + (o.monthly_mobile ?? 0), blockSize: null, self: { rank: null, shown: false }, competitors: {} }; byPlat[p].set(o.text, row); }
    if (o.entity_type === "self") row.self = { rank: o.rank, shown: !!o.shown }; else row.competitors[`c${o.entity_id}`] = { rank: o.rank, shown: !!o.shown, name: "" };
    if (p === "naver_place" && row.blockSize == null) row.blockSize = blockSizeOf(o.detail);
  }
  const out: Record<string, { coverage: number | null; captured: number; pool: number; competitors: Record<string, number> }> = {};
  for (const [p, m] of Object.entries(byPlat)) { const op = computeOpportunity(p, [...m.values()]); out[p] = { coverage: op.coverage, captured: op.captured, pool: op.pool, competitors: Object.fromEntries(Object.entries(op.competitors).map(([k, v]) => [k, v.captured])) }; }
  void hospitalId;
  return out;
}
