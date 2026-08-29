import assert from "node:assert/strict";
import test from "node:test";

import { candidateReviewPack, createCandidateReviewFixture } from "../../src/domain-packs/index.js";
import { ImportCoordinator, parseImportInputs } from "../../src/import/index.js";
import { createDecisionCase, DecisionRuntime, evaluateDecisionCase } from "../../src/kernel/index.js";
import { createImportWebMcpAdapter, createRuntimeWebMcpAdapter } from "../../src/workspace/webMcpAdapters.js";
import { proposeCaseFromDocuments } from "../../src/workspace/importMapper.js";
import { createPresentationRecipe } from "../../src/workspace/questionCompiler.js";
import {
  applyPresentationRecipe,
  commitHumanApproval,
  confirmImportProposal,
  getImportCoordinator,
  getRuntime,
  getWorkspaceStoreState,
  initializeWorkspace,
  openApprovalPreview,
  replaceDecisionModel,
  reserveAgentImportCaseId,
  resetWorkspaceForTesting,
  runScenario,
  switchCase,
  togglePin,
  updateDecisionContract,
} from "../../src/workspace/workspaceStore.js";

const NOW = "2026-08-28T14:00:00.000Z";
const AGENT = { type: "agent", id: "import-review-test-agent" };

function input(name, type, text) {
  return { name, type, text };
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

function delayMatchingCall(target, method, predicate) {
  const original = target[method].bind(target);
  const started = deferred();
  const release = deferred();
  let delayed = false;
  target[method] = async (...args) => {
    if (!delayed && predicate(...args)) {
      delayed = true;
      started.resolve(args);
      await release.promise;
    }
    return original(...args);
  };
  return {
    started: started.promise,
    release: () => release.resolve(),
    restore: () => {
      release.resolve();
      target[method] = original;
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("WebMCP table mappings change the inferred contract instead of acting as preview-only metadata", async (t) => {
  let sequence = 0;
  const coordinator = new ImportCoordinator({
    now: () => NOW,
    idGenerator: () => `mapped-import:${++sequence}`,
  });
  await coordinator.initialize();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    resolveStagedSource: async () => ({
      domainReservation: "generic",
      input: {
        name: "options.csv",
        type: "text/csv",
        text: "option,cost,tier\nOption A,1250,1\nOption B,900,2",
      },
    }),
  });
  t.after(() => adapter.close());

  const started = await adapter.startImport(
    [{ kind: "staged_source", sourceId: "mapped-options" }],
    { caseId: "mapped-options-case", domainHint: "generic", idempotencyKey: "mapped-options-start" },
  );
  await coordinator.waitForImport(started.id);
  const review = await adapter.getImport(started.id);
  const mapped = await adapter.mapTableSchema(
    review.documentIds[0],
    [
      { sourceColumn: "option", targetField: "choice_name", semanticType: "label" },
      { sourceColumn: "cost", targetField: "annual_cost", semanticType: "currency" },
      { sourceColumn: "tier", targetField: "service_tier", semanticType: "category" },
    ],
    { jobId: started.id, expectedImportVersion: review.importVersion },
  );

  assert.equal(mapped.importVersion, review.importVersion + 1);
  const document = await coordinator.inspectDocument(review.documentIds[0]);
  const proposal = proposeCaseFromDocuments({
    caseId: "mapped-options-case",
    title: "Mapped options",
    objective: "Compare annual cost.",
    domainId: "generic",
    documents: [document],
  });
  assert.deepEqual(proposal.caseInput.alternatives.map((entry) => entry.label), ["Option A", "Option B"]);
  assert.deepEqual(
    proposal.caseInput.criteria.map((entry) => ({ label: entry.label, valueType: entry.valueType })),
    [
      { label: "annual_cost", valueType: "currency" },
      { label: "service_tier", valueType: "string" },
    ],
  );
  assert.deepEqual(proposal.claims.map((entry) => entry.value), [1250, "1", 900, "2"]);
  assert.equal(proposal.caseInput.currency, "EUR");
});

test("nested structured imports bind every inferred value to its exact JSON pointer", async () => {
  const parsed = await parseImportInputs([
    input(
      "plans.json",
      "application/json",
      JSON.stringify({
        metadata: { cost: 999, note: "This repeated key is not a plan row." },
        plans: [
          { name: "Alpha", cost: 10, details: { cost: 777 } },
          { name: "Beta", cost: 20, details: { cost: 888 } },
        ],
      }),
    ),
  ], { importId: "import:nested-json", importedAt: NOW });
  const proposal = proposeCaseFromDocuments({
    caseId: "nested-json-case",
    title: "Nested JSON",
    objective: "Compare cost.",
    domainId: "generic",
    documents: parsed.documents,
  });
  assert.deepEqual(proposal.caseInput.alternatives.map((entry) => entry.label), ["Alpha", "Beta"]);
  const beta = proposal.caseInput.alternatives.find((entry) => entry.label === "Beta");
  const cost = proposal.caseInput.criteria.find((entry) => entry.label === "cost");
  const claim = proposal.claims.find((entry) => entry.subjectId === beta.id && entry.criterionId === cost.id);
  assert.ok(claim);
  assert.equal(claim.value, 20);
  assert.equal(claim.sourceRefs[0].locator.jsonPointer, "/plans/1/cost");
  const fragment = parsed.documents[0].blocks.find((entry) => entry.id === claim.sourceRefs[0].fragmentId);
  assert.equal(fragment.text, "20");
});

test("low-confidence extracted values remain proposed and cannot drive gates or scores", async () => {
  const parsed = await parseImportInputs([
    input("options.csv", "text/csv", "name,mandatory,quality\nAlpha,yes,100\nBeta,no,0"),
  ], { importId: "import:low-confidence", importedAt: NOW });
  const uncertain = parsed.documents[0].blocks.find((entry) => entry.locator?.range === "B2");
  uncertain.confidence = 0.31;
  const proposal = proposeCaseFromDocuments({
    caseId: "low-confidence-case",
    title: "Low-confidence import",
    objective: "Compare verified requirements.",
    domainId: "generic",
    documents: parsed.documents,
  });
  const alpha = proposal.caseInput.alternatives.find((entry) => entry.label === "Alpha");
  const mandatory = proposal.caseInput.criteria.find((entry) => entry.label === "mandatory");
  const uncertainClaim = proposal.claims.find((entry) => entry.subjectId === alpha.id && entry.criterionId === mandatory.id);
  assert.equal(uncertainClaim.status, "proposed");
  assert.equal(uncertainClaim.origin, "inferred_import");
  assert.match(proposal.warnings.join(" "), /low-confidence/i);

  const decisionCase = createDecisionCase({
    ...proposal.caseInput,
    documents: parsed.documents,
    fragments: parsed.documents.flatMap((document) => document.blocks),
    claims: proposal.claims,
  });
  const evaluation = evaluateDecisionCase(decisionCase);
  const alphaResult = evaluation.results.find((entry) => entry.alternativeId === alpha.id);
  const mandatoryResult = alphaResult.criteria.find((entry) => entry.criterionId === mandatory.id);
  assert.equal(mandatoryResult.measurement.status, "unknown");
  assert.equal(mandatoryResult.weightedScore, null);
  assert.equal(mandatoryResult.status, "unknown");
  assert.equal(alphaResult.eligible, false);
});

test("candidate policy rejects protected language throughout the decision model", () => {
  const fixture = createCandidateReviewFixture();
  const unsafe = structuredClone(fixture);
  unsafe.alternatives[0].description = "Gender: woman";
  unsafe.criteria[0].label = "Date of birth";
  unsafe.claims[0].summary = "Race: undisclosed";
  unsafe.scenarios[0].description = "Compare by disability status";

  const diagnostics = candidateReviewPack.validateCase(unsafe);
  const protectedPaths = diagnostics
    .filter((entry) => entry.code === "PROTECTED_ATTRIBUTE_TEXT")
    .map((entry) => entry.path);
  assert.deepEqual(protectedPaths, [
    "$.alternatives[0].description",
    "$.criteria[0].label",
    "$.claims[0].summary",
    "$.scenarios[0].description",
  ]);
});

test("candidate WebMCP upserts fail closed when labels contain protected traits", async () => {
  const runtime = new DecisionRuntime({ now: () => NOW });
  await runtime.initialize({ seedCases: [createCandidateReviewFixture()] });
  const adapter = createRuntimeWebMcpAdapter({ runtime, permissions: ["*"] });

  await assert.rejects(
    adapter.executeCommand(
      {
        type: "decision.upsertAlternative",
        caseId: "candidate-review-demo",
        payload: {
          alternativeId: "candidate-protected",
          label: "Gender: woman",
          description: "Imported candidate",
        },
      },
      { expectedRevision: 1, idempotencyKey: "protected-candidate-upsert", actor: AGENT },
    ),
    (error) => error.code === "POLICY_DENIED" && error.safeDetails?.path === "command.payload.label",
  );
  assert.equal((await runtime.getCase("candidate-review-demo")).revision, 1);
});

test("agent-started candidate imports surface in the human review state and commit atomically", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  await initializeWorkspace();
  const coordinator = getImportCoordinator();
  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    reserveImportCaseId: reserveAgentImportCaseId,
    resolveStagedSource: async () => ({
      domainReservation: "candidate-review",
      input: {
        name: "candidate-evidence.csv",
        type: "text/csv",
        text: [
          "candidate,gender,date_of_birth,typescript_years",
          "Candidate A,woman,1990-01-02,6",
          "Candidate B,man,1989-03-04,4",
        ].join("\n"),
      },
    }),
  });
  t.after(() => adapter.close());

  await assert.rejects(
    adapter.startImport(
      [{ kind: "staged_source", sourceId: "candidate-evidence" }],
      { idempotencyKey: "agent-candidate-no-domain", actor: AGENT },
    ),
    (error) => error.code === "POLICY_DENIED" && /exactly match/.test(error.message),
  );
  await assert.rejects(
    adapter.startImport(
      [{ kind: "staged_source", sourceId: "candidate-evidence" }],
      { domainHint: "generic", idempotencyKey: "agent-candidate-wrong-domain", actor: AGENT },
    ),
    (error) => error.code === "POLICY_DENIED" && error.safeDetails?.reservedDomain === "candidate-review",
  );
  assert.equal((await coordinator.listImports()).length, 0);

  const started = await adapter.startImport(
    [{ kind: "staged_source", sourceId: "candidate-evidence" }],
    { domainHint: "candidate-review", idempotencyKey: "agent-candidate-import", actor: AGENT },
  );
  assert.match(started.caseId, /^case:/);
  assert.equal(started.inputSummaries[0].name, "Candidate source 1");
  await coordinator.waitForImport(started.id);
  const visibleReview = await waitFor(
    () => getWorkspaceStoreState().activeImportReview,
    "The review-required agent import was not surfaced in the workspace review state.",
  );

  assert.equal(getWorkspaceStoreState().intakeOpen, true);
  assert.equal(visibleReview.job.id, started.id);
  assert.equal(visibleReview.source, "agent");
  assert.equal(visibleReview.targetMode, "new-case");
  assert.deepEqual(visibleReview.proposal.caseInput.alternatives.map((entry) => entry.label), ["Candidate A", "Candidate B"]);
  assert.deepEqual(visibleReview.proposal.caseInput.criteria.map((entry) => entry.label), ["typescript_years"]);
  const reviewedEvidence = visibleReview.documents.flatMap((document) => document.blocks.map((block) => block.text));
  assert.equal(reviewedEvidence.includes("woman"), false);
  assert.equal(reviewedEvidence.includes("man"), false);
  assert.equal(reviewedEvidence.includes("1990-01-02"), false);
  assert.equal(reviewedEvidence.includes("1989-03-04"), false);
  assert.equal(reviewedEvidence.includes("[protected field redacted]"), true);

  const invalidReview = structuredClone(visibleReview);
  invalidReview.proposal.caseInput.alternatives[0].description = "Gender identity: undisclosed";
  await assert.rejects(
    confirmImportProposal(invalidReview),
    (error) => error.code === "VALIDATION_FAILED",
  );
  assert.equal(await getRuntime().getCase(visibleReview.caseId), null);
  assert.equal((await coordinator.getImport(started.id)).phase, "review_required");
  assert.equal(getWorkspaceStoreState().activeImportReview.job.id, started.id);

  const refreshedReview = getWorkspaceStoreState().activeImportReview;
  assert.ok(refreshedReview.job.version > visibleReview.job.version);
  const committed = await confirmImportProposal(refreshedReview);
  assert.equal(committed.ok, true);
  const decisionCase = await getRuntime().getCase(visibleReview.caseId);
  assert.equal(decisionCase.revision, 1);
  assert.deepEqual(decisionCase.criteria.map((entry) => entry.label), ["typescript_years"]);
  assert.equal(decisionCase.fragments.some((entry) => entry.text === "woman" || entry.text === "man"), false);
  assert.equal(decisionCase.fragments.some((entry) => entry.text === "[protected field redacted]"), true);
  assert.equal((await coordinator.getImport(started.id)).phase, "complete");
  assert.equal(getWorkspaceStoreState().activeImportReview, null);
});

