import { cloneValue } from "./canonicalize.js";
import { ERROR_CODES, SituationRoomError } from "./errors.js";
import { evaluateWithDomainPack } from "./evaluate.js";
import { assertValidDecisionCase } from "./validation.js";

const SUPPORTED_COMMANDS = new Set([
  "replace_contract",
  "replace_model",
  "add_alternative",
  "add_criterion",
  "set_constraint",
  "add_claims_batch",
  "link_evidence",
  "flag_conflict",
  "resolve_claim",
  "create_scenario",
  "merge_scenario",
  "accept_import",
  "approve_decision",
]);
const ALWAYS_HUMAN_ONLY = new Set(["replace_contract", "replace_model", "resolve_claim", "merge_scenario", "approve_decision"]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, `${label} must be an object.`);
  }
  return value;
}

function addUnique(collection, entry, label) {
  if (collection.some((current) => current.id === entry.id)) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, `${label} ID '${entry.id}' already exists.`);
  }
  collection.push(cloneValue(entry));
}

function includeId(collection, id) {
  if (!collection.includes(id)) collection.push(id);
}

export function assertCommandAuthorized(decisionCase, command, actor, domainPack) {
  if (!SUPPORTED_COMMANDS.has(command?.type)) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      `Unsupported decision command '${String(command?.type)}'.`,
    );
  }
  if (!actor || !["human", "agent", "system"].includes(actor.type) || typeof actor.id !== "string") {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "A typed command actor is required.");
  }
  if (decisionCase.status === "approved") {
    throw new SituationRoomError(
      ERROR_CODES.CASE_FROZEN,
      "Approved cases are immutable; fork a new case before making changes.",
    );
  }
  const humanOnly = new Set([
    ...ALWAYS_HUMAN_ONLY,
    ...(decisionCase.contract.authority.humanOnlyActions ?? []),
  ]);
  if (humanOnly.has(command.type) && actor.type !== "human") {
    throw new SituationRoomError(
      ERROR_CODES.POLICY_DENIED,
      `Command '${command.type}' requires a human actor.`,
      { commandType: command.type },
    );
  }
  const policy = domainPack?.canExecute?.({ decisionCase, command, actor }) ?? { allowed: true };
  if (!policy.allowed) {
    throw new SituationRoomError(
      ERROR_CODES.POLICY_DENIED,
      policy.reason ?? "The active domain policy denied this command.",
      { commandType: command.type, domainPackId: decisionCase.domain.packId },
    );
  }
}

function applyReplaceContract(next, payload) {
  requireObject(payload.contract, "contract");
  next.contract = cloneValue(payload.contract);
  return [next.contract.id];
}

function applyReplaceModel(next, payload) {
  const model = requireObject(payload.model, "model");
  for (const field of ["alternatives", "criteria", "constraints", "claims"]) {
    if (!Array.isArray(model[field])) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, `model.${field} must be an array.`);
    }
  }
  if (model.alternatives.length < 1 || model.criteria.length < 1) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "A decision model needs at least one alternative and one criterion.");
  }
  if (model.alternatives.length > 200 || model.criteria.length > 200 || model.constraints.length > 500 || model.claims.length > 2_000) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "The replacement model exceeds the bounded editor limits.");
  }
  next.alternatives = cloneValue(model.alternatives);
  next.criteria = cloneValue(model.criteria);
  next.constraints = cloneValue(model.constraints);
  next.claims = cloneValue(model.claims);
  next.contract.version += 1;
  next.contract.status = "draft";
  next.contract.alternativeIds = next.alternatives.map((entry) => entry.id);
  next.contract.criterionIds = next.criteria.map((entry) => entry.id);
  next.contract.constraintIds = next.constraints.map((entry) => entry.id);
  const alternativeIds = new Set(next.contract.alternativeIds);
  const criterionIds = new Set(next.contract.criterionIds);
  const claimIds = new Set(next.claims.map((entry) => entry.id));
  next.scenarios = next.scenarios.map((scenario) => ({
    ...scenario,
    claimOverrides: Object.fromEntries(
      Object.entries(scenario.claimOverrides ?? {}).filter(([claimId]) => claimIds.has(claimId)),
    ),
    ...(Array.isArray(scenario.additionalClaims)
      ? {
          additionalClaims: scenario.additionalClaims.filter(
            (claim) => alternativeIds.has(claim.subjectId) && criterionIds.has(claim.criterionId),
          ),
        }
      : {}),
  }));
  next.conflicts = next.conflicts
    .map((conflict) => ({ ...conflict, claimIds: conflict.claimIds?.filter((claimId) => claimIds.has(claimId)) ?? [] }))
    .filter((conflict) => conflict.claimIds.length > 0);
  return [
    next.contract.id,
    ...next.contract.alternativeIds,
    ...next.contract.criterionIds,
    ...next.contract.constraintIds,
    ...next.claims.map((entry) => entry.id),
  ];
}

