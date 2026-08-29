import {
  CASE_INFO,
  EVIDENCE,
  REQUIREMENTS,
  STAKEHOLDERS,
  VENDORS,
} from "../data/caseData.js";
import { createDecisionCase } from "../kernel/model.js";
import { makeEvidenceBundle, sourceReference, defaultMapImportedDocuments, allowByDefault } from "./shared.js";

export const PROCUREMENT_PACK_ID = "procurement";

function knownMeasurement(result, criterionId) {
  const measurement = result.criteria.find((entry) => entry.criterionId === criterionId)?.measurement;
  return measurement?.status === "known" ? measurement.value : null;
}

function evaluateProcurement(decisionCase, baseEvaluate) {
  const base = baseEvaluate(decisionCase);
  const results = base.results.map((result) => {
    const responsePass = knownMeasurement(result, "r1");
    const residencyPass = knownMeasurement(result, "r2");
    const deploymentWeeks = knownMeasurement(result, "r3");
    const totalCost = knownMeasurement(result, "r4");
    const costScore = Number.isFinite(totalCost)
      ? Math.max(0, Math.min(30, ((320000 - totalCost) / 70000) * 30))
      : 0;
    const responseScore = responsePass === true ? 30 : 0;
    const deploymentScore = Number.isFinite(deploymentWeeks)
      ? Math.max(0, Math.min(20, (14 - deploymentWeeks) * 4))
      : 0;
    const residencyScore = residencyPass === true ? 20 : 0;
    return { ...result, score: Math.round(costScore + responseScore + deploymentScore + residencyScore) };
  });
  const ranking = [...results].sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    if (right.score !== left.score) return right.score - left.score;
    const leftCost = knownMeasurement(left, "r4");
    const rightCost = knownMeasurement(right, "r4");
    if (!Number.isFinite(leftCost)) return Number.isFinite(rightCost) ? 1 : 0;
    if (!Number.isFinite(rightCost)) return -1;
    return leftCost - rightCost;
  });
  return { ...base, results, ranking, recommendation: ranking.find((entry) => entry.eligible) ?? ranking[0] };
}