test("contract mutation remains bound to its captured case when authority resolution overlaps a case switch", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { runtime, repository } = await initializeWorkspace();
  const sourceCase = getWorkspaceStoreState().activeCase;
  const sourceRevision = sourceCase.revision;
  const targetBefore = await runtime.getCase("generic-demo");
  const delayedAuthority = delayMatchingCall(
    repository,
    "getGovernance",
    (caseId) => caseId === sourceCase.id,
  );
  t.after(delayedAuthority.restore);

  const mutation = updateDecisionContract({
    question: "Which option remains best after the updated service requirement?",
    objective: "Compare the same alternatives against the updated service requirement and retain exact evidence.",
    activate: false,
  });
  await delayedAuthority.started;
  await switchCase("generic-demo");
  delayedAuthority.release();
  const result = await mutation;

  const sourceAfter = await runtime.getCase(sourceCase.id);
  const targetAfter = await runtime.getCase("generic-demo");
  const visible = getWorkspaceStoreState();
  assert.equal(result.receipt.caseId, sourceCase.id);
  assert.equal(sourceAfter.revision, sourceRevision + 1);
  assert.match(sourceAfter.contract.question, /updated service requirement/);
  assert.equal(targetAfter.revision, targetBefore.revision);
  assert.deepEqual(targetAfter.contract, targetBefore.contract);
  assert.equal(visible.activeCase.id, "generic-demo");
  assert.equal(visible.evaluation.caseId, "generic-demo");
  assert.equal(visible.snapshot.caseId, "generic-demo");
  assert.equal(visible.receipts.some((receipt) => receipt.id === result.receipt.id), false);
});

