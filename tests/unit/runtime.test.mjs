import test from "node:test";
import assert from "node:assert/strict";

import {
  DecisionRuntime,
  ERROR_CODES,
  SituationRoomError,
  getDecisionHash,
} from "../../src/kernel/index.js";
import {
  createCandidateReviewFixture,
  createGenericFixture,
  createHealthPlanFixture,
  createProcurementFixture,
} from "../../src/domain-packs/index.js";

function deterministicRuntime(seedCases) {
  let nextId = 0;
  const runtime = new DecisionRuntime({
    idGenerator: () => `generated:${++nextId}`,
    now: () => "2026-08-28T12:00:00.000Z",
  });
  return runtime.initialize({ seedCases }).then(() => runtime);
}

test("runtime exposes workspace, graph, evaluation, revision receipts, and idempotent replay", async () => {
  const runtime = await deterministicRuntime([createGenericFixture()]);
  const workspace = await runtime.getWorkspaceState();
  assert.equal(workspace.activeCaseId, "generic-demo");
  assert.equal(workspace.domainPacks.length, 4);
  assert.equal((await runtime.evaluate()).recommendation.alternativeId, "option-light");
  assert.equal((await runtime.queryGraph({ statuses: ["pass"] })).paths.length > 0, true);

  const initial = await runtime.getCase();
  const command = {
    type: "create_scenario",
    payload: { scenario: { id: "scenario:portable", label: "Portable-first", claimOverrides: {} } },
  };
  const options = {
    expectedRevision: initial.revision,
    idempotencyKey: "scenario-portable",
    actor: { type: "agent", id: "test-agent" },
  };
  const committed = await runtime.executeCommand(command, options);
  assert.equal(committed.replayed, false);
  assert.equal(committed.receipt.revisionAfter, initial.revision + 1);
  assert.equal(committed.receipt.decisionHashBefore, committed.receipt.decisionHashAfter);
  assert.equal((await runtime.getCase()).scenarios.length, initial.scenarios.length + 1);

  const replayed = await runtime.executeCommand(command, options);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.receipt.id, committed.receipt.id);

  await assert.rejects(
    runtime.executeCommand(
      { type: "create_scenario", payload: { scenario: { id: "scenario:other", label: "Other" } } },
      { ...options, idempotencyKey: "stale-command" },
    ),
    (error) => error instanceof SituationRoomError && error.code === ERROR_CODES.STALE_REVISION,
  );
  await assert.rejects(
    runtime.executeCommand(
      { type: "create_scenario", payload: { scenario: { id: "scenario:different", label: "Different" } } },
      options,
    ),
    (error) => error instanceof SituationRoomError && error.code === ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
});

test("the human model editor replaces typed rows atomically and agents cannot use it", async () => {
  const runtime = await deterministicRuntime([createGenericFixture()]);
  const before = await runtime.getCase("generic-demo");
  const model = {
    alternatives: before.alternatives.map((entry, index) => ({
      ...entry,
      label: index === 0 ? "Field workstation, revised" : entry.label,
    })),
    criteria: [...before.criteria].reverse(),
    constraints: before.constraints,
    claims: before.claims,
  };
  await assert.rejects(
    runtime.executeCommand(
      { type: "replace_model", payload: { model } },
      {
        expectedRevision: before.revision,
        idempotencyKey: "agent-model-replacement",
        actor: { type: "agent", id: "browser-agent" },
      },
    ),
    (error) => error.code === ERROR_CODES.POLICY_DENIED,
  );
  const committed = await runtime.executeCommand(
    { type: "replace_model", payload: { model } },
    {
      expectedRevision: before.revision,
      idempotencyKey: "human-model-replacement",
      actor: { type: "human", id: "decision-owner" },
    },
  );
  const after = await runtime.getCase("generic-demo");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.alternatives[0].label, "Field workstation, revised");
  assert.deepEqual(after.criteria.map((entry) => entry.id), before.criteria.map((entry) => entry.id).reverse());
  assert.deepEqual(after.contract.criterionIds, after.criteria.map((entry) => entry.id));
  assert.equal(committed.receipt.commandType, "replace_model");

  await assert.rejects(
    runtime.executeCommand(
      {
        type: "replace_model",
        payload: { model: { ...model, alternatives: [] } },
      },
      {
        expectedRevision: after.revision,
        idempotencyKey: "invalid-model-replacement",
        actor: { type: "human", id: "decision-owner" },
      },
    ),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED,
  );
  assert.deepEqual(await runtime.getCase("generic-demo"), after);
});

