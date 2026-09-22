// Conservative robots gate. Unknown/unavailable policy is never treated as permission.
export const ROBOT_TOKEN = "PatientRadar";
type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[]; delay: number };
export type RobotsDecision = {
  allowed: boolean;
  reason: string;
  matchedRule: string | null;
  crawlDelayMs: number;
};
function normalizePath(value: string): string {
  return value
    .replace(/%[0-9a-f]{2}/gi, (hex) => {
      const char = String.fromCharCode(parseInt(hex.slice(1), 16));
      return /[a-z0-9\-._~]/i.test(char) ? char : hex.toUpperCase();
    })
    .replace(/[^\x00-\x7F]/gu, (c) => encodeURIComponent(c));
}
export function evaluateRobots(
  text: string,
  url: string,
  token = ROBOT_TOKEN,
): RobotsDecision {
  const groups: Group[] = [];
  let current: Group | undefined;
  let hasDirectives = false;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const clean = line.split("#")[0].trim();
    const colon = clean.indexOf(":");
    if (colon < 0) continue;
    const key = clean.slice(0, colon).trim().toLowerCase();
    const value = clean.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || hasDirectives) {
        current = { agents: [], rules: [], delay: 0 };
        groups.push(current);
        hasDirectives = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current && ["allow", "disallow", "crawl-delay"].includes(key)) {
      hasDirectives = true;
      if (key === "crawl-delay") {
        const delay = Number(value);
        if (Number.isFinite(delay) && delay >= 0)
          current.delay = Math.max(current.delay, delay * 1000);
      } else if (value)
        current.rules.push({
          allow: key === "allow",
          pattern: normalizePath(value),
        });
    }
  }
  const name = token.toLowerCase();
  const specificity = (g: Group) =>
    Math.max(
      -1,
      ...g.agents.map((a) =>
        a === "*" ? 0 : name.includes(a) && a ? a.length : -1,
      ),
    );
  const best = Math.max(-1, ...groups.map(specificity));
  const matching = groups.filter((g) => specificity(g) === best && best >= 0);
  const path = normalizePath(new URL(url).pathname + new URL(url).search);
  let winner: Rule | undefined;
  let length = -1;
  for (const rule of matching.flatMap((g) => g.rules)) {
    const regex =
      "^" +
      rule.pattern
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")
        .replace(/\\\$$/, "$");
    if (!new RegExp(regex).test(path)) continue;
    const n = new TextEncoder().encode(
      rule.pattern.replace(/[*$]/g, ""),
    ).length;
    if (n > length || (n === length && rule.allow)) {
      winner = rule;
      length = n;
    }
  }
  return {
    allowed: !winner || winner.allow,
    reason: winner && !winner.allow ? "ROBOTS_DISALLOWED" : "ROBOTS_ALLOWED",
    matchedRule: winner
      ? (winner.allow ? "Allow: " : "Disallow: ") + winner.pattern
      : null,
    crawlDelayMs: Math.max(0, ...matching.map((g) => g.delay)),
  };
}
export async function checkRobots(
  target: string,
  fetchImpl: typeof fetch = fetch,
) {
  const url = new URL("/robots.txt", target).href;
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": `${ROBOT_TOKEN}/0.1`, Accept: "text/plain" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410)
      return {
        url,
        httpStatus: res.status,
        allowed: true,
        reason: "ROBOTS_NOT_FOUND",
        matchedRule: null,
        crawlDelayMs: 0,
      };
    if (!res.ok)
      return {
        url,
        httpStatus: res.status,
        allowed: false,
        reason: "ROBOTS_UNAVAILABLE",
        matchedRule: null,
        crawlDelayMs: 0,
      };
    const body = await res.text();
    if (
      body.length > 512000 ||
      /<html|<!doctype|captcha|자동입력\s*방지/i.test(body)
    )
      return {
        url,
        httpStatus: res.status,
        allowed: false,
        reason: "ROBOTS_INVALID",
        matchedRule: null,
        crawlDelayMs: 0,
      };
    return { url, httpStatus: res.status, ...evaluateRobots(body, target) };
  } catch {
    return {
      url,
      httpStatus: null,
      allowed: false,
      reason: "ROBOTS_UNAVAILABLE",
      matchedRule: null,
      crawlDelayMs: 0,
    };
  }
}
