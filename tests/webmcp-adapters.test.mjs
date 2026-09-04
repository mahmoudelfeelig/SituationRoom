import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

import {
  createCandidateReviewFixture,
  createGenericFixture,
  createHealthPlanFixture,
  createProcurementFixture,
} from "../src/domain-packs/index.js";
import { ImportCoordinator } from "../src/import/index.js";
import { DecisionRuntime, getDecisionHash } from "../src/kernel/index.js";
import { compilePresentation } from "../src/presentation/index.js";
import {
  createImportWebMcpAdapter,
  createOutputWebMcpAdapter,
  createPresentationWebMcpAdapter,
  createReviewArtifactStore,
  createRuntimeWebMcpAdapter,
  createWebMcpPorts,
  translatePresentationRecipeV1,
} from "../src/workspace/webMcpAdapters.js";
import { toPresentationSnapshot } from "../src/workspace/presentationAdapter.js";
import { createDecisionPacket, serializeDecisionPacket } from "../src/workspace/exporter.js";

const NOW = "2026-08-28T14:00:00.000Z";
const AGENT = { type: "agent", id: "adapter-test-agent" };

async function createRuntime(seedCases = [createGenericFixture()]) {
  let sequence = 0;
  const runtime = new DecisionRuntime({
    now: () => NOW,
    idGenerator: () => `adapter-generated:${++sequence}`,
  });
  await runtime.initialize({ seedCases });
  return runtime;
}

function commandOptions(revision, key) {
  return { expectedRevision: revision, idempotencyKey: key, actor: AGENT };
}