test("runtime evaluates the policy-safe fixture scenario in every domain without mutating its case", async () => {
  const fixtures = [
    createProcurementFixture(),
    createCandidateReviewFixture(),
    createHealthPlanFixture(),
    createGenericFixture(),
  ];
  const runtime = await deterministicRuntime(fixtures);

  for (const fixture of fixtures) {
    assert.equal(fixture.scenarios.length > 0, true);
    const before = await runtime.getCase(fixture.id);
    const hashBefore = getDecisionHash(before);
    const baseEvaluation = await runtime.evaluate(fixture.id);
    const scenario = fixture.scenarios[0];
    const result = await runtime.evaluateScenario(fixture.id, scenario.id);
    const after = await runtime.getCase(fixture.id);

    assert.equal(result.scenario.id, scenario.id);
    assert.equal(result.baseRevision, fixture.revision);
    assert.equal(result.originalDecisionUnchanged, true);
    assert.equal(result.evaluation.caseId, fixture.id);
    assert.equal(result.evaluation.results.length, fixture.alternatives.length);
    if (fixture.domain.packId === "candidate-review") {
      assert.equal(result.evaluation.results.every((entry) => !("score" in entry) && !("eligible" in entry)), true);
      assert.equal(result.evaluation.recommendation, null);
      assert.equal(result.evaluation.ranking, null);
    } else {
      assert.equal(
        result.evaluation.results.some((scenarioResult) => {
          const baseResult = baseEvaluation.results.find(
            (entry) => entry.alternativeId === scenarioResult.alternativeId,
          );
          return scenarioResult.score !== baseResult?.score;
        }),
        true,
        `${fixture.domain.packId} scenario scores must reflect its evaluated measurements`,
      );
    }
    for (const [claimId, expectedValue] of Object.entries(scenario.claimOverrides ?? {})) {
      const claim = before.claims.find((entry) => entry.id === claimId);
      const scenarioResult = result.evaluation.results.find(
        (entry) => entry.alternativeId === claim.subjectId,
      );
      const criterionResult = scenarioResult.criteria.find(
        (entry) => entry.criterionId === claim.criterionId,
      );
      assert.equal(criterionResult.measurement.status, "known");
      assert.deepEqual(criterionResult.measurement.value, expectedValue);
    }
    assert.deepEqual(after, before);
    assert.equal(getDecisionHash(after), hashBefore);
  }
});

test("scenario creation rejects unsafe overrides atomically", async () => {
  const cases = [
    {
      createFixture: createGenericFixture,
      scenario: {
        id: "scenario:unknown-claim",
        label: "Unknown claim",
        claimOverrides: { "claim:does-not-exist": 1 },
      },
      diagnosticCode: "UNKNOWN_REFERENCE",
    },
    {
      createFixture: createGenericFixture,
      scenario: {
        id: "scenario:type-drift",
        label: "Type drift",
        claimOverrides: { "generic-demo:claim:option-field:price": "free" },
      },
      diagnosticCode: "CLAIM_TYPE_MISMATCH",
    },
    {
      createFixture: createGenericFixture,
      scenario: {
        id: "scenario:malformed-overrides",
        label: "Malformed overrides",
        claimOverrides: [],
      },
      diagnosticCode: "OBJECT_REQUIRED",
    },
    {
      createFixture: createCandidateReviewFixture,
      scenario: {
        id: "scenario:protected-field",
        label: "Protected field",
        claimOverrides: {},
        modelInputs: { interview: { gender: "must never enter the case" } },
      },
      diagnosticCode: "PROHIBITED_FIELD",
    },
  ];

  for (const entry of cases) {
    const fixture = entry.createFixture();
    const runtime = await deterministicRuntime([fixture]);
    const before = await runtime.getCase(fixture.id);
    const hashBefore = getDecisionHash(before);
    await assert.rejects(
      runtime.executeCommand(
        { type: "create_scenario", payload: { scenario: entry.scenario } },
        {
          expectedRevision: before.revision,
          idempotencyKey: `reject-${entry.scenario.id}`,
          actor: { type: "agent", id: "scenario-test-agent" },
        },
      ),
      (error) =>
        error instanceof SituationRoomError &&
        error.code === ERROR_CODES.VALIDATION_FAILED &&
        error.details?.diagnostics?.some((diagnostic) => diagnostic.code === entry.diagnosticCode),
    );
    const after = await runtime.getCase(fixture.id);
    assert.deepEqual(after, before);
    assert.equal(getDecisionHash(after), hashBefore);
  }
});

