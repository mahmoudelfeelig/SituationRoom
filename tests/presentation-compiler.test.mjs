import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePresentation,
  createDefaultPresentationRecipe,
  getInstrumentCapabilities,
  validatePresentationRecipe,
  validatePresentationSnapshot,
} from "../src/presentation/index.js";

function ref(kind, id) {
  return { kind, id };
}

function createSnapshot(domainKind = "generic", overrides = {}) {
  const entities = [
    {
      id: "alternative-a",
      kind: "alternative",
      label: "Alternative A",
      summary: "The current evidence-backed front runner.",
      status: "eligible",
      attributes: { totalCost: 280000, currency: "EUR", score: 83 },
    },
    {
      id: "alternative-b",
      kind: "alternative",
      label: "Alternative B",
      summary: "Lower confidence because one mandatory constraint is unresolved.",
      status: "blocked",
      attributes: { totalCost: 305000, currency: "EUR", score: 46 },
    },
    {
      id: "criterion-cost",
      kind: "criterion",
      label: "Total cost",
      summary: "Total evaluated cost over the decision horizon.",
      attributes: { mandatory: true, threshold: 300000, unit: "EUR" },
    },
    {
      id: "constraint-cost",
      kind: "constraint",
      label: "Cost must remain below the approved cap",
      summary: "The approved maximum is EUR 300,000.",
      status: "fail",
      attributes: { mandatory: true, protected: true },
    },
    {
      id: "evidence-cost",
      kind: "evidence",
      label: "Submitted commercial terms",
      summary: "Alternative B totals EUR 305,000 including required fees.",
      status: "verified",
      attributes: {
        citation: "Commercial terms, p. 23",
        sourceId: "source-terms",
        confidence: 0.98,
      },
    },
    {
      id: "claim-cost",
      kind: "claim",
      label: "Alternative B exceeds the cap",
      summary: "Required fees place the evaluated total above the protected threshold.",
      status: "verified",
      attributes: { confidence: 0.98 },
    },
    {
      id: "stakeholder-reviewer",
      kind: "stakeholder",
      label: "Accountable reviewer",
      summary: "Confirms the evidence and retains final authority.",
      attributes: { authority: "human-only" },
    },
    {
      id: "scenario-cost",
      kind: "control",
      label: "Staged total cost",
      summary: "A hypothetical value that does not change the canonical record.",
      attributes: { control: "range", min: 260000, max: 320000, step: 1000, value: 305000 },
    },
  ];

  const base = {
    schemaVersion: "1.0",
    caseId: `${domainKind}-case`,
    decisionRevision: 17,
    decisionHash: `decision-${domainKind}-17`,
    viewRevision: 4,
    frozen: false,
    domain: {
      id: `${domainKind}-v1`,
      kind: domainKind,
      label: domainKind.replaceAll("-", " "),
      riskLevel: domainKind === "candidate" || domainKind === "health-plan" ? "high" : "standard",
    },
    contract: {
      title: "Choose an evidence-backed alternative",
      question: "Which alternative best satisfies the protected constraints?",
      status: "active",
      authority: "human-reviewer",
    },
    entities,
    results: [
      {
        id: "result-a-cost",
        kind: "evaluation",
        subjectId: "alternative-a",
        criterionId: "criterion-cost",
        status: "pass",
        value: 280000,
        unit: "EUR",
        reason: "The evaluated total remains below the cap.",
        evidenceIds: ["evidence-cost"],
      },
      {
        id: "result-b-cost",
        kind: "evaluation",
        subjectId: "alternative-b",
        criterionId: "criterion-cost",
        status: "fail",
        value: 305000,
        unit: "EUR",
        reason: "The evaluated total exceeds the cap by EUR 5,000.",
        evidenceIds: ["evidence-cost"],
      },
    ],
    relations: [
      {
        id: "relation-evidence-claim",
        type: "supports",
        from: ref("evidence", "evidence-cost"),
        to: ref("claim", "claim-cost"),
      },
      {
        id: "relation-claim-constraint",
        type: "evaluated-against",
        from: ref("claim", "claim-cost"),
        to: ref("constraint", "constraint-cost"),
      },
    ],
    paths: [
      {
        id: "path-cost-blocker",
        label: "Cost blocker",
        entityRefs: [
          ref("evidence", "evidence-cost"),
          ref("claim", "claim-cost"),
          ref("constraint", "constraint-cost"),
          ref("alternative", "alternative-b"),
        ],
        resultIds: ["result-b-cost"],
        status: "fail",
      },
    ],
    sources: [
      {
        id: "source-terms",
        kind: "source",
        label: "Commercial terms",
        format: "pdf",
        status: "ready",
        locations: [{ label: "p. 23", locator: { page: 23, boundingBox: [18, 44, 260, 92] } }],
      },
    ],
    pins: [ref("evidence", "evidence-cost")],
    protected: {
      entityRefs: [ref("constraint", "constraint-cost")],
      blockerResultIds: ["result-b-cost"],
      omittedEntityCount: 12,
      prohibitedEntityKinds: domainKind === "candidate" ? ["protected-attribute"] : [],
      authority: { mode: "human-only", canApprove: false },
    },
    policy: {
      allowedInstrumentTypes: null,
      blockedInstrumentTypes: [],
      maxInstrumentCount: 10,
    },
    permissions: {
      canCompose: true,
      canSimulate: true,
      canApprove: false,
    },
    metadata: { locale: "en-GB", currency: "EUR" },
    domainData: {},
  };

  return {
    ...base,
    ...overrides,
    domain: { ...base.domain, ...(overrides.domain ?? {}) },
    contract: { ...base.contract, ...(overrides.contract ?? {}) },
    protected: { ...base.protected, ...(overrides.protected ?? {}) },
    policy: { ...base.policy, ...(overrides.policy ?? {}) },
    permissions: { ...base.permissions, ...(overrides.permissions ?? {}) },
  };
}

