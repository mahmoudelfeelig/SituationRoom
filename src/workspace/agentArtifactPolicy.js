import {
  CANDIDATE_REVIEW_PACK_ID,
  HEALTH_PLAN_PACK_ID,
  containsCandidateProtectedText,
  containsHealthPlanProhibitedPurpose,
  isOpaqueCandidateIdentifier,
} from "../domain-packs/index.js";

const CANDIDATE_OUTCOME_PATTERN = /\b(?:hir(?:e|ed|ing)|reject(?:ed|ing|ion)?|shortlis(?:t|ted|ting)|screen(?:ed|ing)?[ -]?out|rank(?:ed|ing)?|recommend(?:ed|ing|ation)?|select(?:ed|ing|ion)?|offer(?:ed|ing)?|terminat(?:e|ed|ing|ion)|advanc(?:e|ed|ing)|eligible|ineligible)\b/i;

const COLLECTION_BY_KIND = Object.freeze({
  alternative: "alternatives",
  criterion: "criteria",
  constraint: "constraints",
  stakeholder: "stakeholders",
  document: "documents",
  fragment: "fragments",
  claim: "claims",
  rule: "rules",
  scenario: "scenarios",
  decision: "decisions",
  approval: "approvals",
});

function hasId(entries, id) {
  return Array.isArray(entries) && entries.some((entry) => entry?.id === id);
}

function canonicalReferenceExists(decisionCase, evaluation, presentation, reference) {
  if (!reference || typeof reference.kind !== "string" || typeof reference.id !== "string") return false;
  if (reference.kind === "case") return decisionCase?.id === reference.id;
  if (["source", "evidence"].includes(reference.kind)) {
    return hasId(decisionCase?.fragments, reference.id) || hasId(decisionCase?.documents, reference.id);
  }
  if (reference.kind === "path") return hasId(evaluation?.paths, reference.id);
  if (reference.kind === "result") return hasId(evaluation?.results, reference.id);
  if (reference.kind === "instrument") return hasId(presentation?.instruments, reference.id);
  const collection = COLLECTION_BY_KIND[reference.kind];
  return collection ? hasId(decisionCase?.[collection], reference.id) : false;
}

function normalizedReferences(entityRefs) {
  return (Array.isArray(entityRefs) ? entityRefs : [])
    .filter((reference) => reference && typeof reference.kind === "string" && typeof reference.id === "string")
    .map((reference) => ({ kind: reference.kind, id: reference.id }));
}

export function assessAgentArtifact({
  decisionCase,
  evaluation,
  presentation,
  texts = [],
  entityRefs = [],
} = {}) {
  if (!decisionCase) {
    return { ok: false, code: "NOT_FOUND", message: "The active decision case is unavailable." };
  }
  const references = normalizedReferences(entityRefs);
  if (references.length !== (Array.isArray(entityRefs) ? entityRefs.length : 0)) {
    return { ok: false, code: "VALIDATION_FAILED", message: "Every cited entity must have a canonical kind and ID." };
  }
  const missingReference = references.find((reference) =>
    !canonicalReferenceExists(decisionCase, evaluation, presentation, reference),
  );
  if (missingReference) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `The cited ${missingReference.kind} '${missingReference.id}' is not part of this decision revision.`,
    };
  }

  const content = (Array.isArray(texts) ? texts : [texts]).filter((value) => typeof value === "string");
  if (decisionCase.domain?.packId === CANDIDATE_REVIEW_PACK_ID) {
    if (content.some(containsCandidateProtectedText)) {
      return {
        ok: false,
        code: "POLICY_DENIED",
        message: "Candidate-review artifacts cannot contain protected-trait language.",
      };
    }
    if (content.some((value) => CANDIDATE_OUTCOME_PATTERN.test(value))) {
      return {
        ok: false,
        code: "POLICY_DENIED",
        message: "Candidate-review artifacts may request job-related evidence clarification, but cannot stage hiring, rejection, ranking, shortlist, or eligibility outcomes.",
      };
    }
    const exposedCandidate = references
      .filter((reference) => reference.kind === "alternative")
      .map((reference) => decisionCase.alternatives.find((alternative) => alternative.id === reference.id))
      .find((alternative) =>
        !isOpaqueCandidateIdentifier(alternative?.id) || !isOpaqueCandidateIdentifier(alternative?.label),
      );
    if (exposedCandidate) {
      return {
        ok: false,
        code: "POLICY_DENIED",
        message: "Candidate citations must use opaque candidate or application identifiers.",
      };
    }
  }

  if (
    decisionCase.domain?.packId === HEALTH_PLAN_PACK_ID &&
    content.some(containsHealthPlanProhibitedPurpose)
  ) {
    return {
      ok: false,
      code: "POLICY_DENIED",
      message: "Health-plan artifacts may compare declared coverage and costs, but cannot diagnose, select treatment, underwrite, price a person, or adjudicate claims or benefits.",
    };
  }

  return { ok: true, entityRefs: references };
}
