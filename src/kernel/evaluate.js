import { stableStringify, cloneValue } from "./canonicalize.js";
import { evaluateConstraint } from "./ruleEngine.js";
import { assertValidDecisionCase } from "./validation.js";

function resolveMeasurement(decisionCase, alternativeId, criterionId) {
  const relevant = decisionCase.claims.filter(
    (claim) =>
      claim.subjectId === alternativeId &&
      claim.criterionId === criterionId &&
      claim.status !== "rejected",
  );
  const accepted = relevant.filter((claim) => claim.status === "accepted");
  const disputed = relevant.filter((claim) => claim.status === "disputed");
  if (!accepted.length) {
    return {
      status: disputed.length ? "conflict" : "unknown",
      value: null,
      claimIds: relevant.map((claim) => claim.id),
      sourceRefs: relevant.flatMap((claim) => claim.sourceRefs ?? []),
    };
  }
  const authoritative = accepted.filter((claim) => claim.authoritative === true);
  const candidates = authoritative.length ? authoritative : accepted;
  const values = new Map();
  for (const claim of candidates) {
    const key = stableStringify(claim.value);
    if (!values.has(key)) values.set(key, claim.value);
  }
  if (values.size !== 1 || disputed.length) {
    return {
      status: "conflict",
      value: authoritative.length === 1 ? authoritative[0].value : null,
      claimIds: relevant.map((claim) => claim.id),
      sourceRefs: relevant.flatMap((claim) => claim.sourceRefs ?? []),
    };
  }
  return {
    status: "known",
    value: values.values().next().value,
    claimIds: candidates.map((claim) => claim.id),
    sourceRefs: candidates.flatMap((claim) => claim.sourceRefs ?? []),
  };
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedScore(criterion, measurement) {
  if (measurement.status !== "known") return null;
  const value = measurement.value;
  const scoring = criterion.scoring ?? {};
  if (scoring.kind === "linear") {
    if (!Number.isFinite(value)) return null;
    const span = scoring.max - scoring.min;
    if (!(span > 0)) return null;
    const ascending = (value - scoring.min) / span;
    return clamp(scoring.direction === "minimize" ? 1 - ascending : ascending);
  }
  if (scoring.kind === "lookup") {
    const mapped = scoring.values?.[String(value)];
    return Number.isFinite(mapped) ? clamp(mapped) : null;
  }
  if (scoring.kind === "boolean" || criterion.valueType === "boolean") {
    return Object.is(value, scoring.preferred ?? true) ? 1 : 0;
  }
  return null;
}

function statusForCriterion(measurement, constraintResults) {
  const mandatory = constraintResults.filter((entry) => entry.constraint.severity === "mandatory");
  if (mandatory.some((entry) => entry.status === "fail")) return "fail";
  if (measurement.status === "conflict") return "conflict";
  if (mandatory.some((entry) => entry.status === "unknown") || measurement.status === "unknown") {
    return "unknown";
  }
  return "pass";
}

export function evaluateDecisionCase(decisionCase) {
  assertValidDecisionCase(decisionCase);
  const criteriaById = new Map(decisionCase.criteria.map((criterion) => [criterion.id, criterion]));
  const activeAlternatives = decisionCase.alternatives.filter((alternative) =>
    decisionCase.contract.alternativeIds.includes(alternative.id),
  );
  const activeCriteria = decisionCase.criteria.filter((criterion) =>
    decisionCase.contract.criterionIds.includes(criterion.id),
  );
  const activeConstraints = decisionCase.constraints.filter((constraint) =>
    decisionCase.contract.constraintIds.includes(constraint.id),
  );
  const results = activeAlternatives.map((alternative) => {
    const criterionResults = activeCriteria.map((criterion) => {
      const measurement = resolveMeasurement(decisionCase, alternative.id, criterion.id);
      const constraintResults = activeConstraints
        .filter(
          (constraint) =>
            constraint.criterionId === criterion.id &&
            (!constraint.alternativeIds?.length || constraint.alternativeIds.includes(alternative.id)),
        )
        .map((constraint) => ({
          constraint,
          ...evaluateConstraint(measurement.status === "known" ? measurement.value : null, constraint),
        }));
      const status = statusForCriterion(measurement, constraintResults);
      const normalized = criterion.kind === "score" ? normalizedScore(criterion, measurement) : null;
      return {
        criterionId: criterion.id,
        criterion,
        measurement,
        constraints: constraintResults,
        status,
        normalizedScore: normalized,
        weightedScore: normalized === null ? null : normalized * (criterion.weight ?? 0),
      };
    });
    const mandatoryResults = criterionResults.filter((entry) =>
      entry.constraints.some((constraint) => constraint.constraint.severity === "mandatory"),
    );
    const blockers = mandatoryResults.filter((entry) => {
      if (entry.status === "fail") return true;
      if (entry.status === "conflict") return decisionCase.contract.evidencePolicy.conflictPolicy === "block";
      if (entry.status === "unknown") return decisionCase.contract.evidencePolicy.hardUnknownPolicy === "block";
      return false;
    });
    const scoringCriteria = criterionResults.filter((entry) => entry.criterion.kind === "score");
    const totalWeight = scoringCriteria.reduce((sum, entry) => sum + (entry.criterion.weight ?? 0), 0);
    const fallback = decisionCase.contract.uncertainty.scoreUnknownAs;
    const earned = scoringCriteria.reduce(
      (sum, entry) => sum + (entry.weightedScore ?? fallback * (entry.criterion.weight ?? 0)),
      0,
    );
    return {
      alternativeId: alternative.id,
      alternative,
      criteria: criterionResults,
      blockers,
      eligible: blockers.length === 0,
      score: totalWeight > 0 ? Math.round((earned / totalWeight) * 10000) / 100 : null,
    };
  });

  let ranking = null;
  let recommendation = null;
  if (decisionCase.contract.authority.allowAutomatedRanking) {
    ranking = [...results].sort((left, right) => {
      if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
      if (left.score !== right.score) return (right.score ?? -Infinity) - (left.score ?? -Infinity);
      return left.alternative.label.localeCompare(right.alternative.label, decisionCase.locale);
    });
    recommendation = ranking.find((entry) => entry.eligible) ?? ranking[0] ?? null;
  }

  const paths = results.flatMap((result) =>
    result.criteria.map((criterionResult) => ({
      id: `${result.alternativeId}:${criterionResult.criterionId}:path`,
      alternativeId: result.alternativeId,
      criterionId: criterionResult.criterionId,
      claimIds: criterionResult.measurement.claimIds,
      sourceRefs: criterionResult.measurement.sourceRefs,
      constraintIds: criterionResult.constraints.map((entry) => entry.constraint.id),
      status: criterionResult.status,
      outcome: criterionResult.status === "pass" ? "verified" : "requires_attention",
    })),
  );

  return {
    caseId: decisionCase.id,
    revision: decisionCase.revision,
    results,
    ranking,
    recommendation,
    paths,
    unresolvedCount: paths.filter((path) => ["unknown", "conflict"].includes(path.status)).length,
    blockerCount: results.reduce((sum, result) => sum + result.blockers.length, 0),
    criterionIndex: Object.fromEntries(criteriaById),
  };
}

export function evaluateWithDomainPack(decisionCase, domainPack) {
  if (typeof domainPack?.evaluate === "function") {
    return domainPack.evaluate(decisionCase, evaluateDecisionCase);
  }
  return evaluateDecisionCase(decisionCase);
}

export function evaluateScenario(decisionCase, scenarioId, domainPack) {
  const scenario = decisionCase.scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario) return null;
  const staged = cloneValue(decisionCase);
  const stagedScenario = staged.scenarios.find((entry) => entry.id === scenarioId);
  const overrides = new Map(Object.entries(stagedScenario.claimOverrides ?? {}));
  staged.claims = staged.claims.map((claim) =>
    overrides.has(claim.id) ? { ...claim, value: cloneValue(overrides.get(claim.id)) } : claim,
  );
  staged.claims.push(...cloneValue(stagedScenario.additionalClaims ?? []));
  staged.scenarios = staged.scenarios.filter((entry) => entry.id !== scenarioId);
  return {
    scenario,
    baseRevision: decisionCase.revision,
    originalDecisionUnchanged: true,
    evaluation: evaluateWithDomainPack(staged, domainPack),
  };
}