test("the documented snapshot contract accepts generic normalized arrays", () => {
  const validation = validatePresentationSnapshot(createSnapshot());
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
});

test("default recipes compile into all four structural layout grammars", () => {
  const snapshot = createSnapshot();
  const expectedPatterns = {
    investigate: "trace",
    compare: "matrix",
    simulate: "fork",
    brief: "council",
  };

  for (const [lens, pattern] of Object.entries(expectedPatterns)) {
    const recipe = createDefaultPresentationRecipe(snapshot, {
      lens,
      question: `Render the ${lens} room for this case.`,
    });
    const result = compilePresentation(snapshot, recipe);
    assert.equal(result.ok, true, result.errors?.join("\n"));
    assert.equal(result.plan.lens, lens);
    assert.equal(result.plan.layout.pattern, pattern);
    assert.equal(result.plan.decisionHash, snapshot.decisionHash);
    assert.equal(result.plan.baseDecisionRevision, snapshot.decisionRevision);
    assert.match(result.plan.viewHash, /^sr-[a-f0-9]{8}$/);
    assert.ok(result.plan.instruments.length >= 3);
    if (lens === "simulate") {
      const outcomes = result.plan.instruments.filter((instrument) => instrument.type === "outcome-seal" && instrument.variant === "hypothetical");
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].variant, "hypothetical");
      assert.equal(outcomes[0].systemInjected, true);
      assert.equal(outcomes[0].locked, true);
      assert.equal(outcomes[0].region, "secondary");
      assert.equal(result.plan.regions.secondary.includes(outcomes[0].id), true);
    }
  }

  const defaultRecipe = createDefaultPresentationRecipe(snapshot, { lens: "simulate" });
  const customRecipe = {
    ...defaultRecipe,
    recipeId: "custom-simulate-without-outcome",
    instruments: defaultRecipe.instruments.filter((instrument) => instrument.type !== "outcome-seal"),
  };

  const customResult = compilePresentation(snapshot, customRecipe);
  assert.equal(customResult.ok, true, customResult.errors?.join("\n"));
  const customOutcomes = customResult.plan.instruments.filter((instrument) => instrument.type === "outcome-seal" && instrument.variant === "hypothetical");
  assert.equal(customOutcomes.length, 1);
  assert.equal(customOutcomes[0].systemInjected, true);
  assert.equal(customOutcomes[0].locked, true);
});

