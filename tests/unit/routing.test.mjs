import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_LENSES,
  parseWorkspacePath,
  phaseForWorkspaceRoute,
  routeFromWorkspaceState,
  workspacePathFor,
} from "../../src/workspace/workspaceRouter.js";

const CASE_ROUTES = [
  ["/cases/procurement-demo/model", { kind: "case", caseId: "procurement-demo", workspace: "model" }],
  ["/cases/procurement-demo/analyze/investigate", { kind: "case", caseId: "procurement-demo", workspace: "analyze", lens: "investigate" }],
  ["/cases/procurement-demo/analyze/compare", { kind: "case", caseId: "procurement-demo", workspace: "analyze", lens: "compare" }],
  ["/cases/procurement-demo/analyze/simulate", { kind: "case", caseId: "procurement-demo", workspace: "analyze", lens: "simulate" }],
  ["/cases/procurement-demo/analyze/brief", { kind: "case", caseId: "procurement-demo", workspace: "analyze", lens: "brief" }],
  ["/cases/procurement-demo/review", { kind: "case", caseId: "procurement-demo", workspace: "review" }],
  ["/cases/procurement-demo/outputs", { kind: "case", caseId: "procurement-demo", workspace: "outputs" }],
];

test("exports the fixed analysis lens contract", () => {
  assert.deepEqual(ANALYSIS_LENSES, ["investigate", "compare", "simulate", "brief"]);
  assert.equal(Object.isFrozen(ANALYSIS_LENSES), true);
});

test("parses root, archive, new, and every case workspace and round-trips them", () => {
  const routes = [
    ["/", { kind: "root" }],
    ["/cases", { kind: "archive" }],
    ["/new", { kind: "new" }],
    ...CASE_ROUTES,
  ];

  for (const [path, expected] of routes) {
    const parsed = parseWorkspacePath(path);
    assert.deepEqual(parsed, expected, path);
    assert.equal(workspacePathFor(parsed), path, path);
  }
});

test("decodes opaque case ids and emits one canonical encoded path", () => {
  const parsed = parseWorkspacePath("/cases/case%3A%CE%B1%20beta/analyze/compare");
  assert.deepEqual(parsed, {
    kind: "case",
    caseId: "case:α beta",
    workspace: "analyze",
    lens: "compare",
  });
  assert.equal(workspacePathFor(parsed), "/cases/case%3A%CE%B1%20beta/analyze/compare");

  assert.equal(
    workspacePathFor({ kind: "case", caseId: "case:import-17", workspace: "review" }),
    "/cases/case%3Aimport-17/review",
  );
});

test("accepts trailing slashes but serializes canonical paths without them", () => {
  for (const [input, canonical] of [
    ["////", "/"],
    ["/cases/", "/cases"],
    ["/new///", "/new"],
    ["/cases/procurement-demo/model/", "/cases/procurement-demo/model"],
    ["/cases/procurement-demo/analyze/brief///", "/cases/procurement-demo/analyze/brief"],
  ]) {
    const parsed = parseWorkspacePath(input);
    assert.notEqual(parsed.kind, "not-found", input);
    assert.equal(workspacePathFor(parsed), canonical, input);
  }
});

test("fails closed for invalid case ids and malformed encodings", () => {
  const invalidPaths = [
    "",
    "cases/procurement-demo/model",
    "/cases//model",
    "/cases/./model",
    "/cases/../model",
    "/cases/%20/model",
    "/cases/%2F/model",
    "/cases/%2f/model",
    "/cases/%5C/model",
    "/cases/%E0%A4%A/model",
    "/cases/procurement%00demo/model",
  ];

  for (const path of invalidPaths) {
    assert.deepEqual(parseWorkspacePath(path), { kind: "not-found" }, path);
  }
});

test("fails closed for unknown or structurally incomplete workspace paths", () => {
  const invalidPaths = [
    "/unknown",
    "/new/extra",
    "/cases/procurement-demo",
    "/cases/procurement-demo/analyze",
    "/cases/procurement-demo/analyze/unknown",
    "/cases/procurement-demo/analyze/compare/extra",
    "/cases/procurement-demo/unknown",
    "/cases/procurement-demo/review/extra",
    "/cases/procurement-demo/outputs/extra",
  ];

  for (const path of invalidPaths) {
    assert.deepEqual(parseWorkspacePath(path), { kind: "not-found" }, path);
  }
});

test("workspacePathFor rejects malformed route-like values", () => {
  const invalidRoutes = [
    null,
    {},
    { kind: "not-found" },
    { kind: "case", workspace: "model" },
    { kind: "case", caseId: "bad/id", workspace: "model" },
    { kind: "case", caseId: "case", workspace: "unknown" },
    { kind: "case", caseId: "case", workspace: "analyze" },
    { kind: "case", caseId: "case", workspace: "analyze", lens: "unknown" },
  ];

  for (const route of invalidRoutes) assert.equal(workspacePathFor(route), null);
});

test("maps workspace routes to their capability phases", () => {
  assert.equal(phaseForWorkspaceRoute({ kind: "root" }), null);
  assert.equal(phaseForWorkspaceRoute({ kind: "archive" }), null);
  assert.equal(phaseForWorkspaceRoute({ kind: "new" }), "intake");
  assert.equal(phaseForWorkspaceRoute(CASE_ROUTES[0][1]), "contract_draft");
  assert.equal(phaseForWorkspaceRoute(CASE_ROUTES[1][1]), "analysis");
  assert.equal(phaseForWorkspaceRoute(CASE_ROUTES[5][1]), "collaboration");
  assert.equal(phaseForWorkspaceRoute(CASE_ROUTES[6][1]), "output");
  assert.equal(phaseForWorkspaceRoute({ kind: "not-found" }), null);
});

test("maps workspace state to new, model, analysis, review, and output routes", () => {
  const activeCase = { id: "case:active" };

  assert.deepEqual(routeFromWorkspaceState({}), { kind: "root" });
  assert.deepEqual(routeFromWorkspaceState({ intakeOpen: true, activeCase }), { kind: "new" });
  assert.deepEqual(routeFromWorkspaceState({ activeCase, capabilityPhase: "contract_draft", lens: "brief" }), {
    kind: "case",
    caseId: "case:active",
    workspace: "model",
  });
  assert.deepEqual(routeFromWorkspaceState({ activeCase, capabilityPhase: "analysis", lens: "compare" }), {
    kind: "case",
    caseId: "case:active",
    workspace: "analyze",
    lens: "compare",
  });
  assert.deepEqual(routeFromWorkspaceState({ activeCase, capabilityPhase: "collaboration", lens: "simulate" }), {
    kind: "case",
    caseId: "case:active",
    workspace: "review",
  });
  assert.deepEqual(routeFromWorkspaceState({ activeCase, capabilityPhase: "output", lens: "simulate" }), {
    kind: "case",
    caseId: "case:active",
    workspace: "outputs",
  });
});

test("state mapping defaults invalid lenses to investigate and invalid case ids to root", () => {
  assert.deepEqual(routeFromWorkspaceState({
    activeCase: { id: "generic-demo" },
    capabilityPhase: "analysis",
    lens: "unknown",
  }), {
    kind: "case",
    caseId: "generic-demo",
    workspace: "analyze",
    lens: "investigate",
  });
  assert.deepEqual(routeFromWorkspaceState({
    activeCase: { id: "bad/id" },
    capabilityPhase: "analysis",
    lens: "compare",
  }), { kind: "root" });
});