async function createPresentationPort(runtime) {
  let viewRevision = 1;
  let currentPlan = null;
  const listeners = new Set();
  const snapshot = async () => toPresentationSnapshot(
    await runtime.getCase("generic-demo"),
    await runtime.evaluate("generic-demo"),
    { viewRevision },
  );
  return {
    getPresentationSnapshot: snapshot,
    async applyPresentationRecipe(recipe) {
      const compiled = compilePresentation(await snapshot(), recipe, { maxInstrumentCount: 10 });
      if (!compiled.ok) return compiled;
      currentPlan = compiled.plan;
      viewRevision = compiled.plan.nextViewRevision;
      for (const listener of listeners) listener({ type: "presentation.committed", plan: currentPlan });
      return {
        ok: true,
        plan: currentPlan,
        receipt: {
          id: `view:${viewRevision}`,
          viewRevisionBefore: viewRevision - 1,
          viewRevisionAfter: viewRevision,
        },
      };
    },
    focusEntity: (reference, pathId) => ({ ok: true, reference, pathId }),
    saveView: (input) => ({ ok: true, saved: input.label }),
    restoreViewRevision: (target) => ({ ok: true, target }),
    waitForSettled: async () => ({ settled: true, viewRevision }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

test("factory exposes enriched real-runtime ports while permissions remain explicitly injected", async () => {
  const runtime = await createRuntime();
  const presentation = await createPresentationPort(runtime);
  const ports = createWebMcpPorts({
    runtime,
    presentation,
    permissions: ["workspace:read", "case:read", "analysis:read", "presentation:write"],
    getWorkspaceContext: () => ({
      governanceVersion: 7,
      sharedAuthorityAvailable: true,
      governedAgentMutationsBlocked: false,
    }),
  });

  assert.deepEqual(Object.keys(ports).sort(), ["outputs", "presentation", "reviewArtifacts", "runtime"]);
  const workspace = await ports.runtime.getWorkspaceState();
  assert.equal(workspace.workspacePhase, "analysis");
  assert.equal(workspace.activeCaseId, "generic-demo");
  assert.equal(workspace.decisionRevision, 1);
  assert.equal(workspace.governanceVersion, 7);
  assert.equal(workspace.sharedAuthorityAvailable, true);
  assert.equal(workspace.governedAgentMutationsBlocked, false);
  assert.deepEqual(workspace.permissions, ["workspace:read", "case:read", "analysis:read", "presentation:write"]);
  assert.ok(workspace.presentationCapabilities.instrumentTypes.includes("evidence-excerpt"));
  assert.equal(workspace.presentationCapabilities.instrumentTypes.includes("plan-cost-waterfall"), false);
  assert.equal(workspace.presentationCapabilities.instrumentTypes.includes("candidate-requirement-coverage"), false);
  assert.ok(workspace.presentationCapabilities.instrumentTypesByLens.compare.includes("comparison-matrix"));
  assert.ok(workspace.presentationCapabilities.instrumentTypesByLens.simulate.includes("scenario-controls"));
  assert.equal(workspace.presentationCapabilities.instrumentTypesByLens.compare.includes("scenario-controls"), false);
  assert.equal(workspace.presentationCapabilities.instrumentTypesByLens.simulate.includes("weighted-criteria"), false);

  const contract = await ports.runtime.getActiveContract("generic-demo");
  assert.equal(contract.caseId, "generic-demo");
  assert.equal(contract.decisionType, "generic");
  assert.equal(contract.evidenceThreshold, "source_required");
  assert.equal(contract.alternativeCount, 3);
});

test("inline scenarios execute typed transient overrides without changing canonical state", async () => {
  const runtime = await createRuntime();
  const adapter = createRuntimeWebMcpAdapter({ runtime, permissions: ["*"] });
  const before = await runtime.getCase("generic-demo");
  const hashBefore = getDecisionHash(before);
  const baseline = await runtime.evaluate("generic-demo");
  const baselineField = baseline.results.find((entry) => entry.alternativeId === "option-field");

  const result = await adapter.evaluate("generic-demo", {
    mode: "scenario",
    alternativeIds: ["option-field"],
    overrides: [{ metricId: "battery", value: 7, unit: "hours" }],
  });

  assert.equal(result.supported, true);
  assert.equal(result.analysisKind, "transient_typed_scenario");
  assert.equal(result.originalDecisionUnchanged, true);
  assert.deepEqual(result.appliedOverrides[0], {
    metricId: "battery",
    value: 7,
    unit: "hours",
    alternativeIds: ["option-field"],
    claimIds: ["generic-demo:claim:option-field:battery"],
  });
  const scenarioField = result.evaluation.results.find((entry) => entry.alternativeId === "option-field");
  assert.notEqual(scenarioField.score, baselineField.score);
  assert.deepEqual(await runtime.getCase("generic-demo"), before);
  assert.equal(getDecisionHash(await runtime.getCase("generic-demo")), hashBefore);

  await assert.rejects(
    adapter.evaluate("generic-demo", {
      mode: "scenario",
      alternativeIds: ["option-field"],
      overrides: [{ metricId: "battery", value: "seven", unit: "hours" }],
    }),
    (error) => error.code === "VALIDATION_FAILED" && /number/.test(error.message),
  );
});

test("saved scenarios run without inline overrides and may be refined transiently", async () => {
  const runtime = await createRuntime([createProcurementFixture()]);
  const adapter = createRuntimeWebMcpAdapter({ runtime, permissions: ["*"] });
  const before = await runtime.getCase("procurement-demo");
  const hashBefore = getDecisionHash(before);

  const savedOnly = await adapter.evaluate("procurement-demo", {
    mode: "scenario",
    scenarioId: "procurement-scenario:deployment-delay",
    alternativeIds: ["vendor-a"],
  });
  assert.equal(savedOnly.supported, true);
  assert.equal(savedOnly.analysisKind, "saved_scenario_evaluation");
  assert.equal(savedOnly.scenarioId, "procurement-scenario:deployment-delay");
  assert.equal(savedOnly.savedScenarioApplied, true);
  assert.equal(savedOnly.savedOverrideCount, 1);
  assert.deepEqual(savedOnly.appliedOverrides, []);
  assert.deepEqual(savedOnly.evaluation.results[0], {
    alternativeId: "vendor-a",
    label: "Northstar Communications",
    eligible: false,
    score: 71,
    blockers: ["r3"],
  });

  const refined = await adapter.evaluate("procurement-demo", {
    mode: "scenario",
    scenarioId: "procurement-scenario:deployment-delay",
    alternativeIds: ["vendor-a"],
    overrides: [{ metricId: "r3", value: 10, unit: "weeks" }],
  });
  assert.equal(refined.analysisKind, "saved_scenario_with_typed_overrides");
  assert.equal(refined.savedScenarioApplied, true);
  assert.equal(refined.appliedOverrides[0].value, 10);
  assert.equal(refined.evaluation.results[0].eligible, true);
  assert.equal(refined.evaluation.results[0].score, 83);

  await assert.rejects(
    adapter.evaluate("procurement-demo", { mode: "scenario" }),
    (error) => error.code === "VALIDATION_FAILED" && /scenarioId|override/i.test(error.message),
  );
  await assert.rejects(
    adapter.evaluate("procurement-demo", {
      mode: "scenario",
      scenarioId: "procurement-scenario:deployment-delay",
      overrides: [],
    }),
    (error) => error.code === "VALIDATION_FAILED" && /between 1 and 50/.test(error.message),
  );
  assert.deepEqual(await runtime.getCase("procurement-demo"), before);
  assert.equal(getDecisionHash(await runtime.getCase("procurement-demo")), hashBefore);
});

test("sensitivity and minimum-change analysis use trusted domains and report diagnostic-only gaps", async () => {
  const procurementRuntime = await createRuntime([createProcurementFixture()]);
  const procurement = createRuntimeWebMcpAdapter({ runtime: procurementRuntime, permissions: ["*"] });
  const before = await procurementRuntime.getCase("procurement-demo");
  const hashBefore = getDecisionHash(before);

  const sensitivity = await procurement.evaluate("procurement-demo", {
    mode: "sensitivity",
    alternativeIds: ["vendor-a"],
    metricIds: ["r3"],
    samples: 10,
  });
  assert.equal(sensitivity.supported, true);
  assert.equal(sensitivity.sampled, true);
  assert.equal(sensitivity.analysisKind, "deterministic_one_at_a_time_sweep");
  assert.deepEqual(sensitivity.sweeps[0].range, {
    min: 8,
    max: 14,
    step: null,
    unit: "weeks",
    source: "criterion.scoring.linear",
  });
  assert.equal(sensitivity.sweeps[0].points.length, 10);
  assert.equal(sensitivity.sweeps[0].points[0].value, 8);
  assert.equal(sensitivity.sweeps[0].points.at(-1).value, 14);
  assert.notEqual(
    sensitivity.sweeps[0].points[0].outcomes[0].score,
    sensitivity.sweeps[0].points.at(-1).outcomes[0].score,
  );

  const minimum = await procurement.evaluate("procurement-demo", {
    mode: "minimum_change",
    alternativeId: "vendor-b",
    targetStatus: "eligible",
    lockedMetricIds: [],
  });
  assert.equal(minimum.supported, true);
  assert.equal(minimum.minimumChangeFound, true);
  assert.equal(minimum.result.eligible, true);
  assert.deepEqual(
    minimum.changes.map((change) => [change.metricId, change.from, change.to]),
    [["r1", false, true], ["r4", 305000, 300000]],
  );

  const diagnostic = await procurement.evaluate("procurement-demo", {
    mode: "sensitivity",
    alternativeIds: ["vendor-a"],
    metricIds: ["r1"],
    samples: 10,
  });
  assert.equal(diagnostic.supported, false);
  assert.equal(diagnostic.sampled, false);
  assert.equal(diagnostic.analysisKind, "diagnostic_only");
  assert.equal(diagnostic.diagnostics[0].code, "NO_TRUSTED_NUMERIC_RANGE");

  assert.deepEqual(await procurementRuntime.getCase("procurement-demo"), before);
  assert.equal(getDecisionHash(await procurementRuntime.getCase("procurement-demo")), hashBefore);
});

test("minimum-change refuses exact continuous numeric exclusions and proves exactness only with a trusted discrete step", async () => {
  for (const operator of ["ne", "not_in"]) {
    const fixture = structuredClone(createGenericFixture());
    fixture.constraints = [{
      id: `generic-constraint:continuous-${operator}`,
      criterionId: "price",
      operator,
      expected: operator === "ne" ? 2050 : [2050],
      severity: "mandatory",
    }];
    fixture.contract.constraintIds = fixture.constraints.map((constraint) => constraint.id);
    const runtime = await createRuntime([fixture]);
    const adapter = createRuntimeWebMcpAdapter({ runtime, permissions: ["*"] });
    const before = await runtime.getCase("generic-demo");

    const result = await adapter.evaluate("generic-demo", {
      mode: "minimum_change",
      alternativeId: "option-field",
      targetStatus: "eligible",
      lockedMetricIds: [],
    });

    assert.equal(result.analysisKind, "diagnostic_only");
    assert.equal(result.supported, false);
    assert.equal(result.minimumChangeFound, false);
    assert.equal(result.exactOptimizationAvailable, false);
    assert.deepEqual(result.changes, []);
    assert.equal(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "CONTINUOUS_EXCLUSION_NOT_EXACT" && diagnostic.metricId === "price",
      ),
      true,
    );
    assert.deepEqual(await runtime.getCase("generic-demo"), before);
  }

  const discreteFixture = structuredClone(createGenericFixture());
  discreteFixture.constraints = [{
    id: "generic-constraint:discrete-ne",
    criterionId: "price",
    operator: "ne",
    expected: 2050,
    severity: "mandatory",
  }];
  discreteFixture.contract.constraintIds = discreteFixture.constraints.map((constraint) => constraint.id);
  const discreteRuntime = await createRuntime([discreteFixture]);
  const presentation = {
    async getPresentationSnapshot() {
      return {
        entities: [{
          id: "price-control",
          kind: "control",
          attributes: {
            control: "range",
            metricId: "price",
            min: 1500,
            max: 2400,
            step: 50,
            unit: "EUR",
          },
        }],
      };
    },
  };
  const discrete = createRuntimeWebMcpAdapter({
    runtime: discreteRuntime,
    presentation,
    permissions: ["*"],
  });
  const beforeDiscrete = await discreteRuntime.getCase("generic-demo");
  const exact = await discrete.evaluate("generic-demo", {
    mode: "minimum_change",
    alternativeId: "option-field",
    targetStatus: "eligible",
    lockedMetricIds: [],
  });

  assert.equal(exact.analysisKind, "deterministic_minimum_change_search");
  assert.equal(exact.supported, true);
  assert.equal(exact.minimumChangeFound, true);
  assert.equal(exact.exactOptimizationAvailable, true);
  assert.equal(exact.result.eligible, true);
  assert.deepEqual(exact.diagnostics, []);
  assert.equal(exact.changes.length, 1);
  assert.equal(exact.changes[0].metricId, "price");
  assert.equal(exact.changes[0].from, 2050);
  assert.equal(Math.abs(exact.changes[0].to - 2050), 50);
  assert.equal(exact.changes[0].exactWithinDomain, true);
  assert.equal(exact.changes[0].domainSource, "presentation.control.range");
  assert.deepEqual(await discreteRuntime.getCase("generic-demo"), beforeDiscrete);
});

test("dotted commands commit only lossless kernel mappings and stage ambiguous proposals without changing decision state", async () => {
  const runtime = await createRuntime();
  const reviewArtifacts = createReviewArtifactStore({ now: () => NOW, idGenerator: (kind) => `${kind}:1` });
  const adapter = createRuntimeWebMcpAdapter({ runtime, reviewArtifacts, permissions: ["*"] });

  const added = await adapter.executeCommand(
    {
      type: "decision.upsertAlternative",
      caseId: "generic-demo",
      payload: { alternativeId: "option-rugged", label: "Rugged workstation", description: "Field-service candidate" },
    },
    commandOptions(1, "add-rugged-option"),
  );
  assert.equal(added.receipt.revisionAfter, 2);
  assert.equal((await runtime.getCase("generic-demo")).alternatives.some((entry) => entry.id === "option-rugged"), true);

  const stagedUpdate = await adapter.executeCommand(
    {
      type: "decision.upsertAlternative",
      caseId: "generic-demo",
      payload: { alternativeId: "option-rugged", label: "Renamed by agent" },
    },
    commandOptions(2, "stage-rugged-update"),
  );
  assert.equal(stagedUpdate.staged, true);
  assert.equal(stagedUpdate.receipt.revisionBefore, 2);
  assert.equal(stagedUpdate.receipt.revisionAfter, 2);
  assert.deepEqual(stagedUpdate.receipt.changedEntityIds, []);
  assert.equal((await runtime.getCase("generic-demo")).alternatives.find((entry) => entry.id === "option-rugged").label, "Rugged workstation");

  const contractProposal = await adapter.executeCommand(
    {
      type: "decision.proposeContract",
      caseId: "generic-demo",
      payload: {
        decisionType: "generic",
        objective: "Replace the active objective only after human review.",
        evidenceThreshold: "corroborated",
        uncertaintyPolicy: "request_review",
        authority: "human_decides",
      },
    },
    commandOptions(2, "stage-contract-proposal"),
  );
  assert.equal(contractProposal.artifact.executable, false);
  assert.equal((await runtime.getCase("generic-demo")).revision, 2);
  assert.equal(reviewArtifacts.list("generic-demo").length, 2);
});

test("claims, evidence links, conflicts, and current-revision branches map to canonical commands", async () => {
  const runtime = await createRuntime();
  const adapter = createRuntimeWebMcpAdapter({ runtime, permissions: ["*"] });
  const current = await runtime.getCase("generic-demo");
  const fragment = current.fragments[0];

  const claimResult = await adapter.executeCommand(
    {
      type: "decision.addClaimsBatch",
      caseId: current.id,
      payload: {
        claims: [{
          claimId: "claim:webmcp-price",
          subjectRef: { kind: "alternative", id: "option-field" },
          predicate: "price",
          value: 1999,
          confidence: 0.82,
          sourceRefs: [{ kind: "source", id: fragment.id }],
        }],
      },
    },
    commandOptions(current.revision, "add-source-linked-claim"),
  );
  assert.equal(claimResult.receipt.revisionAfter, 2);
  const afterClaim = await runtime.getCase(current.id);
  assert.deepEqual(afterClaim.claims.find((claim) => claim.id === "claim:webmcp-price").sourceRefs, [
    { documentId: fragment.documentId, fragmentId: fragment.id },
  ]);

  const branch = await adapter.executeCommand(
    {
      type: "decision.createBranch",
      caseId: current.id,
      payload: { label: "Negotiated price", purpose: "Test a lower verified price", fromRevision: 2 },
    },
    commandOptions(2, "create-negotiated-branch"),
  );
  assert.equal(branch.receipt.revisionAfter, 3);
  assert.equal((await runtime.getCase(current.id)).scenarios.some((scenario) => scenario.label === "Negotiated price"), true);

  const claims = (await runtime.getCase(current.id)).claims.slice(0, 2);
  const conflict = await adapter.executeCommand(
    {
      type: "decision.flagConflict",
      caseId: current.id,
      payload: {
        leftRef: { kind: "claim", id: claims[0].id },
        rightRef: { kind: "claim", id: claims[1].id },
        reason: "The two accepted source readings require reconciliation.",
      },
    },
    commandOptions(3, "flag-source-conflict"),
  );
  assert.equal(conflict.receipt.revisionAfter, 4);
  assert.equal((await runtime.getCase(current.id)).conflicts.length, 1);
});

test("recipe v1 translation reaches the strict compiler and preserves the canonical decision revision and hash", async () => {
  const runtime = await createRuntime();
  const rawPresentation = await createPresentationPort(runtime);
  const adapter = createPresentationWebMcpAdapter({ presentation: rawPresentation });
  const before = await adapter.getPresentationSnapshot();
  const input = {
    recipeVersion: 1,
    intent: "compare",
    lens: "compare",
    question: "Compare the verified workstation evidence.",
    framing: "Keep the common criteria aligned.",
    layoutId: "matrix",
    density: "balanced",
    instruments: [{
      id: "agent-comparison",
      type: "comparison-matrix",
      region: "primary",
      priority: 90,
      entityRefs: [{ kind: "alternative", id: "option-field" }],
      options: { compact: false, showSources: true, sortBy: "label", sortDirection: "asc", metricIds: ["price"] },
    }],
    focusPathIds: [],
    expectedDecisionRevision: before.decisionRevision,
    expectedViewRevision: before.viewRevision,
  };

  const translated = translatePresentationRecipeV1(input, before);
  assert.equal(translated.schemaVersion, "1.0");
  assert.equal(translated.layout.pattern, "matrix");
  assert.equal(translated.instruments[0].options.sort, "label");
  assert.equal(translated.instruments[0].options.showSources, undefined);
  assert.ok(translated.instruments[0].entityRefs.some((reference) => reference.kind === "criterion" && reference.id === "price"));

  const applied = await adapter.applyPresentationRecipe(input, AGENT);
  assert.equal(applied.ok, true);
  assert.equal(applied.baseViewRevision, 1);
  assert.equal(applied.nextViewRevision, 2);
  assert.equal(applied.decisionHashBefore, applied.decisionHashAfter);
  assert.equal((await runtime.getCase("generic-demo")).revision, 1);
  assert.ok(applied.renderedInstrumentIds.includes("agent-comparison"));

  await assert.rejects(
    adapter.applyPresentationRecipe({ ...input, layoutId: "trace", expectedViewRevision: 2 }, AGENT),
    (error) => error.code === "VALIDATION_FAILED" && /matrix/.test(error.message),
  );
});

test("import adapter resolves inline and human-staged sources but fails closed for unsafe or unconnected URLs", async () => {
  let importSequence = 0;
  const coordinator = new ImportCoordinator({ now: () => NOW, idGenerator: () => `adapter-import-${++importSequence}` });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    resolveCaseDomain: async (caseId) => caseId === "generic-demo" ? "generic" : null,
    getCase: async () => null,
    resolveStagedSource: async (sourceId) => ({
      domainReservation: "generic",
      input: {
        name: `${sourceId}.csv`,
        type: "text/csv",
        text: "option,cost\nA,10",
      },
    }),
  });

  const inline = await adapter.startImport(
    [{ kind: "inline_text", text: "Verified evidence paragraph" }],
    { caseId: "generic-demo", domainHint: "generic", idempotencyKey: "inline-import-key" },
  );
  await coordinator.waitForImport(inline.id);
  const status = await adapter.getImport(inline.id);
  assert.equal(status.phase, "review_required");
  assert.equal(Number.isInteger(status.importVersion), true);
  const inspected = await adapter.inspectDocument(status.documentIds[0], {
    caseId: "generic-demo",
    jobId: status.id,
    includeRegions: true,
    limit: 1,
  });
  assert.equal(inspected.regions.length, 1);
  const spans = await adapter.readSourceSpans(inspected.documentId, [inspected.regions[0].anchor], {
    caseId: "generic-demo",
    jobId: status.id,
  });
  assert.match(spans.spans[0].text, /Verified evidence/);

  const staged = await adapter.startImport(
    [{ kind: "staged_source", sourceId: "human-selected-table" }],
    { caseId: "generic-demo", idempotencyKey: "staged-import-key" },
  );
  assert.equal(staged.inputSummaries[0].name, "human-selected-table.csv");
  await coordinator.waitForImport(staged.id);
  const stagedStatus = await adapter.getImport(staged.id);
  const mapped = await adapter.mapTableSchema(
    stagedStatus.documentIds[0],
    [{ sourceColumn: "option", targetField: "alternative_label", semanticType: "label" }],
    { jobId: staged.id, expectedImportVersion: stagedStatus.importVersion },
  );
  assert.equal(mapped.importVersion, stagedStatus.importVersion + 1);
  await assert.rejects(
    adapter.mapTableSchema(
      stagedStatus.documentIds[0],
      [{ sourceColumn: "cost", targetField: "cost", semanticType: "currency" }],
      { jobId: staged.id, expectedImportVersion: stagedStatus.importVersion },
    ),
    (error) => error.code === "STALE_REVISION",
  );

  await assert.rejects(
    adapter.startImport([{ kind: "url", url: "https://127.0.0.1/private" }], { idempotencyKey: "unsafe-url-key" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  await assert.rejects(
    adapter.startImport([{ kind: "url", url: "https://example.com/evidence.csv" }], { idempotencyKey: "no-url-resolver" }),
    (error) => error.code === "POLICY_DENIED",
  );
  adapter.close();
});

test("source tools inspect, search, and read only seeded canonical case evidence", async () => {
  const runtime = await createRuntime([createGenericFixture(), createProcurementFixture()]);
  const coordinator = new ImportCoordinator({ idGenerator: () => "canonical-source-unused" });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    getCase: (caseId) => runtime.getCase(caseId),
    resolveCaseDomain: async (caseId) => (await runtime.getCase(caseId))?.domain?.packId ?? null,
  });
  const generic = await runtime.getCase("generic-demo");
  const document = generic.documents[0];
  const fragment = generic.fragments.find((entry) => entry.documentId === document.id);

  const inspected = await adapter.inspectDocument(document.id, {
    caseId: generic.id,
    includeRegions: true,
  });
  assert.equal(inspected.sourceScope.kind, "canonical_case");
  assert.equal(inspected.regions[0].anchor, fragment.id);

  const searched = await adapter.searchFragments({
    caseId: generic.id,
    query: fragment.text.split(":")[0],
    documentIds: [document.id],
  });
  assert.equal(searched.sourceScope.kind, "canonical_case");
  assert.equal(searched.total, 1);
  assert.equal(searched.results[0].fragmentId, fragment.id);

  const spans = await adapter.readSourceSpans(document.id, [fragment.id], { caseId: generic.id });
  assert.equal(spans.sourceScope.kind, "canonical_case");
  assert.equal(spans.spans[0].text, fragment.text);
  adapter.close();
});

test("source scopes isolate canonical cases and transient import jobs", async () => {
  const runtime = await createRuntime([createGenericFixture(), createProcurementFixture()]);
  let sequence = 0;
  const coordinator = new ImportCoordinator({ idGenerator: () => `source-isolation-${++sequence}` });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    getCase: (caseId) => runtime.getCase(caseId),
    resolveCaseDomain: async (caseId) => (await runtime.getCase(caseId))?.domain?.packId ?? null,
  });
  const procurement = await runtime.getCase("procurement-demo");
  await assert.rejects(
    adapter.inspectDocument(procurement.documents[0].id, { caseId: "generic-demo" }),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    adapter.searchFragments({
      caseId: "generic-demo",
      query: "evidence",
      documentIds: [procurement.documents[0].id],
    }),
    (error) => error.code === "NOT_FOUND",
  );

  const first = await coordinator.startImport(
    [{ name: "first.txt", type: "text/plain", text: "first case private sentinel" }],
    { caseId: "generic-demo", domainHint: "generic" },
  );
  const second = await coordinator.startImport(
    [{ name: "second.txt", type: "text/plain", text: "second case private sentinel" }],
    { caseId: "procurement-demo", domainHint: "procurement" },
  );
  const [firstReview, secondReview] = await Promise.all([
    coordinator.waitForImport(first.id),
    coordinator.waitForImport(second.id),
  ]);
  await assert.rejects(
    adapter.inspectDocument(firstReview.documentIds[0], {
      caseId: "procurement-demo",
      jobId: secondReview.id,
    }),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    adapter.searchFragments({
      caseId: "procurement-demo",
      jobId: secondReview.id,
      query: "first case",
      documentIds: [firstReview.documentIds[0]],
    }),
    (error) => error.code === "NOT_FOUND",
  );
  const isolatedSearch = await adapter.searchFragments({
    caseId: "procurement-demo",
    jobId: secondReview.id,
    query: "first case",
  });
  assert.deepEqual(isolatedSearch.results, []);
  assert.equal(isolatedSearch.total, 0);

  const mappingFirst = await coordinator.startImport(
    [{ name: "mapping-first.csv", type: "text/csv", text: "option,cost\nA,10" }],
    { caseId: "generic-demo", domainHint: "generic" },
  );
  const mappingSecond = await coordinator.startImport(
    [{ name: "mapping-second.csv", type: "text/csv", text: "option,cost\nB,20" }],
    { caseId: "generic-demo", domainHint: "generic" },
  );
  const [mappingFirstReview, mappingSecondReview] = await Promise.all([
    coordinator.waitForImport(mappingFirst.id),
    coordinator.waitForImport(mappingSecond.id),
  ]);
  assert.equal(mappingFirstReview.version, mappingSecondReview.version);
  await assert.rejects(
    adapter.mapTableSchema(
      mappingSecondReview.documentIds[0],
      [{ sourceColumn: "option", targetField: "alternative_label", semanticType: "label" }],
      { jobId: mappingFirstReview.id, expectedImportVersion: mappingFirstReview.version },
    ),
    (error) => error.code === "NOT_FOUND",
  );
  assert.equal((await coordinator.getImport(mappingFirstReview.id)).version, mappingFirstReview.version);
  assert.equal((await coordinator.getImport(mappingSecondReview.id)).version, mappingSecondReview.version);
  adapter.close();
});