test("the compiler injects protected constraints and pins beyond the agent recipe", () => {
  const snapshot = createSnapshot();
  const recipe = {
    schemaVersion: "1.0",
    recipeId: "minimal-investigation",
    intent: "explain",
    lens: "investigate",
    question: "Explain the decisive evidence.",
    framing: "Follow the cited path.",
    layout: { pattern: "trace", density: "focused" },
    instruments: [
      {
        id: "trace",
        type: "causal-trace",
        region: "primary",
        priority: 10,
        entityRefs: [ref("claim", "claim-cost")],
        pathId: "path-cost-blocker",
        options: {},
      },
    ],
    focus: { entityRef: ref("claim", "claim-cost"), pathId: "path-cost-blocker" },
    expectedDecisionRevision: 17,
    expectedViewRevision: 4,
  };

  const result = compilePresentation(snapshot, recipe, { maxInstrumentCount: 3 });
  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.deepEqual(
    result.plan.instruments.map((instrument) => instrument.type),
    ["protected-invariants", "pinned-context", "causal-trace"],
  );
  assert.deepEqual(result.plan.protected.entityRefs, [ref("constraint", "constraint-cost")]);
  assert.deepEqual(result.plan.preservedPins, [ref("evidence", "evidence-cost")]);
});

test("recipe validation rejects unknown fields, unsafe options and layout mismatches", () => {
  const snapshot = createSnapshot();
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "compare" });

  const withUnknownField = { ...recipe, html: "<script>alert(1)</script>" };
  assert.equal(validatePresentationRecipe(snapshot, withUnknownField).ok, false);

  const withUnsafeOption = structuredClone(recipe);
  withUnsafeOption.instruments[0].options = { css: "position:fixed" };
  assert.equal(validatePresentationRecipe(snapshot, withUnsafeOption).ok, false);

  const wrongLayout = structuredClone(recipe);
  wrongLayout.layout.pattern = "fork";
  assert.equal(validatePresentationRecipe(snapshot, wrongLayout).ok, false);
});

test("unknown entity references and stale or frozen mutations reject atomically", () => {
  const snapshot = createSnapshot();
  const unknown = createDefaultPresentationRecipe(snapshot, { lens: "investigate" });
  unknown.instruments[0].entityRefs = [ref("claim", "missing")];
  assert.equal(compilePresentation(snapshot, unknown).ok, false);

  const stale = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
  stale.expectedViewRevision -= 1;
  assert.equal(compilePresentation(snapshot, stale).ok, false);

  const frozen = createSnapshot("generic", { frozen: true });
  assert.equal(
    compilePresentation(frozen, createDefaultPresentationRecipe(frozen, { lens: "brief" })).ok,
    false,
  );
});

test("compilation is deterministic and does not mutate the snapshot or recipe", () => {
  const snapshot = createSnapshot("health-plan");
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
  const beforeSnapshot = structuredClone(snapshot);
  const beforeRecipe = structuredClone(recipe);

  const first = compilePresentation(snapshot, recipe);
  const second = compilePresentation(snapshot, recipe);

  assert.equal(first.ok, true);
  assert.equal(first.plan.viewHash, second.plan.viewHash);
  assert.deepEqual(snapshot, beforeSnapshot);
  assert.deepEqual(recipe, beforeRecipe);
});