test("scenario-only claims stay isolated during evaluation and become canonical only on human merge", async () => {
  const runtime = await deterministicRuntime([createGenericFixture()]);
  const before = await runtime.getCase("generic-demo");
  const scenario = {
    id: "scenario:derived-price",
    label: "Derived price branch",
    claimOverrides: {},
    additionalClaims: [
      {
        id: "scenario:derived-price:claim",
        subjectId: "option-field",
        criterionId: "price",
        value: 1995,
        status: "accepted",
        origin: "derived",
        confidence: 0.75,
        sourceRefs: [],
      },
    ],
  };
  const created = await runtime.executeCommand(
    { type: "create_scenario", payload: { scenario } },
    {
      expectedRevision: before.revision,
      idempotencyKey: "create-derived-price-scenario",
      actor: { type: "agent", id: "scenario-test-agent" },
    },
  );
  const beforeEvaluation = await runtime.getCase("generic-demo");
  const hashBeforeEvaluation = getDecisionHash(beforeEvaluation);
  await runtime.evaluateScenario("generic-demo", scenario.id);
  const afterEvaluation = await runtime.getCase("generic-demo");
  assert.deepEqual(afterEvaluation, beforeEvaluation);
  assert.equal(getDecisionHash(afterEvaluation), hashBeforeEvaluation);
  assert.equal(afterEvaluation.claims.some((claim) => claim.id === "scenario:derived-price:claim"), false);

  await runtime.executeCommand(
    { type: "merge_scenario", payload: { scenarioId: scenario.id } },
    {
      expectedRevision: created.receipt.revisionAfter,
      idempotencyKey: "merge-derived-price-scenario",
      actor: { type: "human", id: "decision-owner" },
    },
  );
  const merged = await runtime.getCase("generic-demo");
  const mergedScenario = merged.scenarios.find((entry) => entry.id === scenario.id);
  assert.equal(merged.claims.some((claim) => claim.id === "scenario:derived-price:claim"), true);
  assert.deepEqual(mergedScenario.additionalClaims, []);
  assert.deepEqual(mergedScenario.mergedClaimIds, ["scenario:derived-price:claim"]);
  assert.equal(typeof mergedScenario.mergedAt, "string");
});

test("approval is human-only, digest-bound, eligibility-gated, and freezes the case", async () => {
  const runtime = await deterministicRuntime([createGenericFixture()]);
  const current = await runtime.getCase();
  const workspace = await runtime.getWorkspaceState();
  const digest = workspace.cases[0].decisionHash;
  await assert.rejects(
    runtime.executeCommand(
      {
        type: "approve_decision",
        payload: { alternativeId: "option-light", approvalId: "approval:agent", expectedDecisionHash: digest },
      },
      {
        expectedRevision: current.revision,
        idempotencyKey: "agent-approval",
        actor: { type: "agent", id: "agent" },
      },
    ),
    (error) => error.code === ERROR_CODES.POLICY_DENIED,
  );
  const approval = await runtime.executeCommand(
    {
      type: "approve_decision",
      payload: { alternativeId: "option-light", approvalId: "approval:human", expectedDecisionHash: digest },
    },
    {
      expectedRevision: current.revision,
      idempotencyKey: "human-approval",
      actor: { type: "human", id: "reviewer" },
    },
  );
  assert.notEqual(approval.receipt.decisionHashBefore, approval.receipt.decisionHashAfter);
  assert.equal((await runtime.getCase()).status, "approved");
  await assert.rejects(
    runtime.executeCommand(
      { type: "create_scenario", payload: { scenario: { id: "scenario:late", label: "Late" } } },
      {
        expectedRevision: approval.receipt.revisionAfter,
        idempotencyKey: "after-approval",
        actor: { type: "human", id: "reviewer" },
      },
    ),
    (error) => error.code === ERROR_CODES.CASE_FROZEN,
  );
});

test("candidate pack prevents outcome approval even by a human", async () => {
  const runtime = await deterministicRuntime([createCandidateReviewFixture()]);
  const current = await runtime.getCase();
  await assert.rejects(
    runtime.executeCommand(
      {
        type: "approve_decision",
        payload: {
          alternativeId: "candidate-a17",
          approvalId: "candidate-approval",
          expectedDecisionHash: (await runtime.getWorkspaceState()).cases[0].decisionHash,
        },
      },
      {
        expectedRevision: current.revision,
        idempotencyKey: "candidate-approval",
        actor: { type: "human", id: "panel" },
      },
    ),
    (error) => error.code === ERROR_CODES.POLICY_DENIED,
  );
});

