import test from "node:test";
import assert from "node:assert/strict";

import {
  UNKNOWN,
  createDecisionCase,
  evaluateExpression,
  evaluateWithDomainPack,
  sha256Hex,
  stableStringify,
  validateDecisionCase,
} from "../../src/kernel/index.js";
import {
  createCandidateReviewFixture,
  createDefaultDomainRegistry,
  createGenericFixture,
  createHealthPlanFixture,
  createProcurementFixture,
} from "../../src/domain-packs/index.js";

test("canonical hashes and safe rule expressions are deterministic", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(
    evaluateExpression(
      {
        op: "and",
        args: [
          { op: "gte", args: [{ op: "ref", path: "facts.score" }, { op: "literal", value: 80 }] },
          { op: "ref", path: "facts.eligible" },
        ],
      },
      { facts: { score: 84, eligible: true } },
    ),
    true,
  );
  assert.equal(evaluateExpression({ op: "ref", path: "facts.missing" }, { facts: {} }), UNKNOWN);
  assert.equal(evaluateExpression({ op: "ref", path: "__proto__.polluted" }, {}), UNKNOWN);
  assert.throws(() => evaluateExpression({ op: "execute", code: "return true" }), /Unsupported rule operator/);
});

test("all four domain packs produce valid, functional cases through the same evaluator", () => {
  const registry = createDefaultDomainRegistry();
  const cases = [
    createProcurementFixture(),
    createCandidateReviewFixture(),
    createHealthPlanFixture(),
    createGenericFixture(),
  ];
  for (const decisionCase of cases) {
    assert.deepEqual(validateDecisionCase(decisionCase).filter((entry) => entry.severity === "error"), []);
    const evaluation = evaluateWithDomainPack(decisionCase, registry.get(decisionCase.domain.packId));
    assert.equal(evaluation.results.length, decisionCase.alternatives.length);
    assert.equal(evaluation.paths.length, decisionCase.alternatives.length * decisionCase.criteria.length);
  }

  const procurement = evaluateWithDomainPack(cases[0], registry.get("procurement"));
  assert.equal(procurement.recommendation.alternativeId, "vendor-a");
  assert.deepEqual(
    procurement.results.find((result) => result.alternativeId === "vendor-b").blockers.map((entry) => entry.criterionId),
    ["r1", "r4"],
  );
  assert.deepEqual(
    procurement.results.find((result) => result.alternativeId === "vendor-c").blockers.map((entry) => entry.criterionId),
    ["r1"],
  );

  const candidate = evaluateWithDomainPack(cases[1], registry.get("candidate-review"));
  assert.equal(candidate.ranking, null);
  assert.equal(candidate.recommendation, null);

  const health = evaluateWithDomainPack(cases[2], registry.get("health-plan"));
  assert.equal(health.recommendation.alternativeId, "plan-harbor");
  assert.equal(health.results.find((result) => result.alternativeId === "plan-river").eligible, false);
});

test("candidate policy rejects protected attributes even when nested", () => {
  const fixture = createCandidateReviewFixture();
  const input = structuredClone(fixture);
  input.alternatives[0].attributes = { interview: { gender: "not allowed" } };
  const unsafe = createDecisionCase(input);
  const diagnostics = validateDecisionCase(unsafe);
  assert.equal(diagnostics.some((entry) => entry.code === "PROHIBITED_FIELD"), true);
});

test("validation rejects typed-claim drift and tampered source anchors", () => {
  const input = structuredClone(createGenericFixture());
  input.claims[0].value = "not a currency";
  input.claims[1].sourceRefs[0].quoteHash = `sha256:${"0".repeat(64)}`;
  const invalid = createDecisionCase(input);
  const diagnostics = validateDecisionCase(invalid);
  assert.equal(diagnostics.some((entry) => entry.code === "CLAIM_TYPE_MISMATCH"), true);
  assert.equal(diagnostics.some((entry) => entry.code === "SOURCE_HASH_MISMATCH"), true);
});
