// 네이버 검색광고 키워드도구 — 키워드별 월간 검색수(최근 30일, PC·모바일). 공식 API, 무료.
// 서명: HMAC-SHA256(secret, `${ts}.${method}.${path}`) base64. 힌트 키워드는 호출당 5개, 공백 제거해서 보낸다.
export type SearchAdEnv = { NAVER_SEARCHAD_KEY: string; NAVER_SEARCHAD_SECRET: string; NAVER_SEARCHAD_CUSTOMER: string };
export type Volume = { keyword: string; pc: number | null; mobile: number | null; low: boolean; found: boolean };

const enc = new TextEncoder();
async function sign(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
const num = (v: unknown): { n: number | null; low: boolean } => {
  if (typeof v === "number") return { n: v, low: false };
  if (typeof v === "string") { const m = /^\s*<\s*(\d+)/.exec(v); if (m) return { n: Math.floor(Number(m[1]) / 2), low: true }; const x = Number(v); return { n: Number.isFinite(x) ? x : null, low: false }; }
  return { n: null, low: false };
};

export async function fetchVolumes(keywords: string[], env: SearchAdEnv, fetchImpl: typeof fetch = fetch): Promise<Volume[]> {
  const out: Volume[] = [];
  for (let i = 0; i < keywords.length; i += 5) {
    const chunk = keywords.slice(i, i + 5);
    const hints = chunk.map((w) => w.replace(/\s+/g, ""));
    const path = "/keywordstool";
    const ts = Date.now().toString();
    const res = await fetchImpl(`https://api.searchad.naver.com${path}?hintKeywords=${encodeURIComponent(hints.join(","))}&showDetail=1`, {
      headers: { "X-Timestamp": ts, "X-API-KEY": env.NAVER_SEARCHAD_KEY, "X-Customer": env.NAVER_SEARCHAD_CUSTOMER, "X-Signature": await sign(env.NAVER_SEARCHAD_SECRET, `${ts}.GET.${path}`) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`SEARCHAD_HTTP_${res.status}`);
    const j = (await res.json()) as { keywordList?: { relKeyword: string; monthlyPcQcCnt: unknown; monthlyMobileQcCnt: unknown }[] };
    const list = j.keywordList || [];
    chunk.forEach((kw, idx) => {
      const hit = list.find((k) => k.relKeyword === hints[idx]);
      if (!hit) { out.push({ keyword: kw, pc: null, mobile: null, low: false, found: false }); return; }
      const pc = num(hit.monthlyPcQcCnt), mo = num(hit.monthlyMobileQcCnt);
      out.push({ keyword: kw, pc: pc.n, mobile: mo.n, low: pc.low || mo.low, found: true });
    });
    if (i + 5 < keywords.length) await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

/** 힌트 키워드 묶음으로 연관 키워드 전체(검색수 포함)를 모은다 — 키워드 후보 발굴용 */
export type KeywordIdea = { keyword: string; pc: number | null; mobile: number | null; low: boolean };
export async function fetchKeywordIdeas(seeds: string[], env: SearchAdEnv, fetchImpl: typeof fetch = fetch): Promise<KeywordIdea[]> {
  const map = new Map<string, KeywordIdea>();
  const hints = [...new Set(seeds.map((w) => w.replace(/\s+/g, "")).filter(Boolean))];
  for (let i = 0; i < hints.length; i += 5) {
    const chunk = hints.slice(i, i + 5);
    const path = "/keywordstool";
    const ts = Date.now().toString();
    const res = await fetchImpl(`https://api.searchad.naver.com${path}?hintKeywords=${encodeURIComponent(chunk.join(","))}&showDetail=1`, {
      headers: { "X-Timestamp": ts, "X-API-KEY": env.NAVER_SEARCHAD_KEY, "X-Customer": env.NAVER_SEARCHAD_CUSTOMER, "X-Signature": await sign(env.NAVER_SEARCHAD_SECRET, `${ts}.GET.${path}`) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`SEARCHAD_HTTP_${res.status}`);
    const j = (await res.json()) as { keywordList?: { relKeyword: string; monthlyPcQcCnt: unknown; monthlyMobileQcCnt: unknown }[] };
    for (const k of j.keywordList || []) {
      const pc = num(k.monthlyPcQcCnt), mo = num(k.monthlyMobileQcCnt);
      if (!map.has(k.relKeyword)) map.set(k.relKeyword, { keyword: k.relKeyword, pc: pc.n, mobile: mo.n, low: pc.low || mo.low });
    }
    if (i + 5 < hints.length) await new Promise((r) => setTimeout(r, 400));
  }
  return [...map.values()];
}
