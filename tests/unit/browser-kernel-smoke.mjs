import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const externalUrl = process.env.SITUATION_ROOM_BROWSER_URL;
const baseUrl = (externalUrl ?? "http://127.0.0.1:4189").replace(/\/$/, "");
const server = externalUrl
  ? null
  : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4189"], {
      cwd: process.cwd(),
      stdio: "ignore",
    });

if (server) {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    server.kill();
    throw new Error("The browser-kernel smoke server did not become ready.");
  }
}

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (
    message.type() === "error" &&
    !message.text().startsWith("Failed to load resource:") &&
    !message.text().startsWith("Estimating resolution as ")
  ) {
    errors.push(message.text());
  }
});
page.on("response", (response) => {
  if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
    errors.push(`${response.status()} ${response.url()}`);
  }
});

if (externalUrl) {
  try {
    const ocrAssets = [];
    page.on("response", (response) => {
      if (/eng\.traineddata|worker\.min|tesseract-core/.test(response.url())) {
        ocrAssets.push({ url: response.url(), status: response.status() });
      }
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const room = window.__situationRoom?.getState?.();
      return room?.bootStatus === "ready" && room?.compositionPhase === "idle";
    });
    const ocrDataUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 360;
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "black";
      context.font = "700 64px Arial";
      context.fillText("SITUATION ROOM 2040", 36, 100);
      context.fillText("ALPHA COST 10", 36, 205);
      context.fillText("BETA COST 20", 36, 310);
      return canvas.toDataURL("image/png");
    });
    await page.getByRole("button", { name: /New decision/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Construct a new decision room" });
    await dialog.getByLabel("Room title").fill("Live OCR verification");
    await dialog.getByLabel("What should the room help decide?").fill("Compare Alpha and Beta using the imported cost evidence.");
    await dialog.getByLabel("Decision domain").selectOption("generic");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "live-ocr-verification.png",
      mimeType: "image/png",
      buffer: Buffer.from(ocrDataUrl.split(",")[1], "base64"),
    });
    await dialog.getByRole("button", { name: /Inspect and propose contract/ }).click();
    try {
      await dialog.getByRole("heading", { name: "Decision Contract" }).waitFor({ timeout: 90_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const room = window.__situationRoom?.getState?.();
        const review = room?.activeImportReview;
        return {
          workspacePhase: room?.workspacePhase,
          jobPhase: review?.job?.phase,
          jobError: review?.job?.error,
          lastAnnouncement: room?.lastAnnouncement,
          documents: review?.documents?.map((document) => ({
            format: document.format,
            blocks: document.blocks.length,
            diagnostics: document.diagnostics.map((item) => item.code),
          })),
        };
      });
      console.error("Production OCR diagnostic", JSON.stringify({
        diagnostic,
        browserErrors: errors,
        ocrAssets,
        dialogText: (await dialog.innerText()).slice(0, 1_500),
      }, null, 2));
      throw error;
    }
    const result = await page.evaluate(() => {
      const room = window.__situationRoom.getState();
      const review = room.activeImportReview;
      return {
        persistenceMode: room.persistenceMode,
        text: review.documents.flatMap((document) => document.blocks.map((block) => block.text)).join(" ").toUpperCase(),
        diagnostics: review.documents.flatMap((document) => document.diagnostics.map((diagnostic) => diagnostic.code)),
      };
    });
    assert.equal(result.persistenceMode, "durable");
    assert.match(result.text, /SITUATION\s+ROOM\s+2040/);
    assert.ok(result.diagnostics.includes("OCR_REQUIRES_REVIEW"));
    assert.ok(ocrAssets.some(({ url, status }) => /eng\.traineddata/.test(url) && status === 200));
    assert.ok(ocrAssets.some(({ url, status }) => /worker\.min/.test(url) && status === 200));
    assert.deepEqual(errors, []);
    console.log("Production Chrome kernel smoke passed", {
      persistenceMode: result.persistenceMode,
      ocrVerified: true,
      ocrAssets: ocrAssets.map(({ url, status }) => ({
        file: new URL(url).pathname.split("/").at(-1),
        status,
      })),
    });
  } finally {
    await browser.close();
  }
  process.exit(0);
}

