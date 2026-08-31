import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDecisionPlayback,
  comparePlaybackEvents,
} from "../src/workspace/decisionPlayback.js";

test("orders, deduplicates, and classifies decision and presentation receipts", () => {
  const receipts = [
    {
      id: "view-2",
      at: "2026-08-31T10:02:00.000Z",
      type: "presentation.committed",
      source: "agent",
      revisionBefore: 4,
      revisionAfter: 4,
      viewRevisionBefore: 2,
      viewRevisionAfter: 3,
      decisionHashBefore: "same",
      decisionHashAfter: "same",
      changedEntityIds: [],
    },
    {
      id: "decision-1",
      at: "2026-08-31T10:01:00.000Z",
      commandType: "decision.setCriterion",
      source: "human",
      revisionBefore: 3,
      revisionAfter: 4,
      viewRevisionBefore: 2,
      viewRevisionAfter: 2,
      decisionHashBefore: "before",
      decisionHashAfter: "after",
      changedEntityIds: ["criterion:cost", "criterion:cost", "alternative:a"],
    },
    { id: "view-2", at: "2026-08-31T10:03:00.000Z", type: "duplicate" },
  ];

  const playback = buildDecisionPlayback(receipts, { activeCaseId: "case-1" });

  assert.equal(playback.events.length, 2);
  assert.deepEqual(playback.events.map((event) => event.id), ["decision-1", "view-2"]);
  assert.equal(playback.events[0].scope, "canonical");
  assert.equal(playback.events[0].decision.changed, true);
  assert.deepEqual(playback.events[0].changedEntityIds, ["criterion:cost", "alternative:a"]);
  assert.equal(playback.events[1].scope, "presentation");
  assert.equal(playback.events[1].decision.changed, false);
  assert.equal(playback.events[1].view.changed, true);
  assert.equal(playback.summary.canonicalChanges, 1);
  assert.equal(playback.summary.presentationChanges, 1);
});

test("keeps rejected WebMCP activity visible without inventing state changes", () => {
  const playback = buildDecisionPlayback([
    {
      id: "tool-rejected",
      at: "2026-08-31T10:04:00.000Z",
      tool: "set_constraint",
      actor: "Browser agent",
      status: "rejected",
      errorCode: "ROOM_FROZEN",
      revisionBefore: 7,
      revisionAfter: 7,
      viewRevisionBefore: 5,
      viewRevisionAfter: 5,
      decisionHashBefore: "frozen",
      decisionHashAfter: "frozen",
    },
  ]);

  assert.equal(playback.events[0].scope, "agent");
  assert.equal(playback.events[0].status, "rejected");
  assert.equal(playback.events[0].decision.changed, false);
  assert.match(playback.events[0].summary, /ROOM FROZEN/i);
});

test("does not describe a non-canonical agent mutation as read-only", () => {
  const playback = buildDecisionPlayback([{
    id: "semantic-proposal",
    at: "2026-08-31T10:05:00Z",
    tool: "propose_semantic_mapping",
    actor: "Browser agent",
    status: "completed",
    revisionBefore: 7,
    revisionAfter: 7,
    viewRevisionBefore: 5,
    viewRevisionAfter: 5,
  }]);
  assert.equal(playback.events[0].scope, "agent");
  assert.doesNotMatch(playback.events[0].summary, /read-only/i);
  assert.match(playback.events[0].summary, /without changing the canonical decision/i);
});

test("bounds malformed, out-of-order, and cross-case receipt input", () => {
  const receipts = [
    null,
    "bad",
    { id: "other", caseId: "case-2", at: "2026-08-31T10:00:00Z" },
    { id: "late", caseId: "case-1", at: "not-a-date", type: "import.review-ready" },
    { id: "early", caseId: "case-1", at: "2026-08-31T09:00:00Z", type: "import.started" },
  ];

  const playback = buildDecisionPlayback(receipts, { activeCaseId: "case-1", limit: 1 });

  assert.equal(playback.events.length, 1);
  assert.equal(playback.events[0].id, "late");
  assert.equal(playback.events[0].scope, "import");
});

test("compares two events without treating presentation motion as a decision mutation", () => {
  const playback = buildDecisionPlayback([
    {
      id: "left",
      at: "2026-08-31T10:00:00Z",
      type: "presentation.committed",
      revisionBefore: 5,
      revisionAfter: 5,
      viewRevisionBefore: 1,
      viewRevisionAfter: 2,
      decisionHashBefore: "stable",
      decisionHashAfter: "stable",
    },
    {
      id: "right",
      at: "2026-08-31T10:01:00Z",
      commandType: "decision.setCriterion",
      revisionBefore: 5,
      revisionAfter: 6,
      viewRevisionBefore: 2,
      viewRevisionAfter: 2,
      decisionHashBefore: "stable",
      decisionHashAfter: "changed",
      changedEntityIds: ["criterion:risk"],
    },
  ]);

  const comparison = comparePlaybackEvents(playback.events[0], playback.events[1], playback.events);

  assert.equal(comparison.decisionChanged, true);
  assert.equal(comparison.viewChanged, false);
  assert.deepEqual(comparison.changedEntityIds, ["criterion:risk"]);
  assert.match(comparison.summary, /canonical decision changed/i);
});

test("compares post-event states instead of treating a baseline mutation as a later delta", () => {
  const playback = buildDecisionPlayback([
    {
      id: "canonical",
      at: "2026-08-31T10:00:00Z",
      revisionBefore: 4,
      revisionAfter: 5,
      viewRevisionBefore: 1,
      viewRevisionAfter: 1,
      decisionHashBefore: "before",
      decisionHashAfter: "stable-five",
      changedEntityIds: ["criterion:cost"],
    },
    {
      id: "view-only",
      at: "2026-08-31T10:01:00Z",
      type: "presentation.committed",
      revisionBefore: 5,
      revisionAfter: 5,
      viewRevisionBefore: 1,
      viewRevisionAfter: 2,
      decisionHashBefore: "stable-five",
      decisionHashAfter: "stable-five",
    },
  ]);
  const comparison = comparePlaybackEvents(playback.events[0], playback.events[1], playback.events);
  assert.equal(comparison.decisionChanged, false);
  assert.equal(comparison.viewChanged, true);
  assert.deepEqual(comparison.changedEntityIds, []);
});

test("uses singular state bindings on native workspace receipts when comparing distant events", () => {
  const playback = buildDecisionPlayback([
    {
      id: "view-at-five",
      at: "2026-08-31T10:00:00Z",
      type: "presentation.saved",
      decisionRevision: 5,
      decisionHash: "hash-five",
      viewRevision: 2,
    },
    {
      id: "canonical-six",
      at: "2026-08-31T10:01:00Z",
      type: "model.replaced",
      revisionBefore: 5,
      revisionAfter: 6,
      decisionHashBefore: "hash-five",
      decisionHashAfter: "hash-six",
      viewRevisionBefore: 2,
      viewRevisionAfter: 2,
      changedEntityIds: ["criterion:risk"],
    },
    {
      id: "output-at-six",
      at: "2026-08-31T10:02:00Z",
      type: "output.prepared",
      decisionRevision: 6,
      decisionHash: "hash-six",
      viewRevision: 2,
    },
  ]);
  const comparison = comparePlaybackEvents(playback.events[0], playback.events[2], playback.events);
  assert.equal(comparison.decisionChanged, true);
  assert.deepEqual(comparison.changedEntityIds, ["criterion:risk"]);
});