test("instrument budgeting is explicit and never omits protected or pinned context", () => {
  const snapshot = createSnapshot();
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "investigate" });
  const result = compilePresentation(snapshot, recipe, { maxInstrumentCount: 4 });

  assert.equal(result.ok, true);
  assert.equal(result.plan.instruments.length, 4);
  assert.equal(result.plan.instruments.some((item) => item.type === "protected-invariants"), true);
  assert.equal(result.plan.instruments.some((item) => item.type === "pinned-context"), true);
  assert.ok(result.plan.omitted.instrumentIds.length > 0);
  assert.ok(result.plan.warnings.some((warning) => warning.code === "INSTRUMENT_BUDGET_APPLIED"));
});

test("empty and partial cases compile to safe generic fallbacks", () => {
  const snapshot = createSnapshot("generic", {
    entities: [],
    results: [],
    relations: [],
    paths: [],
    sources: [],
    pins: [],
    protected: {
      entityRefs: [],
      blockerResultIds: [],
      omittedEntityCount: 0,
      prohibitedEntityKinds: [],
      authority: { mode: "human-only", canApprove: false },
    },
  });
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "investigate" });
  const result = compilePresentation(snapshot, recipe);

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.ok(result.plan.instruments.some((item) => item.type === "missing-evidence"));
  assert.ok(result.plan.warnings.some((warning) => warning.code === "EMPTY_DECISION_GRAPH"));
});

test("domain adapters select distinct trusted instruments without changing the kernel shape", () => {
  const expected = {
    procurement: "compliance-gate-wall",
    candidate: "candidate-requirement-coverage",
    "health-plan": "plan-cost-waterfall",
    generic: "weighted-criteria",
  };

  for (const [domain, instrumentType] of Object.entries(expected)) {
    const snapshot = createSnapshot(domain);
    const recipe = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
    const result = compilePresentation(snapshot, recipe);
    assert.equal(result.ok, true, result.errors?.join("\n"));
    assert.ok(result.plan.instruments.some((item) => item.type === instrumentType));
  }
});

test("wrong-domain instruments and policy-blocked instruments are rejected", () => {
  const snapshot = createSnapshot("candidate");
  const wrongDomain = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
  wrongDomain.instruments.push({
    id: "forbidden-plan-cost",
    type: "plan-cost-waterfall",
    region: "secondary",
    priority: 1,
    entityRefs: [],
    options: {},
  });
  assert.equal(compilePresentation(snapshot, wrongDomain).ok, false);

  const blockedSnapshot = createSnapshot("candidate", {
    policy: { blockedInstrumentTypes: ["risk-frontier"], maxInstrumentCount: 10 },
  });
  const blockedRecipe = createDefaultPresentationRecipe(blockedSnapshot, { lens: "brief" });
  blockedRecipe.instruments.push({
    id: "blocked-risk",
    type: "risk-frontier",
    region: "supporting",
    priority: 1,
    entityRefs: [],
    options: {},
  });
  assert.equal(compilePresentation(blockedSnapshot, blockedRecipe).ok, false);
});

test("orphaned pins are retained as visible warnings instead of being silently discarded", () => {
  const snapshot = createSnapshot("generic", {
    pins: [ref("evidence", "evidence-that-was-reimported")],
  });
  const result = compilePresentation(
    snapshot,
    createDefaultPresentationRecipe(snapshot, { lens: "investigate" }),
  );

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.deepEqual(result.plan.unresolvedPinnedRefs, [ref("evidence", "evidence-that-was-reimported")]);
  assert.ok(result.plan.warnings.some((warning) => warning.code === "ORPHANED_PIN"));
});

test("duplicate instrument IDs and overlong agent text are rejected", () => {
  const snapshot = createSnapshot();
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "brief" });
  recipe.instruments.push(structuredClone(recipe.instruments[0]));
  assert.equal(validatePresentationRecipe(snapshot, recipe).ok, false);

  const longText = createDefaultPresentationRecipe(snapshot, { lens: "brief" });
  longText.framing = "x".repeat(181);
  assert.equal(validatePresentationRecipe(snapshot, longText).ok, false);
});