function applyAddAlternative(next, payload) {
  const alternative = requireObject(payload.alternative, "alternative");
  addUnique(next.alternatives, alternative, "Alternative");
  if (payload.includeInContract !== false) includeId(next.contract.alternativeIds, alternative.id);
  return [alternative.id];
}

function applyAddCriterion(next, payload) {
  const criterion = requireObject(payload.criterion, "criterion");
  addUnique(next.criteria, criterion, "Criterion");
  if (payload.includeInContract !== false) includeId(next.contract.criterionIds, criterion.id);
  return [criterion.id];
}

function applySetConstraint(next, payload) {
  const constraint = requireObject(payload.constraint, "constraint");
  const index = next.constraints.findIndex((entry) => entry.id === constraint.id);
  if (index >= 0) next.constraints[index] = cloneValue(constraint);
  else next.constraints.push(cloneValue(constraint));
  if (payload.includeInContract !== false) includeId(next.contract.constraintIds, constraint.id);
  return [constraint.id];
}

function applyAddClaims(next, payload) {
  if (!Array.isArray(payload.claims) || payload.claims.length < 1 || payload.claims.length > 500) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      "add_claims_batch requires between 1 and 500 claims.",
    );
  }
  for (const claim of payload.claims) addUnique(next.claims, claim, "Claim");
  return payload.claims.map((claim) => claim.id);
}

function applyLinkEvidence(next, payload) {
  const claim = next.claims.find((entry) => entry.id === payload.claimId);
  if (!claim) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Claim '${payload.claimId}' was not found.`);
  requireObject(payload.sourceRef, "sourceRef");
  const key = `${payload.sourceRef.documentId}:${payload.sourceRef.fragmentId}`;
  const sourceRefs = claim.sourceRefs ?? [];
  if (!sourceRefs.some((entry) => `${entry.documentId}:${entry.fragmentId}` === key)) {
    sourceRefs.push(cloneValue(payload.sourceRef));
  }
  claim.sourceRefs = sourceRefs;
  return [claim.id, payload.sourceRef.fragmentId];
}

function applyFlagConflict(next, payload) {
  if (!Array.isArray(payload.claimIds) || payload.claimIds.length < 1) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "At least one claim must be flagged.");
  }
  for (const claimId of payload.claimIds) {
    const claim = next.claims.find((entry) => entry.id === claimId);
    if (!claim) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Claim '${claimId}' was not found.`);
    claim.status = "disputed";
  }
  const conflict = {
    id: payload.conflictId,
    claimIds: [...payload.claimIds],
    reason: String(payload.reason ?? "Conflicting interpretation requires review."),
    status: "open",
  };
  addUnique(next.conflicts, conflict, "Conflict");
  return [conflict.id, ...payload.claimIds];
}

function applyResolveClaim(next, payload) {
  const claim = next.claims.find((entry) => entry.id === payload.claimId);
  if (!claim) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Claim '${payload.claimId}' was not found.`);
  if (!["accepted", "rejected"].includes(payload.status)) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Resolved claims must be accepted or rejected.");
  }
  claim.status = payload.status;
  claim.authoritative = payload.status === "accepted" ? payload.authoritative ?? true : false;
  for (const conflict of next.conflicts) {
    if (conflict.claimIds?.includes(claim.id)) conflict.status = "resolved";
  }
  return [claim.id];
}

function applyCreateScenario(next, payload) {
  const scenario = requireObject(payload.scenario, "scenario");
  if (scenario.mergedAt !== undefined || scenario.mergedClaimIds !== undefined) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      "Scenario merge metadata is system-controlled and cannot be supplied at creation.",
    );
  }
  addUnique(next.scenarios, scenario, "Scenario");
  assertValidDecisionCase(next);
  return [scenario.id];
}

function applyMergeScenario(next, payload) {
  const scenario = next.scenarios.find((entry) => entry.id === payload.scenarioId);
  if (!scenario) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Scenario '${payload.scenarioId}' was not found.`);
  const overrides = new Map(Object.entries(scenario.claimOverrides ?? {}));
  const additionalClaims = scenario.additionalClaims ?? [];
  next.claims = next.claims.map((claim) =>
    overrides.has(claim.id) ? { ...claim, value: cloneValue(overrides.get(claim.id)) } : claim,
  );
  for (const claim of additionalClaims) addUnique(next.claims, claim, "Claim");
  scenario.mergedClaimIds = additionalClaims.map((claim) => claim.id);
  scenario.additionalClaims = [];
  scenario.mergedAt = payload.mergedAt;
  return [scenario.id, ...overrides.keys(), ...scenario.mergedClaimIds];
}

