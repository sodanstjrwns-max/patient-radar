// 앱 화면(로그인 후) — 서버 렌더, 최소 JS. 숫자가 주인공. 측정 안 된 값은 "—"로, 절대 0으로 그리지 않는다.
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { APP_NAME, CONTACT, VERSION } from "./lib/config";
import { PLATFORM_LABEL, type ReportContent } from "./lib/report";
import { CLINIC_TYPES } from "./data/procedures";
import { PLAN_LIMITS, type Plan } from "./lib/plan-limits";
import { LineChart, StackedBars } from "./lib/charts";

export const fmt = (n: number | null | undefined, d = 0) => (n == null ? "—" : Number(n).toFixed(d));
export const pct = (n: number | null | undefined) => (n == null ? "—" : Math.round(n * 100) + "%");
export const delta = (cur: number | null | undefined, prev: number | null | undefined) => {
  if (cur == null || prev == null) return <span class="delta muted">—</span>;
  const d = Math.round((cur - prev) * 10) / 10;
  return <span class={"delta " + (d > 0 ? "up" : d < 0 ? "down" : "flat")}>{d > 0 ? "▲" : d < 0 ? "▼" : "•"} {Math.abs(d)}</span>;
};
export const rankCell = (rank: number | null | undefined, shown?: boolean, ad?: boolean) => (
  <span class={"rank " + (rank == null ? (shown ? "elsewhere" : "absent") : rank <= 3 ? "top" : rank <= 5 ? "mid" : "low")}>
    {rank == null ? (shown ? "노출" : "—") : rank + "위"}{ad ? <small class="ad">광고</small> : null}
  </span>
);

export function AppLayout({ title, hospital, active, children, flash }: { title: string; hospital: { name: string; plan: string }; active: string; children: Child; flash?: string | null }) {
  const nav = [["/app", "대시보드"], ["/app/reports", "주간 리포트"], ["/app/settings", "설정"]];
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex,nofollow" />
          <title>{title} · {APP_NAME.en}</title>
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" />
          <link rel="stylesheet" href="/static/app.css" />
        </head>
        <body class="app-body">
          <header class="app-header">
            <div class="app-header-inner">
              <a href="/app" class="brand"><span class="logo-mark" /><span>patient<b>radar</b></span></a>
              <nav class="app-nav">{nav.map(([href, label]) => <a href={href} class={active === href ? "active" : ""}>{label}</a>)}</nav>
              <div class="app-user"><span class="hname">{hospital.name}</span><span class="plan-chip">{hospital.plan}</span><form method="post" action="/api/auth/logout"><button class="linklike">로그아웃</button></form></div>
            </div>
          </header>
          {flash ? <div class="flash">{flash}</div> : null}
          <main class="app-main">{children}</main>
          <footer class="app-footer">Patient Funnel · {CONTACT.phone} · {CONTACT.email} · v{VERSION}</footer>
        </body>
      </html>
    </>
  );
}

/* ───────── 온보딩 ───────── */
export function Step1({ h, prefill, error }: { h: { name: string; plan: string }; prefill: { name: string; aliases: string; clinic_type: string; region: string; treatments: string; naver_place_id: string; website_url: string; fromHub: boolean }; error?: string }) {
  return (
    <AppLayout title="온보딩 1/3 병원 확인" hospital={h} active="">
      <section class="card narrow">
        <p class="eyebrow">STEP 1 / 3</p>
        <h1>병원을 확인해 주세요</h1>
        <p class="muted">{prefill.fromHub ? "허브 프로필에서 가져왔습니다. 틀린 곳만 고치면 됩니다." : "허브 프로필이 비어 있어 직접 입력합니다. 나중에 설정에서 바꿀 수 있습니다."}</p>
        {error ? <p class="error">{error}</p> : null}
        <form method="post" action="/app/onboarding/step1" class="form">
          <label>병원 이름 (네이버에 등록된 표기) <input name="name" value={prefill.name} required maxlength={60} /></label>
          <label>별칭·지점명 (쉼표로 구분: 예 <i>비디치과, 서울비디치과 불당본점</i>) <input name="aliases" value={prefill.aliases} maxlength={200} /></label>
          <label>진료과
            <select name="clinic_type">{CLINIC_TYPES.map((t) => <option value={t} selected={t === prefill.clinic_type}>{t}</option>)}</select>
          </label>
          <label>지역 (시·군·구·동까지: 예 <i>충청남도 천안시 서북구 불당동</i>) <input name="region" value={prefill.region} required maxlength={60} /></label>
          <label>주력 진료·시술 (쉼표, 최대 6개) <input name="treatments" value={prefill.treatments} maxlength={200} /></label>
          <label>네이버 플레이스 주소 또는 ID (선택 · <i>m.place.naver.com/hospital/1541238930</i> 형태) <input name="naver_place_id" value={prefill.naver_place_id} maxlength={200} /></label>
          <label>홈페이지 주소 (선택 · 구글 순위 매칭에 사용) <input name="website_url" value={prefill.website_url} maxlength={200} placeholder="https://" /></label>
          <label>유튜브 채널 (선택 · 콘텐츠 도달 측정) <input name="youtube" maxlength={200} placeholder="https://www.youtube.com/@..." /></label>
          <button class="button button-primary" type="submit">다음 · 키워드 만들기 →</button>
        </form>
      </section>
    </AppLayout>
  );
}

export const volText = (k: { monthly_pc?: number | null; monthly_mobile?: number | null; volume_low?: number }) => (k.monthly_pc == null && k.monthly_mobile == null ? null : `${((k.monthly_pc ?? 0) + (k.monthly_mobile ?? 0)).toLocaleString()}${k.volume_low ? "↓" : ""}`);
export function Step2({ h, keywords, limit, error, withVolume }: { h: { name: string; plan: string }; keywords: { id: number; text: string; is_active: number; source: string; monthly_pc?: number | null; monthly_mobile?: number | null; volume_low?: number }[]; limit: number; error?: string; withVolume?: boolean }) {
  const active = keywords.filter((k) => k.is_active).length;
  return (
    <AppLayout title="온보딩 2/3 키워드" hospital={h} active="">
      <section class="card narrow">
        <p class="eyebrow">STEP 2 / 3</p>
        <h1>측정할 키워드</h1>
        <p class="muted">{withVolume ? "「지역 × 진료」 조합과 네이버 연관 검색어를 월 검색수 순으로 정렬해, 많이 찾는 것부터 켜 두었습니다." : "「지역 × 진료」로 자동 생성했습니다."} 환자가 실제로 검색할 말만 남기세요. 플랜 한도 <b>{limit}개</b> · 현재 {active}개 선택.</p>
        {error ? <p class="error">{error}</p> : null}
        <form method="post" action="/app/onboarding/step2" class="form">
          <div class="kw-grid">
            {keywords.map((k) => (
              <label class="kw-item"><input type="checkbox" name="active" value={String(k.id)} checked={!!k.is_active} /> <span class="kw-text">{k.text}</span>{volText(k) ? <small class="vol-badge">월 {volText(k)}</small> : null}{k.source === "manual" ? <small class="muted"> 직접</small> : k.source === "related" ? <small class="muted"> 연관</small> : null}</label>
            ))}
          </div>
          <label>추가 키워드 (한 줄에 하나)<textarea name="extra" rows={3} placeholder="천안 앞니 라미네이트"></textarea></label>
          <div class="row"><a href="/app/onboarding?step=1" class="button button-outline">← 이전</a><button class="button button-primary" type="submit">다음 · 경쟁 병원 →</button></div>
        </form>
      </section>
    </AppLayout>
  );
}