test("model mutation cannot reload or append its receipt into a case opened while the command is pending", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { runtime } = await initializeWorkspace();
  const sourceCase = structuredClone(getWorkspaceStoreState().activeCase);
  const targetBefore = await runtime.getCase("generic-demo");
  const delayedCommand = delayMatchingCall(
    runtime,
    "executeCommand",
    (command, options) => command.type === "replace_model" && options.caseId === sourceCase.id,
  );
  t.after(delayedCommand.restore);
  const model = {
    alternatives: sourceCase.alternatives,
    criteria: sourceCase.criteria,
    constraints: sourceCase.constraints,
    claims: sourceCase.claims,
  };

  const mutation = replaceDecisionModel(model);
  await delayedCommand.started;
  await switchCase("generic-demo");
  delayedCommand.release();
  const result = await mutation;

  const sourceAfter = await runtime.getCase(sourceCase.id);
  const targetAfter = await runtime.getCase("generic-demo");
  const visible = getWorkspaceStoreState();
  assert.equal(result.receipt.caseId, sourceCase.id);
  assert.equal(sourceAfter.revision, sourceCase.revision + 1);
  assert.equal(targetAfter.revision, targetBefore.revision);
  assert.equal(visible.activeCase.id, "generic-demo");
  assert.equal(visible.snapshot.caseId, "generic-demo");
  assert.equal(visible.receipts.some((receipt) => receipt.id === result.receipt.id), false);
});

