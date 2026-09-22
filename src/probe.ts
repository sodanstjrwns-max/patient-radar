import { Hono } from "hono";
import type { Bindings } from "./lib/config";
import { adminAuthorized, sameOrigin } from "./lib/security";
import { checkRobots } from "./lib/robots";
import { kstDate, kstIso } from "./lib/time";
import { analyzeSerp, NAVER_MOBILE_UA, serpUrl } from "./collectors/naver-serp";
import { politeDelay } from "./collectors/safe-fetch";

const probe = new Hono<{ Bindings: Bindings }>();
probe.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!c.env.ADMIN_SECRET)
    return c.json(
      {
        error: {
          code: "ADMIN_NOT_CONFIGURED",
          message: "운영 인증 설정이 필요합니다.",
        },
      },
      503,
    );
  if (!(await adminAuthorized(c)))
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "운영자 인증이 필요합니다." } },
      401,
    );
  if (
    c.req.method !== "GET" &&
    !c.req.header("Authorization") &&
    !sameOrigin(c)
  )
    return c.json(
      {
        error: {
          code: "INVALID_ORIGIN",
          message: "동일 출처 요청만 허용됩니다.",
        },
      },
      403,
    );
  await next();
});
probe.get("/latest", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id,status,result_json,started_at,finished_at FROM probe_runs ORDER BY started_at DESC LIMIT 1",
  ).first<{
    id: string;
    status: string;
    result_json: string;
    started_at: string;
    finished_at: string;
  }>();
  return c.json({
    data: row ? { ...row, result_json: JSON.parse(row.result_json) } : null,
  });
});
probe.post("/naver", async (c) => {
  if (c.env.PROBE_ENABLED !== "true")
    return c.json(
      {
        error: {
          code: "PROBE_DISABLED",
          message: "임시 실측 도구가 비활성화되어 있습니다.",
        },
      },
      403,
    );
  const now = Date.now(),
    id = crypto.randomUUID(),
    date = kstDate();
  const lock = await c.env.DB.prepare(
    `INSERT INTO operation_locks(name,owner,expires_at) VALUES('naver-global',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE operation_locks.expires_at < ? RETURNING owner`,
  )
    .bind(id, now + 900_000, now)
    .first<{ owner: string }>();
  if (lock?.owner !== id)
    return c.json(
      {
        error: {
          code: "COLLECTION_BUSY",
          message: "다른 수집 작업이 실행 중입니다.",
        },
      },
      409,
    );
  const report: Record<string, unknown> = {
    id,
    keyword: "천안 임플란트",
    environment: "cloudflare-pages",
    startedAt: kstIso(),
    status: "running",
    targetRequests: 0,
    attempts: [],
  };
  let inserted = false;
  try {
    const pause = await c.env.DB.prepare(
      "SELECT reason FROM collection_pauses WHERE scope='naver' AND until_date>=?",
    )
      .bind(date)
      .first<{ reason: string }>();
    if (pause)
      return c.json(
        {
          error: {
            code: "COLLECTION_PAUSED_TODAY",
            message: "차단 감지로 오늘 수집을 중단했습니다.",
          },
        },
        409,
      );
    await c.env.DB.prepare("INSERT INTO probe_runs(id,started_at) VALUES(?,?)")
      .bind(id, report.startedAt)
      .run();
    inserted = true;
    const target = serpUrl("천안 임플란트");
    const searchPolicy = await checkRobots(target);
    await politeDelay();
    const placePolicy = await checkRobots(
      "https://m.place.naver.com/place/1541238930/home",
    );
    report.robots = { search: searchPolicy, place: placePolicy };
    const robotsRateLimited = [
      searchPolicy.httpStatus,
      placePolicy.httpStatus,
    ].some((status) => status === 429 || status === 403 || status === 401);
    report.robotsRateLimited = robotsRateLimited;
    if (!searchPolicy.allowed) {
      report.status =
        searchPolicy.reason === "ROBOTS_DISALLOWED"
          ? "policy_blocked"
          : "policy_unverified";
      report.stopReason = searchPolicy.reason;
      report.remainingAttemptsSkipped = 3;
    } else if (robotsRateLimited) {
      report.status = "blocked";
      report.stopReason = "ROBOTS_HTTP_BLOCKED";
      report.remainingAttemptsSkipped = 3;
    } else if (searchPolicy.crawlDelayMs > 60000) {
      report.status = "policy_blocked";
      report.stopReason = "CRAWL_DELAY_REQUIRES_SCHEDULER";
    } else {
      const attempts: Record<string, unknown>[] = [];
      report.attempts = attempts;
      for (let i = 0; i < 3; i++) {
        await politeDelay(searchPolicy.crawlDelayMs);
        const start = Date.now();
        const response = await fetch(target, {
          headers: {
            "User-Agent": NAVER_MOBILE_UA + " PatientRadar/0.1",
            "Accept-Language": "ko-KR,ko;q=0.9",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(25000),
        });
        report.targetRequests = i + 1;
        const item: Record<string, unknown> = {
          attempt: i + 1,
          httpStatus: response.status,
          fetchedAt: kstIso(),
        };
        attempts.push(item);
        if (!response.ok) {
          await response.body?.cancel();
          item.htmlLength = null;
          item.cardCount = null;
          report.status = [401, 403, 429].includes(response.status)
            ? "blocked"
            : "failed";
          report.stopReason = [301, 302, 303, 307, 308].includes(
            response.status,
          )
            ? "REDIRECT_REQUIRES_RECHECK"
            : "HTTP_" + response.status;
          break;
        }
        const html = await response.text();
        const parsed = analyzeSerp("천안 임플란트", html, []);
        Object.assign(item, {
          htmlLength: html.length,
          cardCount: parsed.placeCards.filter((card) => !card.isAd).length,
          blocked: parsed.blocked,
          durationMs: Date.now() - start,
        });
        if (parsed.blocked) {
          report.status = "blocked";
          report.stopReason = "CAPTCHA_BLOCKED";
          break;
        }
        // An unknown DOM is a parser failure, never evidence of hospital non-exposure.
        if (!parsed.placeCards.some((card) => !card.isAd)) {
          report.status = "parse_unverified";
          report.stopReason = "NO_NATURAL_CARDS";
          break;
        }
      }
      if (report.status === "running") report.status = "passed";
    }
    if (report.status !== "passed") {
      await c.env.DB.prepare(
        "INSERT INTO alerts(severity,code,message,detail,created_at) VALUES(?,?,?,?,?)",
      )
        .bind(
          "critical",
          String(report.stopReason),
          "네이버 실측을 중단했습니다. 우회 수집은 실행하지 않았습니다.",
          JSON.stringify({ probeId: id }),
          kstIso(),
        )
        .run();
    }
    if (report.status === "blocked" || robotsRateLimited) {
      await c.env.DB.prepare(
        "INSERT INTO collection_pauses(scope,until_date,reason,updated_at) VALUES('naver',?,?,?) ON CONFLICT(scope) DO UPDATE SET until_date=excluded.until_date,reason=excluded.reason,updated_at=excluded.updated_at",
      )
        .bind(date, String(report.stopReason), kstIso())
        .run();
    }
  } catch {
    report.status = "failed";
    report.stopReason = "PROBE_EXECUTION_FAILED";
    // Never serialize raw fetch errors: some providers embed credentials in request URLs.
  } finally {
    report.finishedAt = kstIso();
    try {
      if (inserted)
        await c.env.DB.prepare(
          "UPDATE probe_runs SET status=?,result_json=?,finished_at=? WHERE id=?",
        )
          .bind(
            String(report.status),
            JSON.stringify(report),
            report.finishedAt,
            id,
          )
          .run();
    } finally {
      await c.env.DB.prepare(
        "DELETE FROM operation_locks WHERE name='naver-global' AND owner=?",
      )
        .bind(id)
        .run();
    }
  }
  return c.json(
    { data: report },
    report.status === "passed" ? 200 : report.status === "failed" ? 502 : 424,
  );
});
export default probe;
