import test from "node:test";
import assert from "node:assert/strict";
import { createWebMcpGateway } from "../src/webmcp/gateway.js";
import {
  LocalStorageReceiptLedger,
  ReceiptLedger,
  createMemoryReceiptState,
} from "../src/webmcp/receiptLedger.js";
import {
  MemoryInvocationStore,
  WEBMCP_CLAIM_LEASE_MS,
  createMemoryInvocationState,
} from "../src/webmcp/invocationStore.js";
import { canonicalHash } from "../src/kernel/canonicalize.js";
import { ANALYSIS_SCHEMAS, IMPORT_SCHEMAS, buildPresentationSchemas } from "../src/webmcp/schemas.js";
import { createToolCatalog } from "../src/webmcp/toolCatalog.js";
import { validateInput } from "../src/webmcp/runtimeValidation.js";

class FakeModelContext {
  constructor() {
    this.tools = new Map();
    this.toolchangeEvents = 0;
  }

  async registerTool(definition, { signal } = {}) {
    if (this.tools.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
    this.tools.set(definition.name, definition);
    this.toolchangeEvents += 1;
    signal?.addEventListener(
      "abort",
      () => {
        if (this.tools.get(definition.name) === definition) {
          this.tools.delete(definition.name);
          this.toolchangeEvents += 1;
        }
      },
      { once: true },
    );
  }

  names() {
    return [...this.tools.keys()].sort();
  }

  definition(name) {
    return this.tools.get(name);
  }

  execute(name, input, options = {}) {
    const definition = this.tools.get(name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    return definition.execute(input, options);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const listeners = new Set();
  const emit = (event = { type: "capability-context.changed" }) => {
    for (const listener of listeners) listener(event);
  };
  const state = {
    workspace: {
      id: "workspace-1",
      phase: "analysis",
      activeCaseId: "case-1",
      domainId: "general",
      domainRisk: "ordinary",
      role: "reviewer",
      permissions: ["*"],
      decisionRevision: 3,
      decisionHash: "decision-3",
      cases: [{ id: "case-1", title: "Test case", status: "active", decisionRevision: 3 }],
    },
    contract: {
      id: "contract-1",
      caseId: "case-1",
      status: "active",
      domainId: "general",
      decisionType: "comparison",
      objective: "Choose the best supported alternative.",
      authority: "human_decides",
      evidenceThreshold: "source_required",
      uncertaintyPolicy: "request_review",
      prohibitedInputs: [],
      revision: 3,
    },
    presentation: {
      caseId: "case-1",
      lens: "investigate",
      layoutId: "trace",
      density: "focused",
      question: "What evidence determines this outcome?",
      decisionRevision: 3,
      decisionHash: "decision-3",
      viewRevision: 2,
      viewHash: "view-2",
      sourceDrawerOpen: false,
      capabilities: {
        instrumentTypes: ["causal-trace", "evidence-excerpt", "protected-invariants"],
        layoutIds: ["trace", "matrix", "fork", "council"],
        regions: ["primary", "secondary", "supporting"],
      },
    },
    imports: [],
    applyCalls: 0,
    settledCalls: 0,
    commandCalls: 0,
  };
  Object.assign(state, overrides.state ?? {});

  const runtime = {
    getWorkspaceState: () => state.workspace,
    getActiveContract: () => (state.workspace.activeCaseId ? state.contract : null),
    getRecentChanges: () => ({ entries: [], total: 0, nextCursor: null }),
    queryGraph: (query) => ({ mode: query.mode, paths: [], decisionRevision: state.workspace.decisionRevision }),
    evaluate: (_caseId, options) => ({ mode: options.mode, alternatives: [], decisionRevision: state.workspace.decisionRevision }),
    executeCommand: (_command, { expectedRevision }) => {
      state.commandCalls += 1;
      if (expectedRevision !== state.workspace.decisionRevision) {
        return { ok: false, error: { code: "STALE_REVISION", message: "Stale decision." } };
      }
      const before = state.workspace.decisionRevision;
      state.workspace = {
        ...state.workspace,
        decisionRevision: before + 1,
        decisionHash: `decision-${before + 1}`,
      };
      emit({ type: "decision.changed" });
      return {
        ok: true,
        data: { changed: true },
        receipt: {
          revisionBefore: before,
          revisionAfter: before + 1,
          decisionHashBefore: `decision-${before}`,
          decisionHashAfter: `decision-${before + 1}`,
          changedEntityIds: ["entity-1"],
        },
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const imports = {
    startImport: overrides.startImport ?? (async () => ({ jobId: "job-1", phase: "queued", version: 1 })),
    listImports: () => state.imports,
    getImport: (jobId) => state.imports.find((entry) => (entry.jobId ?? entry.id) === jobId),
    cancelImport: async (jobId) => ({ jobId, phase: "canceled", version: 2 }),
    inspectDocument: overrides.inspectDocument ?? (async (documentId) => ({ documentId, regions: [] })),
    searchFragments: overrides.searchFragments ?? (async () => ({ entries: [], nextCursor: null })),
    readSourceSpans: overrides.readSourceSpans ?? (async (documentId, anchors) => ({ documentId, anchors, spans: [] })),
    mapTableSchema: async () => ({ mapped: true }),
    retryImport: async (jobId) => ({ jobId, phase: "queued", version: 2 }),
    requestHumanReview: async ({ jobId }) => ({ jobId, reviewRequested: true }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const presentation = {
    getPresentationSnapshot: () => state.presentation,
    async applyPresentationRecipe(recipe) {
      state.applyCalls += 1;
      const before = state.presentation.viewRevision;
      state.presentation = {
        ...state.presentation,
        lens: recipe.lens,
        layoutId: recipe.layoutId,
        density: recipe.density,
        question: recipe.question,
        viewRevision: before + 1,
        viewHash: `view-${before + 1}`,
        renderedInstrumentIds: recipe.instruments.map((instrument) => instrument.id),
      };
      emit({ type: "capability-context.changed" });
      return {
        ok: true,
        planId: `plan-${before + 1}`,
        renderedInstrumentIds: state.presentation.renderedInstrumentIds,
        decisionHashBefore: state.workspace.decisionHash,
        decisionHashAfter: state.workspace.decisionHash,
        viewRevisionBefore: before,
        viewRevisionAfter: before + 1,
        announcement: "Room composition settled.",
      };
    },
    focusEntity: async (entityRef, pathId) => ({ entityRef, pathId, focused: true }),
    saveView: async ({ label }) => ({ label, saved: true }),
    restoreViewRevision: async (revision) => ({ revision, restored: true }),
    requestHumanCheckpoint: async (request) => ({ checkpointRequested: true, type: request.type }),
    async waitForSettled() {
      state.settledCalls += 1;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const outputs = {
    previewDecisionPacket: async () => ({ previewId: "preview-1" }),
    exportCase: async () => ({ exportId: "export-1", status: "prepared" }),
    draftRequest: async () => ({ draftId: "draft-1" }),
    prepareExternalAction: async () => ({ draftId: "action-1", status: "awaiting_human" }),
  };

  return {
    state,
    emit,
    ports: { runtime, imports, presentation, outputs },
  };
}

function compositionInput(overrides = {}) {
  return {
    caseId: "case-1",
    recipeVersion: 1,
    intent: "compare",
    lens: "compare",
    question: "Compare the supported alternatives.",
    layoutId: "matrix",
    density: "balanced",
    instruments: [
      {
        id: "comparison-1",
        type: "causal-trace",
        region: "primary",
        priority: 90,
        entityRefs: [{ kind: "alternative", id: "alternative-1" }],
        options: { showSources: true },
      },
    ],
    focusPathIds: [],
    expectedDecisionRevision: 3,
    expectedViewRevision: 2,
    idempotencyKey: "compose-test-0001",
    ...overrides,
  };
}

test("composition discovery exposes domain instruments per lens and validates cross-lens recipes", () => {
  const schema = buildPresentationSchemas({
    instrumentTypes: ["evidence-excerpt"],
    instrumentTypesByLens: {
      investigate: ["evidence-excerpt"],
      compare: ["comparison-matrix"],
      simulate: ["scenario-controls", "sensitivity-plot"],
      brief: ["decision-brief"],
    },
    layoutIds: ["trace", "matrix", "fork", "council"],
    regions: ["primary", "secondary", "supporting"],
  }).compose_decision_room;
  const branches = Object.fromEntries(
    schema.oneOf.map((branch) => [branch.properties.lens.const, branch]),
  );
  assert.deepEqual(branches.compare.properties.instruments.items.properties.type.enum, ["comparison-matrix"]);
  assert.deepEqual(branches.simulate.properties.instruments.items.properties.type.enum, ["scenario-controls", "sensitivity-plot"]);
  assert.equal(branches.compare.properties.layoutId.const, "matrix");
  assert.equal(branches.simulate.properties.layoutId.const, "fork");

  const crossLens = compositionInput({
    instruments: [{
      id: "comparison-1",
      type: "comparison-matrix",
      region: "primary",
      priority: 90,
      entityRefs: [{ kind: "alternative", id: "alternative-1" }],
      options: {},
    }],
  });
  assert.equal(validateInput(schema, crossLens).ok, true);
  assert.equal(validateInput(schema, {
    ...crossLens,
    instruments: [{ ...crossLens.instruments[0], type: "scenario-controls" }],
  }).ok, false);
  assert.equal(validateInput(schema, { ...crossLens, layoutId: "fork" }).ok, false);
});

test("run_scenario schema accepts saved, inline, or refined scenarios but rejects an empty request", () => {
  const schema = ANALYSIS_SCHEMAS.run_scenario;
  const saved = {
    caseId: "case-1",
    scenarioId: "scenario-1",
    alternativeIds: ["alternative-1"],
  };
  const inline = {
    caseId: "case-1",
    alternativeIds: ["alternative-1"],
    overrides: [{ metricId: "metric-1", value: 12, unit: "weeks" }],
  };
  assert.equal(validateInput(schema, saved).ok, true);
  assert.equal(validateInput(schema, inline).ok, true);
  assert.equal(validateInput(schema, { ...saved, overrides: inline.overrides }).ok, true);
  assert.equal(validateInput(schema, { caseId: "case-1" }).ok, false);
  assert.equal(validateInput(schema, { ...saved, overrides: [] }).ok, false);
  assert.equal(validateInput(schema, { ...saved, arbitraryHtml: "<script>" }).ok, false);
});

test("source-read schemas require an explicit case scope and accept an optional import-review job", () => {
  assert.equal(validateInput(IMPORT_SCHEMAS.inspect_document, { documentId: "document-1" }).ok, false);
  assert.equal(validateInput(IMPORT_SCHEMAS.search_sources, { query: "cost" }).ok, false);
  assert.equal(validateInput(IMPORT_SCHEMAS.read_source_spans, {
    documentId: "document-1",
    anchors: ["fragment-1"],
  }).ok, false);
  assert.equal(validateInput(IMPORT_SCHEMAS.inspect_document, {
    caseId: "case-1",
    jobId: "job-1",
    documentId: "document-1",
  }).ok, true);
});

test("the complete catalog stays within WebMCP naming, description, schema, and mutation contracts", () => {
  const { ports, state } = createHarness();
  const catalog = createToolCatalog({
    ports,
    receipts: new ReceiptLedger(),
    actor: { id: "catalog-test-agent" },
    capabilities: state.presentation.capabilities,
  });
  const names = catalog.map((spec) => spec.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const spec of catalog) {
    assert.ok(spec.name.length <= 30, `${spec.name} exceeds the 30-character guidance`);
    assert.ok(spec.description.length <= 500, `${spec.name} description exceeds 500 characters`);
    assert.equal(spec.inputSchema.type, "object", `${spec.name} needs an object input schema`);
    assert.equal(spec.inputSchema.additionalProperties, false, `${spec.name} must reject unknown properties`);
    assert.equal(/(approve|reject_candidate|underwrite|adjudicate_claim|delete_case|submit_external)/i.test(spec.name), false);
    if (spec.mutating) {
      assert.ok(
        spec.inputSchema.required.includes("idempotencyKey"),
        `${spec.name} mutation must require an idempotency key`,
      );
    }
  }
});

test("gracefully reports an unavailable browser API", async () => {
  const { ports } = createHarness();
  const statuses = [];
  const gateway = createWebMcpGateway({ ports, modelContext: undefined, onStatus: (status) => statuses.push(status) });
  const result = await gateway.start();
  assert.equal(result.available, false);
  assert.equal(result.reason, "webmcp-unavailable");
  assert.equal(statuses.at(-1).toolCount, 0);
});

test("registers a compact state-aware tool set with no prohibited authority", async (t) => {
  const { ports } = createHarness();
  const modelContext = new FakeModelContext();
  const gateway = createWebMcpGateway({ ports, modelContext });
  t.after(() => gateway.stop());
  const result = await gateway.start();

  assert.equal(result.available, true);
  assert.ok(result.toolCount <= 10, `expected at most 10 active tools, got ${result.toolCount}`);
  assert.deepEqual(modelContext.names(), result.activeTools);
  assert.equal(modelContext.names().some((name) => /(approve|reject|underwrite|adjudicate|delete|submit_external)/i.test(name)), false);
  assert.deepEqual(modelContext.definition("query_decision_graph").annotations, {
    readOnlyHint: true,
    untrustedContentHint: true,
  });
  assert.equal(modelContext.definition("compose_decision_room").annotations.readOnlyHint, false);

  const capabilities = await modelContext.execute("get_available_capabilities", {});
  assert.equal(capabilities.ok, true);
  assert.ok(JSON.stringify(capabilities).length <= 1_400);
  assert.equal(capabilities.state.decisionRevision, 3);
});

test("strict runtime validation rejects unknown properties and stale revisions before calling presentation", async (t) => {
  const harness = createHarness();
  const modelContext = new FakeModelContext();
  const gateway = createWebMcpGateway({ ports: harness.ports, modelContext });
  t.after(() => gateway.stop());
  await gateway.start();

  const invalid = await modelContext.execute("compose_decision_room", compositionInput({ arbitraryHtml: "<script>" }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "VALIDATION_FAILED");
  assert.equal(harness.state.applyCalls, 0);

  const stale = await modelContext.execute(
    "compose_decision_room",
    compositionInput({ expectedDecisionRevision: 2, idempotencyKey: "compose-test-0002" }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "STALE_REVISION");
  assert.equal(stale.error.details.currentDecisionRevision, 3);
  assert.equal(harness.state.applyCalls, 0);
});

test("source tools enforce import-review job scope and canonical settled-room scope", async (t) => {
  const calls = [];
  const harness = createHarness({
    inspectDocument: async (documentId, options) => {
      calls.push({ documentId, options });
      return { documentId, regions: [], sourceScope: options.jobId ? "import_job" : "canonical_case" };
    },
  });
  harness.state.workspace = { ...harness.state.workspace, phase: "import_review" };
  harness.state.imports = [{ jobId: "job-1", caseId: "case-1", phase: "review_required", version: 2 }];
  const modelContext = new FakeModelContext();
  const gateway = createWebMcpGateway({ ports: harness.ports, modelContext });
  t.after(() => gateway.stop());
  await gateway.start();

  const missingJob = await modelContext.execute("inspect_document", {
    caseId: "case-1",
    documentId: "document-1",
  });
  assert.equal(missingJob.ok, false);
  assert.equal(missingJob.error.code, "VALIDATION_FAILED");
  assert.equal(calls.length, 0);

  const wrongCase = await modelContext.execute("inspect_document", {
    caseId: "case-2",
    jobId: "job-1",
    documentId: "document-1",
  });
  assert.equal(wrongCase.ok, false);
  assert.equal(wrongCase.error.code, "NOT_FOUND");
  assert.equal(calls.length, 0);

  const transient = await modelContext.execute("inspect_document", {
    caseId: "case-1",
    jobId: "job-1",
    documentId: "document-1",
  });
  assert.equal(transient.ok, true);
  assert.equal(calls[0].options.jobId, "job-1");

  harness.state.workspace = { ...harness.state.workspace, phase: "analysis" };
  harness.state.presentation = { ...harness.state.presentation, sourceDrawerOpen: true };
  harness.state.imports = [];
  harness.emit({ type: "workspace.changed" });
  await gateway.flush();
  const staleTransientScope = await modelContext.execute("inspect_document", {
    caseId: "case-1",
    jobId: "job-1",
    documentId: "document-1",
  });
  assert.equal(staleTransientScope.ok, false);
  assert.equal(staleTransientScope.error.code, "VALIDATION_FAILED");
  assert.equal(calls.length, 1);

  const canonical = await modelContext.execute("inspect_document", {
    caseId: "case-1",
    documentId: "document-1",
  });
  assert.equal(canonical.ok, true);
  assert.equal(calls[1].options.jobId, undefined);
  assert.equal(calls[1].options.caseId, "case-1");
});

test("mutations are idempotent, preserve the decision hash, and return visible bounded receipts", async (t) => {
  const harness = createHarness();
  const modelContext = new FakeModelContext();
  const receipts = [];
  const gateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext,
    onReceipt: (receipt) => receipts.push(receipt),
  });
  t.after(() => gateway.stop());
  await gateway.start();

  const input = compositionInput();
  const first = await modelContext.execute("compose_decision_room", input);
  assert.equal(first.ok, true);
  assert.equal(first.receipt.replayed, false);
  assert.equal(first.receipt.revisionBefore, 3);
  assert.equal(first.receipt.revisionAfter, 3);
  assert.equal(first.receipt.decisionHashBefore, "decision-3");
  assert.equal(first.receipt.decisionHashAfter, "decision-3");
  assert.equal(first.receipt.viewRevisionBefore, 2);
  assert.equal(first.receipt.viewRevisionAfter, 3);
  assert.equal(first.ui.settled, true);
  assert.equal(harness.state.applyCalls, 1);
  assert.ok(harness.state.settledCalls >= 2);

  const replay = await modelContext.execute("compose_decision_room", input);
  assert.equal(replay.ok, true);
  assert.equal(replay.receipt.operationId, first.receipt.operationId);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(harness.state.applyCalls, 1);

  const conflict = await modelContext.execute(
    "compose_decision_room",
    compositionInput({ question: "Use this key for a different mutation." }),
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(harness.state.applyCalls, 1);
  assert.ok(receipts.some((receipt) => receipt.status === "completed"));
  assert.ok(receipts.some((receipt) => receipt.errorCode === "IDEMPOTENCY_CONFLICT"));
  assert.ok(JSON.stringify(first).length <= 1_400);
});

test("mutation replay and conflict detection survive gateway recreation", async (t) => {
  const harness = createHarness();
  const invocationStore = new MemoryInvocationStore();
  const firstContext = new FakeModelContext();
  const firstGateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext: firstContext,
    invocationStore,
  });
  await firstGateway.start();
  const input = compositionInput({ idempotencyKey: "durable-compose-0001" });
  const committed = await firstContext.execute("compose_decision_room", input);
  assert.equal(committed.ok, true);
  assert.equal(harness.state.applyCalls, 1);
  await firstGateway.stop();

  const secondContext = new FakeModelContext();
  const secondGateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext: secondContext,
    invocationStore,
  });
  t.after(() => secondGateway.stop());
  await secondGateway.start();
  const replayed = await secondContext.execute("compose_decision_room", input);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.receipt.operationId, committed.receipt.operationId);
  assert.equal(replayed.receipt.replayed, true);
  assert.equal(harness.state.applyCalls, 1);

  const conflict = await secondContext.execute(
    "compose_decision_room",
    compositionInput({
      idempotencyKey: "durable-compose-0001",
      question: "A different request cannot reuse the durable key.",
    }),
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(harness.state.applyCalls, 1);
});

test("stale pre-execution claims are safely reclaimed while execution claims become outcome-uncertain", async () => {
  const sharedState = createMemoryInvocationState();
  const store = new MemoryInvocationStore({ sharedState });
  const key = "compose_decision_room:case-1:lease-recovery";
  const fingerprint = "sha256:lease-recovery";
  const first = await store.claim(key, fingerprint, {
    ownerId: "owner-a",
    at: "2026-01-01T00:00:00.000Z",
    leaseMs: WEBMCP_CLAIM_LEASE_MS,
  });
  assert.equal(first.status, "claimed");
  assert.equal(first.entry.status, "claimed");

  const liveContender = await store.claim(key, fingerprint, {
    ownerId: "owner-b",
    at: "2026-01-01T00:00:10.000Z",
  });
  assert.equal(liveContender.status, "pending");

  const reclaimed = await store.claim(key, fingerprint, {
    ownerId: "owner-b",
    at: "2026-01-01T00:00:31.000Z",
  });
  assert.equal(reclaimed.status, "claimed");
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(reclaimed.entry.ownerId, "owner-b");
  assert.equal(reclaimed.entry.attempt, 2);

  const displacedOwner = await store.markExecuting(
    key,
    fingerprint,
    "owner-a",
    { at: "2026-01-01T00:00:32.000Z" },
  );
  assert.equal(displacedOwner.status, "pending");

  const executing = await store.markExecuting(
    key,
    fingerprint,
    "owner-b",
    { at: "2026-01-01T00:00:32.000Z", leaseMs: 1_000 },
  );
  assert.equal(executing.status, "executing");
  assert.equal(executing.entry.status, "executing");

  const afterExecutionBoundary = await store.claim(key, fingerprint, {
    ownerId: "owner-c",
    at: "2026-01-01T00:00:34.000Z",
  });
  assert.equal(afterExecutionBoundary.status, "uncertain");
  assert.equal(afterExecutionBoundary.entry.ownerId, "owner-b");
  assert.equal((await store.get(key)).status, "executing");
});

test("legacy pending and interrupted execution records fail closed without repeating a mutation", async (t) => {
  const cases = [
    { key: "legacy-pending", status: "pending" },
    {
      key: "interrupted-executing",
      status: "executing",
      executionStartedAt: "2020-01-01T00:00:00.000Z",
      leaseExpiresAt: "2020-01-01T00:00:30.000Z",
    },
  ];

  for (const journalCase of cases) {
    await t.test(journalCase.key, async (subtest) => {
      const harness = createHarness();
      const modelContext = new FakeModelContext();
      const sharedState = createMemoryInvocationState();
      const input = compositionInput({ idempotencyKey: journalCase.key });
      const key = `compose_decision_room:case-1:${journalCase.key}`;
      sharedState.entries.set(key, {
        ...journalCase,
        key,
        fingerprint: canonicalHash(input),
        status: journalCase.status,
        ownerId: "crashed-owner",
        claimedAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        response: null,
      });
      const gateway = createWebMcpGateway({
        ports: harness.ports,
        modelContext,
        invocationStore: new MemoryInvocationStore({ sharedState }),
      });
      subtest.after(() => gateway.stop());
      await gateway.start();

      const result = await modelContext.execute("compose_decision_room", input);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "IDEMPOTENCY_OUTCOME_UNCERTAIN");
      assert.equal(result.error.retryable, false);
      assert.match(result.error.message, /not repeated/i);
      assert.match(result.error.recovery.action, /human reconcile/i);
      assert.equal(harness.state.applyCalls, 0);
      assert.equal(sharedState.entries.get(key).ownerId, "crashed-owner");
    });
  }
});

test("two gateways share one transactional claim so concurrent identical mutations execute once", async (t) => {
  const harness = createHarness();
  const started = deferred();
  const release = deferred();
  const apply = harness.ports.presentation.applyPresentationRecipe;
  harness.ports.presentation.applyPresentationRecipe = async (...args) => {
    started.resolve();
    await release.promise;
    return apply(...args);
  };
  const journalDurability = {
    durable: true,
    transactional: true,
    sharedAcrossTabs: true,
    mode: "transactional-test",
    scope: "shared-test",
  };
  const invocationState = createMemoryInvocationState();
  const receiptState = createMemoryReceiptState();
  const firstContext = new FakeModelContext();
  const secondContext = new FakeModelContext();
  const firstGateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext: firstContext,
    invocationStore: new MemoryInvocationStore({ sharedState: invocationState, journalDurability }),
    receiptLedger: new ReceiptLedger({ sharedState: receiptState, journalDurability }),
  });
  const secondGateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext: secondContext,
    invocationStore: new MemoryInvocationStore({ sharedState: invocationState, journalDurability }),
    receiptLedger: new ReceiptLedger({ sharedState: receiptState, journalDurability }),
  });
  t.after(() => Promise.all([firstGateway.stop(), secondGateway.stop()]));
  await Promise.all([firstGateway.start(), secondGateway.start()]);

  const input = compositionInput({ idempotencyKey: "cross-gateway-claim-1" });
  const firstRun = firstContext.execute("compose_decision_room", input);
  await started.promise;
  const secondRun = secondContext.execute("compose_decision_room", input);
  const conflict = await secondContext.execute(
    "compose_decision_room",
    { ...input, question: "Different input cannot reuse the pending claim." },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  release.resolve();
  const [first, replay] = await Promise.all([firstRun, secondRun]);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(first.receipt.operationId, replay.receipt.operationId);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(harness.state.applyCalls, 1);
  assert.equal(first.meta.journal.durable, true);
  assert.equal(first.meta.journal.invocation.resultPersisted, true);
});

test("transactional receipt ledgers merge concurrent appends without lost entries", async () => {
  const sharedState = createMemoryReceiptState();
  const journalDurability = {
    durable: true,
    transactional: true,
    sharedAcrossTabs: true,
    mode: "transactional-test",
    scope: "shared-test",
  };
  const first = new ReceiptLedger({ sharedState, journalDurability });
  const second = new ReceiptLedger({ sharedState, journalDurability });
  const firstReceipt = first.create({ operationId: "op-first", tool: "compose_decision_room", status: "completed" });
  const secondReceipt = second.create({ operationId: "op-second", tool: "run_scenario", status: "completed" });
  await Promise.all([first.append(firstReceipt), second.append(secondReceipt)]);
  assert.equal(first.list().total, 2);
  assert.equal(second.list().total, 2);
  assert.deepEqual(
    new Set(first.list({ limit: 10 }).entries.map((entry) => entry.operationId)),
    new Set(["op-first", "op-second"]),
  );
});

test("journal claim failure blocks mutation before execution", async (t) => {
  class ClaimFailureStore extends MemoryInvocationStore {
    async claim() {
      const error = new Error("simulated IndexedDB claim failure");
      error.stage = "claim";
      throw error;
    }
  }
  const harness = createHarness();
  const modelContext = new FakeModelContext();
  const gateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext,
    invocationStore: new ClaimFailureStore(),
  });
  t.after(() => gateway.stop());
  await gateway.start();
  const result = await modelContext.execute(
    "compose_decision_room",
    compositionInput({ idempotencyKey: "claim-failure-1" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "JOURNAL_UNAVAILABLE");
  assert.equal(result.error.details.stage, "claim");
  assert.equal(harness.state.applyCalls, 0);
});

test("journal execution-boundary failure blocks mutation before execution", async (t) => {
  class ExecutionBoundaryFailureStore extends MemoryInvocationStore {
    async markExecuting() {
      const error = new Error("simulated IndexedDB execution-boundary failure");
      error.stage = "mark-executing";
      throw error;
    }
  }
  const harness = createHarness();
  const modelContext = new FakeModelContext();
  const gateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext,
    invocationStore: new ExecutionBoundaryFailureStore(),
  });
  t.after(() => gateway.stop());
  await gateway.start();
  const result = await modelContext.execute(
    "compose_decision_room",
    compositionInput({ idempotencyKey: "execution-boundary-failure-1" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "JOURNAL_UNAVAILABLE");
  assert.equal(result.error.details.stage, "mark-executing");
  assert.equal(harness.state.applyCalls, 0);
});

test("result and receipt quota failures label successful mutations as session-only", async (t) => {
  const journalDurability = {
    durable: true,
    transactional: true,
    sharedAcrossTabs: true,
    mode: "transactional-test",
    scope: "shared-test",
  };
  class CompletionQuotaStore extends MemoryInvocationStore {
    async complete() {
      const error = new Error("simulated invocation quota failure");
      error.stage = "complete";
      throw error;
    }
  }
  class ReceiptQuotaLedger extends ReceiptLedger {
    append() {
      throw new Error("simulated receipt quota failure");
    }
  }

  const completionHarness = createHarness();
  const completionContext = new FakeModelContext();
  const completionGateway = createWebMcpGateway({
    ports: completionHarness.ports,
    modelContext: completionContext,
    invocationStore: new CompletionQuotaStore({ journalDurability }),
    receiptLedger: new ReceiptLedger({ journalDurability }),
  });
  t.after(() => completionGateway.stop());
  await completionGateway.start();
  const completionResult = await completionContext.execute(
    "compose_decision_room",
    compositionInput({ idempotencyKey: "completion-quota-1" }),
  );
  assert.equal(completionResult.ok, true);
  assert.equal(completionResult.meta.journal.durable, false);
  assert.equal(completionResult.meta.journal.status, "session-only");
  assert.equal(completionResult.meta.journal.invocation.resultPersisted, false);
  const completionReplay = await completionContext.execute(
    "compose_decision_room",
    compositionInput({ idempotencyKey: "completion-quota-1" }),
  );
  assert.equal(completionReplay.receipt.replayed, true);
  assert.equal(completionHarness.state.applyCalls, 1);

  const receiptHarness = createHarness();
  const receiptContext = new FakeModelContext();
  const receiptGateway = createWebMcpGateway({
    ports: receiptHarness.ports,
    modelContext: receiptContext,
    invocationStore: new MemoryInvocationStore({ journalDurability }),
    receiptLedger: new ReceiptQuotaLedger({ journalDurability }),
  });
  t.after(() => receiptGateway.stop());
  await receiptGateway.start();
  const receiptResult = await receiptContext.execute(
    "compose_decision_room",
    compositionInput({ idempotencyKey: "receipt-quota-1" }),
  );
  assert.equal(receiptResult.ok, true);
  assert.equal(receiptResult.meta.journal.durable, false);
  assert.equal(receiptResult.meta.journal.receipt.durable, false);
  assert.match(receiptResult.meta.journal.receipt.reason, /Receipt persistence failed/i);
  assert.equal(receiptHarness.state.applyCalls, 1);
});

test("a post-execution journal crash is not replayed by a recreated gateway", async (t) => {
  const journalDurability = {
    durable: true,
    transactional: true,
    sharedAcrossTabs: true,
    mode: "transactional-test",
    scope: "shared-test",
  };
  const sharedState = createMemoryInvocationState();
  class CompletionCrashStore extends MemoryInvocationStore {
    async complete() {
      const error = new Error("simulated crash after execution");
      error.stage = "complete";
      throw error;
    }
  }

  const harness = createHarness();
  const input = compositionInput({ idempotencyKey: "post-execution-crash" });
  const journalKey = "compose_decision_room:case-1:post-execution-crash";
  const firstContext = new FakeModelContext();
  const firstGateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext: firstContext,
    invocationStore: new CompletionCrashStore({ sharedState, journalDurability }),
  });
  t.after(() => firstGateway.stop());
  await firstGateway.start();
  const first = await firstContext.execute("compose_decision_room", input);
  assert.equal(first.ok, true);
  assert.equal(harness.state.applyCalls, 1);
  assert.equal(sharedState.entries.get(journalKey).status, "executing");

  sharedState.entries.get(journalKey).leaseExpiresAt = "2020-01-01T00:00:00.000Z";
  await firstGateway.stop();
  const secondContext = new FakeModelContext();
  const secondGateway = createWebMcpGateway({
    ports: harness.ports,
    modelContext: secondContext,
    invocationStore: new MemoryInvocationStore({ sharedState, journalDurability }),
  });
  t.after(() => secondGateway.stop());
  await secondGateway.start();
  const retry = await secondContext.execute("compose_decision_room", input);
  assert.equal(retry.ok, false);
  assert.equal(retry.error.code, "IDEMPOTENCY_OUTCOME_UNCERTAIN");
  assert.equal(retry.error.retryable, false);
  assert.equal(harness.state.applyCalls, 1);
  assert.equal(sharedState.entries.get(journalKey).status, "executing");
});

test("operation receipts remain queryable after a browser-ledger recreation", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const first = new LocalStorageReceiptLedger({ storage });
  const receipt = first.create({
    tool: "compose_decision_room",
    status: "completed",
    actor: "browser-agent",
    caseId: "case-1",
    idempotencyKey: "receipt-persistence-1",
  });
  first.append(receipt);
  const recreated = new LocalStorageReceiptLedger({ storage });
  assert.equal(recreated.get(receipt.operationId)?.idempotencyKey, "receipt-persistence-1");
  assert.equal(recreated.list().total, 1);
  recreated.clear();
  assert.equal(new LocalStorageReceiptLedger({ storage }).list().total, 0);
});