test("human approval commits only its captured case without freezing a newly active case", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { runtime } = await initializeWorkspace();
  const sourceCase = structuredClone(getWorkspaceStoreState().activeCase);
  const targetBefore = await runtime.getCase("generic-demo");
  assert.equal(openApprovalPreview(), true);
  const delayedCommand = delayMatchingCall(
    runtime,
    "executeCommand",
    (command, options) => command.type === "approve_decision" && options.caseId === sourceCase.id,
  );
  t.after(delayedCommand.restore);

  const mutation = commitHumanApproval();
  await delayedCommand.started;
  await switchCase("generic-demo");
  delayedCommand.release();
  const result = await mutation;

  const sourceAfter = await runtime.getCase(sourceCase.id);
  const targetAfter = await runtime.getCase("generic-demo");
  const visible = getWorkspaceStoreState();
  assert.equal(result.receipt.caseId, sourceCase.id);
  assert.equal(sourceAfter.status, "approved");
  assert.equal(sourceAfter.revision, sourceCase.revision + 1);
  assert.equal(targetAfter.status, targetBefore.status);
  assert.equal(targetAfter.revision, targetBefore.revision);
  assert.equal(visible.activeCase.id, "generic-demo");
  assert.equal(visible.frozen, targetAfter.status === "approved");
  assert.equal(visible.approvalOpen, false);
  assert.equal(visible.receipts.some((receipt) => receipt.id === result.receipt.id), false);
});