try {
  await page.goto(`${baseUrl}/src/import/index.js`, {
    waitUntil: "networkidle",
  });
  const result = await page.evaluate(async () => {
    const [{ IndexedDbRepository }, { DecisionRuntime }, domain, imports, invocationJournal, receiptJournal] = await Promise.all([
      import("/src/persistence/index.js"),
      import("/src/kernel/index.js"),
      import("/src/domain-packs/index.js"),
      import("/src/import/index.js"),
      import("/src/webmcp/invocationStore.js"),
      import("/src/webmcp/receiptLedger.js"),
    ]);
    const dbName = `situation-room-browser-smoke-${crypto.randomUUID()}`;
    const repository = new IndexedDbRepository({ dbName });
    const runtime = new DecisionRuntime({ repository });
    await runtime.initialize({ seedCases: [domain.createGenericFixture()] });
    const before = await runtime.getCase("generic-demo");
    const commandResult = await runtime.executeCommand(
      { type: "create_scenario", payload: { scenario: { id: "scenario:browser", label: "Browser" } } },
      {
        caseId: "generic-demo",
        expectedRevision: before.revision,
        idempotencyKey: "browser-scenario",
        actor: { type: "agent", id: "browser-smoke" },
      },
    );
    const parsed = await imports.parseImportInputs(
      [{ name: "browser.yaml", type: "application/yaml", text: "choice: A\ncost: 10\n" }],
      { importId: "import:browser" },
    );
    const canvas = document.createElement("canvas");
    canvas.width = 760;
    canvas.height = 220;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "black";
    context.font = "700 54px Arial";
    context.fillText("SITUATION ROOM 2040", 24, 135);
    const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const ocrParsed = await imports.parseImportInputs(
      [{ name: "browser-ocr.png", type: "image/png", bytes: new Uint8Array(await imageBlob.arrayBuffer()) }],
      { importId: "import:browser-ocr" },
    );
    const firstCoordinator = new imports.ImportCoordinator({
      repository,
      idGenerator: () => "browser-original",
    });
    await firstCoordinator.initialize();
    const startedImport = await firstCoordinator.startImport(
      [{ name: "retry.txt", type: "text/plain", text: "Browser-persisted raw evidence" }],
      { caseId: "generic-demo", domainHint: "generic" },
    );
    const reviewedImport = await firstCoordinator.waitForImport(startedImport.id);
    const replay = await runtime.executeCommand(
      { type: "create_scenario", payload: { scenario: { id: "scenario:browser", label: "Browser" } } },
      {
        caseId: "generic-demo",
        expectedRevision: before.revision,
        idempotencyKey: "browser-scenario",
        actor: { type: "agent", id: "browser-smoke" },
      },
    );
    repository.close();
    const reopenedRepository = new IndexedDbRepository({ dbName });
    const secondCoordinator = new imports.ImportCoordinator({
      repository: reopenedRepository,
      idGenerator: () => "browser-retry",
    });
    await secondCoordinator.initialize();
    const retriedImport = await secondCoordinator.retryImport(startedImport.id);
    const retriedImportJob = await secondCoordinator.waitForImport(retriedImport.id);
    reopenedRepository.close();

    const journalDbName = `situation-room-webmcp-smoke-${crypto.randomUUID()}`;
    const firstInvocationStore = new invocationJournal.IndexedDbInvocationStore({ dbName: journalDbName });
    const secondInvocationStore = new invocationJournal.IndexedDbInvocationStore({ dbName: journalDbName });
    await firstInvocationStore.initialize();
    await secondInvocationStore.initialize();
    const journalKey = "compose_decision_room:case-1:browser-journal";
    const journalFingerprint = "sha256:browser-journal";
    const invocationClaims = await Promise.all([
      firstInvocationStore.claim(journalKey, journalFingerprint, { ownerId: "browser-owner-a" }),
      secondInvocationStore.claim(journalKey, journalFingerprint, { ownerId: "browser-owner-b" }),
    ]);
    const claimOwner = invocationClaims[0].status === "claimed" ? "browser-owner-a" : "browser-owner-b";
    const ownerStore = claimOwner === "browser-owner-a" ? firstInvocationStore : secondInvocationStore;
    const waitingStore = claimOwner === "browser-owner-a" ? secondInvocationStore : firstInvocationStore;
    const markedInvocation = await ownerStore.markExecuting(
      journalKey,
      journalFingerprint,
      claimOwner,
      { at: "2026-01-01T00:00:01.000Z" },
    );
    await ownerStore.complete(journalKey, journalFingerprint, claimOwner, { ok: true, data: { committed: true } });
    const waitedInvocation = await waitingStore.waitForResult(journalKey, journalFingerprint, { timeoutMs: 1_000 });
    const conflictingInvocation = await waitingStore.claim(journalKey, "sha256:different", { ownerId: "browser-owner-c" });

    const recoveryKey = "compose_decision_room:case-1:browser-recovery";
    const recoveryFingerprint = "sha256:browser-recovery";
    await firstInvocationStore.claim(recoveryKey, recoveryFingerprint, {
      ownerId: "expired-pre-execution-owner",
      at: "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
    });
    const reclaimedInvocation = await secondInvocationStore.claim(recoveryKey, recoveryFingerprint, {
      ownerId: "recovery-owner",
      at: "2026-01-01T00:00:02.000Z",
      leaseMs: 1_000,
    });
    await secondInvocationStore.markExecuting(
      recoveryKey,
      recoveryFingerprint,
      "recovery-owner",
      { at: "2026-01-01T00:00:02.000Z", leaseMs: 1_000 },
    );
    const uncertainInvocation = await firstInvocationStore.claim(recoveryKey, recoveryFingerprint, {
      ownerId: "must-not-replay-owner",
      at: "2026-01-01T00:00:04.000Z",
    });

    const firstReceiptLedger = new receiptJournal.IndexedDbReceiptLedger({ dbName: journalDbName });
    const secondReceiptLedger = new receiptJournal.IndexedDbReceiptLedger({ dbName: journalDbName });
    await firstReceiptLedger.initialize();
    await secondReceiptLedger.initialize();
    await Promise.all([
      firstReceiptLedger.append(firstReceiptLedger.create({ operationId: "op-browser-a", tool: "compose_decision_room" })),
      secondReceiptLedger.append(secondReceiptLedger.create({ operationId: "op-browser-b", tool: "run_scenario" })),
    ]);
    const durableReceipts = await firstReceiptLedger.listAsync({ limit: 10 });
    await invocationJournal.clearWebMcpJournalDatabase({ indexedDB, dbName: journalDbName });
    const clearedInvocation = await firstInvocationStore.get(journalKey);
    const clearedReceipts = await secondReceiptLedger.listAsync({ limit: 10 });
    firstInvocationStore.close();
    secondInvocationStore.close();
    firstReceiptLedger.close();
    secondReceiptLedger.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB deletion was blocked."));
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(journalDbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("WebMCP journal deletion was blocked."));
    });
    return {
      revisionAfter: commandResult.receipt.revisionAfter,
      hashPreserved: commandResult.receipt.decisionHashBefore === commandResult.receipt.decisionHashAfter,
      replayed: replay.replayed,
      yamlFormat: parsed.documents[0].format,
      yamlBlocks: parsed.documents[0].blocks.length,
      rawInputsPersisted: reviewedImport.rawInputsPersisted,
      retryPhase: retriedImportJob.phase,
      retryDocumentIsolated: reviewedImport.documentIds[0] !== retriedImportJob.documentIds[0],
      invocationClaims: invocationClaims.map((claim) => claim.status).sort(),
      markedInvocation: markedInvocation.status,
      waitedInvocation: waitedInvocation.status,
      conflictingInvocation: conflictingInvocation.status,
      reclaimedInvocation: {
        status: reclaimedInvocation.status,
        reclaimed: reclaimedInvocation.reclaimed,
        ownerId: reclaimedInvocation.entry.ownerId,
      },
      uncertainInvocation: {
        status: uncertainInvocation.status,
        ownerId: uncertainInvocation.entry.ownerId,
      },
      durableReceiptTotal: durableReceipts.total,
      durableReceiptIds: durableReceipts.entries.map((entry) => entry.operationId).sort(),
      journalClearVerified: clearedInvocation === null && clearedReceipts.total === 0,
      browserOcrText: ocrParsed.documents[0].blocks.map((block) => block.text).join(" ").toUpperCase(),
    };
  });
  assert.deepEqual({ ...result, browserOcrText: undefined }, {
    revisionAfter: 2,
    hashPreserved: true,
    replayed: true,
    yamlFormat: "yaml",
    yamlBlocks: 2,
    rawInputsPersisted: true,
    retryPhase: "review_required",
    retryDocumentIsolated: true,
    invocationClaims: ["claimed", "pending"],
    markedInvocation: "executing",
    waitedInvocation: "replay",
    conflictingInvocation: "conflict",
    reclaimedInvocation: {
      status: "claimed",
      reclaimed: true,
      ownerId: "recovery-owner",
    },
    uncertainInvocation: {
      status: "uncertain",
      ownerId: "recovery-owner",
    },
    durableReceiptTotal: 2,
    durableReceiptIds: ["op-browser-a", "op-browser-b"],
    journalClearVerified: true,
    browserOcrText: undefined,
  });
  assert.match(result.browserOcrText, /SITUATION\s+ROOM\s+2040/);
  assert.deepEqual(errors, []);
  console.log("Chrome kernel smoke passed", result);
} finally {
  await browser.close();
  server?.kill();
}
