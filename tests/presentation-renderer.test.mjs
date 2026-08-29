import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

import {
  compilePresentation,
  createDefaultPresentationRecipe,
  TRUSTED_INSTRUMENT_TYPES,
} from "../src/presentation/index.js";

function createRenderSnapshot(domainKind = "generic") {
  return {
    schemaVersion: "1.0",
    caseId: `${domainKind}-render-case`,
    decisionRevision: 8,
    decisionHash: `decision-${domainKind}-8`,
    viewRevision: 2,
    frozen: false,
    domain: { id: `${domainKind}-v1`, kind: domainKind, label: domainKind, riskLevel: "standard" },
    contract: {
      title: "Evidence-backed decision",
      question: "Which option satisfies the declared constraints?",
      status: "active",
      authority: "human-only",
    },
    entities: [
      { id: "option-a", kind: "alternative", label: "Option A", summary: "Leading option", status: "eligible", attributes: { risk: 2, benefit: 8 } },
      { id: "option-b", kind: "alternative", label: "Option B", summary: "Blocked option", status: "blocked", attributes: { risk: 6, benefit: 5 } },
      { id: "criterion", kind: "criterion", label: "Declared criterion", summary: "Must pass", status: "pass", attributes: { weight: 10 } },
      { id: "constraint", kind: "constraint", label: "Protected constraint", summary: "Cannot be weakened", status: "pass", attributes: { mandatory: true } },
      { id: "evidence", kind: "evidence", label: "Exact source excerpt", summary: "<script>alert('untrusted')</script>", status: "verified", attributes: { citation: "p. 4", sourceId: "source", confidence: 0.95 } },
      { id: "claim", kind: "claim", label: "Normalized claim", summary: "Evidence supports the declared criterion.", status: "verified", attributes: { confidence: 0.95 } },
      { id: "stakeholder", kind: "stakeholder", label: "Reviewer", summary: "Retains authority", attributes: { mandate: "Verify every cited result." } },
      { id: "control", kind: "control", label: "Scenario value", summary: "Hypothetical only", attributes: { control: "range", min: 0, max: 10, step: 1, value: 4, baseline: 3 } },
    ],
    results: [
      { id: "option-a-result", kind: "evaluation", subjectId: "option-a", criterionId: "criterion", status: "pass", value: 8, unit: "points", reason: "Passes the criterion.", evidenceIds: ["evidence"] },
      { id: "option-b-result", kind: "evaluation", subjectId: "option-b", criterionId: "criterion", status: "fail", value: 5, unit: "points", reason: "Fails the criterion.", evidenceIds: ["evidence"] },
    ],
    relations: [
      { id: "supports", type: "supports", from: { kind: "evidence", id: "evidence" }, to: { kind: "claim", id: "claim" } },
      { id: "evaluates", type: "evaluated-against", from: { kind: "claim", id: "claim" }, to: { kind: "constraint", id: "constraint" } },
    ],
    paths: [
      { id: "path", label: "Evidence to outcome", entityRefs: [{ kind: "evidence", id: "evidence" }, { kind: "claim", id: "claim" }, { kind: "constraint", id: "constraint" }, { kind: "alternative", id: "option-a" }], resultIds: ["option-a-result"], status: "pass" },
    ],
    sources: [{ id: "source", kind: "source", label: "Imported PDF", format: "pdf", status: "ready", locations: [{ label: "p. 4", locator: "page:4" }] }],
    pins: [{ kind: "evidence", id: "evidence" }],
    protected: { entityRefs: [{ kind: "constraint", id: "constraint" }], blockerResultIds: [], omittedEntityCount: 3, prohibitedEntityKinds: [], authority: { mode: "human-only", canApprove: false } },
    policy: { allowedInstrumentTypes: null, blockedInstrumentTypes: [], maxInstrumentCount: 10 },
    permissions: { canCompose: true, canSimulate: true, canApprove: false },
    metadata: { locale: "en-GB" },
    domainData: {},
  };
}

