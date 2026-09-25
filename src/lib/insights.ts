// 이번 주 인사이트 — 대시보드 데이터에서 규칙으로 뽑는 문장. 숫자 근거가 없는 문장은 만들지 않는다.
import type { DashboardData } from "../views-app";
export type Insight = { tone: "good" | "warn" | "bad" | "info"; icon: string; title: string; evidence: string; action?: string; rank: number };
const n = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString());
const pct = (v: number | null | undefined) => (v == null ? "—" : Math.round(v * 100) + "%");

export function buildInsights(d: DashboardData, hospitalName: string, keyTreatments: string[]): Insight[] {
  const out: Insight[] = [];
  const o = d.opportunity;
  const np = o?.platforms.find((p) => p.key === "naver_place");
  if (o && np) {
    out.push({ tone: np.coverage != null && np.coverage < 0.5 ? "warn" : "info", icon: "◎", title: `월 ${n(o.pool)}명이 이 진료를 검색하고, 우리는 그중 ${n(np.captured)}명에게 보였습니다 (${pct(np.coverage)})`, evidence: `네이버 플레이스 · 활성 키워드 ${d.matrix.length}개 기준${np.prev != null ? ` · 지난주 ${pct(np.prev)}` : ""}`, rank: 100 });
    const top = o.lost[0];
    if (top && top.lost > 0) out.push({ tone: "bad", icon: "▼", title: `가장 큰 구멍은 「${top.keyword}」— 월 ${n(top.lost)}명을 놓치고 있습니다`, evidence: `월 ${n(top.volume)}회 검색 · 우리 ${top.rank == null ? "미노출" : top.rank + "위"}${top.above.length ? ` · 위: ${top.above.slice(0, 2).join(", ")}` : ""}${top.gainNext > 0 ? ` · ${top.rank == null ? `블록에 들어가면` : `${top.nextRank}위로 오르면`} +${n(top.gainNext)}명` : ""}`, action: top.actions?.[0]?.text, rank: 95 });
    const empty = o.lost.find((l) => l.rank == null && !l.above.length && l.volume >= 100);
    if (empty) out.push({ tone: "good", icon: "★", title: `「${empty.keyword}」는 경쟁사도 없는 빈자리입니다 — 월 ${n(empty.volume)}명`, evidence: "통합검색 플레이스 블록에 등록한 경쟁 병원이 하나도 없음. 먼저 잡으면 그대로 위", action: empty.actions?.[0]?.text, rank: 90 });
    const bigger = o.competitors.filter((c) => c.captured > o.selfCaptured).sort((a, b) => b.captured - a.captured)[0];
    if (bigger) out.push({ tone: "warn", icon: "⇄", title: `${bigger.name}이(가) 우리보다 월 ${n(bigger.captured - o.selfCaptured)}명 더 보입니다`, evidence: `기회 점유 ${n(bigger.captured)} vs 우리 ${n(o.selfCaptured)} · 같은 키워드 세트`, rank: 80 });
    const missingKey = keyTreatments.map((t) => o.lost.find((l) => l.rank == null && l.keyword.includes(t))).find(Boolean);
    if (missingKey) out.push({ tone: "bad", icon: "!", title: `주력이라고 적은 「${missingKey.keyword.replace(/^\S+\s/, "")}」가 네이버 플레이스에서 안 잡힙니다`, evidence: `「${missingKey.keyword}」 월 ${n(missingKey.volume)}회 · 우리 미노출`, action: missingKey.actions?.[0]?.text, rank: 85 });
  }
  // 플랫폼 불일치 × 실제 신환
  const g = o?.platforms.find((p) => p.key === "google");
  const lastWeek = d.arrivals[0];
  if (g && np && g.coverage != null && np.coverage != null && g.coverage - np.coverage >= 0.3 && lastWeek && lastWeek.search > 0) {
    out.push({ tone: "warn", icon: "≠", title: `구글에선 ${pct(g.coverage)} 보이지만, 지난주 검색 신환 ${lastWeek.search}명 중 ${lastWeek.naver}명이 네이버에서 왔습니다`, evidence: `네이버 플레이스 커버 ${pct(np.coverage)} · 구글 ${pct(g.coverage)} · 페이션트 폼 내원경로`, action: "환자가 오는 곳은 네이버입니다. 플레이스 리뷰·항목·블로그에 투자를 집중하세요.", rank: 92 });
  }
  if (lastWeek) out.push({ tone: "info", icon: "⌂", title: `지난주 신환 ${lastWeek.first_visits}명: 소개 ${lastWeek.referral} · 검색 ${lastWeek.search} · AI ${lastWeek.ai} · SNS/콘텐츠 ${lastWeek.sns + lastWeek.content}`, evidence: `응답 ${lastWeek.answered}명 기준 · 페이션트 폼 ${lastWeek.week_start} 주`, rank: 70 });
  // 리뷰
  if (d.reviews) {
    const me = d.reviews.rows.find((r) => r.self); const best = d.reviews.rows.filter((r) => !r.self && r.analyzed > 0).sort((a, b) => b.replied / b.analyzed - a.replied / a.analyzed)[0];
    if (me && best && me.analyzed > 0 && best.replied / best.analyzed > me.replied / me.analyzed + 0.3) out.push({ tone: "warn", icon: "✎", title: `${best.entity}은 최근 리뷰 ${best.replied}/${best.analyzed}건에 답글, 우리는 ${me.replied}/${me.analyzed}건`, evidence: "네이버 방문자 리뷰 최신분 · 답글 응답률은 순위 요인 중 하나", action: "모든 새 리뷰에 48시간 안에 답글을 남기세요. 실장 1명이 하루 5분이면 됩니다.", rank: 75 });
    const richest = d.reviews.rows.filter((r) => !r.self && r.avgLen != null && r.analyzed >= 5).sort((a, b) => (b.avgLen || 0) - (a.avgLen || 0))[0];
    if (me && me.avgLen != null && richest && richest.avgLen != null && me.analyzed >= 5) {
      if (richest.avgLen >= me.avgLen * 1.5) out.push({ tone: "warn", icon: "≡", title: `우리 리뷰는 평균 ${me.avgLen}자, ${richest.entity}은 ${richest.avgLen}자 — 상대 리뷰가 ${Math.round(richest.avgLen / Math.max(1, me.avgLen) * 10) / 10}배 깁니다`, evidence: `100자 이상 리뷰 우리 ${me.longCount}/${me.analyzed} vs ${richest.longCount}/${richest.analyzed} · 사진 ${me.photoCount}/${me.analyzed} vs ${richest.photoCount}/${richest.analyzed}`, action: "리뷰 요청 때 '어떤 치료를 어떻게 받으셨는지 한 줄'을 부탁하면 길어집니다. 긴 리뷰·사진 리뷰가 플레이스 노출과 신뢰에 더 영향을 줍니다.", rank: 68 });
      else if (me.avgLen >= richest.avgLen * 1.5) out.push({ tone: "good", icon: "≡", title: `우리 리뷰가 경쟁사보다 깁니다 — 평균 ${me.avgLen}자 vs ${richest.avgLen}자`, evidence: `100자 이상 ${me.longCount}/${me.analyzed} · 사진 ${me.photoCount}/${me.analyzed}`, rank: 55 });
    }
    if (d.reviews.recentNegative.length) out.push({ tone: "bad", icon: "⚠", title: `부정 신호 리뷰 ${d.reviews.recentNegative.length}건이 있습니다`, evidence: d.reviews.recentNegative.slice(0, 2).map((x) => `${x.entity}: 「${x.body.slice(0, 40)}…」`).join(" · "), action: "본원 리뷰라면 오늘 답글, 경쟁사 리뷰라면 상대의 약점 기록.", rank: 88 });
    if (me && me.treatments.length) { const missingT = keyTreatments.filter((t) => !me.treatments.some(([k]) => k.includes(t) || t.includes(k))); if (missingT.length) out.push({ tone: "info", icon: "☰", title: `우리 리뷰엔 「${me.treatments.slice(0, 3).map(([k]) => k).join("·")}」가 많고 「${missingT.join("·")}」 언급은 없습니다`, evidence: "최근 리뷰 본문 진료 키워드 · 플레이스 순위는 리뷰 단어에 영향", action: `「${missingT[0]}」 환자분께 리뷰 요청 문구에 진료명을 넣어 달라고 부탁하세요.`, rank: 65 }); }
  }
  // 플레이스 완성도: 우리보다 사진이 2배 이상 많은 경쟁사, 네이버가 '미등록'으로 표시한 항목
  if (d.completeness) {
    const me = d.completeness.rows.find((r) => r.self); const rich = d.completeness.rows.filter((r) => !r.self && r.photos != null).sort((a, b) => (b.photos || 0) - (a.photos || 0))[0];
    if (me && rich && me.photos != null && rich.photos != null && rich.photos >= me.photos * 2) out.push({ tone: "warn", icon: "▣", title: `${rich.entity} 플레이스 사진 ${n(rich.photos)}장, 우리는 ${n(me.photos)}장`, evidence: `플레이스 사진 탭 총 장수(업체 등록 ${me.businessImages ?? "—"} vs ${rich.businessImages ?? "—"}) · 소개글 ${me.descriptionLen ?? "—"}자 vs ${rich.descriptionLen ?? "—"}자`, action: "진료실·장비·직원 사진 20장을 스마트플레이스에 올리세요. 사진 수는 페이지에 그대로 보이는 값이라 환자가 비교합니다.", rank: 66 });
    if (me) { const missing = [me.bizHourMissing ? "영업시간" : null, me.descriptionMissing ? "소개글" : null, !me.booking ? "네이버 예약" : null].filter(Boolean) as string[]; if (missing.length) out.push({ tone: "warn", icon: "□", title: `우리 플레이스에 ${missing.join("·")}이(가) 비어 있습니다`, evidence: "네이버 플레이스 페이지가 '미등록'으로 표시하는 항목 · 예약 버튼 유무", action: "스마트플레이스 관리에서 오늘 채우세요. 5분이면 됩니다.", rank: 84 }); }
  }
  // 콘텐츠
  const th = d.content.find((c) => c.platform === "threads"), ig = d.content.find((c) => c.platform === "instagram");
  if (th && ig && th.views != null && ig.views != null && ig.views > 0 && th.views / ig.views >= 5) out.push({ tone: "good", icon: "▲", title: `콘텐츠 도달은 스레드가 주력입니다 — 30일 ${n(th.views)}회, 인스타그램의 ${Math.round(th.views / ig.views)}배`, evidence: `스레드 팔로워 ${n(th.followers)} · 인스타 ${n(ig.followers)} · 같은 사람이 올림`, action: "신환 경로의 SNS/콘텐츠 열이 늘어나는지 4주 지켜보세요. 스레드 글 끝에 예약 경로를 넣어 두면 연결이 잡힙니다.", rank: 72 });
  const yts = d.content.filter((c) => c.platform.startsWith("youtube:"));
  if (yts.length && yts.every((y) => (y.views ?? 0) === 0)) out.push({ tone: "info", icon: "▶", title: `유튜브 ${yts.length}개 채널 모두 최근 30일 업로드·조회가 0입니다`, evidence: yts.map((y) => `${y.label.replace("유튜브 · ", "")} 구독 ${n(y.followers)}`).join(" · "), rank: 40 });
  // 근거 없는 문장은 내보내지 않는다(2026-09-26 규칙)
  return out.filter((i) => i.evidence && i.evidence.trim().length > 0).sort((a, b) => b.rank - a.rank).slice(0, 8);
}
