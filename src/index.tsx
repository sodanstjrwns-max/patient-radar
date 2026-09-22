import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/cloudflare-workers";
import { VERSION, type Bindings } from "./lib/config";
import { adminAuthorized, equalSecret } from "./lib/security";
import { kstIso } from "./lib/time";
import { Landing, Pricing, Legal, StatusPage } from "./views";
import probe from "./probe";
const app = new Hono<{ Bindings: Bindings }>();
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
    referrerPolicy: "no-referrer",
  }),
);
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("/static/*", serveStatic({ root: "./public" }));
app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1 FROM hospitals LIMIT 1").all();
    return c.json({
      status: "ok",
      version: VERSION,
      stage: "foundation",
      database: "ready",
      serviceReady: false,
    });
  } catch {
    return c.json(
      {
        status: "degraded",
        version: VERSION,
        database: "unavailable",
        serviceReady: false,
      },
      503,
    );
  }
});
app.get("/", (c) => c.html(<Landing />));
app.get("/pricing", (c) => c.html(<Pricing />));
for (const kind of ["terms", "privacy", "refund"] as const)
  app.get("/" + kind, (c) => c.html(<Legal kind={kind} />));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
app.get("/favicon.ico", (c) => c.body(null, 204));
app.get("/api/auth/hub", (c) =>
  c.html(
    <StatusPage
      heading="허브 연결을 준비하고 있습니다."
      text="공통 SSO 검증 원본과 허브 서비스 등록을 기다리고 있습니다. 현재 로그인·가입·무료 체험은 시작되지 않습니다."
    />,
    503,
  ),
);
app.get("/api/auth/hub/callback", (c) =>
  c.json(
    {
      error: {
        code: "SSO_NOT_CONFIGURED",
        message: "공통 SSO 검증 원본 및 허브 등록이 필요합니다.",
      },
    },
    503,
  ),
);
app.get("/app", (c) =>
  c.html(
    <StatusPage
      heading="첫 측정 전입니다."
      text="병원 데이터는 허브 인증 이후에만 볼 수 있습니다. 지금은 수집 및 로그인 연동 검증 단계입니다."
    />,
    503,
  ),
);
app.get("/app/*", (c) =>
  c.html(
    <StatusPage
      heading="서비스 연결 대기"
      text="로그인 연동과 수집 검증 후 이용할 수 있습니다."
    />,
    503,
  ),
);
app.get("/admin", (c) =>
  c.html(
    <StatusPage
      heading="운영 화면 준비 중"
      text="보호된 운영 API로 발판을 검증하고 있습니다. 운영 화면은 이후 단계에서 제공됩니다."
    />,
    503,
  ),
);
app.route("/api/admin/probe", probe);
app.get("/api/admin/summary", async (c) => {
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
  const [hospital, runs, alerts] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM hospitals").first(),
    c.env.DB.prepare(
      "SELECT id,status,started_at,finished_at FROM probe_runs ORDER BY started_at DESC LIMIT 5",
    ).all(),
    c.env.DB.prepare(
      "SELECT severity,code,message,created_at FROM alerts ORDER BY id DESC LIMIT 10",
    ).all(),
  ]);
  return c.json({
    data: {
      hospital,
      probeRuns: runs.results,
      alerts: alerts.results,
      configuration: {
        ssoSecret: !!c.env.PS_SSO_SECRET,
        ssoVerifier: false,
        serviceKey: !!c.env.PS_SERVICE_KEY,
        cronSecret: !!c.env.CRON_SECRET,
        probeEnabled: c.env.PROBE_ENABLED === "true",
      },
    },
  });
});
// Fail-closed PS API contract. Success payload awaits the original common PS v1 specification.
app.get("/api/v1/signals", async (c) => {
  const error = (
    code: string,
    message: string,
    status: 400 | 401 | 404 | 503,
  ) => c.json({ error: { code, message } }, status);
  if (!c.env.PS_SERVICE_KEY)
    return error(
      "SERVICE_KEY_NOT_CONFIGURED",
      "공급 API 키가 설정되지 않았습니다.",
      503,
    );
  const bearer = c.req.header("Authorization") || "";
  if (
    !bearer.startsWith("Bearer ") ||
    !(await equalSecret(bearer.slice(7), c.env.PS_SERVICE_KEY))
  )
    return error("UNAUTHORIZED", "유효한 공급 API 인증이 필요합니다.", 401);
  const hid = c.req.header("X-PS-Hospital-Id")?.trim();
  if (!hid)
    return error("MISSING_HOSPITAL_ID", "병원 ID 헤더가 필요합니다.", 400);
  if (hid.length > 200)
    return error(
      "INVALID_HOSPITAL_ID",
      "병원 ID 길이가 올바르지 않습니다.",
      400,
    );
  const hospital = await c.env.DB.prepare(
    "SELECT id FROM hospitals WHERE ps_hospital_id=?",
  )
    .bind(hid)
    .first();
  if (!hospital)
    return error("HOSPITAL_NOT_MAPPED", "연결된 병원이 없습니다.", 404);
  return error(
    "SIGNALS_NOT_READY",
    "측정 및 공급 API 성공 응답 규약 확인이 필요합니다.",
    503,
  );
});
app.post("/api/cron/run-hospital/:id", async (c) => {
  if (!c.env.CRON_SECRET)
    return c.json(
      {
        error: {
          code: "CRON_NOT_CONFIGURED",
          message: "크론 시크릿이 필요합니다.",
        },
      },
      503,
    );
  if (
    !(await equalSecret(c.req.header("x-cron-secret") || "", c.env.CRON_SECRET))
  )
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "크론 인증이 필요합니다." } },
      401,
    );
  return c.json(
    {
      error: {
        code: "COLLECTION_NOT_READY",
        message:
          "실측과 수집 허용 여부 확인 전에는 병원 수집을 실행하지 않습니다.",
      },
    },
    503,
  );
});
app.notFound((c) =>
  c.req.path.startsWith("/api/")
    ? c.json(
        { error: { code: "NOT_FOUND", message: "존재하지 않는 API입니다." } },
        404,
      )
    : c.html(
        <StatusPage
          heading="페이지를 찾을 수 없습니다."
          text="주소를 확인하거나 홈으로 돌아가 주세요."
        />,
        404,
      ),
);
app.onError((_err, c) =>
  c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "요청 처리에 실패했습니다.",
        at: kstIso(),
      },
    },
    500,
  ),
);
export default app;
