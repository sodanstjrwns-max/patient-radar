import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import app from "../src/index";
import type { Bindings } from "../src/lib/config";
import {
  adminAuthorized,
  issueAdminSession,
  issueHospitalSession,
} from "../src/lib/security";
// Only synthetic unit-test environment; no production keys or hospital records.
const syntheticKey = "synthetic-unit-test-credential-not-a-production-secret";
const fakeDb = (found: unknown = null) =>
  ({
    prepare: () => ({
      bind() {
        return this;
      },
      first: async () => found,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
  }) as unknown as D1Database;
const env = (values: Partial<Bindings> = {}) => ({ DB: fakeDb(), ...values });
const request = (
  path: string,
  init: RequestInit = {},
  values: Partial<Bindings> = {},
) => app.request("https://example.test" + path, init, env(values));
test("landing is honest and contains no example hospital ranks", async () => {
  const r = await request("/");
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /실제 대시보드나 측정 결과가 아닙니다/);
  assert.match(text, /가입·결제·정기 측정은 제공하지 않습니다/);
  assert.doesNotMatch(text, /8154|8,154|35스마트플란트|365아홉/);
  assert.match(text, /noindex,nofollow/);
});
test("pricing does not publish proposal prices", async () => {
  const text = await (await request("/pricing")).text();
  assert.match(text, /금액 안내 준비/);
  assert.doesNotMatch(text, /59,000|129,000|249,000/);
});
for (const path of ["/terms", "/privacy", "/refund"])
  test(`${path} is marked draft`, async () => {
    const r = await request(path);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /검토용 초안/);
  });
test("unavailable SSO is not a fake success", async () =>
  assert.equal((await request("/api/auth/hub")).status, 503));
test("forged SSO token does not authenticate", async () =>
  assert.equal(
    (await request("/api/auth/hub/callback?sso_token=forged")).status,
    503,
  ));
test("unavailable app has no sample tenant data", async () =>
  assert.equal((await request("/app")).status, 503));
test("admin missing key fails closed", async () =>
  assert.equal((await request("/api/admin/summary")).status, 503));
test("admin summary requires correct key", async () =>
  assert.equal(
    (await request("/api/admin/summary", {}, { ADMIN_SECRET: syntheticKey }))
      .status,
    401,
  ));
test("probe is not public", async () =>
  assert.equal(
    (
      await request(
        "/api/admin/probe/naver",
        { method: "POST" },
        { ADMIN_SECRET: syntheticKey, PROBE_ENABLED: "true" },
      )
    ).status,
    401,
  ));
test("disabled probe cannot execute even with key", async () => {
  const r = await request(
    "/api/admin/probe/naver",
    { method: "POST", headers: { Authorization: "Bearer " + syntheticKey } },
    { ADMIN_SECRET: syntheticKey, PROBE_ENABLED: "false" },
  );
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as any).error.code, "PROBE_DISABLED");
});
test("supply API missing configured key returns 503", async () =>
  assert.equal((await request("/api/v1/signals")).status, 503));
test("supply API mismatched key returns 401", async () =>
  assert.equal(
    (
      await request(
        "/api/v1/signals",
        { headers: { Authorization: "Bearer wrong" } },
        { PS_SERVICE_KEY: syntheticKey },
      )
    ).status,
    401,
  ));
test("supply API missing hospital header returns structured 400", async () => {
  const r = await request(
    "/api/v1/signals",
    { headers: { Authorization: "Bearer " + syntheticKey } },
    { PS_SERVICE_KEY: syntheticKey },
  );
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as any).error.code, "MISSING_HOSPITAL_ID");
});
test("supply API unmapped hospital returns 404", async () => {
  const r = await request(
    "/api/v1/signals",
    {
      headers: {
        Authorization: "Bearer " + syntheticKey,
        "X-PS-Hospital-Id": "synthetic-hospital",
      },
    },
    { PS_SERVICE_KEY: syntheticKey },
  );
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as any).error.code, "HOSPITAL_NOT_MAPPED");
});
test("supply API mapped hospital still returns not ready until contract implemented", async () => {
  const r = await request(
    "/api/v1/signals",
    {
      headers: {
        Authorization: "Bearer " + syntheticKey,
        "X-PS-Hospital-Id": "synthetic-hospital",
      },
    },
    { PS_SERVICE_KEY: syntheticKey, DB: fakeDb({ id: 1 }) },
  );
  assert.equal(r.status, 503);
});
test("cron missing key returns 503", async () =>
  assert.equal(
    (await request("/api/cron/run-hospital/1", { method: "POST" })).status,
    503,
  ));
test("cron rejects mismatched key", async () =>
  assert.equal(
    (
      await request(
        "/api/cron/run-hospital/1",
        { method: "POST", headers: { "x-cron-secret": "wrong" } },
        { CRON_SECRET: syntheticKey },
      )
    ).status,
    401,
  ));
test("cron never runs before collection verification", async () =>
  assert.equal(
    (
      await request(
        "/api/cron/run-hospital/1",
        { method: "POST", headers: { "x-cron-secret": syntheticKey } },
        { CRON_SECRET: syntheticKey },
      )
    ).status,
    503,
  ));
test("unknown API returns structured 404", async () => {
  const r = await request("/api/unknown");
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as any).error.code, "NOT_FOUND");
});
test("API responses are not cached", async () =>
  assert.equal(
    (await request("/api/v1/signals")).headers.get("Cache-Control"),
    "no-store",
  ));
test("security headers protect framing and credentials", async () => {
  const r = await request("/");
  assert.match(
    r.headers.get("Content-Security-Policy")!,
    /frame-ancestors 'none'/,
  );
  assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
});
test("admin HMAC session rejects tampering", async () => {
  const auth = new Hono<{ Bindings: Bindings }>();
  auth.get("/issue", async (c) => {
    await issueAdminSession(c);
    return c.text("ok");
  });
  auth.get("/check", async (c) =>
    c.json({ authorized: await adminAuthorized(c) }),
  );
  const e = env({ ADMIN_SECRET: syntheticKey });
  const issued = await auth.request("https://example.test/issue", {}, e);
  const cookie = issued.headers.get("Set-Cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const valid = await auth.request(
    "https://example.test/check",
    { headers: { Cookie: cookie.split(";")[0] } },
    e,
  );
  assert.equal(((await valid.json()) as any).authorized, true);
  const tampered = await auth.request(
    "https://example.test/check",
    { headers: { Cookie: cookie.split(";")[0] + "x" } },
    e,
  );
  assert.equal(((await tampered.json()) as any).authorized, false);
});
test("hospital session signer has correct cookie properties but is not wired to fake SSO", async () => {
  const auth = new Hono<{ Bindings: Bindings }>();
  auth.get("/issue", async (c) => {
    await issueHospitalSession(c, 1, 1);
    return c.text("ok");
  });
  const r = await auth.request(
    "https://example.test/issue",
    {},
    env({ PS_SSO_SECRET: syntheticKey }),
  );
  const cookie = r.headers.get("Set-Cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=1209600/);
});
