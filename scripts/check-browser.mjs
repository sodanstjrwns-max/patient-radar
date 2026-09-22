import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const origin = process.env.TEST_ORIGIN || "http://localhost:3000";
await mkdir("artifacts/screenshots", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const results = [];
try {
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const path of ["/", "/pricing", "/terms", "/privacy", "/refund"]) {
      const response = await page.goto(origin + path, {
        waitUntil: "networkidle",
      });
      assert.equal(response.status(), 200);
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page.evaluate(() => ({
        viewport: innerWidth,
        width: document.documentElement.scrollWidth,
        mode: document.compatMode,
        h1: document.querySelectorAll("h1").length,
      }));
      assert.equal(metrics.mode, "CSS1Compat");
      assert.equal(metrics.h1, 1);
      assert.ok(
        metrics.width <= metrics.viewport,
        `Overflow ${path} at ${width}: ${metrics.width}`,
      );
      results.push({
        path,
        viewport: width,
        status: response.status(),
        horizontalOverflow: false,
        mode: metrics.mode,
      });
      if (path === "/" && [1440, 390].includes(width))
        await page.screenshot({
          path: `artifacts/screenshots/landing-${width}.png`,
          fullPage: true,
        });
    }
    await page.goto(origin);
    await page.locator(".hero-actions .button-primary").click();
    await page
      .getByRole("heading", { name: "허브 연결을 준비하고 있습니다." })
      .waitFor();
    assert.ok(page.url().endsWith("/api/auth/hub"));
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(
    "artifacts/browser-checks.json",
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) +
      "\n",
  );
  console.log(
    JSON.stringify({
      pageChecks: results.length,
      viewports: [1440, 768, 390, 320],
      consoleErrors: 0,
      overflow: 0,
      hubNotReadyNavigation: "passed",
    }),
  );
} finally {
  await browser.close();
}