test("candidate contract question and objective reject protected-purpose language", async () => {
  const unsafeContracts = [
    {
      field: "question",
      value: "Which candidate's age should influence the interview panel's review?",
    },
    {
      field: "objective",
      value: "Use gender to decide which application receives additional review.",
    },
  ];

  for (const { field, value } of unsafeContracts) {
    const fixture = structuredClone(createCandidateReviewFixture());
    fixture.contract[field] = value;
    const runtime = new DecisionRuntime({
      now: () => "2026-08-28T12:00:00.000Z",
      idGenerator: () => `candidate-policy:${field}`,
    });
    await assert.rejects(
      runtime.initialize({ seedCases: [fixture] }),
      (error) =>
        error instanceof SituationRoomError &&
        error.code === ERROR_CODES.VALIDATION_FAILED &&
        error.details?.diagnostics?.some(
          (diagnostic) =>
            diagnostic.code === "PROTECTED_ATTRIBUTE_TEXT" &&
            diagnostic.path === `$.contract.${field}`,
        ),
      `candidate contract ${field} must reject protected-purpose language`,
    );
  }
});

test("candidate model accepts only opaque identifiers and positively typed job evidence", async () => {
  for (const label of [
    "45-year-old Muslim woman",
    "Exampleland national with a disability",
    "Jane Smith",
  ]) {
    const fixture = structuredClone(createCandidateReviewFixture());
    fixture.alternatives[0].label = label;
    await assert.rejects(
      new DecisionRuntime().initialize({ seedCases: [fixture] }),
      (error) =>
        error instanceof SituationRoomError &&
        error.code === ERROR_CODES.VALIDATION_FAILED &&
        error.details?.diagnostics?.some((diagnostic) => diagnostic.code === "CANDIDATE_IDENTIFIER_NOT_BLINDED"),
    );
  }

  const nonJobCriterion = structuredClone(createCandidateReviewFixture());
  nonJobCriterion.criteria[0].label = "Religion and nationality fit";
  nonJobCriterion.criteria[0].candidateAspect = "required-experience";
  await assert.rejects(
    new DecisionRuntime().initialize({ seedCases: [nonJobCriterion] }),
    (error) =>
      error instanceof SituationRoomError &&
      error.code === ERROR_CODES.VALIDATION_FAILED &&
      error.details?.diagnostics?.some((diagnostic) => diagnostic.code === "CANDIDATE_CRITERION_NOT_JOB_RELATED"),
  );
});