test("post-acceptance source tools use sanitized canonical evidence after parsed copies are purged", async () => {
  const runtime = await createRuntime([createCandidateReviewFixture()]);
  const coordinator = new ImportCoordinator({ idGenerator: () => "adapter-candidate-purge" });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    getCase: (caseId) => runtime.getCase(caseId),
    resolveCaseDomain: async (caseId) => (await runtime.getCase(caseId))?.domain?.packId ?? null,
  });
  const started = await coordinator.startImport(
    [{
      name: "candidate.json",
      type: "application/json",
      text: '{"gender":"private source value","typescriptYears":6.5}',
    }],
    { caseId: "candidate-review-demo", domainHint: "candidate-review" },
  );
  const reviewed = await coordinator.waitForImport(started.id);
  const documentId = reviewed.documentIds[0];
  const before = await runtime.getCase("candidate-review-demo");
  const accepted = await coordinator.acceptImport(reviewed.id, {
    runtime,
    expectedRevision: before.revision,
    expectedImportVersion: reviewed.version,
    idempotencyKey: "adapter-candidate-purge-accept",
    actor: { type: "human", id: "panel" },
  });
  assert.deepEqual(accepted.job.documentIds, []);
  await assert.rejects(coordinator.inspectDocument(documentId), (error) => error.code === "NOT_FOUND");

  const inspected = await adapter.inspectDocument(documentId, {
    caseId: "candidate-review-demo",
    includeRegions: true,
  });
  const serialized = JSON.stringify(inspected);
  assert.equal(serialized.includes("private source value"), false);
  assert.match(serialized, /protected field redacted|candidate source withheld/i);
  const protectedSearch = await adapter.searchFragments({
    caseId: "candidate-review-demo",
    query: "private source value",
    documentIds: [documentId],
  });
  assert.deepEqual(protectedSearch.results, []);
  assert.equal(protectedSearch.total, 0);
  const safeSearch = await adapter.searchFragments({
    caseId: "candidate-review-demo",
    query: "6.5",
    documentIds: [documentId],
  });
  assert.equal(safeSearch.total, 1);
  const spans = await adapter.readSourceSpans(documentId, [inspected.regions[0].anchor], {
    caseId: "candidate-review-demo",
  });
  assert.equal(JSON.stringify(spans).includes("private source value"), false);
  adapter.close();
});

