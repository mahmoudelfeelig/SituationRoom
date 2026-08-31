import assert from "node:assert/strict";
import test from "node:test";

import {
  createWebMcpEvidenceBundle,
  scoreWebMcpEvalCase,
  scoreWebMcpEvalCorpus,
} from "../src/webmcp/evalScorer.js";

const evalCase = {
  id: "compare",
  prompt: "Compare the options.",
  initialState: { phase: "analysis", lens: "compare", domain: "generic" },
  expectedCalls: [
    { name: "query_decision_graph", argumentsMustInclude: ["caseId"] },
    { name: "compose_decision_room", argumentsMustInclude: ["caseId", "lens"], argumentConstraints: { lens: "compare" } },
  ],
  forbiddenCalls: ["approve_decision"],
  success: "Read, then recompose without approval.",
};

test("passes a model trace only when required calls, keys, and safe constraints are observed", () => {
  const result = scoreWebMcpEvalCase(evalCase, [
    { tool: "query_decision_graph", argumentKeys: ["caseId"], status: "settled" },
    { tool: "compose_decision_room", argumentKeys: ["caseId", "lens"], safeArguments: { lens: "compare" }, status: "settled" },
  ]);
  assert.equal(result.status, "passed");
  assert.equal(result.score, 1);
});

test("fails forbidden authority calls and argument-contract violations", () => {
  const result = scoreWebMcpEvalCase(evalCase, [
    { tool: "query_decision_graph", argumentKeys: ["caseId"] },
    { tool: "compose_decision_room", argumentKeys: ["caseId"], safeArguments: { lens: "simulate" } },
    { tool: "approve_decision", argumentKeys: ["caseId"] },
  ]);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.forbiddenCalls, ["approve_decision"]);
  assert.deepEqual(result.expected[1].missingArguments, ["lens"]);
  assert.equal(result.expected[1].constraintFailures[0].actual, "simulate");
});

test("does not count a rejected expected tool call as model success", () => {
  const result = scoreWebMcpEvalCase(evalCase, [
    { tool: "query_decision_graph", argumentKeys: ["caseId"], status: "settled" },
    { tool: "compose_decision_room", argumentKeys: ["caseId", "lens"], safeArguments: { lens: "compare" }, status: "rejected" },
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.expected[1].executionRejected, true);
});

test("keeps started, unknown, and statusless expected calls incomplete until they settle", () => {
  for (const status of ["started", "unknown", undefined]) {
    const result = scoreWebMcpEvalCase({
      ...evalCase,
      expectedCalls: [evalCase.expectedCalls[0]],
    }, [{ tool: "query_decision_graph", argumentKeys: ["caseId"], ...(status ? { status } : {}) }]);
    assert.equal(result.status, "incomplete");
    assert.equal(result.expected[0].status, "incomplete");
  }
});

test("marks absent expected work incomplete instead of claiming a failure or pass", () => {
  const result = scoreWebMcpEvalCase(evalCase, []);
  assert.equal(result.status, "incomplete");
  assert.equal(result.expected.every((entry) => entry.status === "missing"), true);
});

test("scores a corpus by stable case ID and emits privacy-bounded evidence", () => {
  const report = scoreWebMcpEvalCorpus({ cases: [evalCase] }, [{
    id: "compare",
    calls: [
      { name: "query_decision_graph", status: "settled", arguments: { caseId: "case-1" } },
      { name: "compose_decision_room", status: "settled", arguments: { caseId: "case-1", lens: "compare" } },
    ],
  }]);
  assert.equal(report.summary.passed, 1);

  const evidence = createWebMcpEvidenceBundle({
    evalCase,
    calls: [{
      tool: "query_decision_graph",
      caseId: "case-1",
      argumentKeys: ["caseId", "query"],
      safeArguments: {},
      secretInput: "never retain this",
    }],
    captureContext: { armedAt: "2026-08-31T11:59:59.000Z", caseId: "case-1", phase: "analysis", lens: "compare", domain: "generic", decisionRevision: 3, viewRevision: 2 },
    appState: { caseId: "case-1", phase: "analysis", lens: "compare", domain: "generic" },
    capturedAt: "2026-08-31T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(evidence).includes("never retain this"), false);
  assert.deepEqual(evidence.calls[0].argumentKeys, ["caseId", "query"]);
  assert.equal(evidence.capture.caseId, "case-1");
  assert.equal(evidence.appState.caseId, "case-1");
  assert.equal(evidence.calls[0].caseId, "case-1");
});
