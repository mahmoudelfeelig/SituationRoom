import { canonicalHash, cloneValue, deepFreeze } from "./canonicalize.js";

export const DECISION_SCHEMA_VERSION = 1;
export const CLAIM_STATUSES = Object.freeze(["proposed", "accepted", "disputed", "rejected"]);
export const CRITERION_KINDS = Object.freeze(["gate", "score", "informational"]);
export const CONSTRAINT_OPERATORS = Object.freeze([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "in",
  "not_in",
]);

function array(value) {
  return Array.isArray(value) ? cloneValue(value) : [];
}

export function createDecisionCase(input) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const contract = input.contract ?? {};
  const decisionCase = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    id: input.id,
    title: input.title,
    subtitle: input.subtitle ?? "",
    domain: {
      packId: input.domain?.packId ?? "generic",
      packVersion: input.domain?.packVersion ?? "1.0.0",
    },
    locale: input.locale ?? "en",
    currency: input.currency ?? null,
    status: input.status ?? "active",
    revision: input.revision ?? 1,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    owner: input.owner ?? null,
    contract: {
      id: contract.id ?? `${input.id}:contract`,
      version: contract.version ?? 1,
      status: contract.status ?? "active",
      question: contract.question ?? "",
      objective: contract.objective ?? "",
      alternativeIds: array(contract.alternativeIds),
      criterionIds: array(contract.criterionIds),
      constraintIds: array(contract.constraintIds),
      stakeholderIds: array(contract.stakeholderIds),
      evidencePolicy: {
        sourceRequired: contract.evidencePolicy?.sourceRequired ?? true,
        hardUnknownPolicy: contract.evidencePolicy?.hardUnknownPolicy ?? "block",
        conflictPolicy: contract.evidencePolicy?.conflictPolicy ?? "block",
      },
      authority: {
        mode: contract.authority?.mode ?? "assistive",
        humanConfirmationRequired: contract.authority?.humanConfirmationRequired ?? true,
        allowAutomatedRanking: contract.authority?.allowAutomatedRanking ?? true,
        humanOnlyActions: array(
          contract.authority?.humanOnlyActions ?? ["activate_contract", "accept_import", "approve_decision"],
        ),
        prohibitedFields: array(contract.authority?.prohibitedFields),
      },
      uncertainty: {
        scoreUnknownAs: contract.uncertainty?.scoreUnknownAs ?? 0,
        surfaceConflicts: contract.uncertainty?.surfaceConflicts ?? true,
      },
    },
    alternatives: array(input.alternatives),
    criteria: array(input.criteria),
    constraints: array(input.constraints),
    stakeholders: array(input.stakeholders),
    documents: array(input.documents),
    fragments: array(input.fragments),
    claims: array(input.claims),
    rules: array(input.rules),
    scenarios: array(input.scenarios),
    decisions: array(input.decisions),
    approvals: array(input.approvals),
    conflicts: array(input.conflicts),
    audit: array(input.audit),
  };
  return deepFreeze(decisionCase);
}

export function getDecisionPayload(decisionCase) {
  return {
    schemaVersion: decisionCase.schemaVersion,
    id: decisionCase.id,
    title: decisionCase.title,
    subtitle: decisionCase.subtitle,
    domain: decisionCase.domain,
    locale: decisionCase.locale,
    currency: decisionCase.currency,
    status: decisionCase.status,
    owner: decisionCase.owner,
    contract: decisionCase.contract,
    alternatives: decisionCase.alternatives,
    criteria: decisionCase.criteria,
    constraints: decisionCase.constraints,
    stakeholders: decisionCase.stakeholders,
    documents: decisionCase.documents,
    fragments: decisionCase.fragments,
    claims: decisionCase.claims,
    rules: decisionCase.rules,
    decisions: decisionCase.decisions,
    approvals: decisionCase.approvals,
    conflicts: decisionCase.conflicts,
  };
}

export function getDecisionHash(decisionCase) {
  return canonicalHash(getDecisionPayload(decisionCase));
}

export function thawDecisionCase(decisionCase) {
  return cloneValue(decisionCase);
}

export function withCaseRevision(decisionCase, patch, auditEvent) {
  const next = thawDecisionCase(decisionCase);
  Object.assign(next, patch);
  next.revision = decisionCase.revision + 1;
  next.updatedAt = auditEvent?.at ?? new Date().toISOString();
  if (auditEvent) next.audit = [...decisionCase.audit, auditEvent];
  return createDecisionCase(next);
}