test("snapshot validation rejects broken result, path, relation, and blocker references", () => {
  const brokenResult = createSnapshot();
  brokenResult.results[0].subjectId = "missing-subject";
  assert.equal(validatePresentationSnapshot(brokenResult).ok, false);

  const brokenBlocker = createSnapshot();
  brokenBlocker.protected.blockerResultIds = ["missing-result"];
  assert.equal(validatePresentationSnapshot(brokenBlocker).ok, false);

  const brokenRelation = createSnapshot();
  brokenRelation.relations[0].to = ref("claim", "missing-claim");
  assert.equal(validatePresentationSnapshot(brokenRelation).ok, false);

  const brokenPath = createSnapshot();
  brokenPath.paths[0].resultIds = ["missing-result"];
  assert.equal(validatePresentationSnapshot(brokenPath).ok, false);
});

test("composition permission and trusted environment budgets are enforced", () => {
  const forbidden = createSnapshot("generic", {
    permissions: { canCompose: false, canSimulate: false, canApprove: false },
  });
  const recipe = createDefaultPresentationRecipe(forbidden, { lens: "investigate" });
  const denied = compilePresentation(forbidden, recipe);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /not allowed to compose/);

  const snapshot = createSnapshot();
  const validRecipe = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
  assert.equal(compilePresentation(snapshot, validRecipe, { maxInstrumentCount: 1 }).ok, false);
  assert.equal(compilePresentation(snapshot, validRecipe, { maxInstrumentCount: 25 }).ok, false);
});

test("high-stakes candidate rooms inject the bias shield and advertise only governed capabilities", () => {
  const snapshot = createSnapshot("candidate");
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
  const result = compilePresentation(snapshot, recipe);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.plan.instruments.some((item) => item.type === "bias-shield" && item.systemInjected), true);

  const capabilities = getInstrumentCapabilities(snapshot, { lens: "compare" });
  assert.ok(capabilities.includes("bias-shield"));
  assert.ok(capabilities.includes("candidate-requirement-coverage"));
  assert.equal(capabilities.includes("plan-cost-waterfall"), false);
});

test("unknown instrument IDs in snapshot policy fail before compilation", () => {
  const snapshot = createSnapshot("generic", {
    policy: { allowedInstrumentTypes: ["comparison-matrix", "made-up-dashboard"], blockedInstrumentTypes: [], maxInstrumentCount: 10 },
  });
  const validation = validatePresentationSnapshot(snapshot);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes("made-up-dashboard")));
});

test("default recipes adapt to policy allowlists and reserved namespaces stay system-only", () => {
  const snapshot = createSnapshot("generic", {
    policy: {
      allowedInstrumentTypes: ["comparison-matrix", "weighted-criteria"],
      blockedInstrumentTypes: [],
      maxInstrumentCount: 10,
    },
  });
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
  assert.deepEqual(
    [...new Set(recipe.instruments.map((instrument) => instrument.type))].sort(),
    ["comparison-matrix", "weighted-criteria"],
  );
  assert.equal(compilePresentation(snapshot, recipe).ok, true);

  const reserved = createDefaultPresentationRecipe(createSnapshot(), { lens: "investigate" });
  reserved.instruments[0].id = "system-forged-firewall";
  assert.equal(validatePresentationRecipe(createSnapshot(), reserved).ok, false);
});

test("unsupported lenses and unknown trusted environment fields fail explicitly", () => {
  const snapshot = createSnapshot();
  assert.throws(
    () => createDefaultPresentationRecipe(snapshot, { lens: "dashboard" }),
    /Unsupported presentation lens/,
  );
  const recipe = createDefaultPresentationRecipe(snapshot, { lens: "compare" });
  const result = compilePresentation(snapshot, recipe, { css: "position:fixed" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown presentation environment fields/);
});