test("health-plan review source tools redact structured personal fields while preserving plan terms and job scope", async () => {
  let sequence = 0;
  const coordinator = new ImportCoordinator({ idGenerator: () => `adapter-health-review:${++sequence}` });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    getCase: async () => null,
    resolveCaseDomain: async (caseId) => caseId === "health-plan-demo" ? "health-plan" : null,
  });
  const secrets = ["TRANSIENT-PRIVATE-ASTHMA", "1990-01-02", "MEMBER-PRIVATE-991"];
  const started = await coordinator.startImport(
    [{
      name: "personal-plan-comparison.csv",
      type: "text/csv",
      text: [
        "plan,monthly_premium,medical_history,date_of_birth,member_id,formulary_coverage",
        `Harbor Silver Plan,410,${secrets[0]},${secrets[1]},${secrets[2]},covered`,
      ].join("\n"),
    }],
    { caseId: "health-plan-demo", domainHint: "health-plan" },
  );
  const otherStarted = await coordinator.startImport(
    [{ name: "other-plan.txt", type: "text/plain", text: "Other Plan deductible is 900." }],
    { caseId: "health-plan-demo", domainHint: "health-plan" },
  );
  const [reviewed, otherReviewed] = await Promise.all([
    coordinator.waitForImport(started.id),
    coordinator.waitForImport(otherStarted.id),
  ]);
  assert.equal(reviewed.phase, "review_required");
  const documentId = reviewed.documentIds[0];

  const inspected = await adapter.inspectDocument(documentId, {
    caseId: "health-plan-demo",
    jobId: reviewed.id,
    includeRegions: true,
    limit: 50,
  });
  const serializedInspection = JSON.stringify(inspected);
  for (const secret of secrets) assert.equal(serializedInspection.includes(secret), false);
  assert.match(serializedInspection, /health-sensitive field redacted/i);
  assert.match(serializedInspection, /Harbor Silver Plan/);
  assert.match(serializedInspection, /monthly_premium/);
  assert.match(serializedInspection, /formulary_coverage/);

  const spans = await adapter.readSourceSpans(
    documentId,
    inspected.regions.map((region) => region.anchor),
    { caseId: "health-plan-demo", jobId: reviewed.id },
  );
  const serializedSpans = JSON.stringify(spans);
  for (const secret of secrets) assert.equal(serializedSpans.includes(secret), false);
  assert.match(serializedSpans, /Harbor Silver Plan/);

  for (const secret of secrets) {
    const searched = await adapter.searchFragments({
      caseId: "health-plan-demo",
      jobId: reviewed.id,
      query: secret,
      documentIds: [documentId],
    });
    assert.equal(searched.total, 0);
  }
  const safeSearch = await adapter.searchFragments({
    caseId: "health-plan-demo",
    jobId: reviewed.id,
    query: "Harbor Silver Plan",
    documentIds: [documentId],
  });
  assert.equal(safeSearch.total, 1);

  await assert.rejects(
    adapter.inspectDocument(documentId, {
      caseId: "health-plan-demo",
      jobId: otherReviewed.id,
      includeRegions: true,
    }),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    adapter.searchFragments({
      caseId: "other-health-case",
      jobId: reviewed.id,
      query: "Harbor Silver Plan",
    }),
    (error) => error.code === "NOT_FOUND",
  );
  adapter.close();
});

