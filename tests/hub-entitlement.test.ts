import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index";
import { pickEntitlement, effectivePlan, hubPlanLine, getHubEntitlement, withHubPlan } from "../src/lib/hub-entitlement";
import type { Bindings } from "../src/lib/config";

// Synthetic values only.
const secret = "synthetic-unit-test-credential-not-a-production-secret";
const future = new Date(Date.now() + 30 * 86400_000).toISOString();
const past = new Date(Date.now() - 86400_000).toISOString();
const deleted: string[] = [];
const fakeDb = () =>
  ({
    prepare: (sql: string) => ({
      args: [] as unknown[],
      bind(...a: unknown[]) { this.args = a; return this; },
      first: async () => { if (sql.includes("hub_entitlement_cache")) throw new Error("no such table"); return null; },
      all: async () => ({ results: [] }),
      async run() { if (sql.startsWith("DELETE FROM hub_entitlement_cache")) deleted.push(String(this.args[0])); return { success: true }; },
    }),
  }) as unknown as D1Database;

test("allpass active S is picked; expired/canceled ignored; service overrides allpass", () => {
  assert.equal(pickEntitlement({ allpass: { tier: "S", status: "active", ends_at: future }, services: {} })?.tier, "S");
  assert.equal(pickEntitlement({ allpass: { tier: "M", status: "cancel_at_period_end", ends_at: future } })?.tier, "M");
  assert.equal(pickEntitlement({ allpass: { tier: "L", status: "active", ends_at: past } }), null);
  assert.equal(pickEntitlement({ allpass: { tier: "L", status: "past_due", ends_at: future } }), null);
  assert.equal(pickEntitlement({ allpass: null, services: {} }), null);
  const e = pickEntitlement({ allpass: { tier: "L", status: "active", ends_at: future }, services: { radar: { tier: "M", status: "active", ends_at: future } } });
  assert.equal(e?.tier, "M"); assert.equal(e?.via, "service");
});

test("effective plan only upgrades", () => {
  const ent = pickEntitlement({ allpass: { tier: "M", status: "active", ends_at: future } });
  assert.equal(effectivePlan("FREE", ent), "M");
  assert.equal(effectivePlan("S", ent), "M");
  assert.equal(effectivePlan("L", ent), "L");
  assert.equal(effectivePlan("S", null), "S");
});

test("settings line mentions grant", () => {
  const ent = pickEntitlement({ allpass: { tier: "S", status: "active", source: "grant", ends_at: "2027-09-26T00:00:00.000Z" } });
  assert.equal(hubPlanLine(ent), "허브 올패스 S 적용 중 · 2027-09-26까지 · 올인원 수강생 무료 제공");
  assert.equal(hubPlanLine(null), null);
});

test("hub failure keeps local plan", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
  try {
    const env = { DB: fakeDb(), HUB_API_KEY: secret } as unknown as Bindings;
    assert.equal(await getHubEntitlement(env, "hid-x"), null);
    const h = await withHubPlan(env, { plan: "S", ps_hospital_id: "hid-x" });
    assert.equal(h.plan, "S"); assert.equal(h.local_plan, "S");
  } finally { globalThis.fetch = orig; }
});

test("hub active allpass upgrades plan at decision time", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ allpass: { tier: "L", status: "active", source: "grant", ends_at: future, trial: false }, services: {} }), { status: 200 })) as typeof fetch;
  try {
    const env = { DB: fakeDb(), HUB_API_KEY: secret } as unknown as Bindings;
    const h = await withHubPlan(env, { plan: "S", ps_hospital_id: "hid-y" });
    assert.equal(h.plan, "L"); assert.equal(h.local_plan, "S");
  } finally { globalThis.fetch = orig; }
});

test("hub-events requires PS_SSO_SECRET and clears cache on subscription_updated", async () => {
  const env = { DB: fakeDb(), PS_SSO_SECRET: secret };
  const post = (auth: string, body: unknown) => app.request("https://example.test/api/v1/hub-events", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
  assert.equal((await post("Bearer wrong", { type: "subscription_updated", ps_hospital_id: "h1" })).status, 401);
  assert.equal((await post(`Bearer ${secret}`, { type: "subscription_updated" })).status, 400);
  const ok = await post(`Bearer ${secret}`, { type: "subscription_updated", ps_hospital_id: "h1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, type: "subscription_updated", cleared: true });
  assert.ok(deleted.includes("h1"));
  const prof = await post(`Bearer ${secret}`, { type: "profile_updated", ps_hospital_id: "h2" });
  assert.equal(prof.status, 200); assert.ok(!deleted.includes("h2"));
});
