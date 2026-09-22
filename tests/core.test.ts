import test from "node:test";
import assert from "node:assert/strict";
import { rankScore, platformScore, totalScore } from "../src/lib/scoring";
import { evaluateRobots, checkRobots } from "../src/lib/robots";
import { kstDate, kstIso, weekStart } from "../src/lib/time";
import {
  analyzeSerp,
  parsePlaceCards,
  isBlockedHtml,
} from "../src/collectors/naver-serp";
import {
  parsePlaceHome,
  collectNaverPlace,
} from "../src/collectors/naver-place";
import { publicOrigin } from "../src/lib/config";
import { PLANS } from "../src/lib/pricing";
import { equalSecret } from "../src/lib/security";

// Synthetic parser fixtures, never used by the UI or persisted as observations.
const card = (id: string, name: string, segment = "hospital") =>
  `<a href="https://m.place.naver.com/${segment}/${id}?entry=pll"><span>${name}</span></a>`;
for (const [rank, score] of [
  [1, 100],
  [2, 80],
  [3, 80],
  [4, 60],
  [5, 60],
  [6, 30],
  [10, 30],
  [11, 10],
  [100, 10],
]) {
  test(`rank ${rank} yields ${score}`, () =>
    assert.equal(rankScore(rank), score));
}
test("absence, elsewhere, and ad-only remain distinct", () => {
  assert.equal(rankScore(null), 0);
  assert.equal(rankScore(null, true), 15);
  assert.equal(rankScore(null, true, true), 0);
});
test("invalid ranks are rejected", () => {
  for (const rank of [0, -1, 1.1, NaN, Infinity])
    assert.throws(() => rankScore(rank));
});
test("unmeasured platform is not a zero", () =>
  assert.equal(totalScore({ naver_serp: 60, google: null }), 60));
test("empty aggregate is unmeasured", () => {
  assert.equal(totalScore({}), null);
  assert.equal(platformScore([]).score, null);
});
test("measured zero remains in denominator", () =>
  assert.equal(totalScore({ naver_serp: 60, naver_place: 0 }), 35));
test("known weights are deterministic", () => {
  for (let i = 0; i < 10; i++)
    assert.equal(totalScore({ naver_serp: 80, naver_place: 100 }), 88.3);
});
test("invalid scores and unknown platforms rejected", () => {
  assert.throws(() => totalScore({ naver_serp: NaN }));
  assert.throws(() => totalScore({ google_serp: 50 }));
  assert.throws(() =>
    platformScore([{ keyword: "test", self: 101, competitors: {} }]),
  );
});
test("no competitors means no SOV", () =>
  assert.deepEqual(
    platformScore([{ keyword: "test", self: 80, competitors: {} }]),
    { score: 80, sov: null, shown: 1 },
  ));
test("SOV requires identical keyword and competitor sets", () => {
  assert.equal(
    platformScore([
      { keyword: "a", self: 100, competitors: { a: 100 } },
      { keyword: "b", self: 0, competitors: { a: 0 } },
    ]).sov,
    0.5,
  );
  assert.throws(() =>
    platformScore([
      { keyword: "a", self: 100, competitors: { a: 10 } },
      { keyword: "b", self: 80, competitors: { b: 10 } },
    ]),
  );
});
test("all-zero SOV is undefined", () =>
  assert.equal(
    platformScore([{ keyword: "a", self: 0, competitors: { a: 0 } }]).sov,
    null,
  ));
test("robots disallow root applies to crawler", () =>
  assert.equal(
    evaluateRobots(
      "User-agent: *\nDisallow: /",
      "https://m.search.naver.com/search.naver?q=test",
    ).allowed,
    false,
  ));
test("robots exact longest allow wins", () => {
  const policy =
    "User-agent: *\nDisallow: /\nAllow: /public\nDisallow: /public/private";
  assert.equal(
    evaluateRobots(policy, "https://example.test/public/ok").allowed,
    true,
  );
  assert.equal(
    evaluateRobots(policy, "https://example.test/public/private").allowed,
    false,
  );
});
test("robots allow wins at equal specificity", () =>
  assert.equal(
    evaluateRobots(
      "User-agent: *\nDisallow: /x\nAllow: /x",
      "https://example.test/x",
    ).allowed,
    true,
  ));
test("robots wildcard and end anchor", () => {
  const policy = "User-agent: *\nDisallow: /*.pdf$";
  assert.equal(
    evaluateRobots(policy, "https://example.test/a.pdf").allowed,
    false,
  );
  assert.equal(
    evaluateRobots(policy, "https://example.test/a.pdf/other").allowed,
    true,
  );
});
test("robots groups never impersonate Yeti", () =>
  assert.equal(
    evaluateRobots(
      "User-agent: Yeti\nAllow: /\nUser-agent: *\nDisallow: /",
      "https://example.test/",
    ).allowed,
    false,
  ));
test("robots specific product group is respected", () => {
  const d = evaluateRobots(
    "User-agent: PatientRadar\nDisallow: /private\nCrawl-delay: 12\nUser-agent: *\nDisallow: /",
    "https://example.test/public",
  );
  assert.equal(d.allowed, true);
  assert.equal(d.crawlDelayMs, 12000);
});
test("robots combines repeated groups", () =>
  assert.equal(
    evaluateRobots(
      "User-agent: *\nDisallow: /x\nUser-agent: *\nDisallow: /y",
      "https://example.test/y",
    ).allowed,
    false,
  ));
