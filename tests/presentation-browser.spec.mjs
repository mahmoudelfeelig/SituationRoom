import { test, expect } from "@playwright/test";

function collectErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response ${response.status()}: ${response.url()}`);
  });
  return errors;
}

test("Chrome renders and interacts with all four compiled layouts", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await page.goto("/tests/presentation-preview.html", { waitUntil: "networkidle" });
  await expect(page.locator('[data-layout-pattern="trace"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Which option best satisfies our declared constraints?" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-investigate.png"), fullPage: true });

  const expected = { compare: "matrix", simulate: "fork", brief: "council", investigate: "trace" };
  for (const [lens, pattern] of Object.entries(expected)) {
    await page.getByRole("button", { name: lens }).click();
    await expect(page.locator(`[data-layout-pattern="${pattern}"]`)).toBeVisible();
  }

  await page.getByRole("button", { name: "brief" }).click();
  const briefAlignment = await page.evaluate(() => {
    const heading = document.querySelector(".compiled-view-heading").getBoundingClientRect();
    const mandate = document.querySelector(".council-mandate-plane .decision-instrument").getBoundingClientRect();
    return { headingBottom: heading.bottom, mandateTop: mandate.top };
  });
  expect(briefAlignment.mandateTop - briefAlignment.headingBottom).toBeLessThan(96);

  await page.getByRole("button", { name: "compare" }).click();
  await expect(page.getByRole("table").first()).toBeVisible();
  await page.getByRole("button", { name: "investigate" }).click();
  await page.getByRole("button", { name: "Trace" }).first().click();
  await expect(page.locator(".preview-action-receipt")).toContainText('"type":"focus"');

  await page.getByRole("button", { name: "simulate" }).click();
  const range = page.getByLabel("Hypothetical total cost");
  await expect(range).toBeVisible();
  await range.fill("300000");
  await expect(page.locator(".preview-action-receipt")).toContainText('"value":300000');
  expect(errors, errors.join("\n")).toEqual([]);
});

test("Chrome mobile layout keeps complete context reachable without page overflow", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tests/presentation-preview.html", { waitUntil: "networkidle" });

  for (const lens of ["investigate", "compare", "simulate", "brief"]) {
    await page.getByRole("button", { name: lens }).click();
    const technicalDetails = page.locator(".compiled-view-record");
    await expect(technicalDetails).toBeVisible();
    if (!(await technicalDetails.evaluate((element) => element.open))) {
      await technicalDetails.getByText("Technical view details").click();
    }
    await expect(technicalDetails.locator(".compiled-view-receipt")).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  }

  await page.getByRole("button", { name: "compare" }).click();
  const comparisonRegion = page.getByRole("region", { name: "Compare the options" });
  await expect(comparisonRegion).toBeVisible();
  await comparisonRegion.focus();
  await expect(comparisonRegion).toBeFocused();
  const stageOverflow = await page.locator(".preview-stage").evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(stageOverflow.scrollWidth).toBeLessThanOrEqual(stageOverflow.clientWidth + 1);
  await page.getByRole("button", { name: "investigate" }).click();
  const evidenceLedger = page.getByRole("region", { name: /Evidence excerpts, 9 saved items/ });
  await expect(evidenceLedger).toBeVisible();
  await evidenceLedger.focus();
  await expect(evidenceLedger).toBeFocused();
  const evidenceContainment = await evidenceLedger.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(evidenceContainment.scrollHeight).toBeGreaterThan(evidenceContainment.clientHeight);
  await page.getByRole("button", { name: "brief" }).click();
  await page.screenshot({ path: testInfo.outputPath("mobile-brief.png"), fullPage: true });
  expect(errors, errors.join("\n")).toEqual([]);
});