test("health-plan policy accepts plan comparison and rejects diagnosis, treatment, underwriting, personalized premium, and claims decisions", async () => {
  const safeRuntime = await deterministicRuntime([createHealthPlanFixture()]);
  assert.equal((await safeRuntime.evaluate("health-plan-demo")).recommendation.alternativeId, "plan-harbor");
  const safePrescriptionPlan = structuredClone(createHealthPlanFixture());
  safePrescriptionPlan.alternatives[0].label = "Harbor Prescription Drug Plan";
  await deterministicRuntime([safePrescriptionPlan]);

  const unsafeModels = [
    {
      label: "diagnosis criterion",
      mutate(fixture) {
        fixture.criteria[0].label = "Predicted diagnosis";
      },
      code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
      path: "$.criteria[0].label",
    },
    {
      label: "treatment alternative",
      mutate(fixture) {
        fixture.alternatives[0].label = "Chemotherapy A";
      },
      code: "CLINICAL_ALTERNATIVE_PROHIBITED",
      path: "$.alternatives[0].label",
    },
    {
      label: "procedure alternative",
      mutate(fixture) {
        fixture.alternatives[0].label = "Radiation therapy";
      },
      code: "CLINICAL_ALTERNATIVE_PROHIBITED",
      path: "$.alternatives[0].label",
    },
    {
      label: "underwriting objective",
      mutate(fixture) {
        fixture.contract.objective = "Underwrite this household using the imported evidence.";
      },
      code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
      path: "$.contract.objective",
    },
    {
      label: "personalized premium objective",
      mutate(fixture) {
        fixture.contract.objective = "Calculate a personalized premium for this household.";
      },
      code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
      path: "$.contract.objective",
    },
    {
      label: "claims-decision question",
      mutate(fixture) {
        fixture.contract.question = "Should the insurer deny this claim based on the imported record?";
      },
      code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
      path: "$.contract.question",
    },
    {
      label: "underwriting constraint description",
      mutate(fixture) {
        fixture.constraints[0].description = "Underwrite this person from their medical history.";
      },
      code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
      path: "$.constraints[0].description",
    },
    {
      label: "claims-decision claim note",
      mutate(fixture) {
        fixture.claims[0].note = "Deny this coverage claim using the member health status.";
      },
      code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
      path: "$.claims[0].note",
    },
    {
      label: "treatment scenario description",
      mutate(fixture) {
        fixture.scenarios[0].description = "Recommend which chemotherapy treatment the patient should start.";
      },
      code: "HEALTH_DECISION_PURPOSE_PROHIBITED",
      path: "$.scenarios[0].description",
    },
  ];

  for (const unsafeModel of unsafeModels) {
    const fixture = structuredClone(createHealthPlanFixture());
    unsafeModel.mutate(fixture);
    const runtime = new DecisionRuntime({
      now: () => "2026-08-28T12:00:00.000Z",
      idGenerator: () => `health-policy:${unsafeModel.label}`,
    });
    await assert.rejects(
      runtime.initialize({ seedCases: [fixture] }),
      (error) =>
        error instanceof SituationRoomError &&
        error.code === ERROR_CODES.VALIDATION_FAILED &&
        error.details?.diagnostics?.some(
          (diagnostic) => diagnostic.code === unsafeModel.code && diagnostic.path === unsafeModel.path,
        ),
      `health-plan policy must reject ${unsafeModel.label}`,
    );
  }

  const unfamiliarTreatmentModel = structuredClone(createHealthPlanFixture());
  unfamiliarTreatmentModel.contract.question = "Which option best controls blood glucose for this patient?";
  ["Metformin 500 mg", "Insulin glargine", "Semaglutide weekly"].forEach((label, index) => {
    unfamiliarTreatmentModel.alternatives[index].label = label;
  });
  unfamiliarTreatmentModel.criteria[0].label = "HbA1c reduction";
  const unfamiliarRuntime = new DecisionRuntime();
  await assert.rejects(
    unfamiliarRuntime.initialize({ seedCases: [unfamiliarTreatmentModel] }),
    (error) =>
      error instanceof SituationRoomError &&
      error.code === ERROR_CODES.VALIDATION_FAILED &&
      error.details?.diagnostics?.some((diagnostic) => diagnostic.code === "HEALTH_PLAN_CONTEXT_REQUIRED") &&
      error.details?.diagnostics?.some((diagnostic) => diagnostic.code === "INSURANCE_PLAN_IDENTITY_REQUIRED") &&
      error.details?.diagnostics?.some((diagnostic) => diagnostic.code === "HEALTH_PLAN_CRITERION_SCOPE_INVALID"),
    "unknown drugs and clinical outcome criteria must fail the positive insurance-plan model",
  );

  const launderedTreatmentModel = structuredClone(createHealthPlanFixture());
  launderedTreatmentModel.contract.question = "Which health plan best lowers HbA1c for this patient?";
  launderedTreatmentModel.contract.objective = "Compare coverage for Metformin, insulin glargine, and semaglutide efficacy.";
  ["Metformin Plan", "Insulin Glargine Plan", "Semaglutide Plan"].forEach((label, index) => {
    launderedTreatmentModel.alternatives[index].label = label;
    launderedTreatmentModel.alternatives[index].entityType = "insurance-plan";
  });
  launderedTreatmentModel.criteria[0].label = "Coverage HbA1c reduction";
  launderedTreatmentModel.criteria[0].planAspect = "benefits-coverage";
  await assert.rejects(
    new DecisionRuntime().initialize({ seedCases: [launderedTreatmentModel] }),
    (error) =>
      error instanceof SituationRoomError &&
      error.code === ERROR_CODES.VALIDATION_FAILED &&
      error.details?.diagnostics?.some((diagnostic) => diagnostic.code === "CLINICAL_OUTCOME_CRITERION_PROHIBITED") &&
      error.details?.diagnostics?.some((diagnostic) => diagnostic.code === "INSURANCE_PLAN_IDENTITY_REQUIRED"),
    "plan and coverage words cannot launder treatment efficacy into a health-plan decision",
  );
});