test("robots percent-encoded unreserved path is normalized", () =>
  assert.equal(
    evaluateRobots(
      "User-agent: *\nDisallow: /%70rivate",
      "https://example.test/private",
    ).allowed,
    false,
  ));
test("robots HTTP 429 fails closed", async () =>
  assert.equal(
    (
      await checkRobots(
        "https://example.test/",
        async () => new Response("", { status: 429 }),
      )
    ).allowed,
    false,
  ));
test("robots 404 means no robots file", async () =>
  assert.equal(
    (
      await checkRobots(
        "https://example.test/",
        async () => new Response("", { status: 404 }),
      )
    ).allowed,
    true,
  ));
test("robots challenge is not a valid policy", async () =>
  assert.equal(
    (
      await checkRobots(
        "https://example.test/",
        async () => new Response("<html>captcha</html>"),
      )
    ).allowed,
    false,
  ));
test("robots network failure fails closed", async () =>
  assert.equal(
    (
      await checkRobots("https://example.test/", async () => {
        throw new Error("synthetic");
      })
    ).allowed,
    false,
  ));
test("robots redirect is not followed blindly", async () =>
  assert.equal(
    (
      await checkRobots(
        "https://example.test/",
        async () =>
          new Response("", {
            status: 302,
            headers: { Location: "/challenge" },
          }),
      )
    ).allowed,
    false,
  ));
test("KST rollover and week boundary", () => {
  const date = new Date("2026-09-20T15:00:00Z");
  assert.equal(kstDate(date), "2026-09-21");
  assert.equal(weekStart(date), "2026-09-21");
  assert.equal(kstIso(date), "2026-09-21T00:00:00.000+09:00");
  assert.equal(weekStart(new Date("2026-09-20T14:59:59Z")), "2026-09-14");
});
test("parser recognizes hospital and place paths", () =>
  assert.equal(
    parsePlaceCards(
      card("101", "Synthetic A") + card("102", "Synthetic B", "place"),
    ).length,
    2,
  ));
test("parser deduplicates repeated cards", () =>
  assert.equal(
    parsePlaceCards(card("101", "Synthetic A") + card("101", "Synthetic A"))
      .length,
    1,
  ));
test("known place ID beats same-name wrong branch", () => {
  const parsed = analyzeSerp(
    "fixture",
    card("101", "Synthetic Clinic") + card("102", "Synthetic Clinic"),
    [{ key: "self", name: "Synthetic Clinic", aliases: [], placeId: "102" }],
  );
  assert.equal(parsed.entities.self.placeRank, 2);
});
test("ad and natural appearance can coexist", () => {
  const html =
    card("101", "Synthetic Clinic") +
    "m.place.naver.com%2Fhospital%2F101%3Fentry%3Dpll%26from%3DPLACE_AD";
  const parsed = analyzeSerp("fixture", html, [
    { key: "self", name: "Synthetic Clinic", aliases: [], placeId: "101" },
  ]);
  assert.equal(parsed.entities.self.placeRank, 1);
  assert.equal(parsed.entities.self.placeAd, true);
});
test("absent entity remains absent", () => {
  const parsed = analyzeSerp("fixture", card("101", "Synthetic A"), [
    { key: "self", name: "Missing Clinic", aliases: [], placeId: "102" },
  ]);
  assert.equal(parsed.entities.self.shown, false);
  assert.equal(parsed.entities.self.placeRank, null);
});
test("short CAPTCHA HTML triggers block with no cards", () => {
  assert.equal(isBlockedHtml("자동입력 방지"), true);
  const parsed = analyzeSerp(
    "fixture",
    "captcha" + card("101", "Synthetic A"),
    [],
  );
  assert.equal(parsed.blocked, true);
  assert.deepEqual(parsed.placeCards, []);
});
test("review parser returns only public counters, missing is null", () => {
  const r = parsePlaceHome(
    "101",
    '<meta property="og:description" content="방문자리뷰 1,234 · 블로그리뷰 56">',
  );
  assert.equal(r.visitorReviews, 1234);
  assert.equal(r.blogReviews, 56);
  assert.equal(parsePlaceHome("101", "").visitorReviews, null);
});
test("invalid place ID never reaches network", async () => {
  let fetched = false;
  await assert.rejects(
    collectNaverPlace("../x", async () => {
      fetched = true;
      return new Response("");
    }),
  );
  assert.equal(fetched, false);
});
test("PUBLIC_ORIGIN is HTTPS and configurable", () => {
  assert.equal(publicOrigin({}), "https://patientradar.kr");
  assert.equal(
    publicOrigin({ PUBLIC_ORIGIN: "https://example.test/" }),
    "https://example.test",
  );
  assert.throws(() => publicOrigin({ PUBLIC_ORIGIN: "http://example.test" }));
});
test("prices are deliberately unconfirmed", () =>
  assert.equal(
    PLANS.every((p) => p.monthlyPrice === null),
    true,
  ));
test("secret comparison rejects mismatch", async () => {
  assert.equal(await equalSecret("synthetic-test-a", "synthetic-test-a"), true);
  assert.equal(
    await equalSecret("synthetic-test-a", "synthetic-test-b"),
    false,
  );
});
