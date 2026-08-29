import { createDecisionCase } from "../kernel/model.js";
import { makeEvidenceBundle, sourceReference, defaultMapImportedDocuments, allowByDefault } from "./shared.js";

export const GENERIC_PACK_ID = "generic";

export function createGenericFixture() {
  const caseId = "generic-demo";
  const alternatives = [
    { id: "option-field", label: "Field workstation", values: [2050, 13, 1.35, true] },
    { id: "option-studio", label: "Studio workstation", values: [2190, 9, 1.72, true] },
    { id: "option-light", label: "Lightweight workstation", values: [1780, 16, 1.08, false] },
  ];
  const criteria = [
    {
      id: "price",
      label: "Price",
      kind: "score",
      valueType: "currency",
      unit: "EUR",
      weight: 30,
      scoring: { kind: "linear", min: 1500, max: 2400, direction: "minimize" },
    },
    {
      id: "battery",
      label: "Verified battery life",
      kind: "score",
      valueType: "number",
      unit: "hours",
      weight: 30,
      scoring: { kind: "linear", min: 7, max: 17, direction: "maximize" },
    },
    {
      id: "weight",
      label: "Carry weight",
      kind: "score",
      valueType: "number",
      unit: "kg",
      weight: 20,
      scoring: { kind: "linear", min: 1, max: 2, direction: "minimize" },
    },
    {
      id: "repairable",
      label: "User-replaceable storage",
      kind: "score",
      valueType: "boolean",
      weight: 20,
      scoring: { kind: "boolean", preferred: true },
    },
  ];
  const constraints = [
    { id: "generic-constraint:budget", criterionId: "price", operator: "lte", expected: 2200, severity: "mandatory" },
  ];
  const entries = alternatives.flatMap((alternative) =>
    criteria.map((criterion, index) => ({
      key: `${alternative.id}:${criterion.id}`,
      document: `${alternative.label} product sheet`,
      text: `${criterion.label}: ${String(alternative.values[index])}`,
      locator: { field: criterion.id },
    })),
  );
  const bundle = makeEvidenceBundle(caseId, entries);
  const claims = alternatives.flatMap((alternative) =>
    criteria.map((criterion, index) => ({
      id: `${caseId}:claim:${alternative.id}:${criterion.id}`,
      subjectId: alternative.id,
      criterionId: criterion.id,
      value: alternative.values[index],
      status: "accepted",
      confidence: 1,
      sourceRefs: sourceReference(bundle.refs, `${alternative.id}:${criterion.id}`),
    })),
  );
  return createDecisionCase({
    id: caseId,
    title: "Portable Workstation Choice",
    subtitle: "Generic evidence-backed comparison",
    domain: { packId: GENERIC_PACK_ID, packVersion: "1.0.0" },
    currency: "EUR",
    contract: {
      question: "Which workstation best balances mobility, endurance, price, and repairability?",
      objective: "Choose a workstation within budget using verified product-sheet evidence.",
      alternativeIds: alternatives.map((entry) => entry.id),
      criterionIds: criteria.map((entry) => entry.id),
      constraintIds: constraints.map((entry) => entry.id),
      stakeholderIds: ["decision-owner"],
    },
    alternatives: alternatives.map(({ values: _values, ...alternative }) => alternative),
    criteria,
    constraints,
    stakeholders: [{ id: "decision-owner", label: "Decision owner", mandate: "Confirm the final selection." }],
    documents: bundle.documents,
    fragments: bundle.fragments,
    claims,
    scenarios: [
      {
        id: "generic-scenario:field-battery",
        label: "Battery derating in field use",
        description: "Hypothetical sustained-load branch using lower field battery-life assumptions for every option.",
        claimOverrides: {
          [`${caseId}:claim:option-field:battery`]: 10,
          [`${caseId}:claim:option-studio:battery`]: 7,
          [`${caseId}:claim:option-light:battery`]: 12,
        },
      },
    ],
    audit: [
      {
        id: `${caseId}:audit:seed`,
        caseId,
        revision: 1,
        at: "2026-08-28T10:00:00.000Z",
        actor: { type: "system", id: "fixture" },
        action: "Created a synthetic generic comparison.",
      },
    ],
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
  });
}

export const genericPack = Object.freeze({
  id: GENERIC_PACK_ID,
  version: "1.0.0",
  label: "Generic decision",
  description: "A flexible typed comparison for evidence-backed decisions not covered by a specialized pack.",
  riskClass: "context-dependent",
  instrumentHints: ["comparison-rulers", "constraint-wall", "sensitivity", "causal-trace"],
  createFixture: createGenericFixture,
  mapImportedDocuments: defaultMapImportedDocuments,
  validateCase: () => [],
  canExecute: allowByDefault,
});