test("health-plan review withholds unstructured clinical sources from inspect, search, and span reads", async () => {
  let sequence = 0;
  const coordinator = new ImportCoordinator({ idGenerator: () => `adapter-health-unstructured:${++sequence}` });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    getCase: async () => null,
    resolveCaseDomain: async (caseId) => caseId === "health-plan-demo" ? "health-plan" : null,
  });
  const secrets = ["Jane Private", "TRANSIENT-CLINICAL-SECRET", "SECRET-MED"];
  const started = await coordinator.startImport(
    [
      {
        name: "plan-terms.txt",
        type: "text/plain",
        text: "Harbor Silver Plan coverage terms: deductible EUR 1,800 and formulary coverage included.",
      },
      {
        name: "personal-medical-record.txt",
        type: "text/plain",
        text: `Patient name: ${secrets[0]}. Medical history: ${secrets[1]}. Current medications: ${secrets[2]}.`,
      },
    ],
    { caseId: "health-plan-demo", domainHint: "health-plan" },
  );
  const reviewed = await coordinator.waitForImport(started.id);
  assert.equal(reviewed.phase, "review_required");
  const inspectedDocuments = await Promise.all(reviewed.documentIds.map((documentId) => adapter.inspectDocument(documentId, {
    caseId: "health-plan-demo",
    jobId: reviewed.id,
    includeRegions: true,
    limit: 50,
  })));
  const inspectedSerialized = JSON.stringify(inspectedDocuments);
  for (const secret of secrets) assert.equal(inspectedSerialized.includes(secret), false);
  assert.match(inspectedSerialized, /personal clinical source withheld pending plan-term-only extraction/i);
  assert.match(inspectedSerialized, /deductible EUR 1,800/);

  for (const document of inspectedDocuments) {
    const spans = await adapter.readSourceSpans(
      document.id,
      document.regions.map((region) => region.anchor),
      { caseId: "health-plan-demo", jobId: reviewed.id },
    );
    const serialized = JSON.stringify(spans);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  }
  for (const query of [...secrets, "personal clinical source withheld"]) {
    const searched = await adapter.searchFragments({
      caseId: "health-plan-demo",
      jobId: reviewed.id,
      query,
    });
    assert.equal(searched.total, 0);
  }
  const safeSearch = await adapter.searchFragments({
    caseId: "health-plan-demo",
    jobId: reviewed.id,
    query: "deductible EUR 1,800",
  });
  assert.equal(safeSearch.total, 1);
  assert.match(safeSearch.results[0].excerpt, /Harbor Silver Plan/);
  adapter.close();
});

