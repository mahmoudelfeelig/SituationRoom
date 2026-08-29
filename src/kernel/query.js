import { ERROR_CODES, SituationRoomError } from "./errors.js";

function boundedLimit(value) {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      "Query limit must be an integer between 1 and 500.",
    );
  }
  return value;
}

export function queryDecisionGraph(decisionCase, evaluation, query = {}) {
  const limit = boundedLimit(query.limit);
  const alternativeIds = new Set(query.alternativeIds ?? []);
  const criterionIds = new Set(query.criterionIds ?? []);
  const statuses = new Set(query.statuses ?? []);
  const paths = evaluation.paths.filter(
    (path) =>
      (!alternativeIds.size || alternativeIds.has(path.alternativeId)) &&
      (!criterionIds.size || criterionIds.has(path.criterionId)) &&
      (!statuses.size || statuses.has(path.status)),
  );
  const selected = paths.slice(0, limit);
  const selectedAlternativeIds = new Set(selected.map((path) => path.alternativeId));
  const selectedCriterionIds = new Set(selected.map((path) => path.criterionId));
  const selectedClaimIds = new Set(selected.flatMap((path) => path.claimIds));
  const selectedFragmentIds = new Set(
    selected.flatMap((path) => path.sourceRefs.map((reference) => reference.fragmentId)),
  );
  return {
    caseId: decisionCase.id,
    revision: decisionCase.revision,
    truncated: paths.length > selected.length,
    totalPathCount: paths.length,
    alternatives: decisionCase.alternatives.filter((entry) => selectedAlternativeIds.has(entry.id)),
    criteria: decisionCase.criteria.filter((entry) => selectedCriterionIds.has(entry.id)),
    claims: decisionCase.claims.filter((entry) => selectedClaimIds.has(entry.id)),
    fragments: decisionCase.fragments.filter((entry) => selectedFragmentIds.has(entry.id)),
    paths: selected,
  };
}
