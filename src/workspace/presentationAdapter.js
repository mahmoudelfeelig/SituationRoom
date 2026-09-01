import { getDecisionHash } from "../kernel/index.js";

function formatValue(value, criterion, decisionCase) {
  if (value === null || value === undefined) return "Unknown";
  if (criterion?.valueType === "currency" || criterion?.unit === "currency") {
    const amount = typeof value === "object" ? value.amount : value;
    const currency = typeof value === "object" ? value.currency : decisionCase.currency;
    if (Number.isFinite(amount) && currency) {
      return new Intl.NumberFormat(decisionCase.locale || "en", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount);
    }
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    const suffix = criterion?.unit && criterion.unit !== "currency" ? ` ${criterion.unit}` : "";
    return `${new Intl.NumberFormat(decisionCase.locale || "en").format(value)}${suffix}`;
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function sourceLocator(fragment) {
  const locator = fragment.locator ?? fragment.nativeLocator ?? {};
  if (typeof locator === "string") return locator;
  if (locator.page) return `Page ${locator.page}`;
  if (locator.sheet && locator.range) return `${locator.sheet}!${locator.range}`;
  if (locator.slide) return `Slide ${locator.slide}`;
  if (locator.paragraph) return `Paragraph ${locator.paragraph}`;
  if (locator.line) return `Line ${locator.line}`;
  if (locator.region) return locator.region;
  return "Source location retained";
}

function statusForAlternative(result) {
  if (!result) return "unknown";
  if (result.eligible) return "eligible";
  return result.blockers?.length ? "blocked" : "review";
}

function presentationDomainKind(packId) {
  if (packId === "candidate-review") return "candidate";
  return packId || "generic";
}

function scenarioEvaluationSummary(decisionCase, evaluation, scenarioResult) {
  const stagedEvaluation = scenarioResult?.evaluation;
  if (!stagedEvaluation) return null;

  const scenario = scenarioResult.scenario
    ?? decisionCase.scenarios.find((entry) => entry.id === scenarioResult.scenarioId)
    ?? null;
  const alternativeById = new Map(decisionCase.alternatives.map((entry) => [entry.id, entry]));
  const criterionById = new Map(decisionCase.criteria.map((entry) => [entry.id, entry]));
  const claimById = new Map(decisionCase.claims.map((entry) => [entry.id, entry]));
  const baseResultByAlternative = new Map((evaluation?.results ?? []).map((entry) => [entry.alternativeId, entry]));
  const stagedResultByAlternative = new Map((stagedEvaluation.results ?? []).map((entry) => [entry.alternativeId, entry]));

  const changes = Object.entries(scenario?.claimOverrides ?? {}).flatMap(([claimId, requestedValue]) => {
    const claim = claimById.get(claimId);
    if (!claim) return [];
    const baseResult = baseResultByAlternative.get(claim.subjectId);
    const stagedResult = stagedResultByAlternative.get(claim.subjectId);
    const baseCriterion = baseResult?.criteria?.find((entry) => entry.criterionId === claim.criterionId);
    const stagedCriterion = stagedResult?.criteria?.find((entry) => entry.criterionId === claim.criterionId);
    const criterion = stagedCriterion?.criterion ?? baseCriterion?.criterion ?? criterionById.get(claim.criterionId);
    const alternative = stagedResult?.alternative ?? baseResult?.alternative ?? alternativeById.get(claim.subjectId);
    const baselineValue = baseCriterion?.measurement?.value ?? claim.value;
    const scenarioValue = stagedCriterion?.measurement?.value ?? requestedValue;
    const stagedConstraint = stagedCriterion?.constraints?.find((entry) => entry.constraint?.severity === "mandatory" && entry.status === "fail")
      ?? stagedCriterion?.constraints?.find((entry) => entry.constraint?.severity === "mandatory")
      ?? null;
    const baseConstraint = stagedConstraint
      ? baseCriterion?.constraints?.find((entry) => entry.constraint?.id === stagedConstraint.constraint?.id) ?? null
      : null;
    return [{
      claimId,
      alternativeId: claim.subjectId,
      alternativeLabel: alternative?.label ?? claim.subjectId,
      criterionId: claim.criterionId,
      criterionLabel: criterion?.label ?? claim.criterionId,
      baselineValue,
      baselineFormattedValue: formatValue(baselineValue, criterion, decisionCase),
      scenarioValue,
      scenarioFormattedValue: formatValue(scenarioValue, criterion, decisionCase),
      baselineStatus: baseCriterion?.status ?? "unknown",
      scenarioStatus: stagedCriterion?.status ?? "unknown",
      constraint: stagedConstraint
        ? {
            id: stagedConstraint.constraint?.id ?? null,
            label: stagedConstraint.constraint?.label ?? criterion?.label ?? claim.criterionId,
            operator: stagedConstraint.constraint?.operator ?? null,
            expected: stagedConstraint.expected,
            expectedFormattedValue: formatValue(stagedConstraint.expected, criterion, decisionCase),
            actual: stagedConstraint.actual,
            actualFormattedValue: formatValue(stagedConstraint.actual, criterion, decisionCase),
            severity: stagedConstraint.constraint?.severity ?? null,
            baselineStatus: baseConstraint?.status ?? baseCriterion?.status ?? "unknown",
            scenarioStatus: stagedConstraint.status ?? stagedCriterion?.status ?? "unknown",
          }
        : null,
    }];
  });

  const eligibleAlternativeCount = (stagedEvaluation.results ?? []).filter((entry) => entry.eligible).length;
  const baseBlockerCount = evaluation?.blockerCount ?? 0;
  const blockerCount = stagedEvaluation.blockerCount ?? 0;
  return {
    scenarioId: scenario?.id ?? null,
    scenarioLabel: scenario?.label ?? "Active scenario",
    scenarioDescription: scenario?.description ?? "A hypothetical branch evaluated against the declared decision contract.",
    outcomeLabel: eligibleAlternativeCount === 0
      ? "No eligible alternative"
      : `${eligibleAlternativeCount} eligible ${eligibleAlternativeCount === 1 ? "alternative" : "alternatives"}`,
    eligibleAlternativeCount,
    recommendation: stagedEvaluation.recommendation
      ? {
          alternativeId: stagedEvaluation.recommendation.alternativeId,
          label: stagedEvaluation.recommendation.alternative.label,
          score: stagedEvaluation.recommendation.score,
          eligible: stagedEvaluation.recommendation.eligible,
        }
      : null,
    baseBlockerCount,
    blockerCount,
    blockerDelta: blockerCount - baseBlockerCount,
    unresolvedCount: stagedEvaluation.unresolvedCount,
    changes,
    originalDecisionUnchanged: scenarioResult.originalDecisionUnchanged === true,
  };
}

export function toPresentationSnapshot(decisionCase, evaluation, presentation = {}) {
  if (!decisionCase) return null;
  const candidateReview = decisionCase.domain.packId === "candidate-review";
  const resultByAlternative = new Map(
    (evaluation?.results ?? []).map((result) => [result.alternativeId, result]),
  );
  const criterionById = new Map(decisionCase.criteria.map((criterion) => [criterion.id, criterion]));
  const documentById = new Map(decisionCase.documents.map((document) => [document.id, document]));

  const entities = [
    ...decisionCase.alternatives.map((alternative) => {
      const result = resultByAlternative.get(alternative.id);
      return {
        id: alternative.id,
        kind: "alternative",
        label: alternative.label,
        summary: alternative.summary ?? alternative.description ?? "Decision alternative",
        status: candidateReview ? "review" : statusForAlternative(result),
        attributes: candidateReview
          ? {
              ...alternative.attributes,
              requirementCount: result?.criteria?.length ?? 0,
              unresolvedRequirementCount: result?.criteria?.filter((entry) => ["unknown", "conflict"].includes(entry.status)).length ?? 0,
            }
          : {
              ...alternative.attributes,
              score: result?.score ?? null,
              eligible: result?.eligible ?? null,
              blockerCount: result?.blockers?.length ?? 0,
            },
      };
    }),
    ...decisionCase.criteria.map((criterion) => ({
      id: criterion.id,
      kind: "criterion",
      label: criterion.label,
      summary: criterion.description ?? criterion.question ?? "Evaluation criterion",
      status: criterion.kind === "gate" ? "mandatory" : criterion.kind,
      attributes: {
        kind: criterion.kind,
        valueType: criterion.valueType,
        weight: criterion.weight ?? null,
        unit: criterion.unit ?? null,
      },
    })),
    ...decisionCase.constraints.map((constraint) => ({
      id: constraint.id,
      kind: "constraint",
      label: constraint.label ?? criterionById.get(constraint.criterionId)?.label ?? constraint.id,
      summary: constraint.description ?? `${constraint.operator} ${String(constraint.expected)}`,
      status: constraint.severity,
      attributes: {
        criterionId: constraint.criterionId,
        operator: constraint.operator,
        expected: constraint.expected,
        severity: constraint.severity,
      },
    })),
    ...decisionCase.stakeholders.map((stakeholder) => ({
      id: stakeholder.id,
      kind: "stakeholder",
      label: stakeholder.label,
      summary: stakeholder.mandate ?? stakeholder.description ?? "Decision stakeholder",
      status: "represented",
      attributes: { ...stakeholder },
    })),
    ...decisionCase.scenarios.map((scenario) => ({
      id: scenario.id,
      kind: "control",
      label: scenario.label,
      summary: scenario.description ?? "Evaluate this hypothetical branch without changing the canonical record.",
      status: presentation.activeScenario === scenario.id ? "active" : "available",
      attributes: {
        control: "boolean",
        value: presentation.activeScenario === scenario.id,
        baseline: false,
        scenarioId: scenario.id,
        hypothetical: true,
      },
    })),
    ...decisionCase.claims.map((claim) => ({
      id: claim.id,
      kind: "claim",
      label: claim.label ?? criterionById.get(claim.criterionId)?.label ?? claim.id,
      summary: claim.summary ?? formatValue(claim.value, criterionById.get(claim.criterionId), decisionCase),
      status: claim.status,
      attributes: {
        subjectId: claim.subjectId,
        criterionId: claim.criterionId,
        value: claim.value,
        formattedValue: formatValue(claim.value, criterionById.get(claim.criterionId), decisionCase),
        confidence: claim.confidence ?? null,
        sourceRefs: claim.sourceRefs ?? [],
        sourceId: claim.sourceRefs?.[0]?.fragmentId ?? null,
        citation: claim.sourceRefs?.[0]?.fragmentId ?? "No accepted citation",
      },
    })),
  ];

  const sources = decisionCase.fragments.map((fragment) => {
    const document = documentById.get(fragment.documentId);
    return {
      id: fragment.id,
      kind: "source",
      documentId: fragment.documentId,
      label: fragment.label ?? document?.title ?? document?.name ?? fragment.id,
      text: fragment.text,
      locator: sourceLocator(fragment),
      confidence: fragment.confidence ?? fragment.extractionConfidence ?? 1,
      status: fragment.status ?? "parsed",
      format: document?.format ?? document?.mimeType ?? "document",
      fingerprint: document?.fingerprint ?? document?.hash ?? null,
      untrusted: true,
      locations: [{
        label: sourceLocator(fragment),
        locator: fragment.locator ?? fragment.nativeLocator ?? sourceLocator(fragment),
      }],
      attributes: {
        confidence: fragment.confidence ?? fragment.extractionConfidence ?? 1,
        location: sourceLocator(fragment),
        citation: `${document?.title ?? document?.name ?? fragment.documentId} · ${sourceLocator(fragment)}`,
      },
    };
  });

  const results = (evaluation?.results ?? []).flatMap((alternativeResult) =>
    alternativeResult.criteria.map((entry) => ({
      id: `result:${alternativeResult.alternativeId}:${entry.criterionId}`,
      kind: "result",
      label: `${alternativeResult.alternative.label} · ${entry.criterion.label}`,
      summary: `${entry.status}: ${formatValue(entry.measurement.value, entry.criterion, decisionCase)}`,
      subjectId: alternativeResult.alternativeId,
      criterionId: entry.criterionId,
      status: entry.status,
      value: entry.measurement.value,
      unit: entry.criterion.unit ?? (entry.criterion.valueType === "currency" ? decisionCase.currency : null),
      formattedValue: formatValue(entry.measurement.value, entry.criterion, decisionCase),
      measurementStatus: entry.measurement.status,
      claimIds: entry.measurement.claimIds,
      sourceRefs: entry.measurement.sourceRefs,
      ...(!candidateReview ? {
        normalizedScore: entry.normalizedScore,
        weightedScore: entry.weightedScore,
        eligible: alternativeResult.eligible,
        overallScore: alternativeResult.score,
      } : {}),
      constraints: entry.constraints.map((constraint) => ({
        id: constraint.constraint.id,
        label: constraint.constraint.label ?? entry.criterion.label,
        status: constraint.status,
        expected: constraint.expected,
        actual: constraint.actual,
        severity: constraint.constraint.severity,
      })),
      attributes: {
        subjectId: alternativeResult.alternativeId,
        criterionId: entry.criterionId,
        measurementStatus: entry.measurement.status,
        claimIds: entry.measurement.claimIds,
        sourceRefs: entry.measurement.sourceRefs,
      },
    })),
  );

  const resultIdByPair = new Map(
    results.map((result) => [`${result.subjectId}:${result.criterionId}`, result.id]),
  );

  const relations = [
    ...decisionCase.claims.flatMap((claim) =>
      (claim.sourceRefs ?? []).map((reference, index) => ({
        id: `relation:${claim.id}:${reference.fragmentId}:${index}`,
        from: { kind: "source", id: reference.fragmentId },
        to: { kind: "claim", id: claim.id },
        type: reference.relationship ?? "supports",
      })),
    ),
    ...(evaluation?.paths ?? []).map((path) => ({
      id: `relation:${path.id}`,
      from: { kind: "alternative", id: path.alternativeId },
      to: { kind: "criterion", id: path.criterionId },
      type: path.status,
      pathId: path.id,
    })),
  ];

  const paths = (evaluation?.paths ?? []).map((path) => {
    const entityRefs = [
      ...(path.sourceRefs ?? []).map((reference) => ({ kind: "source", id: reference.fragmentId })),
      ...(path.claimIds ?? []).map((id) => ({ kind: "claim", id })),
      { kind: "criterion", id: path.criterionId },
      { kind: "alternative", id: path.alternativeId },
      ...(path.constraintIds ?? []).map((id) => ({ kind: "constraint", id })),
    ];
    return {
      id: path.id,
      label: `${decisionCase.alternatives.find((item) => item.id === path.alternativeId)?.label ?? path.alternativeId} · ${criterionById.get(path.criterionId)?.label ?? path.criterionId}`,
      status: path.status,
      entityRefs,
      resultIds: [resultIdByPair.get(`${path.alternativeId}:${path.criterionId}`)].filter(Boolean),
    };
  });

  const mandatory = decisionCase.constraints.filter((constraint) => constraint.severity === "mandatory");
  const pins = (presentation.pins ?? []).filter(
    (pin) => pin && typeof pin === "object" && typeof pin.kind === "string" && typeof pin.id === "string",
  );
  const recommendation = !candidateReview && evaluation?.recommendation
    ? {
        id: evaluation.recommendation.alternativeId,
        label: evaluation.recommendation.alternative.label,
        status: statusForAlternative(evaluation.recommendation),
        score: evaluation.recommendation.score,
      }
    : null;
  const scenarioSummary = !candidateReview
    ? scenarioEvaluationSummary(decisionCase, evaluation, presentation.scenarioResult)
    : null;

  return {
    schemaVersion: "1.0",
    caseId: decisionCase.id,
    decisionRevision: decisionCase.revision,
    decisionHash: getDecisionHash(decisionCase),
    viewRevision: presentation.viewRevision ?? 1,
    frozen: presentation.frozen ?? decisionCase.status === "approved",
    domain: {
      id: decisionCase.domain.packId,
      kind: presentationDomainKind(decisionCase.domain.packId),
      label: presentation.domainLabel ?? decisionCase.domain.packId,
      riskLevel: presentation.riskLevel ?? "standard",
    },
    contract: {
      title: decisionCase.title,
      question: decisionCase.contract.question,
      objective: decisionCase.contract.objective,
      status: decisionCase.contract.status,
      authority: decisionCase.contract.authority.mode,
    },
    entities,
    results,
    relations,
    paths,
    sources,
    pins,
    protected: {
      entityRefs: mandatory.map((constraint) => ({ kind: "constraint", id: constraint.id })),
      blockerResultIds: candidateReview ? [] : results
        .filter((result) => ["fail", "conflict", "unknown"].includes(result.status))
        .filter((result) => result.constraints.some((constraint) => constraint.severity === "mandatory"))
        .map((result) => result.id),
      humanOnlyActions: decisionCase.contract.authority.humanOnlyActions,
      unresolvedCount: evaluation?.unresolvedCount ?? 0,
      blockerCount: candidateReview ? 0 : evaluation?.blockerCount ?? 0,
      omittedEntityCount: presentation.omittedEntityCount ?? 0,
      prohibitedEntityKinds: decisionCase.contract.authority.prohibitedFields,
      authority: decisionCase.contract.authority.mode,
      recommendation,
    },
    policy: {
      allowedInstrumentTypes: null,
      blockedInstrumentTypes: candidateReview
        ? ["outcome-seal", "decision-brief", "score-breakdown", "metric-waterfall", "sensitivity-plot", "risk-frontier", "pareto-frontier", "weighted-criteria", "utilization-scenario", "concession-set"]
        : [],
      maxInstrumentCount: presentation.maxInstrumentCount ?? 10,
      authorityMode: decisionCase.contract.authority.mode,
      prohibitedFields: decisionCase.contract.authority.prohibitedFields,
    },
    permissions: candidateReview ? {
      ...(presentation.permissions ?? {}),
      canCompose: presentation.permissions?.canCompose ?? true,
      canAnalyze: true,
      canSimulate: false,
      canEditContract: presentation.permissions?.canEditContract ?? true,
      canApprove: false,
    } : presentation.permissions ?? {
      canCompose: true,
      canAnalyze: true,
      canSimulate: true,
      canEditContract: true,
      canApprove: decisionCase.contract.authority.humanConfirmationRequired,
    },
    metadata: {
      title: decisionCase.title,
      subtitle: decisionCase.subtitle,
      owner: decisionCase.owner,
      locale: decisionCase.locale,
      currency: decisionCase.currency,
      updatedAt: decisionCase.updatedAt,
      counts: {
        alternatives: decisionCase.alternatives.length,
        criteria: decisionCase.criteria.length,
        documents: decisionCase.documents.length,
        claims: decisionCase.claims.length,
      },
    },
    domainData: {
      alternativeSummaries: (evaluation?.results ?? []).map((result) => candidateReview
        ? {
            id: result.alternativeId,
            label: result.alternative.label,
            requirementCount: result.criteria.length,
            unresolvedRequirementCount: result.criteria.filter((entry) => ["unknown", "conflict"].includes(entry.status)).length,
          }
        : {
            id: result.alternativeId,
            label: result.alternative.label,
            eligible: result.eligible,
            score: result.score,
            blockerCount: result.blockers.length,
          }),
      criteria: decisionCase.criteria.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        kind: criterion.kind,
        weight: criterion.weight ?? null,
      })),
      scenarios: decisionCase.scenarios.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        description: scenario.description ?? "",
        active: presentation.activeScenario === scenario.id,
      })),
      activeScenario: presentation.activeScenario ?? null,
      activeScenarioId: presentation.activeScenario ?? null,
      scenarioEvaluation: scenarioSummary,
    },
  };
}