export function Step3({ h, suggestions, existing, limit, note, error }: { h: { name: string; plan: string }; suggestions: { name: string; count: number; placeId: string | null }[]; existing: { id: number; name: string }[]; limit: number; note?: string; error?: string }) {
  return (
    <AppLayout title="온보딩 3/3 경쟁 병원" hospital={h} active="">
      <section class="card narrow">
        <p class="eyebrow">STEP 3 / 3</p>
        <h1>비교할 경쟁 병원</h1>
        <p class="muted">상위 키워드에서 플레이스 상위 5에 반복 등장한 병원을 추천합니다. 플랜 한도 <b>{limit}곳</b>.{limit === 0 ? " FREE 플랜은 경쟁사 비교가 없습니다 — 건너뛰어도 됩니다." : ""}</p>
        {note ? <p class="notice-inline">{note}</p> : null}
        {error ? <p class="error">{error}</p> : null}
        <form method="post" action="/app/onboarding/step3" class="form">
          {existing.length ? <div class="kw-grid">{existing.map((c) => <label class="kw-item"><input type="checkbox" name="keep" value={String(c.id)} checked /> {c.name}</label>)}</div> : null}
          {suggestions.length ? (
            <div class="kw-grid">{suggestions.map((s) => (
              <label class="kw-item"><input type="checkbox" name="pick" value={s.name + "|" + (s.placeId || "")} /> {s.name} <small class="muted">{s.count}회 등장</small></label>
            ))}</div>
          ) : <p class="muted">추천 후보가 없습니다. 아래에 직접 적어 주세요.</p>}
          <label>직접 추가 (한 줄에 하나, 네이버 표기 그대로)<textarea name="extra" rows={3} placeholder="365아홉가지약속치과의원"></textarea></label>
          <div class="row"><a href="/app/onboarding?step=2" class="button button-outline">← 이전</a><button class="button button-primary" type="submit">완료 · 첫 측정으로 →</button></div>
        </form>
      </section>
    </AppLayout>
  );
}

export function FirstRun({ h, ready, reasons, result, lines }: { h: { name: string; plan: string }; ready: boolean; reasons: string[]; result?: { total: number | null; platforms: Record<string, { score: number | null }> } | null; lines?: string[] }) {
  return (
    <AppLayout title="첫 측정" hospital={h} active="">
      <section class="card narrow">
        <p class="eyebrow">FIRST MEASUREMENT</p>
        <h1>{result ? "첫 측정 결과" : "첫 측정을 시작합니다"}</h1>
        {!result ? (
          <>
            <p class="muted">키워드 최대 5개를 지금 바로 측정해 첫 화면을 채웁니다. 나머지 키워드는 다음 정기 측정(평일 새벽)에 채워집니다. 1~2분 걸립니다.</p>
            {!ready ? <div class="notice-inline"><b>지금은 측정할 수 있는 플랫폼이 없습니다.</b><ul>{reasons.map((r) => <li>{r}</li>)}</ul><a href="/app" class="button button-outline">대시보드로</a></div> : (
              <form method="post" action="/app/first-run"><button class="button button-primary" type="submit">측정 시작</button></form>
            )}
          </>
        ) : (
          <>
            <div class="score-hero"><span class="score-big">{fmt(result.total, 1)}</span><span class="score-cap">/ 100 · 온라인 가시성</span></div>
            <ul class="lines">{(lines || []).map((l) => <li>{l}</li>)}</ul>
            <div class="row"><a href="/app" class="button button-primary">대시보드 보기 →</a></div>
          </>
        )}
      </section>
    </AppLayout>
  );
}

/* ───────── 대시보드 ───────── */
export type LostItem = { keyword: string; volume: number; rank: number | null; lost: number; gainTop3: number; above: string[]; actions?: string[] };
export type DashboardData = {
  week: string | null;
  total: { score: number | null; prev: number | null; sov: number | null; weighted: number | null; series: { week: string; score: number }[]
};
  platforms: { key: string; label: string; score: number | null; prev: number | null; sov: number | null; state: "ok" | "unmeasured" | "needs_key" | "plan" }[];
  matrix: { keyword: string; volume: number | null; volumeLow?: boolean; cells: Record<string, { rank: number | null; shown: boolean; ad?: boolean }>; competitors: Record<string, { rank: number | null; shown: boolean }> }[];
  hasVolume: boolean;
  history: {
    runs: { date: string; runId: number; total: number | null; weighted: number | null; platforms: Record<string, number | null>; coverage: Record<string, number | null>; selfCaptured: number | null; competitors: Record<string, number> }[];
    rankTable: { keyword: string; volume: number | null; ranks: (number | null)[]; shown: boolean[]; change: number | null }[];
    dates: string[];
    reviews: { entity: string; self: boolean; points: { x: string; y: number | null }[] }[];
    content: { label: string; followers: { x: string; y: number | null }[]; views: { x: string; y: number | null }[] }[];
    changes: { kind: string; label: string; before: string; after: string; delta: number; unit: string; good: boolean | null }[];
    prevDate: string | null;
  };
  insights: { tone: string; icon: string; title: string; evidence: string; action?: string }[];
  reviews: { rows: { entity: string; self: boolean; velocity30: number | null; analyzed: number; negative: number; replied: number; treatments: [string, number][]; complaints: [string, number][] }[]; recentNegative: { entity: string; body: string; complaints: string[]; written_at: string | null }[]; latest: { body: string; written_at: string | null; treatments: string[] }[] } | null;
  content: { platform: string; label: string; followers: number | null; prevFollowers: number | null; views: number | null; prevViews: number | null; date: string; manual: boolean; top: { title: string; views: number }[] }[];
  arrivals: { week_start: string; first_visits: number; answered: number; search: number; naver: number; google: number; ai: number; sns: number; content: number; referral: number; sign: number; nearby: number; other: number; coverage: number | null }[];
  opportunity: { pool: number; platforms: { key: string; label: string; captured: number; coverage: number | null; prev: number | null }[]; lost: LostItem[]; competitors: { name: string; captured: number; coverage: number | null }[]; selfCaptured: number } | null;
  matrixPlatforms: { key: string; label: string }[];
  competitors: { id: number; name: string; score: number | null }[];
  selfScore: number | null;
  reputation: { entity: string; platform: string; points: { date: string; reviews: number | null; blog: number | null; rating: number | null }[] }[];
  alerts: { severity: string; message: string; created_at: string }[];
  runs: { run_date: string; status: string; kind: string; error: string | null }[];
  compare: boolean;
  onboarded: boolean;
};

