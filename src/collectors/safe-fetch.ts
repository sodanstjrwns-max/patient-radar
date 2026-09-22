import { checkRobots } from "../lib/robots";
export class CollectionError extends Error {
  constructor(
    public code: string,
    public httpStatus: number | null = null,
  ) {
    super(code);
  }
}
export const politeDelay = async (minimumMs = 0) => {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(minimumMs, 3000 + Math.random() * 4000)),
  );
};
// No proxy, browser challenge solving, or unchecked redirect path is supported.
export const safeNaverFetch: typeof fetch = async (input, init) => {
  let url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  for (let hop = 0; hop < 4; hop++) {
    if (
      url.protocol !== "https:" ||
      !["m.search.naver.com", "m.place.naver.com"].includes(url.hostname)
    )
      throw new CollectionError("UNAPPROVED_HOST");
    const policy = await checkRobots(url.href);
    if (!policy.allowed)
      throw new CollectionError(policy.reason, policy.httpStatus);
    // Very long delays need scheduling rather than an open HTTP request.
    if (policy.crawlDelayMs > 60000)
      throw new CollectionError("CRAWL_DELAY_REQUIRES_SCHEDULER");
    await politeDelay(policy.crawlDelayMs);
    const headers = new Headers(init?.headers);
    headers.set(
      "User-Agent",
      (headers.get("User-Agent") || "") + " PatientRadar/0.1",
    );
    const res = await fetch(url.href, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("Location");
      await res.body?.cancel();
      if (!location) throw new CollectionError("INVALID_REDIRECT");
      url = new URL(location, url);
      continue;
    }
    if ([401, 403, 429].includes(res.status)) {
      await res.body?.cancel();
      throw new CollectionError("HTTP_BLOCKED", res.status);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new CollectionError("HTTP_ERROR", res.status);
    }
    const html = await res.text();
    if (
      /captcha|자동입력\s*방지|비정상적인\s*(검색|접근)/i.test(html) &&
      html.length < 50000
    )
      throw new CollectionError("CAPTCHA_BLOCKED", res.status);
    return new Response(html, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "text/html",
      },
    });
  }
  throw new CollectionError("TOO_MANY_REDIRECTS");
};
