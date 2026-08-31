import assert from "node:assert/strict";
import test from "node:test";

import {
  SEMANTIC_INTAKE_LIMITS,
  proposeSemanticIntake,
} from "../src/workspace/semanticIntake.js";

function document(id, name, blocks) {
  return {
    id,
    name,
    format: "test",
    securityStatus: "review-required",
    blocks: blocks.map((block, index) => ({
      id: `${id}:block:${index + 1}`,
      documentId: id,
      kind: block.kind ?? "paragraph",
      confidence: block.confidence ?? 1,
      ...block,
    })),
  };
}

function tableDocument(id, name, headers, rows, confidences = {}) {
  const blocks = [];
  headers.forEach((text, column) => {
    blocks.push({
      kind: "cell",
      text,
      locator: { sheet: "Options", row: 1, column: column + 1, range: `${String.fromCharCode(65 + column)}1` },
    });
  });
  rows.forEach((row, rowIndex) => {
    row.forEach((text, column) => {
      const range = `${String.fromCharCode(65 + column)}${rowIndex + 2}`;
      blocks.push({
        kind: "cell",
        text: String(text),
        confidence: confidences[range] ?? 1,
        locator: { sheet: "Options", row: rowIndex + 2, column: column + 1, range },
      });
    });
  });
  return document(id, name, blocks);
}