function Spark({ series }: { series: { week: string; score: number }[] }) {
  if (series.length < 2) return <span class="muted small">추세는 2회 측정부터</span>;
  const w = 220, hgt = 44, min = 0, max = 100;
  const pts = series.map((p, i) => `${(i / (series.length - 1)) * w},${hgt - ((p.score - min) / (max - min)) * hgt}`).join(" ");
  return <svg class="spark" viewBox={`0 0 ${w} ${hgt}`} width={w} height={hgt} aria-label="8주 추세"><polyline points={pts} fill="none" stroke="currentColor" stroke-width="2" /></svg>;
}

function Sec({ title, sub, open, children, id }: { title: string; sub?: string; open?: boolean; children: Child; id?: string }) {
  return (
    <details class="sec" open={!!open} id={id}>
      <summary><span class="sec-title">{title}</span>{sub ? <span class="sec-sub">{sub}</span> : null}<span class="sec-chev">›</span></summary>
      <div class="sec-body">{children}</div>
    </details>
  );
}

export function Dashboard({ h, d }: { h: { name: string; plan: string }; d: DashboardData }) {
  const np = d.opportunity?.platforms.find((p) => p.key === "naver_place");
  const lastWeek = d.arrivals[0];
  return (
    <AppLayout title="대시보드" hospital={h} active="/app">
      {!d.onboarded ? <div class="notice-inline">온보딩이 끝나지 않았습니다. <a href="/app/onboarding">이어서 진행 →</a></div> : null}
      {!d.week ? (
        <section class="card"><h1>아직 측정 결과가 없습니다</h1><p class="muted">첫 측정을 실행하면 이 자리에 점수가 표시됩니다.</p><a class="button button-primary" href="/app/first-run">첫 측정 →</a></section>
      ) : (
        <>
          {/* ── 한눈에 ── */}
          <section class="hero-tiles">
            <div class="tile tile-main">
              <p class="tile-label">검색 기회 커버율 <small>네이버 플레이스 · {d.week} 주</small></p>
              <div class="tile-num">{np ? pct(np.coverage) : "—"}{np ? <span class="tile-delta">{np.prev != null && np.coverage != null ? <span class={"delta " + (np.coverage - np.prev > 0.005 ? "up" : np.coverage - np.prev < -0.005 ? "down" : "flat")}>{np.coverage - np.prev >= 0 ? "▲" : "▼"}{Math.abs(Math.round((np.coverage - np.prev) * 100))}%p</span> : <span class="muted small">첫 주</span>}</span> : null}</div>
              <p class="tile-sub">{d.opportunity ? <>월 <b>{d.opportunity.pool.toLocaleString()}</b>명이 검색 · 우리에게 보인 기회 <b>{np?.captured.toLocaleString()}</b>명</> : "검색량 연결 전"}</p>
              <div class="tile-spark"><Spark series={d.history.runs.map((r) => ({ week: r.date, score: (r.coverage.naver_place ?? 0) * 100 }))} /></div>
            </div>
            <div class="tile">
              <p class="tile-label">온라인 가시성 점수</p>
              <div class="tile-num">{fmt(d.total.score, 1)}<span class="tile-cap">/100</span>{delta(d.total.score, d.total.prev)}</div>
              <p class="tile-sub">{d.total.weighted != null ? <>수요 가중 <b>{fmt(d.total.weighted, 1)}</b> · 점유율 {pct(d.total.sov)}</> : <>점유율 {pct(d.total.sov)}</>}</p>
              <div class="tile-spark"><Spark series={d.history.runs.filter((r) => r.total != null).map((r) => ({ week: r.date, score: r.total as number }))} /></div>
            </div>
            <div class="tile">
              <p class="tile-label">지난주 신환 <small>페이션트 폼</small></p>
              <div class="tile-num">{lastWeek ? lastWeek.first_visits : "—"}<span class="tile-cap">명</span></div>
              <p class="tile-sub">{lastWeek ? <>검색 <b>{lastWeek.search}</b> · 소개 {lastWeek.referral} · AI {lastWeek.ai} · SNS/콘텐츠 {lastWeek.sns + lastWeek.content}</> : "폼 연결 전"}</p>
            </div>
          </section>

          {/* ── 무엇이 변했나 ── */}
          <section class="card changes">
            <div class="card-head"><h2 class="h2">무엇이 변했나 <small class="muted">{d.history.prevDate ? `${d.history.prevDate} → ${d.history.dates[d.history.dates.length - 1]}` : "첫 측정 · 다음 측정부터 비교가 시작됩니다"}</small></h2></div>
            {d.history.changes.length ? (
              <div class="change-grid">{d.history.changes.map((c) => (
                <div class={"change " + (c.good == null ? "neutral" : c.good ? "good" : "bad")}><p class="change-label">{c.label}</p><p class="change-val"><span class="before">{c.before}</span><span class="arrow">→</span><span class="after">{c.after}</span></p><p class={"change-delta " + (c.delta > 0 ? "plus" : "minus")}>{c.delta > 0 ? "▲" : "▼"} {Math.abs(c.delta).toLocaleString()}{c.unit}</p></div>
              ))}</div>
            ) : d.history.prevDate ? <p class="muted small">지난 측정과 달라진 것이 없습니다.</p> : <p class="muted small">화요일 새벽 정기 측정부터 순위·커버율·리뷰·팔로워 변화가 여기에 쌓입니다.</p>}
          </section>

          {/* ── 인사이트 ── */}
          {d.insights.length ? (
            <section class="insights">
              <h2 class="h2">이번 주 인사이트 <small class="muted">실측 숫자에서 규칙으로 뽑은 문장 · 근거는 아래 각 섹션</small></h2>
              <ol class="insight-list">{d.insights.map((i) => (
                <li class={"insight " + i.tone}><span class="ins-icon">{i.icon}</span><div><p class="ins-title">{i.title}</p><p class="ins-evidence">{i.evidence}</p>{i.action ? <p class="ins-action">→ {i.action}</p> : null}</div></li>
              ))}</ol>
            </section>
          ) : null}

          <Sec title="추이" sub="측정마다 쌓이는 그래프 · 커버율 · 점수 · 순위 · 리뷰 · 팔로워 · 신환" open id="trend">
            <div class="grid-2">
              <div><h3 class="h3">검색 기회 커버율</h3><LineChart percent yMax={1} series={[{ label: "네이버 플레이스", color: "#6B4226", points: d.history.runs.map((r) => ({ x: r.date, y: r.coverage.naver_place ?? null })) }, { label: "구글", color: "#3b5a7a", points: d.history.runs.map((r) => ({ x: r.date, y: r.coverage.google ?? null })) }, { label: "카카오맵", color: "#c9a227", points: d.history.runs.map((r) => ({ x: r.date, y: r.coverage.kakao ?? null })) }]} /></div>
              <div><h3 class="h3">온라인 가시성 점수</h3><LineChart yMax={100} series={[{ label: "점수", color: "#6B4226", points: d.history.runs.map((r) => ({ x: r.date, y: r.total })) }, { label: "수요 가중", color: "#a86a10", points: d.history.runs.map((r) => ({ x: r.date, y: r.weighted })) }, { label: "네이버 플레이스", color: "#2f7d4f", points: d.history.runs.map((r) => ({ x: r.date, y: r.platforms.naver_place ?? null })) }]} /></div>
            </div>
            <div class="grid-2">
              <div><h3 class="h3">누가 수요를 가져가나 <small class="muted">플레이스 기회(명)</small></h3><LineChart series={[{ label: h.name, color: "#6B4226", points: d.history.runs.map((r) => ({ x: r.date, y: r.selfCaptured })) }, ...Object.keys(d.history.runs[d.history.runs.length - 1]?.competitors || {}).map((name, i) => ({ label: name, color: ["#8a8f98", "#b3352b", "#3b5a7a", "#c9a227"][i % 4], points: d.history.runs.map((r) => ({ x: r.date, y: r.competitors[name] ?? null })) }))]} /></div>
              <div><h3 class="h3">방문자 리뷰 수 <small class="muted">네이버 플레이스</small></h3><LineChart yMin={0} series={d.history.reviews.map((rv, i) => ({ label: rv.entity, color: rv.self ? "#6B4226" : ["#8a8f98", "#b3352b", "#3b5a7a", "#c9a227"][i % 4], points: rv.points }))} /></div>
            </div>
            <div>
              <h3 class="h3">키워드 순위 변화 <small class="muted">네이버 플레이스 · 열 = 측정일 · 마지막 열 = 직전 대비</small></h3>
              <div class="table-scroll"><table class="matrix heat">
                <thead><tr><th>키워드</th><th>월 검색</th>{d.history.dates.map((dt) => <th>{dt.slice(5)}</th>)}<th>변화</th></tr></thead>
                <tbody>{d.history.rankTable.map((r) => <tr><td class="kw">{r.keyword}</td><td class="vol">{r.volume == null ? "—" : r.volume.toLocaleString()}</td>{r.ranks.map((rk, i) => <td><span class={"heat-cell " + (rk == null ? (r.shown[i] ? "h-else" : "h-none") : rk === 1 ? "h1" : rk <= 3 ? "h3" : rk <= 5 ? "h5" : "h10")}>{rk == null ? (r.shown[i] ? "노출" : "—") : rk}</span></td>)}<td>{r.change == null ? <span class="muted">—</span> : r.change === 0 ? <span class="muted">=</span> : <span class={"delta " + (r.change > 0 ? "up" : "down")}>{r.change > 0 ? "▲" : "▼"}{Math.abs(r.change) >= 90 ? "" : Math.abs(r.change)}</span>}</td></tr>)}</tbody>
              </table></div>
            </div>
            <div class="grid-2">
              {d.history.content.length ? <div><h3 class="h3">콘텐츠 30일 조회·도달</h3><LineChart series={d.history.content.map((c, i) => ({ label: c.label.replace("유튜브 · ", "YT "), color: ["#6B4226", "#b3352b", "#3b5a7a", "#c9a227", "#2f7d4f", "#8a8f98"][i % 6], points: c.views }))} /></div> : null}
              {d.arrivals.length ? <div><h3 class="h3">주간 신환 경로 <small class="muted">페이션트 폼</small></h3><StackedBars keys={["검색", "AI", "SNS·콘텐츠", "소개", "기타"]} colors={{ "검색": "#6B4226", "AI": "#a86a10", "SNS·콘텐츠": "#c9a227", "소개": "#2f7d4f", "기타": "#b8b0a6" }} groups={[...d.arrivals].reverse().map((a) => ({ x: a.week_start, values: { "검색": a.search, "AI": a.ai, "SNS·콘텐츠": a.sns + a.content, "소개": a.referral, "기타": a.sign + a.nearby + a.other } }))} /></div> : null}
            </div>
          </Sec>

          {d.opportunity ? (
            <Sec title="검색 기회" sub="놓친 기회 순위 · 누가 가져가나 · 처방" open id="opp">
              <div class="opp-top">
                <div class="opp-bars">{d.opportunity.platforms.map((p) => (
                  <div class="bar-row"><span class="bar-label">{p.label}</span><span class={"bar " + (p.key === "naver_place" ? "self" : "")} style={`width:${Math.max(2, Math.round((p.coverage ?? 0) * 100))}%`} /><span class="bar-val">{pct(p.coverage)} <small class="muted">{p.captured.toLocaleString()}명</small></span></div>
                ))}</div>
                <div class="bars">
                  <p class="small muted">누가 이 수요를 가져가나 · 네이버 플레이스</p>
                  <div class="bar-row"><span class="bar-label">우리 병원</span><span class="bar self" style={`width:${Math.max(2, Math.round((d.opportunity.selfCaptured / Math.max(1, d.opportunity.pool)) * 100))}%`} /><span class="bar-val">{d.opportunity.selfCaptured.toLocaleString()}</span></div>
                  {d.opportunity.competitors.map((c) => <div class="bar-row"><span class="bar-label">{c.name}</span><span class="bar" style={`width:${Math.max(2, Math.round((c.coverage ?? 0) * 100))}%`} /><span class="bar-val">{c.captured.toLocaleString()}</span></div>)}
                </div>
              </div>
              <div class="table-scroll"><table class="matrix"><thead><tr><th>키워드</th><th>월 검색</th><th>우리</th><th>놓침</th><th>3위 진입 시</th><th>위에 있는 병원</th><th></th></tr></thead>
                <tbody>{d.opportunity.lost.map((l) => [
                  <tr><td class="kw">{l.keyword}</td><td>{l.volume.toLocaleString()}</td><td>{rankCell(l.rank, false)}</td><td><b>{l.lost.toLocaleString()}</b></td><td class="muted">{l.gainTop3 > 0 ? "+" + l.gainTop3.toLocaleString() : "—"}</td><td class="small muted">{l.above.length ? l.above.slice(0, 2).join(" · ") : (l.rank == null ? "경쟁사도 없음" : "—")}</td><td>{l.actions?.length ? <details class="rx-d"><summary>이렇게</summary><ul>{l.actions.map((a) => <li>{a}</li>)}</ul></details> : null}</td></tr>,
                ])}</tbody></table></div>
              <p class="muted small">검색 기회 = 월 검색수 × 순위별 노출 확률(1위 100 · 2위 80 · 3위 65 · 4위 45 · 5위 35 · 6~10위 15 · 다른 섹션 10%). 본 기회의 추정치이지 클릭 수가 아닙니다.</p>
            </Sec>
          ) : null}

          <Sec title="키워드 순위" sub={d.compare ? "경쟁사 비교 · 네이버 플레이스" : "플랫폼별 자연 순위"}>
            <div class="row" style="margin-bottom:8px"><a href={d.compare ? "/app#kw" : "/app?compare=1#kw"} class="button button-small button-outline">{d.compare ? "플랫폼별로 보기" : "경쟁사와 비교"}</a>
              {d.platforms.filter((p) => p.state !== "ok").length ? <span class="muted small">미측정: {d.platforms.filter((p) => p.state !== "ok").map((p) => p.label + (p.state === "needs_key" ? "(키 필요)" : p.state === "plan" ? "(플랜)" : "")).join(", ")}</span> : null}</div>
            <div class="table-scroll"><table class="matrix">
              <thead><tr><th>키워드</th>{d.hasVolume ? <th>월 검색</th> : null}{d.compare ? [<th>우리</th>, ...d.competitors.map((c) => <th>{c.name}</th>)] : d.matrixPlatforms.map((p) => <th>{p.label}</th>)}</tr></thead>
              <tbody>{d.matrix.map((r) => (
                <tr><td class="kw">{r.keyword}</td>{d.hasVolume ? <td class="vol">{r.volume == null ? <span class="muted">—</span> : <>{r.volume.toLocaleString()}{r.volumeLow ? <small class="muted"> ↓</small> : null}</>}</td> : null}
                  {d.compare ? [<td>{rankCell(r.cells.naver_place?.rank, r.cells.naver_place?.shown, r.cells.naver_place?.ad)}</td>, ...d.competitors.map((c) => <td>{rankCell(r.competitors[`c${c.id}`]?.rank, r.competitors[`c${c.id}`]?.shown)}</td>)] : d.matrixPlatforms.map((p) => <td>{r.cells[p.key] ? rankCell(r.cells[p.key].rank, r.cells[p.key].shown, r.cells[p.key].ad) : <span class="muted">—</span>}</td>)}
                </tr>))}</tbody></table></div>
            <div class="platform-cards">{d.platforms.map((p) => <div class={"pcard " + p.state}><p class="tile-label">{p.label}</p><div class="pscore"><span class="num">{p.state === "ok" ? fmt(p.score, 1) : "—"}</span>{p.state === "ok" ? delta(p.score, p.prev) : null}</div><p class="muted small">{p.state === "ok" ? (p.sov != null ? `점유율 ${pct(p.sov)}` : " ") : p.state === "needs_key" ? "키 필요" : p.state === "plan" ? "상위 플랜" : "미측정"}</p></div>)}</div>
            <p class="muted small">「노출」= 순위 목록엔 없지만 블로그·카페 등에 이름이 나옴 · 「—」= 미노출 · 월 검색 = 네이버 최근 30일(↓ 10 미만 포함)</p>
          </Sec>

          {d.reviews ? (
            <Sec title="리뷰" sub="네이버 방문자 리뷰 · 최근 30일 · 본원 vs 경쟁사">
              <div class="table-scroll"><table class="matrix">
                <thead><tr><th>병원</th><th>30일 리뷰 증가</th><th>분석</th><th>부정</th><th>답글</th><th>많이 언급된 진료</th><th>불만 키워드</th></tr></thead>
                <tbody>{d.reviews.rows.map((r) => <tr class={r.self ? "self-row" : ""}><td class="kw">{r.entity}</td><td>{r.velocity30 == null ? <span class="muted">다음 주부터</span> : <b>+{r.velocity30.toLocaleString()}</b>}</td><td>{r.analyzed}</td><td>{r.negative ? <span class="delta down">{r.negative}</span> : "0"}</td><td>{r.replied}/{r.analyzed}</td><td class="small">{r.treatments.length ? r.treatments.slice(0, 4).map(([k, n]) => `${k} ${n}`).join(" · ") : <span class="muted">—</span>}</td><td class="small">{r.complaints.length ? r.complaints.slice(0, 4).map(([k, n]) => `${k} ${n}`).join(" · ") : <span class="muted">없음</span>}</td></tr>)}</tbody>
              </table></div>
              <div class="grid-2">
                <div><h3 class="h3">새 부정 신호 리뷰</h3>{d.reviews.recentNegative.length ? <ul class="plain small">{d.reviews.recentNegative.map((n) => <li><b>{n.entity}</b> <span class="muted">{n.written_at || ""}</span> · {n.complaints.join("·")}<br />{n.body.slice(0, 140)}</li>)}</ul> : <p class="muted small">최근 30일 없음</p>}</div>
                <div><h3 class="h3">우리 최근 리뷰</h3><ul class="plain small">{d.reviews.latest.map((r) => <li><span class="muted">{r.written_at || ""}</span> {r.body.slice(0, 90)}{r.treatments.length ? <small class="vol-badge"> {r.treatments.join("·")}</small> : null}</li>)}</ul></div>
              </div>
            </Sec>
          ) : null}

          {d.content.length ? (
            <Sec title="콘텐츠 도달" sub="유튜브 · 인스타그램 · 스레드 · 최근 30일">
              <div class="platform-cards">{d.content.map((x) => (
                <div class="pcard ok"><p class="tile-label">{x.label}{x.manual ? " · 수동" : ""}</p>
                  <div class="pscore"><span class="num">{x.views == null ? "—" : x.views.toLocaleString()}</span>{delta(x.views, x.prevViews)}</div><p class="muted small">30일 조회·도달</p>
                  <p class="small">구독·팔로워 <b>{x.followers?.toLocaleString() ?? "—"}</b> {delta(x.followers, x.prevFollowers)}</p>
                  {x.top.length ? <ul class="plain small muted">{x.top.slice(0, 3).map((t) => <li>{t.title.slice(0, 26)} · {t.views.toLocaleString()}</li>)}</ul> : null}
                </div>))}</div>
              <p class="muted small"><a href="/app/settings#content" class="text-link">계정 관리</a></p>
            </Sec>
          ) : null}

          {d.arrivals.length ? (
            <Sec title="실제 신환 경로" sub="페이션트 폼 접수 문진 · 주 단위 · 같은 주 플레이스 커버율과 나란히">
              <div class="table-scroll"><table class="matrix">
                <thead><tr><th>주</th><th>신환</th><th>검색</th><th class="muted">네이버 / 구글</th><th>AI</th><th>SNS</th><th>콘텐츠</th><th>소개</th><th>간판·근처</th><th>기타</th><th>플레이스 커버</th></tr></thead>
                <tbody>{d.arrivals.map((a) => <tr><td class="kw">{a.week_start.slice(5)}</td><td><b>{a.first_visits}</b>{a.answered < a.first_visits ? <small class="muted"> (응답 {a.answered})</small> : null}</td><td><b>{a.search}</b></td><td class="muted">{a.naver} / {a.google}</td><td>{a.ai}</td><td>{a.sns}</td><td>{a.content}</td><td>{a.referral}</td><td>{a.sign + a.nearby}</td><td>{a.other}</td><td>{a.coverage == null ? <span class="muted">—</span> : pct(a.coverage)}</td></tr>)}</tbody>
              </table></div>
              <p class="muted small">1단계 인지 지표 = 신환 중 검색·AI·SNS·콘텐츠 비중. 노출이 오르내릴 때 검색 신환이 따라오는지 4주 이상 보세요.</p>
            </Sec>
          ) : null}

          <Sec title="경보 · 측정 기록" sub={`경보 ${d.alerts.length} · 최근 실행 ${d.runs[0]?.run_date ?? "—"}`}>
            <div class="grid-2">
              <div>{d.alerts.length ? <ul class="alerts">{d.alerts.map((a) => <li class={a.severity}><span class="sev">{a.severity}</span>{a.message}<small class="muted">{a.created_at.slice(0, 10)}</small></li>)}</ul> : <p class="muted small">경보 없음</p>}</div>
              <div><ul class="runs">{d.runs.map((r) => <li><span>{r.run_date}</span><span class={"status " + r.status}>{r.status}</span><span class="muted small">{r.kind}{r.error ? " · " + r.error.slice(0, 60) : ""}</span></li>)}</ul></div>
            </div>
          </Sec>

          <Sec title="점수와 점유율은 이렇게 계산합니다">
            <ul class="plain defs">
              <li><b>키워드 점수</b> — 자연 순위(광고 제외): 1위 100 · 2~3위 80 · 4~5위 60 · 6~10위 30 · 그 밖 10 · 다른 섹션에만 보이면 15 · 미노출 0.</li>
              <li><b>플랫폼 점수</b> — 키워드 점수 평균. <b>온라인 가시성 점수</b> — 가중 평균(네이버 통합검색 35 · 플레이스 25 · 구글 20 · 카카오 10 · AI 10), 미측정 플랫폼은 분모 제외.</li>
              <li><b>수요 가중 점수</b> — 키워드 점수에 월 검색수를 곱해 평균. <b>점유율</b> — 우리 점수 합 ÷ (우리 + 경쟁 병원 점수 합).</li>
              <li><b>검색 기회</b> — 월 검색수 × 순위별 노출 확률의 합. 클릭 수가 아니라 "볼 기회"의 추정치. 놓친 기회 = 검색수 − 잡은 기회.</li>
              <li><b>미노출도 기록</b> — 안 보이는 것도 데이터. 「—」로 남기고 다음 주와 비교.</li>
            </ul>
          </Sec>
        </>
      )}
    </AppLayout>
  );
}