test("health-plan imports cannot expose sensitive source fields after canonical acceptance or export", async () => {
  const runtime = await createRuntime([createHealthPlanFixture()]);
  const coordinator = new ImportCoordinator({ idGenerator: () => "adapter-health-source-privacy" });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    getCase: (caseId) => runtime.getCase(caseId),
    resolveCaseDomain: async (caseId) => (await runtime.getCase(caseId))?.domain?.packId ?? null,
  });
  const secrets = [
    "private asthma history",
    "1990-01-02",
    "MEMBER-PRIVATE-991",
  ];
  const started = await coordinator.startImport(
    [{
      name: "personal-plan-comparison.csv",
      type: "text/csv",
      text: [
        "plan,monthly_premium,medical_history,date_of_birth,member_id,formulary_coverage",
        `Harbor Silver Plan,410,${secrets[0]},${secrets[1]},${secrets[2]},covered`,
      ].join("\n"),
    }],
    { caseId: "health-plan-demo", domainHint: "health-plan" },
  );
  const reviewed = await coordinator.waitForImport(started.id);
  const documentId = reviewed.documentIds[0];
  const before = await runtime.getCase("health-plan-demo");
  const accepted = await coordinator.acceptImport(reviewed.id, {
    runtime,
    expectedRevision: before.revision,
    expectedImportVersion: reviewed.version,
    idempotencyKey: "adapter-health-source-privacy-accept",
    actor: { type: "human", id: "consumer" },
  });
  assert.equal(accepted.diagnostics.some((entry) => entry.code === "HEALTH_SENSITIVE_SOURCE_FIELDS_REDACTED"), true);
  assert.deepEqual(accepted.job.documentIds, []);
  await assert.rejects(coordinator.inspectDocument(documentId), (error) => error.code === "NOT_FOUND");

  const canonical = await runtime.getCase("health-plan-demo");
  const canonicalSource = canonical.fragments.filter((fragment) => fragment.documentId === documentId);
  assert.ok(canonicalSource.length > 0);
  const canonicalSerialized = JSON.stringify(canonicalSource);
  for (const secret of secrets) assert.equal(canonicalSerialized.includes(secret), false);
  assert.match(canonicalSerialized, /health-sensitive field redacted/i);
  assert.match(canonicalSerialized, /monthly_premium/);
  assert.match(canonicalSerialized, /formulary_coverage/);

  const inspected = await adapter.inspectDocument(documentId, {
    caseId: "health-plan-demo",
    includeRegions: true,
    limit: 50,
  });
  const sourceSpans = await adapter.readSourceSpans(
    documentId,
    inspected.regions.map((region) => region.anchor),
    { caseId: "health-plan-demo" },
  );
  for (const sourceResult of [inspected, sourceSpans]) {
    const serialized = JSON.stringify(sourceResult);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  }
  for (const secret of secrets) {
    const searched = await adapter.searchFragments({
      caseId: "health-plan-demo",
      query: secret,
      documentIds: [documentId],
    });
    assert.equal(searched.total, 0);
  }

  const packet = createDecisionPacket(canonical, await runtime.evaluate("health-plan-demo"), {
    generatedAt: NOW,
  });
  const exported = ["json", "jsonld", "csv", "html", "pdf"]
    .map((format) => serializeDecisionPacket(packet, format).text);
  exported.push(strFromU8(unzipSync(serializeDecisionPacket(packet, "xlsx").bytes)["xl/worksheets/sheet1.xml"]));
  exported.push(strFromU8(unzipSync(serializeDecisionPacket(packet, "docx").bytes)["word/document.xml"]));
  for (const content of exported) {
    for (const secret of secrets) assert.equal(content.includes(secret), false);
  }
  adapter.close();
});