test("the compiled renderer covers every layout grammar, escapes evidence, and exposes semantic controls", async () => {
  const server = await createServer({
    configFile: "vite.config.mjs",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { CompiledRoomView } = await server.ssrLoadModule("/src/components/composer/CompiledRoomView.jsx");
    const snapshot = createRenderSnapshot();
    const expectedPatterns = { investigate: "trace", compare: "matrix", simulate: "fork", brief: "council" };

    for (const [lens, pattern] of Object.entries(expectedPatterns)) {
      const compiled = compilePresentation(snapshot, createDefaultPresentationRecipe(snapshot, { lens }));
      assert.equal(compiled.ok, true, compiled.errors?.join("\n"));
      const html = renderToStaticMarkup(React.createElement(CompiledRoomView, { snapshot, plan: compiled.plan }));
      assert.match(html, new RegExp(`data-layout-pattern="${pattern}"`));
      assert.match(html, /Decision hash decision-generic-8 unchanged/);
      assert.doesNotMatch(html, /<script>/);
      if (lens === "investigate") assert.match(html, /&lt;script&gt;alert/);
      if (lens === "compare") assert.match(html, /<table class="compiled-comparison-table/);
      if (lens === "simulate") {
        assert.match(html, /<label for="[^"]+">Scenario value<\/label>/);
        assert.match(html, /type="range"/);
      }
    }
  } finally {
    await server.close();
  }
});

test("the registry and renderer expose the same complete trusted instrument set", async () => {
  const server = await createServer({
    configFile: "vite.config.mjs",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { INSTRUMENT_COMPONENTS } = await server.ssrLoadModule("/src/components/instruments/index.js");
    assert.deepEqual(Object.keys(INSTRUMENT_COMPONENTS).sort(), [...TRUSTED_INSTRUMENT_TYPES].sort());
  } finally {
    await server.close();
  }
});

test("scenario instruments expose adapter-declared scenarios when no parameter controls exist", async () => {
  const server = await createServer({
    configFile: "vite.config.mjs",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { CompiledRoomView } = await server.ssrLoadModule("/src/components/composer/CompiledRoomView.jsx");
    const snapshot = createRenderSnapshot();
    snapshot.entities = snapshot.entities.filter((entity) => entity.kind !== "control");
    snapshot.domainData = {
      scenarios: [{ id: "scenario-low-risk", label: "Low-risk case", description: "Use conservative assumptions." }],
      activeScenarioId: null,
    };
    const compiled = compilePresentation(snapshot, createDefaultPresentationRecipe(snapshot, { lens: "simulate" }));
    assert.equal(compiled.ok, true, compiled.errors?.join("\n"));
    const html = renderToStaticMarkup(React.createElement(CompiledRoomView, { snapshot, plan: compiled.plan }));
    assert.match(html, /Low-risk case/);
    assert.match(html, /Run scenario/);
    assert.match(html, /aria-pressed="false"/);
  } finally {
    await server.close();
  }
});

test("long canonical ledgers remain complete inside a labelled keyboard-scrollable region", async () => {
  const server = await createServer({
    configFile: "vite.config.mjs",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { CompiledRoomView } = await server.ssrLoadModule("/src/components/composer/CompiledRoomView.jsx");
    const snapshot = createRenderSnapshot();
    snapshot.entities.push(...Array.from({ length: 9 }, (_, index) => ({
      id: `evidence-${index + 2}`,
      kind: "evidence",
      label: `Evidence ${index + 2}`,
      summary: `Canonical evidence row ${index + 2}`,
      status: "verified",
      attributes: { confidence: 0.9, sourceId: "source" },
    })));
    const compiled = compilePresentation(snapshot, createDefaultPresentationRecipe(snapshot, { lens: "investigate" }));
    assert.equal(compiled.ok, true, compiled.errors?.join("\n"));
    const html = renderToStaticMarkup(React.createElement(CompiledRoomView, { snapshot, plan: compiled.plan }));
    assert.match(html, /class="instrument-bounded-region"/);
    assert.match(html, /aria-label="Evidence excerpts, 10 canonical items"/);
    assert.match(html, /data-bounded-item-count="10"/);
    assert.match(html, /Canonical evidence row 10/);
  } finally {
    await server.close();
  }
});

test("metric waterfalls never invent totals across subjects or incompatible units", async () => {
  const server = await createServer({
    configFile: "vite.config.mjs",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { MetricWaterfallInstrument } = await server.ssrLoadModule("/src/components/instruments/AnalysisInstruments.jsx");
    const snapshot = createRenderSnapshot("health-plan");
    snapshot.results = [
      { id: "monthly-premium", subjectId: "option-a", criterionId: "criterion", value: 410, unit: "EUR/month", label: "Option A monthly premium" },
      { id: "annual-deductible", subjectId: "option-a", criterionId: "criterion", value: 1_800, unit: "EUR/year", label: "Option A annual deductible" },
      { id: "other-plan-premium", subjectId: "option-b", criterionId: "criterion", value: 545, unit: "EUR/month", label: "Option B monthly premium" },
    ];
    const instrument = {
      id: "safe-waterfall",
      type: "metric-waterfall",
      region: "primary",
      priority: 1,
      entityRefs: [],
      options: {},
    };
    const html = renderToStaticMarkup(React.createElement(MetricWaterfallInstrument, { snapshot, instrument }));
    assert.match(html, /410[^<]*EUR\/month/);
    assert.match(html, /1,800[^<]*EUR\/year/);
    assert.match(html, /No cross-metric total/);
    assert.doesNotMatch(html, /Total of displayed components/);
    assert.doesNotMatch(html, /2,755/);
  } finally {
    await server.close();
  }
});

test("score and sensitivity meters never compare incompatible units on one scale", async () => {
  const server = await createServer({
    configFile: "vite.config.mjs",
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const { ScoreBreakdownInstrument, SensitivityPlotInstrument } = await server.ssrLoadModule("/src/components/instruments/AnalysisInstruments.jsx");
    const snapshot = createRenderSnapshot("health-plan");
    snapshot.results = [
      { id: "premium-a", subjectId: "option-a", value: 410, unit: "EUR/month", label: "Premium A" },
      { id: "premium-b", subjectId: "option-b", value: 545, unit: "EUR/month", label: "Premium B" },
      { id: "deductible", subjectId: "option-a", value: 1_800, unit: "EUR/year", label: "Deductible" },
    ];
    const base = { id: "unit-safe", region: "primary", priority: 1, entityRefs: [], options: {} };
    for (const [Component, type] of [[ScoreBreakdownInstrument, "score-breakdown"], [SensitivityPlotInstrument, "sensitivity-plot"]]) {
      const html = renderToStaticMarkup(React.createElement(Component, { snapshot, instrument: { ...base, type } }));
      assert.match(html, /max="545" value="410" data-scale-unit="EUR\/month"/);
      assert.match(html, /max="545" value="545" data-scale-unit="EUR\/month"/);
      assert.match(html, /max="1800" value="1800" data-scale-unit="EUR\/year"/);
      assert.doesNotMatch(html, /max="1800" value="410" data-scale-unit="EUR\/month"/);
    }
  } finally {
    await server.close();
  }
});