test("a delayed scenario result cannot attach to another case after rapid switching", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { runtime } = await initializeWorkspace();
  const sourceCase = structuredClone(getWorkspaceStoreState().activeCase);
  const sourceRevision = sourceCase.revision;
  const targetBefore = await runtime.getCase("generic-demo");
  const scenarioId = sourceCase.scenarios[0].id;
  const delayedScenario = delayMatchingCall(
    runtime,
    "evaluateScenario",
    (caseId, requestedScenarioId) => caseId === sourceCase.id && requestedScenarioId === scenarioId,
  );
  t.after(delayedScenario.restore);

  const evaluation = runScenario(scenarioId);
  await delayedScenario.started;
  await switchCase("generic-demo");
  delayedScenario.release();
  const result = await evaluation;

  const visible = getWorkspaceStoreState();
  assert.equal(result.scenario.id, scenarioId);
  assert.equal((await runtime.getCase(sourceCase.id)).revision, sourceRevision);
  assert.equal((await runtime.getCase("generic-demo")).revision, targetBefore.revision);
  assert.equal(visible.activeCase.id, "generic-demo");
  assert.equal(visible.evaluation.caseId, "generic-demo");
  assert.equal(visible.snapshot.caseId, "generic-demo");
  assert.equal(visible.activeScenario, null);
  assert.equal(visible.scenarioResult, null);
});

test("composition preflight cannot reinterpret a captured case recipe after navigation", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { repository } = await initializeWorkspace();
  const sourceCase = getWorkspaceStoreState().activeCase;
  const recipe = createPresentationRecipe(
    getWorkspaceStoreState().snapshot,
    "Compare the captured case without changing its evidence or authority.",
    { lens: "compare" },
  );
  const delayedAuthority = delayMatchingCall(repository, "getGovernance", (caseId) => caseId === sourceCase.id);
  t.after(delayedAuthority.restore);

  const composition = applyPresentationRecipe(recipe, AGENT);
  await delayedAuthority.started;
  await switchCase("generic-demo");
  const targetViewRevision = getWorkspaceStoreState().viewRevision;
  delayedAuthority.release();

  await assert.rejects(composition, (error) => error.code === "EXECUTION_CANCELED");
  const visible = getWorkspaceStoreState();
  assert.equal(visible.activeCase.id, "generic-demo");
  assert.equal(visible.snapshot.caseId, "generic-demo");
  assert.equal(visible.viewRevision, targetViewRevision);
  assert.equal(visible.receipts.some((receipt) => receipt.type === "presentation.committed" && receipt.caseId === sourceCase.id), false);
});

