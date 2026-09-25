// 서버 렌더 SVG 차트 — 스크립트 없음(CSP). 선 그래프·누적 막대. 값이 없는 점은 건너뛴다.
export type Series = { label: string; color: string; points: { x: string; y: number | null }[] };
const fmtK = (v: number) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}k` : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v * 10) / 10));

export function LineChart({ series, height = 180, yMax, yMin = 0, unit = "", percent = false }: { series: Series[]; height?: number; yMax?: number; yMin?: number; unit?: string; percent?: boolean }) {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  if (!xs.length) return <p class="muted small">데이터 없음</p>;
  const W = 720, H = height, padL = 44, padR = 16, padT = 14, padB = 30;
  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((v): v is number => v != null);
  const max = yMax ?? Math.max(1, ...all) * 1.1, min = yMin;
  const x = (i: number) => padL + (xs.length === 1 ? (W - padL - padR) / 2 : (i / (xs.length - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const ticks = [0, 0.5, 1].map((t) => min + (max - min) * t);
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
        {ticks.map((t) => <g><line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="rgba(60,40,20,.10)" /><text x={padL - 6} y={y(t) + 4} font-size="10" text-anchor="end" fill="#6f675f">{percent ? Math.round(t * 100) + "%" : fmtK(t) + unit}</text></g>)}
        {xs.map((d, i) => (xs.length <= 8 || i % Math.ceil(xs.length / 8) === 0 || i === xs.length - 1) ? <text x={x(i)} y={H - 8} font-size="10" text-anchor="middle" fill="#6f675f">{d.slice(5)}</text> : null)}
        {series.map((s) => {
          const pts = xs.map((d, i) => { const p = s.points.find((q) => q.x === d); return p && p.y != null ? { i, v: p.y } : null; }).filter((p): p is { i: number; v: number } => !!p);
          if (!pts.length) return null;
          const path = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
          return <g><path d={path} fill="none" stroke={s.color} stroke-width="2.2" stroke-linejoin="round" />{pts.map((p) => <circle cx={x(p.i)} cy={y(p.v)} r="3.2" fill={s.color} />)}{pts.length ? <text x={x(pts[pts.length - 1].i) + 6} y={y(pts[pts.length - 1].v) + 4} font-size="10" fill={s.color}>{percent ? Math.round(pts[pts.length - 1].v * 100) + "%" : fmtK(pts[pts.length - 1].v)}</text> : null}</g>;
        })}
      </svg>
      <div class="legend">{series.map((s) => <span><i style={`background:${s.color}`} />{s.label}</span>)}</div>
    </div>
  );
}

export function StackedBars({ groups, keys, colors, height = 160 }: { groups: { x: string; values: Record<string, number> }[]; keys: string[]; colors: Record<string, string>; height?: number }) {
  if (!groups.length) return <p class="muted small">데이터 없음</p>;
  const W = 720, H = height, padL = 34, padR = 10, padT = 10, padB = 28;
  const totals = groups.map((g) => keys.reduce((a, k) => a + (g.values[k] || 0), 0));
  const max = Math.max(1, ...totals);
  const bw = Math.min(56, ((W - padL - padR) / groups.length) * 0.6);
  const x = (i: number) => padL + ((i + 0.5) / groups.length) * (W - padL - padR) - bw / 2;
  const hOf = (v: number) => (v / max) * (H - padT - padB);
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
        {groups.map((g, i) => { let acc = 0; return <g>{keys.map((k) => { const v = g.values[k] || 0; const hh = hOf(v); acc += hh; return v ? <rect x={x(i)} y={H - padB - acc} width={bw} height={hh} fill={colors[k]} rx="2" /> : null; })}<text x={x(i) + bw / 2} y={H - 8} font-size="10" text-anchor="middle" fill="#6f675f">{g.x.slice(5)}</text><text x={x(i) + bw / 2} y={H - padB - acc - 4} font-size="10" text-anchor="middle" fill="#1d1a17">{totals[i]}</text></g>; })}
      </svg>
      <div class="legend">{keys.map((k) => <span><i style={`background:${colors[k]}`} />{k}</span>)}</div>
    </div>
  );
}