test("mixed documents resolve exact entity identities and preserve exact field anchors", () => {
  const csv = tableDocument(
    "document:csv",
    "vendors.csv",
    ["Vendor", "Annual cost", "Quality"],
    [["ACME, Inc.", "1200", "8"]],
  );
  const narrative = document("document:email", "acme-email.txt", [{
    text: "Vendor: acme inc\nAnnual cost: 1200\nSupport region: EU",
    locator: { paragraph: 1 },
  }]);

  const proposal = proposeSemanticIntake({ documents: [csv, narrative] });

  assert.equal(proposal.requiresHumanReview, true);
  assert.equal(proposal.entities.length, 1);
  assert.equal(proposal.entities[0].documentIds.length, 2);
  assert.equal(proposal.entities[0].resolution.crossDocument, true);
  assert.deepEqual(proposal.entities[0].aliases, ["ACME, Inc.", "acme inc"]);
  const cost = proposal.mappings.find((mapping) => mapping.normalizedField === "annual_cost");
  assert.equal(cost.status, "review-ready");
  assert.equal(cost.sourceAnchors.length, 2);
  assert.equal(cost.sourceAnchors[0].documentId, "document:csv");
  assert.equal(cost.sourceAnchors[0].locator.range, "B2");
  assert.match(cost.sourceAnchors[0].quoteHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(proposal.conflicts.length, 0);
  assert.equal(proposal.unresolved.some((item) => item.code === "UNSTRUCTURED_TEXT"), false);
});

test("contradictory values remain explicit and are never collapsed into one fact", () => {
  const first = tableDocument("document:first", "first.csv", ["Vendor", "Cost"], [["Northwind", "900"]]);
  const second = document("document:second", "second.txt", [{
    text: "Vendor: NORTHWIND\nCost: 1250",
    locator: { paragraph: 4 },
  }]);

  const proposal = proposeSemanticIntake({ documents: [first, second] });

  assert.equal(proposal.entities.length, 1);
  assert.equal(proposal.conflicts.length, 1);
  assert.equal(proposal.conflicts[0].status, "unresolved");
  assert.equal(proposal.conflicts[0].normalizedField, "cost");
  assert.deepEqual(proposal.conflicts[0].values.map((entry) => entry.value), [900, 1250]);
  assert.equal(proposal.conflicts[0].values.every((entry) => entry.sourceAnchors.length === 1), true);
  assert.equal(proposal.mappings.find((entry) => entry.normalizedField === "cost").status, "conflicted");
});

test("agent mappings stay proposed and cannot override deterministic mappings", () => {
  const source = tableDocument("document:source", "source.csv", ["Vendor", "Cost"], [["Contoso", "700"]]);
  const costBlock = source.blocks.find((block) => block.locator.range === "B2");
  const proposal = proposeSemanticIntake({
    documents: [source],
    agentSuggestions: [
      {
        id: "suggestion:cost",
        kind: "field-mapping",
        sourceField: "Cost",
        targetCriterion: "Vendor charisma",
        confidence: 1,
        sourceRefs: [{ documentId: source.id, fragmentId: costBlock.id }],
      },
      {
        id: "suggestion:command",
        kind: "field-mapping",
        sourceField: "Cost",
        targetCriterion: "Approved",
        confidence: 1,
        sourceRefs: [{ documentId: source.id, fragmentId: costBlock.id }],
        command: "approve_decision",
      },
    ],
  });

  const deterministic = proposal.mappings.find((entry) => entry.normalizedField === "cost");
  assert.equal(deterministic.targetCriterion, "Cost");
  assert.equal(deterministic.basis, "deterministic-evidence");
  assert.equal(proposal.agentSuggestionReview.proposed.length, 1);
  assert.equal(proposal.agentSuggestionReview.proposed[0].status, "proposed");
  assert.equal(proposal.agentSuggestionReview.proposed[0].wouldOverride, true);
  assert.equal(proposal.agentSuggestionReview.rejected.length, 1);
  assert.equal(proposal.agentSuggestionReview.rejected[0].code, "INVALID_SUGGESTION_SCHEMA");
});

test("a field-mapping suggestion may cite the exact source header", () => {
  const source = tableDocument("document:header-citation", "source.csv", ["Vendor", "Cost"], [["Contoso", "700"]]);
  const costHeader = source.blocks.find((block) => block.locator.range === "B1");
  const proposal = proposeSemanticIntake({
    documents: [source],
    agentSuggestions: [{
      id: "suggestion:header-cost",
      kind: "field-mapping",
      sourceField: "Cost",
      targetCriterion: "Verified operating cost",
      confidence: 0.95,
      sourceRefs: [{ documentId: source.id, fragmentId: costHeader.id }],
    }],
  });
  assert.equal(proposal.agentSuggestionReview.proposed.length, 1);
  assert.equal(proposal.agentSuggestionReview.rejected.length, 0);
});

test("oversized suggestion payloads fail closed without affecting deterministic evidence", () => {
  const source = tableDocument("document:bounded", "bounded.csv", ["Vendor", "Cost"], [["Fabrikam", "500"]]);
  const result = proposeSemanticIntake({
    documents: [source],
    agentSuggestions: [{
      id: "suggestion:oversized",
      kind: "field-mapping",
      sourceField: "Cost",
      targetCriterion: "X".repeat(SEMANTIC_INTAKE_LIMITS.maxSuggestionBytes),
      confidence: 1,
      sourceRefs: [{ documentId: source.id, fragmentId: source.blocks.at(-1).id }],
    }],
  });

  assert.equal(result.agentSuggestionReview.proposed.length, 0);
  assert.equal(result.agentSuggestionReview.rejected.length, 1);
  assert.equal(result.agentSuggestionReview.rejected[0].code, "AGENT_SUGGESTIONS_TOO_LARGE");
  assert.equal(result.mappings.find((entry) => entry.normalizedField === "cost").targetCriterion, "Cost");
});

test("duplicate entity records are merged but remain visible for human review", () => {
  const source = tableDocument(
    "document:duplicates",
    "duplicates.csv",
    ["Vendor", "Cost"],
    [["Tailspin", "300"], ["TAILSPIN", "300"]],
  );

  const proposal = proposeSemanticIntake({ documents: [source] });

  assert.equal(proposal.entities.length, 1);
  assert.equal(proposal.conflicts.length, 0);
  const duplicate = proposal.unresolved.find((item) => item.code === "DUPLICATE_ENTITY_RECORD");
  assert.ok(duplicate);
  assert.equal(duplicate.entityId, proposal.entities[0].id);
  assert.equal(duplicate.sourceAnchors.length, 2);
});

test("near aliases and valid agent links remain review proposals instead of merging entities", () => {
  const first = tableDocument("document:alpha-a", "a.csv", ["Vendor", "Cost"], [["Alpha Medical Ltd", "40"]]);
  const second = tableDocument("document:alpha-b", "b.csv", ["Vendor", "Quality"], [["Alpha Medical", "9"]]);
  const proposal = proposeSemanticIntake({
    documents: [first, second],
    agentSuggestions: [{
      id: "suggestion:alpha-link",
      kind: "entity-resolution",
      aliases: ["Alpha Medical Ltd", "Alpha Medical"],
      confidence: 0.99,
      sourceRefs: [
        { documentId: first.id, fragmentId: first.blocks.find((block) => block.locator.range === "A2").id },
        { documentId: second.id, fragmentId: second.blocks.find((block) => block.locator.range === "A2").id },
      ],
    }],
  });

  assert.equal(proposal.entities.length, 2);
  assert.equal(proposal.resolutionProposals.some((entry) => entry.basis === "deterministic-alias-similarity"), true);
  assert.equal(proposal.agentSuggestionReview.proposed[0].kind, "entity-resolution");
  assert.equal(proposal.agentSuggestionReview.proposed[0].status, "proposed");
});

test("low-confidence facts and missing locators cannot become review-ready mappings", () => {
  const uncertain = tableDocument(
    "document:uncertain",
    "uncertain.csv",
    ["Vendor", "Cost", "Quality"],
    [["Adventure Works", "80", "6"]],
    { B2: 0.34 },
  );
  delete uncertain.blocks.find((block) => block.locator.range === "C2").locator;

  const proposal = proposeSemanticIntake({ documents: [uncertain] });

  assert.equal(proposal.mappings.find((entry) => entry.normalizedField === "cost").status, "proposed");
  assert.equal(proposal.mappings.some((entry) => entry.normalizedField === "quality"), false);
  const unresolved = proposal.unresolved.find((item) => item.code === "MISSING_SOURCE_ANCHOR");
  assert.ok(unresolved);
  assert.match(unresolved.fragmentId, /block:/);
  assert.equal(proposal.entities[0].facts.some((fact) => fact.sourceAnchor === null), false);
});

test("nested structured fields keep their semantic path and exact JSON pointer", () => {
  const structured = document("document:json", "vendors.json", [
    { kind: "field", text: "v-1", locator: { jsonPointer: "/vendors/0/id" } },
    { kind: "field", text: "Litware", locator: { jsonPointer: "/vendors/0/name" } },
    { kind: "field", text: "100", locator: { jsonPointer: "/vendors/0/cost" } },
    { kind: "field", text: "250", locator: { jsonPointer: "/vendors/0/details/cost" } },
  ]);

  const proposal = proposeSemanticIntake({ documents: [structured] });

  assert.equal(proposal.entities.length, 1);
  assert.equal(proposal.entities[0].canonicalLabel, "Litware");
  assert.deepEqual(
    proposal.mappings.map((mapping) => mapping.normalizedField),
    ["cost", "details_cost"],
  );
  const nested = proposal.mappings.find((mapping) => mapping.normalizedField === "details_cost");
  assert.equal(nested.sourceAnchors[0].locator.jsonPointer, "/vendors/0/details/cost");
  assert.equal(proposal.unresolved.some((item) => item.code === "DUPLICATE_ENTITY_RECORD"), false);
});

test("agent suggestions with unresolved source references are rejected", () => {
  const source = tableDocument("document:anchors", "anchors.csv", ["Vendor", "Cost"], [["Woodgrove", "55"]]);
  const proposal = proposeSemanticIntake({
    documents: [source],
    agentSuggestions: [{
      id: "suggestion:missing-anchor",
      kind: "field-mapping",
      sourceField: "Cost",
      targetCriterion: "Operating cost",
      confidence: 0.9,
      sourceRefs: [{ documentId: source.id, fragmentId: "missing-fragment" }],
    }],
  });

  assert.equal(proposal.agentSuggestionReview.proposed.length, 0);
  assert.equal(proposal.agentSuggestionReview.rejected[0].code, "UNRESOLVED_SUGGESTION_ANCHOR");
  assert.equal(proposal.mappings.find((mapping) => mapping.normalizedField === "cost").targetCriterion, "Cost");
});

test("agent suggestions cannot cite unrelated fragments as semantic support", () => {
  const source = tableDocument("document:support", "support.csv", ["Vendor", "Cost"], [["Woodgrove", "55"]]);
  const identity = source.blocks.find((block) => block.locator.range === "A2");
  const proposal = proposeSemanticIntake({
    documents: [source],
    agentSuggestions: [{
      id: "suggestion:unsupported-cost",
      kind: "field-mapping",
      sourceField: "Cost",
      targetCriterion: "Operating cost",
      confidence: 0.9,
      sourceRefs: [{ documentId: source.id, fragmentId: identity.id }],
    }],
  });
  assert.equal(proposal.agentSuggestionReview.proposed.length, 0);
  assert.equal(proposal.agentSuggestionReview.rejected[0].code, "SUGGESTION_EVIDENCE_MISMATCH");
});

test("workbook cells with range-only locators retain their sheet and cell anchors", () => {
  const workbook = document("document:xlsx", "options.xlsx", [
    { kind: "heading", text: "Benefits", locator: { sheet: "Benefits", sheetIndex: 1 } },
    { kind: "cell", text: "Plan", locator: { sheet: "Benefits", range: "A1" } },
    { kind: "cell", text: "Premium", locator: { sheet: "Benefits", range: "B1" } },
    { kind: "cell", text: "Standard", locator: { sheet: "Benefits", range: "A2" } },
    { kind: "cell", text: "120", locator: { sheet: "Benefits", range: "B2" } },
  ]);

  const proposal = proposeSemanticIntake({ documents: [workbook] });

  assert.equal(proposal.entities[0].canonicalLabel, "Standard");
  const premium = proposal.mappings.find((mapping) => mapping.normalizedField === "premium");
  assert.equal(premium.sourceAnchors[0].locator.sheet, "Benefits");
  assert.equal(premium.sourceAnchors[0].locator.range, "B2");
  assert.equal(proposal.unresolved.some((item) => item.code === "UNSTRUCTURED_TEXT"), false);
});
