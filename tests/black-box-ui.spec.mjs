import { expect, test } from "@playwright/test";

const CASE_NAMES = Object.freeze({
  procurement: /Emergency Communications Platform/i,
  candidate: /Senior Frontend Engineer Evidence Review/i,
  health: /Household Health-Plan Comparison/i,
  generic: /Portable Workstation Choice/i,
});
const browserErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([]);
});

async function waitForRoom(page) {
  await expect(page.locator(".decision-os")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.evaluate(() => ({
    boot: window.__situationRoom?.getState?.().bootStatus,
    composition: window.__situationRoom?.getState?.().compositionPhase,
  })), { timeout: 15_000 }).toEqual({ boot: "ready", composition: "idle" });
}

async function openRoom(page, path = "/") {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await waitForRoom(page);
}

async function openRoomControls(page) {
  const toggle = page.getByRole("button", { name: "Room controls", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.locator("#os-utility-menu")).toHaveClass(/is-open/);
}

async function clickRoomControl(page, name) {
  await openRoomControls(page);
  const control = page.locator("#os-utility-menu").getByRole("button", { name });
  await control.click();
  return control;
}

async function openNewDecision(page) {
  const link = page.locator(".os-new-docket");
  if (await link.isVisible()) await link.click();
  else await clickRoomControl(page, /New decision/);
  await expect(page).toHaveURL(/\/new$/);
}

async function openSourceArchive(page) {
  const spineControl = page.locator(".os-spine-utilities").getByRole("button", { name: /^Sources/ });
  if (await spineControl.isVisible()) {
    await spineControl.click();
    return spineControl;
  }
  return clickRoomControl(page, /Source archive/);
}

async function followLens(page, name) {
  await page.locator(".os-lens-tabs").getByRole("link", { name }).click();
}

async function followWorkflow(page, name) {
  await page.locator(".os-workflow-tabs").getByRole("link", { name }).click();
}

async function expandFirewall(page) {
  const details = page.locator("details.os-firewall-details");
  if (!await details.evaluate((element) => element.open)) await details.locator(":scope > summary").click();
  return details;
}

async function expandViewHistory(page) {
  const details = page.locator("details.os-history-rail");
  if (!await details.evaluate((element) => element.open)) await details.locator(":scope > summary").click();
  return details;
}

async function roomState(page) {
  return page.evaluate(() => {
    const room = window.__situationRoom.getState();
    return {
      caseId: room.activeCase.id,
      title: room.activeCase.title,
      domainId: room.activeCase.domain.packId,
      decisionRevision: room.activeCase.revision,
      decisionJson: JSON.stringify(room.activeCase),
      decisionHash: room.snapshot.decisionHash,
      contractStatus: room.activeCase.contract.status,
      viewRevision: room.viewRevision,
      lens: room.lens,
      layout: room.plan?.layout?.pattern,
      historyLength: room.history.length,
      frozen: room.frozen,
      capabilityPhase: room.capabilityPhase,
      pins: room.pins.length,
      instruments: room.plan?.instruments?.map((instrument) => instrument.type) ?? [],
      activeImportReview: room.activeImportReview?.job?.id ?? null,
      persistenceMode: room.persistenceMode,
    };
  });
}

async function switchCase(page, name, domainId) {
  const switcher = page.locator(".os-case-switcher details");
  if (!await switcher.evaluate((element) => element.open)) await switcher.locator(":scope > summary").click();
  await switcher.getByRole("link", { name }).click();
  await expect.poll(async () => (await roomState(page)).domainId).toBe(domainId);
  await waitForRoom(page);
}

async function openSmallGenericImportReview(page, title) {
  await openNewDecision(page);
  const dialog = page.getByRole("dialog", { name: "Construct a new decision room" });
  await dialog.getByLabel("Room title").fill(title);
  await dialog.getByLabel("What should the room help decide?").fill("Compare two choices using verified cost and readiness evidence.");
  await dialog.getByLabel("Decision domain").selectOption("generic");
  await dialog.getByLabel("Or paste source text").fill("name,cost,ready\nAlpha,10,yes\nBeta,20,no");
  await dialog.getByRole("button", { name: /Inspect and propose contract/ }).click();
  await expect(dialog.getByRole("heading", { name: "Decision Contract" })).toBeVisible({ timeout: 20_000 });
  return dialog;
}

async function failIndexedDbSourceDeletion(page) {
  await page.evaluate(() => {
    window.__situationRoomOriginalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function blockedSituationRoomDelete(key) {
      if (["blobs", "documents"].includes(this.name)) throw new DOMException(`Simulated deletion failure for ${String(key)}`, "UnknownError");
      return window.__situationRoomOriginalDelete.call(this, key);
    };
  });
}

async function restoreIndexedDbSourceDeletion(page) {
  await page.evaluate(() => {
    if (window.__situationRoomOriginalDelete) {
      IDBObjectStore.prototype.delete = window.__situationRoomOriginalDelete;
      delete window.__situationRoomOriginalDelete;
    }
  });
}

test("the Living Caseboard opens with its governance shell and no startup errors", async ({ page }) => {
  await openRoom(page);
  await expect(page.getByRole("heading", { name: "SituationRoom", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/analyze\/investigate$/);
  await expect(page.getByRole("complementary", { name: "Case file navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Decision views" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Case workflow" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Decision Firewall" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Authority rail" })).toBeHidden();
  await expandFirewall(page);
  await expect(page.getByRole("heading", { name: "Authority rail" })).toBeVisible();
  await expect(page.getByRole("region", { name: "View history" })).toBeVisible();
  await expect(page.locator(".os-red-thread")).toHaveCount(1);
  await expect(page.locator(".os-case-tab")).toHaveCount(4);
  expect((await roomState(page)).domainId).toBe("procurement");
});

test("a health-plan comparison deep link restores the case, lens, and analysis surface", async ({ page }) => {
  await openRoom(page, "/cases/health-plan-demo/analyze/compare");
  await expect(page).toHaveURL(/\/cases\/health-plan-demo\/analyze\/compare$/);
  const restored = await roomState(page);
  expect(restored).toMatchObject({
    caseId: "health-plan-demo",
    domainId: "health-plan",
    capabilityPhase: "analysis",
    lens: "compare",
    layout: "matrix",
  });
  await expect(page.locator('.os-lens-tabs a[aria-current="page"]')).toContainText("Aligned comparison");
  await expect(page.locator('[data-layout-pattern="matrix"]')).toBeVisible();
  await expect(page.locator(".compiled-room-view")).toHaveCount(1);
  await expect(page.locator(".os-workflow-desk")).toHaveCount(0);
});

test("the decision archive is an isolated route instead of another stacked room rail", async ({ page }) => {
  await openRoom(page, "/cases");
  await expect(page).toHaveURL(/\/cases$/);
  await expect(page.getByRole("heading", { name: "Open a case file" })).toBeVisible();
  await expect(page.locator(".os-archive-ledger > li")).toHaveCount(4);
  await expect(page.locator(".os-room-shell")).toHaveCount(0);
  await expect(page.locator(".os-firewall")).toHaveCount(0);
  await expect(page.locator(".compiled-room-view")).toHaveCount(0);
  await expect(page.locator(".os-workflow-desk")).toHaveCount(0);
});

test("case routes mount one work surface and browser history restores its location", async ({ page }) => {
  await openRoom(page, "/cases/procurement-demo/analyze/investigate");
  await expect(page.locator(".compiled-room-view")).toHaveCount(1);
  await expect(page.locator(".os-question-rail")).toHaveCount(1);
  await expect(page.locator(".os-workflow-desk")).toHaveCount(0);

  await followWorkflow(page, /^Model/);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/model$/);
  await expect.poll(async () => (await roomState(page)).capabilityPhase).toBe("contract_draft");
  await expect(page.getByRole("heading", { name: "Decision contract" })).toBeVisible();
  await expect(page.locator(".contract-desk")).toHaveCount(1);
  await expect(page.locator(".compiled-room-view, .os-question-rail, .os-history-rail, .collaboration-desk, .output-desk")).toHaveCount(0);

  await followWorkflow(page, /^Review/);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/review$/);
  await expect.poll(async () => (await roomState(page)).capabilityPhase).toBe("collaboration");
  await expect(page.getByRole("heading", { name: "Review exchange" })).toBeVisible();
  await expect(page.locator(".collaboration-desk")).toHaveCount(1);
  await expect(page.locator(".compiled-room-view, .os-question-rail, .os-history-rail, .contract-desk, .output-desk")).toHaveCount(0);

  await page.goBack();
  await waitForRoom(page);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/model$/);
  await expect(page.getByRole("heading", { name: "Decision contract" })).toBeVisible();

  await page.goBack();
  await waitForRoom(page);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/analyze\/investigate$/);
  await expect(page.locator('[data-layout-pattern="trace"]')).toBeVisible();

  await page.goForward();
  await waitForRoom(page);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/model$/);
  await followWorkflow(page, /^Outputs/);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/outputs$/);
  await expect.poll(async () => (await roomState(page)).capabilityPhase).toBe("output");
  await expect(page.getByRole("heading", { name: "Packet press" })).toBeVisible();
  await expect(page.locator(".output-desk")).toHaveCount(1);
  await expect(page.locator(".compiled-room-view, .os-question-rail, .os-history-rail, .contract-desk, .collaboration-desk")).toHaveCount(0);
});