test("output adapter returns bounded previews and visible non-executable drafts", async () => {
  const runtime = await createRuntime();
  const reviewArtifacts = createReviewArtifactStore({ now: () => NOW });
  const outputs = createOutputWebMcpAdapter({ runtime, reviewArtifacts });

  const preview = await outputs.previewDecisionPacket({
    caseId: "generic-demo",
    format: "html",
    includeAppendix: true,
    expectedDecisionRevision: 1,
  });
  assert.equal(preview.status, "preview");
  assert.equal(preview.executable, false);
  assert.equal(preview.alternatives.length, 3);
  assert.ok(JSON.stringify(preview).length < 8_000);

  const draft = await outputs.draftRequest({
    caseId: "generic-demo",
    purpose: "Request independent confirmation of the repairability evidence.",
    recipientRole: "Technical reviewer",
    entityRefs: [{ kind: "criterion", id: "repairable" }],
    expectedDecisionRevision: 1,
    idempotencyKey: "draft-review-request",
  }, { actor: AGENT });
  assert.equal(draft.awaitingHuman, true);
  assert.equal(draft.artifact.executable, false);
  assert.match(draft.artifact.payload.body, /has not been sent/);
  assert.equal((await runtime.getCase("generic-demo")).revision, 1);

  await assert.rejects(
    outputs.prepareExternalAction({
      caseId: "generic-demo",
      actionType: "approve_purchase",
      summary: "Approve and submit the purchase.",
      expectedDecisionRevision: 1,
      idempotencyKey: "prohibited-action-draft",
    }, { actor: AGENT }),
    (error) => error.code === "POLICY_DENIED",
  );

  let staleHandlerCalled = false;
  const delegated = createOutputWebMcpAdapter({
    runtime,
    handlers: {
      exportCase: async () => {
        staleHandlerCalled = true;
        return { ok: true };
      },
    },
  });
  await assert.rejects(
    delegated.exportCase({
      caseId: "generic-demo",
      format: "json",
      expectedDecisionRevision: 0,
      idempotencyKey: "stale-export-handler",
    }, { actor: AGENT }),
    (error) => error.code === "STALE_REVISION",
  );
  assert.equal(staleHandlerCalled, false);
});