test("replace_contract is human-only and an agent attempt is atomic", async () => {
  const runtime = await deterministicRuntime([createGenericFixture()]);
  const before = await runtime.getCase("generic-demo");
  const proposedContract = {
    ...structuredClone(before.contract),
    version: before.contract.version + 1,
    objective: "An agent must not be able to replace governing authority.",
  };

  await assert.rejects(
    runtime.executeCommand(
      { type: "replace_contract", payload: { contract: proposedContract } },
      {
        caseId: before.id,
        expectedRevision: before.revision,
        idempotencyKey: "agent-replace-contract",
        actor: { type: "agent", id: "contract-agent" },
      },
    ),
    (error) =>
      error instanceof SituationRoomError &&
      error.code === ERROR_CODES.POLICY_DENIED &&
      error.details?.commandType === "replace_contract",
  );

  const after = await runtime.getCase("generic-demo");
  assert.deepEqual(after, before);
  assert.equal(getDecisionHash(after), getDecisionHash(before));
});

test("approval of a draft contract is rejected atomically", async () => {
  const runtime = await deterministicRuntime([createGenericFixture()]);
  const active = await runtime.getCase("generic-demo");
  const draftResult = await runtime.executeCommand(
    {
      type: "replace_contract",
      payload: {
        contract: {
          ...structuredClone(active.contract),
          version: active.contract.version + 1,
          status: "draft",
        },
      },
    },
    {
      caseId: active.id,
      expectedRevision: active.revision,
      idempotencyKey: "human-draft-contract",
      actor: { type: "human", id: "decision-owner" },
    },
  );
  const beforeApproval = await runtime.getCase("generic-demo");
  assert.equal(beforeApproval.contract.status, "draft");

  await assert.rejects(
    runtime.executeCommand(
      {
        type: "approve_decision",
        payload: {
          alternativeId: "option-light",
          approvalId: "approval:draft-contract",
          expectedDecisionHash: getDecisionHash(beforeApproval),
        },
      },
      {
        caseId: beforeApproval.id,
        expectedRevision: draftResult.receipt.revisionAfter,
        idempotencyKey: "approve-draft-contract",
        actor: { type: "human", id: "decision-owner" },
      },
    ),
    (error) =>
      error instanceof SituationRoomError &&
      error.code === ERROR_CODES.POLICY_DENIED &&
      /draft decision contract/i.test(error.message),
  );

  const afterApproval = await runtime.getCase("generic-demo");
  assert.deepEqual(afterApproval, beforeApproval);
  assert.equal(afterApproval.status, "active");
  assert.deepEqual(afterApproval.approvals, []);
  assert.equal(getDecisionHash(afterApproval), getDecisionHash(beforeApproval));
});

test("case creation is idempotent despite generated audit metadata", async () => {
  const runtime = await deterministicRuntime([]);
  const fixture = createGenericFixture();
  const options = {
    idempotencyKey: "create-generic",
    actor: { type: "human", id: "owner" },
  };
  const first = await runtime.createCase(fixture, options);
  const replay = await runtime.createCase(fixture, options);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal((await runtime.getCase(fixture.id)).audit.some((event) => event.commandType === "create_case"), true);
});

test("disputed evidence blocks approval even when the affected criterion is not a hard gate", async () => {
  const runtime = await deterministicRuntime([createGenericFixture()]);
  const initial = await runtime.getCase();
  const claimId = initial.claims.find(
    (claim) => claim.subjectId === "option-light" && claim.criterionId === "battery",
  ).id;
  const disputed = await runtime.executeCommand(
    {
      type: "flag_conflict",
      payload: { claimIds: [claimId], conflictId: "conflict:battery", reason: "Needs independent verification" },
    },
    {
      expectedRevision: initial.revision,
      idempotencyKey: "flag-battery",
      actor: { type: "agent", id: "review-agent" },
    },
  );
  await assert.rejects(
    runtime.executeCommand(
      {
        type: "approve_decision",
        payload: {
          alternativeId: "option-light",
          approvalId: "approval:disputed",
          expectedDecisionHash: disputed.receipt.decisionHashAfter,
        },
      },
      {
        expectedRevision: disputed.receipt.revisionAfter,
        idempotencyKey: "approve-disputed",
        actor: { type: "human", id: "reviewer" },
      },
    ),
    (error) => error.code === ERROR_CODES.POLICY_DENIED && /disputed/.test(error.message),
  );
});