test("Chrome 151-safe retirement leaves an executing tool registered until it settles", async (t) => {
  const importRun = deferred();
  const importStarted = deferred();
  const harness = createHarness({
    state: {
      workspace: {
        id: "workspace-1",
        phase: "empty",
        activeCaseId: null,
        permissions: ["*"],
        decisionRevision: 0,
        decisionHash: "decision-empty",
      },
      contract: null,
      presentation: {
        lens: "investigate",
        viewRevision: 0,
        viewHash: "view-empty",
        capabilities: {},
      },
      imports: [],
    },
    startImport: () => {
      importStarted.resolve();
      return importRun.promise;
    },
  });
  const modelContext = new FakeModelContext();
  const gateway = createWebMcpGateway({ ports: harness.ports, modelContext });
  t.after(() => gateway.stop());
  await gateway.start();
  assert.ok(modelContext.definition("start_import"));

  const running = modelContext.execute("start_import", {
    sourceIds: ["staged-source-1"],
    idempotencyKey: "import-test-0001",
  });
  await importStarted.promise;
  harness.state.workspace = { ...harness.state.workspace, phase: "importing" };
  harness.state.imports = [{ jobId: "job-1", phase: "queued", version: 1 }];
  harness.emit({ type: "import.progress" });
  await gateway.flush();

  assert.ok(modelContext.definition("start_import"), "in-flight registration must not be aborted");
  const rejectedLateCall = await modelContext.execute("start_import", {
    sourceIds: ["staged-source-2"],
    idempotencyKey: "import-test-0002",
  });
  assert.equal(rejectedLateCall.ok, false);
  assert.equal(rejectedLateCall.error.code, "CAPABILITY_NOT_ACTIVE");

  importRun.resolve({ jobId: "job-1", phase: "queued", version: 1 });
  const completed = await running;
  assert.equal(completed.ok, true);
  await gateway.flush();
  assert.equal(modelContext.definition("start_import"), undefined);
  assert.ok(modelContext.definition("get_import_status"));
  assert.ok(modelContext.definition("cancel_import"));
});

test("large untrusted contract content is replaced by a bounded truncation envelope", async (t) => {
  const harness = createHarness();
  harness.state.contract = {
    ...harness.state.contract,
    objective: "source-derived ".repeat(2_000),
    prohibitedInputs: Array.from({ length: 100 }, (_, index) => `field-${index}-${"x".repeat(50)}`),
  };
  const modelContext = new FakeModelContext();
  const gateway = createWebMcpGateway({ ports: harness.ports, modelContext });
  t.after(() => gateway.stop());
  await gateway.start();

  const result = await modelContext.execute("get_active_decision_contract", { caseId: "case-1" });
  assert.equal(result.ok, true);
  assert.equal(result.meta.outputTruncated, true);
  assert.ok(JSON.stringify(result).length <= 1_400);
});