test("shared freeze arriving during composition prevents the compiled view from committing", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { repository } = await initializeWorkspace();
  const before = getWorkspaceStoreState();
  const beforeViewRevision = before.viewRevision;
  const beforeViewHash = before.plan.viewHash;
  const recipe = createPresentationRecipe(
    before.snapshot,
    "Reframe the same decision around implementation risk while preserving authority.",
    { lens: "investigate" },
  );

  const composition = applyPresentationRecipe(recipe, AGENT);
  await waitFor(
    () => getWorkspaceStoreState().compositionPhase === "arranging",
    "Composition never reached the deterministic pre-commit phase.",
  );
  const frozen = await repository.commitGovernanceMutation({
    caseId: before.activeCase.id,
    expectedVersion: before.governance.version,
    nextGovernance: {
      ...before.governance,
      id: before.activeCase.id,
      version: before.governance.version + 1,
      manualFrozen: true,
      humanCheckpoints: before.governance.humanCheckpoints,
    },
  });
  assert.equal(frozen.status, "committed");

  await assert.rejects(composition, (error) => error.code === "CASE_FROZEN" || error.code === "EXECUTION_CANCELED");
  const visible = getWorkspaceStoreState();
  assert.equal(visible.frozen, true);
  assert.equal(visible.viewRevision, beforeViewRevision);
  assert.equal(visible.plan.viewHash, beforeViewHash);
  assert.equal(visible.compositionPhase, "idle");
});

test("canonical revision change during composition invalidates the pending view atomically", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { runtime } = await initializeWorkspace();
  const before = getWorkspaceStoreState();
  const recipe = createPresentationRecipe(
    before.snapshot,
    "Keep the current evidence visible while reorganizing the causal stage.",
    { lens: "investigate" },
  );
  const composition = applyPresentationRecipe(recipe, AGENT);
  await waitFor(
    () => getWorkspaceStoreState().compositionPhase === "arranging",
    "Composition never reached the deterministic pre-commit phase.",
  );
  const contract = {
    ...before.activeCase.contract,
    version: before.activeCase.contract.version + 1,
    question: "Which option remains defensible after the concurrent contract update?",
  };
  await runtime.executeCommand(
    { type: "replace_contract", payload: { contract } },
    {
      caseId: before.activeCase.id,
      expectedRevision: before.activeCase.revision,
      idempotencyKey: "workspace-composition-concurrent-contract",
      actor: { type: "human", id: "concurrent-owner" },
    },
  );

  await assert.rejects(composition, (error) => error.code === "STALE_REVISION" || error.code === "EXECUTION_CANCELED");
  const visible = getWorkspaceStoreState();
  assert.equal((await runtime.getCase(before.activeCase.id)).revision, before.activeCase.revision + 1);
  assert.equal(visible.viewRevision, before.viewRevision);
  assert.equal(visible.plan.viewHash, before.plan.viewHash);
  assert.equal(visible.receipts.some((receipt) => receipt.type === "presentation.committed" && receipt.viewRevisionAfter > before.viewRevision), false);
});

test("pin authority resolution cannot apply a captured-case interaction to a newly opened case", async (t) => {
  resetWorkspaceForTesting();
  t.after(() => resetWorkspaceForTesting());
  const { repository } = await initializeWorkspace();
  const sourceCase = getWorkspaceStoreState().activeCase;
  const reference = { kind: "alternative", id: sourceCase.alternatives[0].id };
  const delayedAuthority = delayMatchingCall(repository, "getGovernance", (caseId) => caseId === sourceCase.id);
  t.after(delayedAuthority.restore);

  const interaction = togglePin(reference);
  await delayedAuthority.started;
  await switchCase("generic-demo");
  const targetPins = structuredClone(getWorkspaceStoreState().pins);
  const targetViewRevision = getWorkspaceStoreState().viewRevision;
  delayedAuthority.release();
  const result = await interaction;

  const visible = getWorkspaceStoreState();
  assert.equal(result.canceled, true);
  assert.equal(visible.activeCase.id, "generic-demo");
  assert.deepEqual(visible.pins, targetPins);
  assert.equal(visible.viewRevision, targetViewRevision);
  assert.equal(visible.pins.some((pin) => pin.id === reference.id), false);
});