test("a cross-case route normalization preserves the prior case in browser history", async ({ page }) => {
  await openRoom(page, "/cases/generic-demo/analyze/investigate");
  await clickRoomControl(page, "Freeze");
  await expect.poll(async () => (await roomState(page)).frozen).toBe(true);

  await switchCase(page, CASE_NAMES.procurement, "procurement");
  await followWorkflow(page, /^Review/);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/review$/);

  await switchCase(page, CASE_NAMES.generic, "generic");
  await expect(page).toHaveURL(/\/cases\/generic-demo\/analyze\/investigate$/);
  expect((await roomState(page)).frozen).toBe(true);

  await page.goBack();
  await waitForRoom(page);
  await expect(page).toHaveURL(/\/cases\/procurement-demo\/review$/);
  expect((await roomState(page)).caseId).toBe("procurement-demo");
});

test("a corrupted durable case exposes retry and a confirmed local recovery reset", async ({ page }) => {
  await openRoom(page);
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("situation-room-os-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("cases", "readwrite");
      transaction.objectStore("cases").put({
        id: "procurement-demo",
        title: "Corrupted local decision",
        revision: 17,
        domain: { packId: "missing-domain-pack" },
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      localStorage.setItem("situation-room:active-case:v1", "procurement-demo");
    } finally {
      database.close();
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const boot = page.locator(".os-boot-surface");
  await expect(boot).toContainText("The decision runtime could not start.");
  await boot.getByRole("button", { name: "Retry startup" }).click();
  await expect(boot).toContainText("The decision runtime could not start.");
  await expect(boot.getByRole("button", { name: "Retry startup" })).toBeEnabled();

  await boot.getByRole("button", { name: "Reset local workspace" }).click();
  await expect(boot).toContainText("This erases local cases, imports, receipts, and prepared outputs");
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    boot.getByRole("button", { name: "Confirm erase and reseed" }).click(),
  ]);
  await waitForRoom(page);
  await expect(page.locator(".os-case-tab")).toHaveCount(4);
  expect((await roomState(page)).domainId).toBe("procurement");
});

test("all four room grammars recompose without changing the canonical decision", async ({ page }) => {
  await openRoom(page);
  const before = await roomState(page);
  const lenses = [
    [/Causal trace/i, "trace", "investigate"],
    [/Aligned comparison/i, "matrix", "compare"],
    [/Scenario fork/i, "fork", "simulate"],
    [/Decision council/i, "council", "brief"],
  ];
  for (const [name, layout, lens] of lenses) {
    await followLens(page, name);
    await expect(page.locator(`[data-layout-pattern="${layout}"]`)).toBeVisible();
    await waitForRoom(page);
    const current = await roomState(page);
    expect(current.lens).toBe(lens);
    expect(current.layout).toBe(layout);
    expect(current.decisionJson).toBe(before.decisionJson);
    expect(current.decisionHash).toBe(before.decisionHash);
    expect(current.decisionRevision).toBe(before.decisionRevision);
  }
  const after = await roomState(page);
  expect(after.viewRevision).toBeGreaterThan(before.viewRevision);
  expect(after.historyLength).toBeGreaterThanOrEqual(3);
});

test("a human question visibly recompiles the room while preserving decision state", async ({ page }) => {
  await openRoom(page);
  const before = await roomState(page);
  const question = "Show the contradictions and exact evidence that could reverse the award.";
  await page.locator("#decision-question").fill(question);
  await page.locator(".os-ask-button").click();
  await waitForRoom(page);
  await expect(page.locator(".compiled-view-heading").getByRole("heading", { name: question })).toBeVisible();
  const after = await roomState(page);
  expect(after.viewRevision).toBeGreaterThan(before.viewRevision);
  expect(after.decisionJson).toBe(before.decisionJson);
  expect(after.decisionHash).toBe(before.decisionHash);
});

test("composition cancellation and history restoration preserve the prior canonical room", async ({ page }) => {
  await openRoom(page);
  const before = await roomState(page);
  await page.locator("#decision-question")
    .fill("Build a comparison that should be canceled before it replaces the room.");
  await page.locator(".os-ask-button").click();
  const strip = page.locator(".os-composition-strip");
  await expect(strip).toBeVisible();
  await strip.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitForRoom(page);
  const canceled = await roomState(page);
  expect(canceled.viewRevision).toBe(before.viewRevision);
  expect(canceled.layout).toBe(before.layout);
  expect(canceled.decisionJson).toBe(before.decisionJson);

  await followLens(page, /Aligned comparison/);
  await expect(page.locator('[data-layout-pattern="matrix"]')).toBeVisible();
  await waitForRoom(page);
  const comparison = await roomState(page);
  await followLens(page, /Decision council/);
  await expect(page.locator('[data-layout-pattern="council"]')).toBeVisible();
  await waitForRoom(page);
  const council = await roomState(page);
  await expandViewHistory(page);
  const comparisonHistory = page.locator(".os-history-track button").filter({ hasText: "compare" }).first();
  await comparisonHistory.click();
  await waitForRoom(page);
  const restored = await roomState(page);
  expect(restored.layout).toBe("matrix");
  expect(restored.lens).toBe("compare");
  expect(restored.viewRevision).toBeGreaterThan(council.viewRevision);
  expect(restored.decisionJson).toBe(before.decisionJson);
  expect(comparison.viewRevision).toBeGreaterThan(before.viewRevision);
});

test("the source archive preserves exact citations, focus, pins, and modal focus", async ({ page }) => {
  await openRoom(page);
  const trigger = await openSourceArchive(page);
  const dialog = page.getByRole("dialog", { name: "Source archive" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".os-source-ledger li").first()).toContainText(/page|paragraph|cell|source/i);
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);

  const firstSource = dialog.locator(".os-source-ledger li").first();
  await firstSource.getByRole("button", { name: "Trace" }).click();
  await firstSource.getByRole("button", { name: "Pin" }).click();
  await expect.poll(async () => (await roomState(page)).pins).toBe(1);
  for (let index = 0; index < 8; index += 1) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the accessible outline uses the same compiled plan and traps focus", async ({ page }) => {
  await openRoom(page);
  await clickRoomControl(page, /Accessible outline/);
  const dialog = page.getByRole("dialog", { name: "Accessible room outline" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("article.os-outline")).toContainText((await page.locator(".compiled-view-heading h2").textContent()).trim());
  for (let index = 0; index < 12; index += 1) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a remotely surfaced intake checkpoint replaces utility overlays and contains focus", async ({ page }) => {
  await openRoom(page);
  await openSourceArchive(page);
  await expect(page.getByRole("dialog", { name: "Source archive" })).toBeVisible();

  await page.evaluate(async () => {
    const room = window.__situationRoom.getState();
    await window.__situationRoom.ports.imports.startImport([
      { kind: "inline_text", text: "Vendor Delta incident response evidence requires exact human review." },
    ], {
      caseId: room.activeCase.id,
      domainHint: room.activeCase.domain.packId,
      idempotencyKey: "remote-overlay-existing-case-import",
      actor: { type: "agent", id: "overlay-test-agent" },
    });
  });
  const intake = page.getByRole("dialog", { name: "Construct a new decision room" });
  await expect(intake).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Source archive" })).toHaveCount(0);
  for (let index = 0; index < 10; index += 1) await page.keyboard.press("Tab");
  expect(await intake.evaluate((node) => node.contains(document.activeElement))).toBe(true);

  const discardReview = intake.getByRole("button", { name: "Discard and revise intake" });
  const discardRecovery = intake.getByRole("button", { name: "Discard retained source data" });
  if (await discardReview.count()) await discardReview.click();
  else if (await discardRecovery.count()) await discardRecovery.click();
  await intake.getByRole("button", { name: "Cancel" }).click();
  await expect(intake).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Source archive" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a pending import review overrides a stale case URL and remains visible after hydration", async ({ page }) => {
  await openRoom(page);
  const dialog = await openSmallGenericImportReview(page, "Hydrated import checkpoint");
  await expect(dialog.getByRole("heading", { name: "Decision Contract" })).toBeVisible();
  expect((await roomState(page)).activeImportReview).not.toBeNull();

  await page.evaluate(() => {
    window.history.replaceState({ situationRoom: true }, "", "/cases/procurement-demo/analyze/investigate");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForRoom(page);

  const restored = page.getByRole("dialog", { name: "Construct a new decision room" });
  await expect(restored).toBeVisible();
  await expect(restored.getByRole("heading", { name: "Decision Contract" })).toBeVisible();
  expect((await roomState(page)).activeImportReview).not.toBeNull();
  await expect(page).toHaveURL(/\/new$/);
});

test("a large standard CSV exposes complete paginated review and commits only a draft", async ({ page }) => {
  await openRoom(page);
  const original = await roomState(page);
  await openNewDecision(page);
  const dialog = page.getByRole("dialog", { name: "Construct a new decision room" });
  await dialog.getByLabel("Room title").fill("Regional field-device review");
  await dialog.getByLabel("What should the room help decide?").fill("Compare the imported options against cost, mandatory readiness, quality, and warranty evidence.");
  await dialog.getByLabel("Decision domain").selectOption("generic");
  const rows = ["name,cost,mandatory,quality,warranty"];
  for (let index = 1; index <= 25; index += 1) {
    rows.push(`Option ${String(index).padStart(2, "0")},${800 + index},${index % 4 ? "yes" : "no"},${70 + index},${12 + index}`);
  }
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "regional-options.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(rows.join("\n")),
  });
  await dialog.getByRole("button", { name: /Inspect and propose contract/ }).click();
  await expect(dialog.getByRole("heading", { name: "Decision Contract" })).toBeVisible({ timeout: 20_000 });

  const alternatives = dialog.getByRole("list", { name: "Alternatives" });
  await expect(alternatives).toContainText("Option 01");
  await expect(alternatives).not.toContainText("Option 25");
  await dialog.getByRole("button", { name: "Show next Alternatives page" }).click();
  await expect(alternatives).toContainText("Option 25");
  const evidence = dialog.getByRole("list", { name: "Evidence values and exact anchors" });
  await expect(evidence.locator("li")).toHaveCount(80);
  await dialog.getByRole("button", { name: "Show next Evidence values and exact anchors page" }).click();
  await expect(evidence).toContainText(/Option 25|alternative:option-25/i);
  expect((await roomState(page)).decisionJson).toBe(original.decisionJson);

  await dialog.getByLabel(/I reviewed the complete paginated alternatives/).check();
  await dialog.getByRole("button", { name: "Commit reviewed draft" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const committed = await roomState(page);
  expect(committed.title).toBe("Regional field-device review");
  expect(committed.contractStatus).toBe("draft");
  expect(committed.capabilityPhase).toBe("contract_draft");
  expect(committed.caseId).not.toBe(original.caseId);
  await expect(page).toHaveURL(new RegExp(`/cases/${encodeURIComponent(committed.caseId)}/model$`));
  await expect(page.getByRole("heading", { name: "Decision contract" })).toBeVisible();
  await expect(page.locator(".os-missing-route")).toHaveCount(0);
});

test("unsafe unstructured candidate material fails into a discardable recovery checkpoint", async ({ page }) => {
  await openRoom(page);
  const original = await roomState(page);
  await openNewDecision(page);
  const dialog = page.getByRole("dialog", { name: "Construct a new decision room" });
  await dialog.getByLabel("Room title").fill("Blinded candidate evidence review");
  await dialog.getByLabel("What should the room help decide?").fill("Organize verified job-related TypeScript evidence for a blinded human panel.");
  await dialog.getByLabel("Decision domain").selectOption("candidate-review");
  await dialog.getByLabel("Or paste source text").fill("Jane Smith is 36 and pregnant. She has six years of TypeScript experience.");
  await dialog.getByRole("button", { name: /Inspect and propose contract/ }).click();
  await expect(dialog.getByRole("heading", { name: "Domain-safe mapping cannot proceed" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText(/isolated|blinded|policy-compliant structured extraction/i);
  const during = await roomState(page);
  expect(during.decisionJson).toBe(original.decisionJson);
  expect(await page.evaluate(() => window.__situationRoom.getState().bootStatus)).toBe("ready");
  await dialog.getByRole("button", { name: "Discard retained source data" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect((await roomState(page)).decisionJson).toBe(original.decisionJson);
});

test("failed pre-commit deletion stays visible and can be resumed without trapping the room", async ({ page }) => {
  await openRoom(page);
  let dialog = await openSmallGenericImportReview(page, "Discard recovery exercise");
  await failIndexedDbSourceDeletion(page);
  await dialog.getByRole("button", { name: "Discard and revise intake" }).click();
  await expect(dialog.getByRole("heading", { name: "Retained source data needs a decision" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText(/could not be completely removed/i);
  await dialog.getByRole("button", { name: "Return to room" }).click();
  await expect(dialog).toBeHidden();
  const docket = page.locator(".os-recovery-docket");
  await expect(docket).toContainText("Import recovery requires human attention");
  await expect(page.locator(".decision-os")).toBeVisible();

  await restoreIndexedDbSourceDeletion(page);
  await docket.getByRole("button", { name: "Open recovery docket" }).click();
  dialog = page.getByRole("dialog", { name: "Construct a new decision room" });
  await dialog.getByRole("button", { name: "Discard retained source data" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(docket).toHaveCount(0);
});

test("post-commit cleanup failure leaves a nonblocking durable docket and never replays the commit", async ({ page }) => {
  await openRoom(page);
  let dialog = await openSmallGenericImportReview(page, "Cleanup recovery exercise");
  await dialog.getByLabel(/I reviewed the complete paginated alternatives/).check();
  await failIndexedDbSourceDeletion(page);
  await dialog.getByRole("button", { name: "Commit reviewed draft" }).click();
  await expect(dialog.getByRole("heading", { name: "Canonical commit complete; source cleanup pending" })).toBeVisible({ timeout: 20_000 });
  const committed = await roomState(page);
  await dialog.getByRole("button", { name: "Retry retained-source cleanup" }).click();
  await expect(dialog.getByRole("heading", { name: "Canonical commit complete; source cleanup pending" })).toBeVisible();
  expect((await roomState(page)).decisionRevision).toBe(committed.decisionRevision);
  await dialog.getByRole("button", { name: "Return to room" }).click();
  const docket = page.locator(".os-recovery-docket");
  await expect(docket).toContainText("Retained-source cleanup is pending");
  expect((await roomState(page)).decisionRevision).toBe(committed.decisionRevision);

  await restoreIndexedDbSourceDeletion(page);
  await docket.getByRole("button", { name: "Open recovery docket" }).click();
  dialog = page.getByRole("dialog", { name: "Construct a new decision room" });
  await dialog.getByRole("button", { name: "Retry retained-source cleanup" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(docket).toHaveCount(0);
  expect((await roomState(page)).decisionRevision).toBe(committed.decisionRevision);
});

test("the typed contract must be reactivated after a human draft edit", async ({ page }) => {
  await openRoom(page);
  await switchCase(page, CASE_NAMES.generic, "generic");
  await followWorkflow(page, /^Model/);
  await expect(page.getByRole("heading", { name: "Decision contract" })).toBeVisible();
  const question = page.getByLabel("Decision question");
  await question.fill("Which portable workstation is feasible after independently verified repairability evidence?");
  const before = await roomState(page);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(async () => (await roomState(page)).contractStatus).toBe("draft");
  const draft = await roomState(page);
  expect(draft.decisionRevision).toBe(before.decisionRevision + 1);
  await expect(page.getByRole("button", { name: "Activate contract before approval" })).toBeDisabled();
  await page.getByRole("button", { name: "Activate contract", exact: true }).click();
  await expect.poll(async () => (await roomState(page)).contractStatus).toBe("active");
  expect((await roomState(page)).decisionRevision).toBe(draft.decisionRevision + 1);
});

test("typed model validation is atomic and a valid edit persists as one revision", async ({ page }) => {
  await openRoom(page);
  await switchCase(page, CASE_NAMES.generic, "generic");
  await followWorkflow(page, /^Model/);
  const before = await roomState(page);
  const claims = page.locator("details.model-editor-section").filter({ hasText: "Claims and source anchors" });
  await claims.locator(":scope > summary").click();
  await claims.getByLabel("Confidence").first().fill("1.5");
  await page.getByRole("button", { name: "Apply typed model" }).click();
  await expect(page.getByRole("alert")).toContainText(/confidence must be between zero and one/i);
  expect((await roomState(page)).decisionRevision).toBe(before.decisionRevision);

  await page.getByRole("button", { name: "Discard edits" }).click();
  const alternatives = page.locator("details.model-editor-section").filter({ hasText: /^Alternatives/ });
  const revisedName = "Field-tested Workstation Alpha";
  await alternatives.getByLabel("Name").first().fill(revisedName);
  await page.getByRole("button", { name: "Apply typed model" }).click();
  await expect.poll(async () => (await roomState(page)).decisionRevision).toBe(before.decisionRevision + 1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForRoom(page);
  expect(await page.evaluate(() => window.__situationRoom.getState().activeCase.alternatives[0].label)).toBe(revisedName);
});

test("human approval requires a fresh confirmation every time the dialog opens", async ({ page }) => {
  await openRoom(page);
  const trigger = page.getByRole("button", { name: "Preview human approval" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "Commit the human decision" });
  const commit = dialog.getByRole("button", { name: "Commit approval" });
  await expect(commit).toBeDisabled();
  await dialog.getByLabel(/I reviewed the cited evidence/).check();
  await expect(commit).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await trigger.click();
  dialog = page.getByRole("dialog", { name: "Commit the human decision" });
  await expect(dialog.getByRole("button", { name: "Commit approval" })).toBeDisabled();
  await expect(dialog.getByLabel(/I reviewed the cited evidence/)).not.toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("candidate review exposes requirement evidence without a machine outcome", async ({ page }) => {
  await openRoom(page);
  await switchCase(page, CASE_NAMES.candidate, "candidate-review");
  const room = await roomState(page);
  const firewall = page.getByRole("complementary", { name: "Decision Firewall" });
  await expect(firewall).toContainText("Machine ranking disabled");
  await expandFirewall(page);
  await expect(firewall).toContainText("Job requirement evidence");
  await expect(firewall.locator(".os-gate-ledger")).toContainText("1 not demonstrated");
  await expect(firewall.locator(".os-firewall__metrics")).not.toContainText("blockers");
  await expect(page.getByRole("button", { name: "Human employment decision only" })).toBeDisabled();
  expect(room.instruments).toEqual(expect.arrayContaining(["bias-shield"]));
  expect(room.instruments).not.toEqual(expect.arrayContaining(["outcome-seal", "score-breakdown", "decision-brief"]));
  const serialized = await page.evaluate(() => JSON.stringify(window.__situationRoom.getState().evaluation));
  expect(serialized).not.toMatch(/"ranking":\s*\[/);
  expect(serialized).not.toMatch(/"recommendation":\s*\{/);
});

test("the complete review backlog remains paginated and durable without local-storage preferences", async ({ page }) => {
  await openRoom(page);
  await followWorkflow(page, /^Review/);
  const desk = page.locator(".collaboration-desk");
  const note = desk.getByRole("textbox", { name: "Review note" });
  for (let index = 0; index < 8; index += 1) {
    await note.fill(`Durable review entry ${index}`);
    await desk.getByRole("button", { name: "Stage for review" }).click();
  }
  const pager = desk.getByRole("navigation", { name: "Review exchange pages" });
  await expect(pager).toContainText("Page 1 of 2 · 8 entries");
  await pager.getByRole("button", { name: "Next" }).click();
  await expect(desk).toContainText("Durable review entry 0");

  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("situation-room-os-v2");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("blobs", "readonly");
      const record = await new Promise((resolve, reject) => {
        const request = transaction.objectStore("blobs").get("workspace-session:procurement-demo");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return record?.value?.reviewArtifacts?.length ?? 0;
    } finally {
      database.close();
    }
  })).toBe(8);
  await page.evaluate(() => localStorage.removeItem("situation-room:presentation:v2"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForRoom(page);
  await followWorkflow(page, /^Review/);
  const restoredDesk = page.locator(".collaboration-desk");
  const restoredPager = restoredDesk.getByRole("navigation", { name: "Review exchange pages" });
  await expect(restoredPager).toContainText("Page 1 of 2 · 8 entries");
  await restoredPager.getByRole("button", { name: "Next" }).click();
  await expect(restoredDesk).toContainText("Durable review entry 0");
});

test("health-plan and generic rooms remain general, domain-specific, and reload the active case", async ({ page }) => {
  await openRoom(page);
  await switchCase(page, CASE_NAMES.candidate, "candidate-review");
  await switchCase(page, CASE_NAMES.generic, "generic");
  await switchCase(page, CASE_NAMES.health, "health-plan");
  await expect(page.locator(".os-case-identity > strong")).toHaveText("Household Health-Plan Comparison");
  expect((await roomState(page)).instruments.some((type) => /plan|provider|formulary|utilization/.test(type))).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForRoom(page);
  expect((await roomState(page)).domainId).toBe("health-plan");
  await switchCase(page, CASE_NAMES.generic, "generic");
  await expect(page.locator(".os-case-identity > strong")).toHaveText("Portable Workstation Choice");
  expect((await roomState(page)).instruments.some((type) => /comparison|pareto|weighted|evidence/.test(type))).toBe(true);
});

test("prepared packets are revision-bound and only download after a human click", async ({ page }) => {
  await openRoom(page);
  const before = await roomState(page);
  await followWorkflow(page, /^Outputs/);
  await expect(page.getByRole("heading", { name: "Packet press" })).toBeVisible();
  await page.getByRole("button", { name: /json Portable JSON/i }).click();
  const item = page.locator(".prepared-output-ledger li").first();
  await expect(item).toContainText(`r${before.decisionRevision}`);
  const downloadPromise = page.waitForEvent("download");
  await item.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/i);
  const after = await roomState(page);
  expect(after.decisionJson).toBe(before.decisionJson);
  expect(after.decisionHash).toBe(before.decisionHash);
});

test("manual freeze persists across reload and disables every human mutation surface", async ({ page }) => {
  await openRoom(page);
  const before = await roomState(page);
  await clickRoomControl(page, "Freeze");
  await expect.poll(async () => (await roomState(page)).frozen).toBe(true);
  await expect(page.locator("#decision-question")).toBeDisabled();
  await expect(page.locator(".os-workflow-tabs a[aria-disabled='true']")).toHaveCount(3);
  await expect(page.locator(".os-lens-tabs a")).toHaveCount(4);
  await followLens(page, /Aligned comparison/);
  await expect(page).toHaveURL(/\/analyze\/compare$/);
  expect((await roomState(page)).decisionJson).toBe(before.decisionJson);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForRoom(page);
  expect((await roomState(page)).frozen).toBe(true);
  await clickRoomControl(page, "Frozen");
  await expect.poll(async () => (await roomState(page)).frozen).toBe(false);
});

test("the full manual workflow remains operational when WebMCP is absent", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(Document.prototype, "modelContext", { configurable: true, get: () => undefined });
    } catch {
      // The deterministic fallback assertion below remains authoritative.
    }
  });
  await openRoom(page);
  await expect(page.locator(".os-webmcp-state")).toContainText("Manual parity active");
  expect(await page.evaluate(() => window.__situationRoom.getState().webMcp.available)).toBe(false);
  await followLens(page, /Aligned comparison/);
  await expect(page.locator('[data-layout-pattern="matrix"]')).toBeVisible();
  await followWorkflow(page, /^Review/);
  await expect(page.getByRole("heading", { name: "Review exchange" })).toBeVisible();
  await followWorkflow(page, /^Outputs/);
  await expect(page.getByRole("heading", { name: "Packet press" })).toBeVisible();
});

test("tablet composition keeps compact governance inside the single routed stage", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await openRoom(page);
  const geometry = await page.evaluate(() => {
    const stageElement = document.querySelector(".os-decision-stage");
    const firewallElement = document.querySelector(".os-firewall");
    const stage = stageElement.getBoundingClientRect();
    const firewall = firewallElement.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      firewallInsideStage: stageElement.contains(firewallElement),
      firewallWithinStageWidth: firewall.left >= stage.left - 1 && firewall.right <= stage.right + 1,
    };
  });
  expect(geometry.overflow).toBe(0);
  expect(geometry.firewallInsideStage).toBe(true);
  expect(geometry.firewallWithinStageWidth).toBe(true);
  await expect(page.getByRole("complementary", { name: "Decision Firewall" })).toBeVisible();
});

test("destructive reset requires confirmation and reseeds the four clean rooms", async ({ page }) => {
  await openRoom(page);
  const initial = await roomState(page);
  const question = "Prepare a reset verification view with the current evidence.";
  await page.locator("#decision-question").fill(question);
  await page.locator(".os-ask-button").click();
  await expect(page.locator(".compiled-view-heading").getByRole("heading", { name: question })).toBeVisible();
  await waitForRoom(page);
  const changed = await roomState(page);
  expect(changed.viewRevision).toBeGreaterThan(initial.viewRevision);
  await clickRoomControl(page, "Reset demo");
  let dialog = page.getByRole("dialog", { name: "Reset the local demonstration" });
  await dialog.getByRole("button", { name: "Keep workspace" }).click();
  await expect(dialog).toBeHidden();
  expect((await roomState(page)).viewRevision).toBe(changed.viewRevision);

  await clickRoomControl(page, "Reset demo");
  dialog = page.getByRole("dialog", { name: "Reset the local demonstration" });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    dialog.getByRole("button", { name: "Erase local workspace and reseed" }).click(),
  ]);
  await waitForRoom(page);
  await expect(page.locator(".os-case-tab")).toHaveCount(4);
  const reset = await roomState(page);
  expect(reset.domainId).toBe("procurement");
  expect(reset.decisionRevision).toBe(17);
  expect(reset.viewRevision).toBe(1);
});

test("mobile layout has no page overflow, a working skip link, named controls, and reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRoom(page);
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#decision-stage")).toBeFocused();
  const accessibility = await page.evaluate(() => {
    const name = (element) => {
      const labels = element.labels ? [...element.labels].map((label) => label.textContent).join(" ") : "";
      return `${labels} ${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`.trim();
    };
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      unnamedButtons: [...document.querySelectorAll("button")].filter((button) => button.getClientRects().length && !name(button)).length,
      unnamedFields: [...document.querySelectorAll("input,select,textarea")].filter((field) => field.getClientRects().length && !name(field)).length,
      h1: document.querySelectorAll("h1").length,
    };
  });
  expect(accessibility).toEqual({ overflow: 0, unnamedButtons: 0, unnamedFields: 0, h1: 1 });
  await openRoomControls(page);
  const motion = page.locator("#os-utility-menu").getByRole("button", { name: /Reduced motion/ });
  await motion.click();
  await expect(page.locator(".decision-os")).toHaveClass(/reduce-motion/);
  await openRoomControls(page);
  await expect(page.locator("#os-utility-menu").getByRole("button", { name: /Reduced motion/ }))
    .toHaveAttribute("aria-pressed", "true");
});

test("the mobile room map removes closed navigation from Tab order and restores opener focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRoom(page);
  const trigger = page.getByRole("button", { name: "Room map", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.focus();

  const closedDrawerFocus = [];
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    closedDrawerFocus.push(await page.evaluate(() => Boolean(document.activeElement?.closest("#workspace-navigation"))));
  }
  expect(closedDrawerFocus).not.toContain(true);

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#workspace-navigation")).toHaveClass(/is-open/);
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("#workspace-navigation")))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});
