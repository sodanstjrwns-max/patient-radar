import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/cloudflare-workers";
import { VERSION, platformAvailability, type Bindings } from "./lib/config";
import { kstIso } from "./lib/time";
import { Landing, Pricing, Legal, StatusPage } from "./views";
import auth from "./routes/auth";
import appRoutes from "./routes/app";
import api from "./routes/cron";
import social from "./routes/social";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"], fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
    imgSrc: ["'self'", "data:"], scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], baseUri: ["'self'"],
  },
  referrerPolicy: "no-referrer",
}));
app.use("/api/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
app.use("/app/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
app.use("/static/*", serveStatic({ root: "./public" }));

app.get("/health", async (c) => {
  const a = platformAvailability(c.env);
  const ready = !!c.env.PS_SSO_SECRET && !!c.env.CRON_SECRET && (a.naver || a.google || a.kakao);
  try {
    await c.env.DB.prepare("SELECT 1 FROM hospitals LIMIT 1").all();
    return c.json({ status: "ok", version: VERSION, database: "ready", serviceReady: ready, platforms: { naver: a.naverMode || false, google: a.google, kakao: a.kakao, signal: a.signal } });
  } catch {
    return c.json({ status: "degraded", version: VERSION, database: "unavailable", serviceReady: false }, 503);
  }
});
app.get("/", (c) => c.html(<Landing />));
app.get("/pricing", (c) => c.html(<Pricing />));
for (const kind of ["terms", "privacy", "refund"] as const) app.get("/" + kind, (c) => c.html(<Legal kind={kind} />));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /app\nDisallow: /admin\nDisallow: /api\n"));
app.get("/favicon.ico", (c) => c.body(null, 204));
app.get("/google17dbe9a80407755e.html", (c) => c.text("google-site-verification: google17dbe9a80407755e.html"));

app.route("/", auth);
app.route("/", social);
app.route("/", appRoutes);
app.route("/", api);

app.notFound((c) => c.req.path.startsWith("/api/")
  ? c.json({ error: { code: "NOT_FOUND", message: "존재하지 않는 API입니다." } }, 404)
  : c.html(<StatusPage heading="페이지를 찾을 수 없습니다." text="주소를 확인하거나 홈으로 돌아가 주세요." />, 404));
app.onError((e, c) => {
  console.log("[radar error]", c.req.method, c.req.path, String(e).slice(0, 300));
  return c.json({ error: { code: "INTERNAL_ERROR", message: "요청 처리에 실패했습니다.", at: kstIso() } }, 500);
});
export default app;