test("agent-authored drafts reject invented citations and regulated-domain policy laundering", async () => {
  const runtime = await createRuntime([
    createGenericFixture(),
    createCandidateReviewFixture(),
    createHealthPlanFixture(),
  ]);
  const outputs = createOutputWebMcpAdapter({ runtime });

  await assert.rejects(
    outputs.draftRequest({
      caseId: "generic-demo",
      purpose: "Clarify this cited record.",
      recipientRole: "Reviewer",
      entityRefs: [{ kind: "criterion", id: "invented-criterion" }],
      expectedDecisionRevision: 1,
      idempotencyKey: "invented-citation-request",
    }, { actor: AGENT }),
    (error) => error.code === "NOT_FOUND" && /not part of this decision revision/i.test(error.message),
  );

  for (const purpose of [
    "Please compare the candidates' pregnancy status.",
    "Please decide which candidate should be hired and shortlisted.",
  ]) {
    await assert.rejects(
      outputs.draftRequest({
        caseId: "candidate-review-demo",
        purpose,
        recipientRole: "Evidence reviewer",
        entityRefs: [{ kind: "criterion", id: "typescript-years" }],
        expectedDecisionRevision: 1,
        idempotencyKey: `candidate-policy-${purpose.includes("pregnancy") ? "trait" : "outcome"}`,
      }, { actor: AGENT }),
      (error) => error.code === "POLICY_DENIED",
    );
  }

  await assert.rejects(
    outputs.prepareExternalAction({
      caseId: "health-plan-demo",
      actionType: "review_note",
      summary: "Recommend which chemotherapy treatment this person should start.",
      entityRefs: [{ kind: "criterion", id: "monthly-premium" }],
      expectedDecisionRevision: 1,
      idempotencyKey: "health-treatment-laundering",
    }, { actor: AGENT }),
    (error) => error.code === "POLICY_DENIED",
  );

  const safe = await outputs.draftRequest({
    caseId: "health-plan-demo",
    purpose: "Clarify the declared monthly premium source for this insurance plan comparison.",
    recipientRole: "Plan benefits reviewer",
    entityRefs: [{ kind: "criterion", id: "monthly-premium" }],
    expectedDecisionRevision: 1,
    idempotencyKey: "health-plan-safe-request",
  }, { actor: AGENT });
  assert.equal(safe.awaitingHuman, true);
  assert.equal((await runtime.getCase("health-plan-demo")).revision, 1);
});