function applyAcceptImport(next, payload) {
  const changed = [];
  for (const document of payload.documents ?? []) {
    if (!next.documents.some((entry) => entry.id === document.id)) {
      next.documents.push(cloneValue(document));
      changed.push(document.id);
    }
  }
  for (const fragment of payload.fragments ?? []) {
    if (!next.fragments.some((entry) => entry.id === fragment.id)) {
      next.fragments.push(cloneValue(fragment));
      changed.push(fragment.id);
    }
  }
  for (const claim of payload.claims ?? []) {
    addUnique(next.claims, claim, "Claim");
    changed.push(claim.id);
  }
  if (!changed.length) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "The accepted import contains no new entities.");
  }
  return changed;
}

function applyApproval(next, payload, context) {
  if (next.contract.status !== "active") {
    throw new SituationRoomError(
      ERROR_CODES.POLICY_DENIED,
      "A draft decision contract must be explicitly activated before approval.",
    );
  }
  if (payload.expectedDecisionHash !== context.decisionHashBefore) {
    throw new SituationRoomError(
      ERROR_CODES.STALE_REVISION,
      "The approval digest no longer matches the current decision.",
    );
  }
  const evaluation = evaluateWithDomainPack(next, context.domainPack);
  const result = evaluation.results.find((entry) => entry.alternativeId === payload.alternativeId);
  if (!result?.eligible) {
    throw new SituationRoomError(
      ERROR_CODES.POLICY_DENIED,
      "Only an alternative that passes every mandatory gate can be approved.",
    );
  }
  if (next.claims.some((claim) => claim.subjectId === payload.alternativeId && claim.status === "disputed")) {
    throw new SituationRoomError(
      ERROR_CODES.POLICY_DENIED,
      "Approval is blocked while evidence for the selected alternative is disputed.",
    );
  }
  const approval = {
    id: payload.approvalId,
    alternativeId: payload.alternativeId,
    decisionDigest: context.decisionHashBefore,
    approvedBy: context.actor,
    approvedAt: context.at,
    status: "approved",
  };
  addUnique(next.approvals, approval, "Approval");
  next.status = "approved";
  return [approval.id, payload.alternativeId];
}

export function applyDecisionCommand(decisionCase, command, context) {
  const payload = command.payload ?? {};
  const next = cloneValue(decisionCase);
  let changedEntityIds;
  switch (command.type) {
    case "replace_contract":
      changedEntityIds = applyReplaceContract(next, payload);
      break;
    case "replace_model":
      changedEntityIds = applyReplaceModel(next, payload);
      break;
    case "add_alternative":
      changedEntityIds = applyAddAlternative(next, payload);
      break;
    case "add_criterion":
      changedEntityIds = applyAddCriterion(next, payload);
      break;
    case "set_constraint":
      changedEntityIds = applySetConstraint(next, payload);
      break;
    case "add_claims_batch":
      changedEntityIds = applyAddClaims(next, payload);
      break;
    case "link_evidence":
      changedEntityIds = applyLinkEvidence(next, payload);
      break;
    case "flag_conflict":
      changedEntityIds = applyFlagConflict(next, payload);
      break;
    case "resolve_claim":
      changedEntityIds = applyResolveClaim(next, payload);
      break;
    case "create_scenario":
      changedEntityIds = applyCreateScenario(next, payload);
      break;
    case "merge_scenario":
      changedEntityIds = applyMergeScenario(next, { ...payload, mergedAt: context.at });
      break;
    case "accept_import":
      changedEntityIds = applyAcceptImport(next, payload);
      break;
    case "approve_decision":
      changedEntityIds = applyApproval(next, payload, context);
      break;
    default:
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Unsupported command.");
  }
  return { next, changedEntityIds };
}