export function createProcurementFixture() {
  const caseId = "procurement-demo";
  const bundle = makeEvidenceBundle(
    caseId,
    EVIDENCE.map((evidence) => ({
      key: evidence.id,
      document: evidence.document,
      text: evidence.text,
      locator: { pages: evidence.pages, citation: evidence.citation },
    })),
  );
  const alternatives = VENDORS.map((vendor) => ({
    id: vendor.id,
    label: vendor.name,
    description: vendor.proposal,
    attributes: {
      code: vendor.code,
      commercial: vendor.commercial,
      operations: vendor.operations,
    },
  }));
  const criteria = REQUIREMENTS.map((requirement) => ({
    id: requirement.id,
    label: requirement.title,
    description: requirement.description,
    kind: "score",
    valueType: ["r1", "r2"].includes(requirement.id) ? "boolean" : "number",
    unit: requirement.id === "r3" ? "weeks" : requirement.id === "r4" ? "EUR" : null,
    weight: requirement.id === "r1" ? 30 : requirement.id === "r2" ? 20 : requirement.id === "r3" ? 20 : 30,
    scoring:
      requirement.id === "r1" || requirement.id === "r2"
        ? { kind: "boolean", preferred: true }
        : requirement.id === "r3"
          ? { kind: "linear", min: 8, max: 14, direction: "minimize" }
          : { kind: "linear", min: 250000, max: 320000, direction: "minimize" },
  }));
  const constraints = [
    { id: "constraint:r1", criterionId: "r1", operator: "eq", expected: true, severity: "mandatory" },
    { id: "constraint:r2", criterionId: "r2", operator: "eq", expected: true, severity: "mandatory" },
    { id: "constraint:r3", criterionId: "r3", operator: "lte", expected: 12, severity: "mandatory" },
    { id: "constraint:r4", criterionId: "r4", operator: "lte", expected: 300000, severity: "mandatory" },
  ];
  const claims = VENDORS.flatMap((vendor) => {
    const prefix = vendor.code.toLowerCase();
    const responseKeys = vendor.id === "vendor-b" ? ["b-monitoring", "b-response"] : [`${prefix}-response`];
    const totalCost = vendor.commercial.baseCost + vendor.commercial.recurringFees + vendor.commercial.requiredOptions;
    const responsePass =
      vendor.operations.coverage === "24/7" &&
      vendor.operations.namedEngineer &&
      vendor.operations.acknowledgementMinutes <= 15 &&
      vendor.operations.continuousEngagement;
    return [
      {
        id: `${caseId}:claim:${vendor.id}:r1`,
        subjectId: vendor.id,
        criterionId: "r1",
        value: responsePass,
        status: "accepted",
        confidence: 1,
        sourceRefs: sourceReference(bundle.refs, ...responseKeys),
      },
      {
        id: `${caseId}:claim:${vendor.id}:r2`,
        subjectId: vendor.id,
        criterionId: "r2",
        value: vendor.operations.euResidency,
        status: "accepted",
        confidence: 1,
        sourceRefs: sourceReference(bundle.refs, `${prefix}-residency`),
      },
      {
        id: `${caseId}:claim:${vendor.id}:r3`,
        subjectId: vendor.id,
        criterionId: "r3",
        value: vendor.operations.deploymentWeeks,
        status: "accepted",
        confidence: 1,
        sourceRefs: sourceReference(bundle.refs, `${prefix}-deployment`),
      },
      {
        id: `${caseId}:claim:${vendor.id}:r4`,
        subjectId: vendor.id,
        criterionId: "r4",
        value: totalCost,
        status: "accepted",
        confidence: 1,
        sourceRefs: sourceReference(bundle.refs, `${prefix}-cost`),
      },
    ];
  });
  return createDecisionCase({
    id: caseId,
    title: CASE_INFO.title,
    subtitle: CASE_INFO.subtitle,
    domain: { packId: PROCUREMENT_PACK_ID, packVersion: "1.0.0" },
    currency: "EUR",
    owner: CASE_INFO.owner,
    revision: CASE_INFO.canonicalRevision,
    createdAt: CASE_INFO.issuedAt,
    updatedAt: CASE_INFO.updatedAt,
    contract: {
      question: "Which eligible vendor best satisfies the emergency communications requirements?",
      objective: "Select an eligible vendor without weakening mandatory clinical, security, delivery, or cost gates.",
      alternativeIds: alternatives.map((entry) => entry.id),
      criterionIds: criteria.map((entry) => entry.id),
      constraintIds: constraints.map((entry) => entry.id),
      stakeholderIds: STAKEHOLDERS.map((entry) => entry.id),
      authority: {
        mode: "assistive",
        humanConfirmationRequired: true,
        allowAutomatedRanking: true,
        humanOnlyActions: ["activate_contract", "accept_import", "approve_decision"],
      },
    },
    alternatives,
    criteria,
    constraints,
    stakeholders: STAKEHOLDERS.map((stakeholder) => ({ ...stakeholder })),
    documents: bundle.documents,
    fragments: bundle.fragments,
    claims,
    scenarios: [
      {
        id: "procurement-scenario:deployment-delay",
        label: "Deployment delay",
        description:
          "Hypothetical schedule stress test in which the leading proposal slips beyond the mandatory launch window.",
        claimOverrides: {
          [`${caseId}:claim:vendor-a:r3`]: 13,
        },
      },
    ],
    audit: [
      {
        id: `${caseId}:audit:seed`,
        caseId,
        revision: CASE_INFO.canonicalRevision,
        at: CASE_INFO.updatedAt,
        actor: { type: "system", id: "legacy-migration" },
        action: "Migrated the procurement prototype into the universal decision kernel.",
      },
    ],
  });
}

export const procurementPack = Object.freeze({
  id: PROCUREMENT_PACK_ID,
  version: "1.0.0",
  label: "Procurement",
  description: "Evidence-backed vendor selection with hard compliance gates and deterministic scoring.",
  riskClass: "consequential",
  instrumentHints: ["requirement-gates", "cost-waterfall", "vendor-comparison", "causal-trace"],
  createFixture: createProcurementFixture,
  mapImportedDocuments: defaultMapImportedDocuments,
  validateCase: () => [],
  canExecute: allowByDefault,
  evaluate: evaluateProcurement,
});