/* ───────── 설정 ───────── */
export function Settings({ h, hospital, keywords, competitors, settings, users, limits, platform, flash, social, err }: {
  h: { name: string; plan: string };
  hospital: { name: string; aliases: string; clinic_type: string; region: string; treatments: string; naver_place_id: string; website_url: string };
  keywords: { id: number; text: string; is_active: number; source: string; monthly_pc?: number | null; monthly_mobile?: number | null; volume_low?: number }[];
  competitors: { id: number; name: string; is_active: number; naver_place_id: string | null }[];
  settings: { report_email_enabled: number; report_recipients: string };
  users: { email: string; name: string | null; role: string }[];
  limits: (typeof PLAN_LIMITS)[Plan];
  platform: { naver: string; google: string; kakao: string; signal: string; mail: string };
  flash?: string | null;
  err?: string | null;
  social: { youtube: { input: string; title: string | null; enabled: boolean; channels: { id: string; title: string }[] }; instagram: { username: string | null; enabled: boolean }; threads: { username: string | null; enabled: boolean }; latest: Record<string, { followers: number | null; views: number | null; date: string; manual?: boolean }> };
}) {
  return (
    <AppLayout title="설정" hospital={h} active="/app/settings" flash={flash}>
      {err ? <div class="flash error">{err}</div> : null}
      <section class="card">
        <h2>병원</h2>
        <form method="post" action="/app/settings/hospital" class="form two-col">
          <label>병원 이름<input name="name" value={hospital.name} required maxlength={60} /></label>
          <label>별칭·지점명 (쉼표)<input name="aliases" value={hospital.aliases} maxlength={200} /></label>
          <label>진료과<select name="clinic_type">{CLINIC_TYPES.map((t) => <option value={t} selected={t === hospital.clinic_type}>{t}</option>)}</select></label>
          <label>지역<input name="region" value={hospital.region} maxlength={60} /></label>
          <label>주력 진료·시술 (쉼표)<input name="treatments" value={hospital.treatments} maxlength={200} /></label>
          <label>네이버 플레이스 ID<input name="naver_place_id" value={hospital.naver_place_id} maxlength={200} /></label>
          <label>홈페이지<input name="website_url" value={hospital.website_url} maxlength={200} /></label>
          <div><button class="button button-primary" type="submit">저장</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>키워드 <small class="muted">{keywords.filter((k) => k.is_active).length} / {limits.keywords}개 사용 중</small></h2></div>
        <form method="post" action="/app/settings/keywords" class="form">
          <div class="kw-grid">{keywords.map((k) => <label class="kw-item"><input type="checkbox" name="active" value={String(k.id)} checked={!!k.is_active} /> <span class="kw-text">{k.text}</span>{volText(k) ? <small class="vol-badge">월 {volText(k)}</small> : null}{k.source === "manual" ? <small class="muted"> 직접</small> : k.source === "related" ? <small class="muted"> 연관</small> : null}</label>)}</div>
          <label>추가 (한 줄에 하나)<textarea name="extra" rows={2}></textarea></label>
          <div class="row"><button class="button button-primary" type="submit">키워드 저장</button><button class="button button-outline" type="submit" name="regen" value="1">후보 다시 만들기 (검색량 순)</button></div>
          <p class="muted small">월 검색수 = 네이버 최근 30일 PC+모바일. 새 후보는 꺼진 상태로 추가되고 기존 선택은 유지됩니다.</p>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>경쟁 병원 <small class="muted">{competitors.filter((c) => c.is_active).length} / {limits.competitors}곳</small></h2></div>
        <form method="post" action="/app/settings/competitors" class="form">
          <div class="kw-grid">{competitors.map((c) => <label class="kw-item"><input type="checkbox" name="active" value={String(c.id)} checked={!!c.is_active} /> {c.name}{c.naver_place_id ? <small class="muted"> #{c.naver_place_id}</small> : null}</label>)}</div>
          <label>추가 (한 줄에 하나 · 이름 뒤에 <i>|플레이스ID</i> 를 붙이면 정확히 매칭)<textarea name="extra" rows={2} placeholder="더보스톤치과병원|672785300"></textarea></label>
          <div><button class="button button-primary" type="submit">경쟁사 저장</button></div>
        </form>
      </section>
      <section class="card" id="content">
        <h2>콘텐츠 계정 <small class="muted">3층 · 콘텐츠 도달(구독자·팔로워·30일 조회수)</small></h2>
        <div class="grid-2">
          <form method="post" action="/app/settings/youtube" class="form">
            <label>유튜브 채널 주소 (한 줄에 하나, 최대 5개){social.youtube.channels.length ? <small class="vol-badge">연결됨 · {social.youtube.channels.map((x) => x.title).join(" · ")}</small> : null}<textarea name="channels" rows={3} placeholder="https://www.youtube.com/@...">{social.youtube.input}</textarea></label>
            <div class="row"><button class="button button-primary button-small" type="submit" disabled={!social.youtube.enabled}>{social.youtube.enabled ? "저장" : "운영자 키 필요"}</button>{social.latest.youtube ? <span class="muted small">구독자 {social.latest.youtube.followers?.toLocaleString() ?? "—"} · 30일 조회 {social.latest.youtube.views?.toLocaleString() ?? "—"} ({social.latest.youtube.date})</span> : null}</div>
          </form>
          <div class="form">
            <div><b>인스타그램</b> {social.instagram.username ? <><span class="vol-badge">연결됨 · @{social.instagram.username}</span> <form method="post" action="/app/disconnect/instagram" class="inline"><button class="linklike">연결 해제</button></form></> : <a class={"button button-small " + (social.instagram.enabled ? "button-primary" : "button-outline")} href="/app/connect/instagram">{social.instagram.enabled ? "연결하기" : "Meta 앱 심사 후 열림"}</a>}
              {social.latest.instagram ? <p class="muted small">팔로워 {social.latest.instagram.followers?.toLocaleString() ?? "—"} · 30일 도달/조회 {social.latest.instagram.views?.toLocaleString() ?? "—"} ({social.latest.instagram.date}{social.latest.instagram.manual ? " · 수동" : ""})</p> : null}</div>
            <div><b>스레드</b> {social.threads.username ? <><span class="vol-badge">연결됨 · @{social.threads.username}</span> <form method="post" action="/app/disconnect/threads" class="inline"><button class="linklike">연결 해제</button></form></> : <a class={"button button-small " + (social.threads.enabled ? "button-primary" : "button-outline")} href="/app/connect/threads">{social.threads.enabled ? "연결하기" : "Meta 앱 심사 후 열림"}</a>}
              {social.latest.threads ? <p class="muted small">팔로워 {social.latest.threads.followers?.toLocaleString() ?? "—"} · 30일 조회 {social.latest.threads.views?.toLocaleString() ?? "—"} ({social.latest.threads.date}{social.latest.threads.manual ? " · 수동" : ""})</p> : null}</div>
            <details><summary class="muted small">연결 전 수동 입력 (인사이트 화면 숫자를 주 1회 옮겨 적기)</summary>
              <form method="post" action="/app/settings/social-manual" class="form two-col" style="margin-top:8px">
                <label>인스타 팔로워<input name="instagram_followers" inputmode="numeric" /></label><label>인스타 30일 도달<input name="instagram_reach" inputmode="numeric" /></label>
                <label>스레드 팔로워<input name="threads_followers" inputmode="numeric" /></label><label>스레드 30일 조회<input name="threads_views" inputmode="numeric" /></label>
                <div><button class="button button-small button-outline" type="submit">이번 주 값 저장</button></div>
              </form></details>
          </div>
        </div>
      </section>
      <section class="grid-2">
        <div class="card">
          <h2>주간 리포트 메일</h2>
          <form method="post" action="/app/settings/report" class="form">
            <label class="kw-item"><input type="checkbox" name="enabled" value="1" checked={!!settings.report_email_enabled} /> 매주 월요일 08:30 리포트 메일 받기</label>
            <p class="muted small">기본 수신: {users.map((u) => u.email).join(", ") || "—"}</p>
            <label>추가 수신자 (직원 이메일, 쉼표)<input name="recipients" value={JSON.parse(settings.report_recipients || "[]").join(", ")} maxlength={300} /></label>
            <div><button class="button button-primary" type="submit">저장</button></div>
          </form>
        </div>
        <div class="card">
          <h2>플랜 · 측정 플랫폼</h2>
          <p><span class="plan-chip">{h.plan}</span> 키워드 {limits.keywords} · 경쟁사 {limits.competitors} · 월 측정일 {limits.monthlyRunDays}일 · <a class="text-link" href="https://hub.patientfunnel.kr" target="_blank" rel="noopener">플랜 변경은 허브에서 ↗</a></p>
          <ul class="plain">
            <li>네이버: {platform.naver}</li><li>구글: {platform.google}</li><li>카카오맵: {platform.kakao}</li><li>AI(시그널): {platform.signal}</li><li>메일: {platform.mail}</li>
          </ul>
        </div>
      </section>
    </AppLayout>
  );
}

/* ───────── 리포트 ───────── */
export function ReportList({ h, weeks }: { h: { name: string; plan: string }; weeks: { week_start: string; score: number }[] }) {
  return (
    <AppLayout title="주간 리포트" hospital={h} active="/app/reports">
      <section class="card"><h1>주간 리포트</h1>{weeks.length ? <ul class="plain">{weeks.map((w) => <li><a class="text-link" href={"/app/reports/" + w.week_start}>{w.week_start} 주 · {fmt(w.score, 1)}점</a></li>)}</ul> : <p class="muted">아직 없습니다. 첫 측정 후 생깁니다.</p>}</section>
    </AppLayout>
  );
}
export function ReportView({ h, r }: { h: { name: string; plan: string }; r: ReportContent }) {
  return (
    <AppLayout title={r.week + " 주 리포트"} hospital={h} active="/app/reports">
      <section class="card narrow report">
        <p class="eyebrow">WEEKLY REPORT · {r.week}</p>
        <h1>{r.hospital}</h1>
        <div class="score-hero"><span class="score-big">{fmt(r.total, 1)}</span><span class="score-cap">/ 100</span>{delta(r.total, r.prevTotal)}</div>
        {r.opportunity ? (<>
          <h2>검색 기회 <small class="muted">네이버 플레이스</small></h2>
          <p>월 <b>{r.opportunity.pool.toLocaleString()}</b>회 검색 중 우리가 보인 기회 <b>{r.opportunity.captured.toLocaleString()}</b>회 ({pct(r.opportunity.coverage)}{r.opportunity.prevCoverage != null ? <span class="muted">, 지난주 {pct(r.opportunity.prevCoverage)}</span> : null})</p>
          <table class="matrix"><thead><tr><th>놓친 기회</th><th>월 검색</th><th>우리</th><th>놓침</th><th>3위 진입 시</th></tr></thead><tbody>{r.opportunity.lost.map((x) => <tr><td>{x.keyword}</td><td>{x.volume.toLocaleString()}</td><td>{rankCell(x.rank, false)}</td><td><b>{x.lost.toLocaleString()}</b></td><td class="muted">{x.gainTop3 > 0 ? "+" + x.gainTop3.toLocaleString() : "—"}</td></tr>)}</tbody></table>
        </>) : null}
        <h2>플랫폼별</h2>
        <table class="matrix"><tbody>{r.platforms.map((p) => <tr><td>{p.label}</td><td><b>{fmt(p.score, 1)}</b></td><td>{delta(p.score, p.prev)}</td><td class="muted">{p.sov != null ? "점유율 " + pct(p.sov) : ""}</td></tr>)}</tbody></table>
        {r.up.length ? <><h2>올라간 키워드</h2><ul class="plain">{r.up.map((k) => <li>{k.keyword} <small class="muted">{k.platform}</small> {k.from ?? "—"}위 → <b>{k.to ?? "—"}위</b></li>)}</ul></> : null}
        {r.down.length ? <><h2>내려간 키워드</h2><ul class="plain">{r.down.map((k) => <li>{k.keyword} <small class="muted">{k.platform}</small> {k.from ?? "—"}위 → <b>{k.to ?? "—"}위</b></li>)}</ul></> : null}
        {r.reputation.length ? <><h2>평판</h2><ul class="plain">{r.reputation.map((x) => <li>{x.entity} · {x.platform} 리뷰 {x.reviews?.toLocaleString() ?? "—"}{x.prevReviews != null && x.reviews != null ? <small class="muted"> ({x.reviews - x.prevReviews >= 0 ? "+" : ""}{x.reviews - x.prevReviews})</small> : null}</li>)}</ul></> : null}
        {r.alerts.length ? <><h2>경보</h2><ul class="alerts">{r.alerts.map((a) => <li class={a.severity}><span class="sev">{a.severity}</span>{a.message}</li>)}</ul></> : null}
        {r.notes.length ? <div class="notice-inline">{r.notes.map((n) => <p>{n}</p>)}</div> : null}
        <p class="muted small">다음 측정 예정: {r.nextRun} 주</p>
      </section>
    </AppLayout>
  );
}

/* ───────── 어드민 ───────── */
export function AdminLogin({ error }: { error?: string }) {
  return (
    <AppLayout title="운영" hospital={{ name: "운영자", plan: "ADMIN" }} active="">
      <section class="card narrow"><h1>운영자 로그인</h1>{error ? <p class="error">{error}</p> : null}<form method="post" action="/admin/login" class="form"><label>ADMIN_SECRET<input type="password" name="secret" required /></label><button class="button button-primary" type="submit">들어가기</button></form></section>
    </AppLayout>
  );
}
export function AdminPage({ hospitals, runs, alerts, config, flash }: { hospitals: Record<string, unknown>[]; runs: Record<string, unknown>[]; alerts: Record<string, unknown>[]; config: Record<string, unknown>; flash?: string | null }) {
  return (
    <AppLayout title="운영" hospital={{ name: "운영자", plan: "ADMIN" }} active="" flash={flash}>
      <section class="card"><h1>운영</h1><p class="muted small">설정: {Object.entries(config).map(([k, v]) => `${k}=${v}`).join(" · ")}</p></section>
      <section class="card"><h2>병원</h2><div class="table-scroll"><table class="matrix"><thead><tr><th>id</th><th>병원</th><th>hid</th><th>플랜</th><th>온보딩</th><th>키워드</th><th>마지막 측정</th><th>이번 주</th><th></th></tr></thead>
        <tbody>{hospitals.map((x) => <tr><td>{String(x.id)}</td><td>{String(x.name)}</td><td class="muted small">{String(x.ps_hospital_id ?? "")}</td>
          <td><form method="post" action={"/admin/plan/" + x.id} class="inline"><select name="plan">{["FREE", "S", "M", "L"].map((p) => <option value={p} selected={p === x.plan}>{p}</option>)}</select><button class="button button-small button-outline">저장</button></form></td>
          <td>{x.onboarded_at ? "✓" : "—"}</td><td>{String(x.keywords)}</td><td class="small">{String(x.last_run ?? "—")} {String(x.last_status ?? "")}</td><td>{x.week_score == null ? "—" : String(x.week_score)}</td>
          <td><form method="post" action={"/admin/run/" + x.id} class="inline"><button class="button button-small button-primary">지금 측정</button></form> <form method="post" action={"/admin/form-key/" + x.id} class="inline"><input type="password" name="key" placeholder={x.has_form_key ? "폼 키 설정됨 · 교체" : "폼 연동 키 pfk_…"} style="width:150px" /><button class="button button-small button-outline">저장</button></form></td></tr>)}</tbody></table></div></section>
      <section class="grid-2">
        <div class="card"><h2>최근 실행</h2><ul class="runs">{runs.map((r) => <li><span>{String(r.run_date)} #{String(r.hospital_id)}</span><span class={"status " + r.status}>{String(r.status)}</span><span class="muted small">{String(r.kind)} {r.error ? String(r.error).slice(0, 80) : ""}</span></li>)}</ul></div>
        <div class="card"><h2>경보</h2><ul class="alerts">{alerts.map((a) => <li class={String(a.severity)}><span class="sev">{String(a.severity)}</span>#{String(a.hospital_id ?? "-")} {String(a.message)}<small class="muted">{String(a.created_at).slice(0, 16)}</small></li>)}</ul>
          <form method="post" action="/admin/clear-pause" class="inline"><button class="button button-small button-outline">네이버 수집 일시중단 해제</button></form></div>
      </section>
    </AppLayout>
  );
}
