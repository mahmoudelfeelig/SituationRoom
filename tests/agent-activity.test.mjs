import test from "node:test";
import assert from "node:assert/strict";

import {
  createAgentActivityState,
  diffPresentationPlans,
  reduceAgentActivity,
  selectAgentActivityForCase,
} from "../src/workspace/agentActivity.js";

test("records a truthful browser-agent execution without retaining tool input", () => {
  let state = createAgentActivityState();
  state = reduceAgentActivity(state, {
    id: "call-1",
    phase: "started",
    tool: "query_decision_graph",
    family: "analysis",
    mutating: false,
    caseId: "case-1",
    at: "2026-08-31T10:00:00Z",
    input: { secret: "must not persist" },
  });
  state = reduceAgentActivity(state, {
    id: "call-1",
    phase: "settled",
    tool: "query_decision_graph",
    family: "analysis",
    caseId: "case-1",
    at: "2026-08-31T10:00:01Z",
    receipt: {
      id: "receipt-1",
      revisionBefore: 7,
      revisionAfter: 7,
      viewRevisionBefore: 3,
      viewRevisionAfter: 3,
      changedEntityIds: [],
    },
  });

  assert.equal(state.status, "settled");
  assert.equal(state.steps.length, 1);
  assert.equal(state.steps[0].status, "settled");
  assert.equal(state.steps[0].tool, "query_decision_graph");
  assert.equal("input" in state.steps[0], false);
  assert.equal(JSON.stringify(state).includes("must not persist"), false);
  assert.equal(state.lastDiff.decisionChanged, false);
});

test("keeps rejected calls visible and does not invent mutations", () => {
  let state = reduceAgentActivity(createAgentActivityState(), {
    id: "call-2",
    phase: "started",
    tool: "set_constraint",
    family: "model",
    mutating: true,
    at: "2026-08-31T10:00:00Z",
  });
  state = reduceAgentActivity(state, {
    id: "call-2",
    phase: "rejected",
    tool: "set_constraint",
    family: "model",
    at: "2026-08-31T10:00:01Z",
    errorCode: "ROOM_FROZEN",
    receipt: { id: "receipt-2", revisionBefore: 7, revisionAfter: 7 },
  });

  assert.equal(state.status, "rejected");
  assert.equal(state.steps[0].status, "rejected");
  assert.equal(state.steps[0].errorCode, "ROOM_FROZEN");
  assert.equal(state.lastDiff.decisionChanged, false);
});

test("keeps the channel running until every overlapping tool call settles", () => {
  let state = createAgentActivityState();
  state = reduceAgentActivity(state, {
    id: "call-a",
    phase: "started",
    tool: "query_decision_graph",
    at: "2026-08-31T10:00:00Z",
  });
  state = reduceAgentActivity(state, {
    id: "call-b",
    phase: "started",
    tool: "search_sources",
    at: "2026-08-31T10:00:00.100Z",
  });
  state = reduceAgentActivity(state, {
    id: "call-a",
    phase: "settled",
    tool: "query_decision_graph",
    at: "2026-08-31T10:00:01Z",
    receipt: { id: "receipt-a" },
  });

  assert.equal(state.status, "running");
  assert.equal(state.currentTool, "search_sources");

  state = reduceAgentActivity(state, {
    id: "call-b",
    phase: "settled",
    tool: "search_sources",
    at: "2026-08-31T10:00:02Z",
    receipt: { id: "receipt-b" },
  });
  assert.equal(state.status, "settled");
  assert.equal(state.currentTool, null);
});

test("projects activity into the active case without leaking another room's calls", () => {
  let state = createAgentActivityState();
  state = reduceAgentActivity(state, { id: "case-a-call", caseId: "case-a", phase: "settled", tool: "query_decision_graph", at: "2026-08-31T10:00:00Z" });
  state = reduceAgentActivity(state, { id: "case-b-call", caseId: "case-b", phase: "started", tool: "search_sources", at: "2026-08-31T10:00:01Z" });
  const caseA = selectAgentActivityForCase(state, "case-a");
  assert.equal(caseA.status, "settled");
  assert.deepEqual(caseA.steps.map((step) => step.id), ["case-a-call"]);
});

test("case projection uses completion time when overlapping calls settle out of start order", () => {
  let state = createAgentActivityState();
  state = reduceAgentActivity(state, { id: "call-a", caseId: "case-a", phase: "started", tool: "set_criterion", at: "2026-08-31T10:00:00Z" });
  state = reduceAgentActivity(state, { id: "call-b", caseId: "case-a", phase: "started", tool: "search_sources", at: "2026-08-31T10:00:01Z" });
  state = reduceAgentActivity(state, { id: "call-b", caseId: "case-a", phase: "rejected", tool: "search_sources", at: "2026-08-31T10:00:02Z", receipt: { id: "receipt-b", revisionBefore: 4, revisionAfter: 4 } });
  state = reduceAgentActivity(state, { id: "call-a", caseId: "case-a", phase: "settled", tool: "set_criterion", at: "2026-08-31T10:00:03Z", receipt: { id: "receipt-a", revisionBefore: 4, revisionAfter: 5, changedEntityIds: ["criterion:cost"] } });
  const projected = selectAgentActivityForCase(state, "case-a");
  assert.equal(projected.status, "settled");
  assert.equal(projected.updatedAt, "2026-08-31T10:00:03Z");
  assert.equal(projected.lastDiff.decisionChanged, true);
  assert.deepEqual(projected.lastDiff.changedEntityIds, ["criterion:cost"]);
});

test("bounds the transient activity strip to the latest 24 executions", () => {
  let state = createAgentActivityState();
  for (let index = 0; index < 30; index += 1) {
    state = reduceAgentActivity(state, {
      id: `call-${index}`,
      phase: "settled",
      tool: "get_workspace_state",
      at: `2026-08-31T10:${String(index).padStart(2, "0")}:00Z`,
      receipt: { id: `receipt-${index}` },
    });
  }
  assert.equal(state.steps.length, 24);
  assert.equal(state.steps[0].id, "call-6");
  assert.equal(state.steps.at(-1).id, "call-29");
});

test("describes added, removed, retained, and moved semantic instruments", () => {
  const previous = {
    lens: "investigate",
    instruments: [
      { type: "causal-trace", region: "primary" },
      { type: "evidence-excerpt", region: "secondary" },
      { type: "outcome-seal", region: "supporting" },
    ],
  };
  const next = {
    lens: "compare",
    instruments: [
      { type: "comparison-matrix", region: "primary" },
      { type: "evidence-excerpt", region: "supporting" },
      { type: "outcome-seal", region: "supporting" },
    ],
  };

  const diff = diffPresentationPlans(previous, next);

  assert.deepEqual(diff.added, ["comparison-matrix"]);
  assert.deepEqual(diff.removed, ["causal-trace"]);
  assert.deepEqual(diff.retained, ["evidence-excerpt", "outcome-seal"]);
  assert.deepEqual(diff.moved, ["evidence-excerpt"]);
  assert.equal(diff.lensChanged, true);
});
