import {
  entityRefKey,
  getDomainKind,
  isPlainRecord,
  LAYOUT_PATTERN_BY_LENS,
  LENSES,
  PRESENTATION_SCHEMA_VERSION,
} from "./contracts.js";
import { hashPresentationValue } from "./hash.js";
import { getInstrumentDefinition } from "./instrumentRegistry.js";
import { createPresentationIndex, resolveEntityRef } from "./presentationSelectors.js";
import { validatePresentationRecipe, validatePresentationSnapshot } from "./recipeSchema.js";

const DENSITY_BUDGETS = Object.freeze({ focused: 10, balanced: 10, dense: 12 });

const DEFAULT_FRAMING = Object.freeze({
  investigate: "Follow exact evidence through interpretation, constraint, and outcome.",
  compare: "Align every alternative against the same declared criteria.",
  simulate: "Separate the canonical record from hypothetical controls and consequences.",
  brief: "Converge affected stakeholders, cited findings, and human authority.",
});

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function itemRef(item, fallbackKind) {
  return { kind: item.kind || fallbackKind, id: item.id };
}

function refsForKinds(snapshot, kinds, limit = 100) {
  const kindSet = new Set(kinds);
  const references = [];
  for (const entity of snapshot.entities ?? []) {
    if (kindSet.has(entity.kind)) references.push(itemRef(entity, "entity"));
  }
  for (const result of snapshot.results ?? []) {
    if (kindSet.has(result.kind || "result")) references.push(itemRef(result, "result"));
  }
  for (const source of snapshot.sources ?? []) {
    if (kindSet.has(source.kind || "source")) references.push(itemRef(source, "source"));
  }
  return references.slice(0, limit);
}

function allResultRefs(snapshot, limit = 100) {
  return (snapshot.results ?? []).slice(0, limit).map((result) => itemRef(result, "result"));
}

function makeInstrument(type, region, priority, entityRefs = [], extra = {}) {
  return {
    id: extra.id,
    type,
    region,
    priority,
    entityRefs,
    ...(extra.pathId ? { pathId: extra.pathId } : {}),
    ...(extra.variant ? { variant: extra.variant } : {}),
    options: extra.options ?? {},
  };
}

function defaultDomainInstrument(domain, lens, snapshot) {
  const entityRefs = refsForKinds(
    snapshot,
    ["alternative", "criterion", "constraint", "requirement", "evidence", "control", "metric"],
    100,
  );
  const byDomain = {
    procurement: {
      investigate: ["compliance-gate-wall", "secondary"],
      compare: ["compliance-gate-wall", "primary"],
      simulate: ["concession-set", "secondary"],
      brief: ["tco-waterfall", "primary"],
    },
    candidate: {
      investigate: ["missing-verification-docket", "secondary"],
      compare: ["candidate-requirement-coverage", "primary"],
      simulate: null,
      brief: ["candidate-requirement-coverage", "primary"],
    },
    "health-plan": {
      investigate: ["provider-network-check", "secondary"],
      compare: ["plan-cost-waterfall", "primary"],
      simulate: ["utilization-scenario", "secondary"],
      brief: ["plan-cost-waterfall", "primary"],
    },
    generic: {
      investigate: ["data-quality-docket", "secondary"],
      compare: ["weighted-criteria", "primary"],
      simulate: null,
      brief: ["pareto-frontier", "primary"],
    },
  };
  const selected = byDomain[domain]?.[lens];
  if (!selected) return null;
  return makeInstrument(selected[0], selected[1], 90, entityRefs, {});
}

function buildDefaultInstruments(snapshot, lens) {
  const firstPath = snapshot.paths?.[0] ?? null;
  const pathId = firstPath?.id;
  const pathRefs = firstPath?.entityRefs ?? [];
  const evidenceRefs = refsForKinds(snapshot, ["evidence"], 24);
  const missingEvidenceRefs = (snapshot.entities ?? [])
    .filter((entity) => {
      const confidence = entity.attributes?.confidence;
      return (
        ["unknown", "missing"].includes(entity.kind) ||
        ["missing", "unknown", "unresolved", "low-confidence", "error"].includes(String(entity.status ?? "").toLowerCase()) ||
        (typeof confidence === "number" && confidence < 0.6)
      );
    })
    .map((entity) => itemRef(entity, "entity"))
    .slice(0, 50);
  const sourceRefs = refsForKinds(snapshot, ["source"], 24);
  const claimRefs = refsForKinds(snapshot, ["claim", "interpretation"], 24);
  const constraintRefs = refsForKinds(snapshot, ["constraint", "requirement", "criterion"], 50);
  const alternativeRefs = refsForKinds(snapshot, ["alternative", "candidate", "plan", "vendor"], 50);
  const controlRefs = refsForKinds(snapshot, ["control", "scenario-control"], 50);
  const stakeholderRefs = refsForKinds(snapshot, ["stakeholder", "actor", "reviewer"], 50);
  const metricRefs = refsForKinds(snapshot, ["metric", "criterion"], 50);
  const resultRefs = allResultRefs(snapshot, 100);
  const pathResultIds = new Set(firstPath?.resultIds ?? []);
  const pathResultRefs = (snapshot.results ?? [])
    .filter((result) => pathResultIds.has(result.id))
    .map((result) => itemRef(result, "result"));
  const pathConstraintRefs = pathRefs.filter((reference) =>
    ["constraint", "requirement", "criterion"].includes(reference.kind),
  );
  const pathAlternativeRefs = pathRefs.filter((reference) =>
    ["alternative", "candidate", "plan", "vendor"].includes(reference.kind),
  );
  const domain = getDomainKind(snapshot);
  const domainInstrument = defaultDomainInstrument(domain, lens, snapshot);

  const byLens = {
    investigate: [
      makeInstrument("evidence-excerpt", "primary", 80, evidenceRefs.length ? evidenceRefs : sourceRefs, {
        pathId,
        options: { showCitations: true, showConfidence: true },
      }),
      makeInstrument("claim-interpretation", "primary", 75, claimRefs.length ? claimRefs : pathRefs, {
        pathId,
        options: { showConfidence: true },
      }),
      makeInstrument("constraint-gate", "primary", 70, [
        ...(pathConstraintRefs.length ? pathConstraintRefs : constraintRefs),
        ...pathResultRefs,
      ].slice(0, 50), { pathId }),
      makeInstrument("outcome-seal", "primary", 65, [
        ...(pathResultRefs.length ? pathResultRefs : resultRefs),
        ...(pathAlternativeRefs.length ? pathAlternativeRefs : alternativeRefs),
      ].slice(0, 50), {
        pathId,
        variant: "canonical",
      }),
      makeInstrument("contradiction-docket", "secondary", 35, [...claimRefs, ...evidenceRefs].slice(0, 50), {
        options: { showCitations: true, showConfidence: true },
      }),
      makeInstrument("missing-evidence", "supporting", 30, missingEvidenceRefs, {
        options: { showConfidence: true },
      }),
    ],
    compare: [
      makeInstrument("comparison-matrix", "primary", 85, [...alternativeRefs, ...constraintRefs].slice(0, 100), {
        options: { stickyHeaders: true },
      }),
      makeInstrument("score-breakdown", "secondary", 55, resultRefs),
      makeInstrument("metric-waterfall", "secondary", 45, [...resultRefs, ...metricRefs].slice(0, 100), {
        options: { mode: "cumulative", showBaseline: true },
      }),
      makeInstrument("risk-frontier", "supporting", 35, [...alternativeRefs, ...metricRefs].slice(0, 100), {
        options: { showConfidence: true },
      }),
    ],
    simulate: [
      makeInstrument("outcome-seal", "primary", 80, [...resultRefs, ...alternativeRefs].slice(0, 50), {
        variant: "canonical",
      }),
      makeInstrument("scenario-controls", "secondary", 75, controlRefs, {
        options: { showBaseline: true },
      }),
      makeInstrument("sensitivity-plot", "supporting", 45, [...controlRefs, ...resultRefs].slice(0, 100), {
        options: { showBaseline: true },
      }),
      makeInstrument("outcome-seal", "supporting", 40, [...resultRefs, ...alternativeRefs].slice(0, 50), {
        variant: "hypothetical",
      }),
    ],
    brief: [
      makeInstrument("stakeholder-mandate", "primary", 80, stakeholderRefs),
      makeInstrument("decision-brief", "secondary", 75, [...alternativeRefs, ...resultRefs].slice(0, 100), {
        options: { showCitations: true, showConfidence: true },
      }),
      makeInstrument("outcome-seal", "secondary", 65, [...resultRefs, ...alternativeRefs].slice(0, 50), {
        variant: "canonical",
      }),
      makeInstrument("evidence-excerpt", "supporting", 35, evidenceRefs, {
        options: { limit: 8, showCitations: true, showConfidence: true },
      }),
      makeInstrument("risk-frontier", "supporting", 30, [...alternativeRefs, ...metricRefs].slice(0, 100), {
        options: { showConfidence: true },
      }),
    ],
  };

  const selected = [domainInstrument, ...byLens[lens]].filter(Boolean).filter((instrument) =>
    !(domain === "generic" && lens === "brief" && instrument.type === "risk-frontier"),
  );
  return selected.map((instrument, index) => ({
    ...instrument,
    id: `default-${lens}-${instrument.type}-${index + 1}`,
  }));
}

export function createDefaultPresentationRecipe(snapshot, {
  lens = "investigate",
  question = snapshot?.contract?.question || "Inspect the available decision evidence.",
  framing = DEFAULT_FRAMING[lens],
} = {}) {
  if (!LENSES.includes(lens)) {
    throw new TypeError(`Unsupported presentation lens: ${String(lens)}.`);
  }
  const firstPath = snapshot?.paths?.[0];
  const firstFocusRef = firstPath?.entityRefs?.[0] ?? snapshot?.entities?.[0];
  const focus = {};
  if (firstPath?.id) focus.pathId = firstPath.id;
  if (firstFocusRef) {
    focus.entityRef = firstFocusRef.kind
      ? { kind: firstFocusRef.kind, id: firstFocusRef.id }
      : null;
  }
  if (!focus.entityRef) delete focus.entityRef;

  const draft = {
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    recipeId: "",
    intent: lens === "investigate" ? "explain" : lens,
    lens,
    question,
    framing,
    layout: {
      pattern: LAYOUT_PATTERN_BY_LENS[lens],
      density: lens === "investigate" ? "focused" : "balanced",
    },
    instruments: buildDefaultInstruments(snapshot, lens).filter((instrument) => {
      const allowed = snapshot?.policy?.allowedInstrumentTypes;
      const blocked = snapshot?.policy?.blockedInstrumentTypes ?? [];
      return (
        (!Array.isArray(allowed) || allowed.includes(instrument.type)) &&
        !blocked.includes(instrument.type)
      );
    }),
    ...(Object.keys(focus).length ? { focus } : {}),
    expectedDecisionRevision: snapshot?.decisionRevision,
    expectedViewRevision: snapshot?.viewRevision,
  };
  draft.recipeId = `recipe-${hashPresentationValue({
    caseId: snapshot?.caseId,
    lens,
    question,
    decisionRevision: snapshot?.decisionRevision,
    viewRevision: snapshot?.viewRevision,
  }).slice(3)}`;
  return draft;
}

function systemInstrument(type, entityRefs, extra = {}) {
  return {
    id: `system-${type}`,
    type,
    region: "supporting",
    priority: type === "protected-invariants" ? 1000 : 990,
    entityRefs,
    options: type === "pinned-context" ? { showCitations: true } : {},
    systemInjected: true,
    locked: true,
    ...extra,
  };
}

function resolveReferenceGroups(snapshot) {
  const index = createPresentationIndex(snapshot);
  const validPins = [];
  const orphanedPins = [];
  for (const reference of snapshot.pins ?? []) {
    (resolveEntityRef(index, reference) ? validPins : orphanedPins).push(clone(reference));
  }
  const validProtected = [];
  const orphanedProtected = [];
  for (const reference of snapshot.protected?.entityRefs ?? []) {
    (resolveEntityRef(index, reference) ? validProtected : orphanedProtected).push(clone(reference));
  }
  return { validPins, orphanedPins, validProtected, orphanedProtected };
}

function buildWarnings(snapshot, references) {
  const warnings = [];
  if ((snapshot.entities?.length ?? 0) + (snapshot.results?.length ?? 0) === 0) {
    warnings.push({
      code: "EMPTY_DECISION_GRAPH",
      message: "The decision graph is empty; the room is showing safe missing-evidence fallbacks.",
    });
  }
  if (references.orphanedPins.length) {
    warnings.push({
      code: "ORPHANED_PIN",
      message: `${references.orphanedPins.length} human-pinned reference could not be resolved after the latest import.`,
      entityRefs: clone(references.orphanedPins),
    });
  }
  if (references.orphanedProtected.length) {
    warnings.push({
      code: "ORPHANED_PROTECTED_REFERENCE",
      message: `${references.orphanedProtected.length} protected reference could not be resolved.`,
      entityRefs: clone(references.orphanedProtected),
    });
  }
  const lowConfidenceCount = (snapshot.entities ?? []).filter((entity) => {
    const confidence = entity.attributes?.confidence;
    return typeof confidence === "number" && confidence < 0.6;
  }).length;
  if (lowConfidenceCount) {
    warnings.push({
      code: "LOW_CONFIDENCE_EVIDENCE",
      message: `${lowConfidenceCount} canonical item has low extraction or interpretation confidence.`,
    });
  }
  return warnings;
}

function resolveBudget(snapshot, recipe, environment, systemCount) {
  const requested = environment.maxInstrumentCount;
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 2 || requested > 24)) {
    return { error: "environment.maxInstrumentCount must be an integer between 2 and 24." };
  }
  const policyLimit = snapshot.policy?.maxInstrumentCount;
  const densityLimit = DENSITY_BUDGETS[recipe.layout.density] ?? 8;
  const limit = Math.min(requested ?? 24, policyLimit ?? 24, densityLimit);
  return { limit: Math.max(systemCount, limit) };
}

function uniqueReferences(references) {
  const seen = new Set();
  return references.filter((reference) => {
    const key = entityRefKey(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compilePresentation(snapshot, recipe, environment = {}) {
  if (!isPlainRecord(environment)) {
    return {
      ok: false,
      error: "Presentation environment must be an object.",
      errors: ["Presentation environment must be an object."],
    };
  }
  const unknownEnvironmentKeys = Object.keys(environment).filter((key) => key !== "maxInstrumentCount");
  if (unknownEnvironmentKeys.length) {
    const error = `Unknown presentation environment fields: ${unknownEnvironmentKeys.join(", ")}.`;
    return { ok: false, error, errors: [error] };
  }
  const snapshotValidation = validatePresentationSnapshot(snapshot);
  if (!snapshotValidation.ok) {
    const errors = snapshotValidation.errors.map((error) => `Invalid snapshot: ${error}`);
    return { ok: false, error: errors[0], errors };
  }
  const recipeValidation = validatePresentationRecipe(snapshot, recipe);
  if (!recipeValidation.ok) {
    return { ok: false, error: recipeValidation.errors[0], errors: recipeValidation.errors };
  }
  if (snapshot.frozen) {
    return {
      ok: false,
      error: "The room is frozen by a human reviewer.",
      errors: ["The room is frozen by a human reviewer."],
    };
  }
  if (snapshot.permissions?.canCompose === false) {
    return {
      ok: false,
      error: "The current actor is not allowed to compose this room.",
      errors: ["The current actor is not allowed to compose this room."],
    };
  }
  if (recipe.expectedDecisionRevision !== snapshot.decisionRevision) {
    return {
      ok: false,
      error: "The recipe targets a stale decision revision.",
      errors: ["The recipe targets a stale decision revision."],
    };
  }
  if (recipe.expectedViewRevision !== snapshot.viewRevision) {
    return {
      ok: false,
      error: "The room changed before this recipe could be applied.",
      errors: ["The room changed before this recipe could be applied."],
    };
  }

  const references = resolveReferenceGroups(snapshot);
  const warnings = buildWarnings(snapshot, references);
  const systemInstruments = [
    systemInstrument("protected-invariants", references.validProtected, {
      unresolvedEntityRefs: clone(references.orphanedProtected),
      blockerResultIds: clone(snapshot.protected?.blockerResultIds ?? []),
    }),
  ];
  if ((snapshot.pins?.length ?? 0) > 0) {
    systemInstruments.push(
      systemInstrument("pinned-context", references.validPins, {
        unresolvedEntityRefs: clone(references.orphanedPins),
      }),
    );
  }
  if (getDomainKind(snapshot) === "candidate") {
    systemInstruments.push(
      systemInstrument("bias-shield", [], {
        unresolvedEntityRefs: [],
      }),
    );
  }
  const injectScenarioOutcome = recipe.lens === "simulate" && snapshot.permissions?.canSimulate !== false;
  if (injectScenarioOutcome) {
    systemInstruments.push(
      systemInstrument("outcome-seal", [
        ...allResultRefs(snapshot, 50),
        ...refsForKinds(snapshot, ["alternative", "candidate", "plan", "vendor"], 50),
      ].slice(0, 100), {
        region: "secondary",
        priority: 995,
        variant: "hypothetical",
      }),
    );
  }

  const budget = resolveBudget(snapshot, recipe, environment, systemInstruments.length);
  if (budget.error) return { ok: false, error: budget.error, errors: [budget.error] };

  const requestedInstruments = recipe.instruments
    .filter((instrument) => !(injectScenarioOutcome && instrument.type === "outcome-seal" && instrument.variant === "hypothetical"))
    .map((instrument, index) => ({
      ...clone(instrument),
      systemInjected: false,
      locked: false,
      recipeOrder: index,
    }));
  const ranked = [...requestedInstruments].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.recipeOrder - right.recipeOrder;
  });
  const availableRequestedSlots = Math.max(0, budget.limit - systemInstruments.length);
  const retainedRequested = ranked.slice(0, availableRequestedSlots);
  const omittedRequested = ranked.slice(availableRequestedSlots);
  const instruments = [...systemInstruments, ...retainedRequested].map((instrument) => {
    const { recipeOrder, ...safeInstrument } = instrument;
    return safeInstrument;
  });
  if (omittedRequested.length) {
    warnings.push({
      code: "INSTRUMENT_BUDGET_APPLIED",
      message: `${omittedRequested.length} lower-priority instrument was moved out of the active composition.`,
      instrumentIds: omittedRequested.map((instrument) => instrument.id),
    });
  }

  const visibleEntityRefs = uniqueReferences(instruments.flatMap((instrument) => instrument.entityRefs ?? []));
  const totalCanonicalItems =
    (snapshot.entities?.length ?? 0) +
    (snapshot.results?.length ?? 0) +
    (snapshot.sources?.length ?? 0);
  const computedOmittedEntityCount = Math.max(0, totalCanonicalItems - visibleEntityRefs.length);
  const regions = Object.fromEntries(
    ["primary", "secondary", "supporting"].map((region) => [
      region,
      instruments.filter((instrument) => instrument.region === region).map((instrument) => instrument.id),
    ]),
  );

  const planPayload = {
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    recipeId: recipe.recipeId,
    caseId: snapshot.caseId,
    lens: recipe.lens,
    intent: recipe.intent,
    question: recipe.question,
    framing: recipe.framing ?? DEFAULT_FRAMING[recipe.lens],
    layout: clone(recipe.layout),
    instruments,
    regions,
    focus: clone(recipe.focus ?? null),
    baseDecisionRevision: snapshot.decisionRevision,
    baseViewRevision: snapshot.viewRevision,
    nextViewRevision: snapshot.viewRevision + 1,
    decisionHash: snapshot.decisionHash,
    protected: {
      entityRefs: clone(snapshot.protected?.entityRefs ?? []),
      blockerResultIds: clone(snapshot.protected?.blockerResultIds ?? []),
      prohibitedEntityKinds: clone(snapshot.protected?.prohibitedEntityKinds ?? []),
      authority: clone(snapshot.protected?.authority ?? null),
    },
    preservedPins: clone(snapshot.pins ?? []),
    unresolvedPinnedRefs: clone(references.orphanedPins),
    unresolvedProtectedRefs: clone(references.orphanedProtected),
    visibleEntityRefs,
    omitted: {
      instrumentIds: omittedRequested.map((instrument) => instrument.id),
      entityCount: Math.max(
        computedOmittedEntityCount,
        Number(snapshot.protected?.omittedEntityCount) || 0,
      ),
    },
    warnings,
  };
  const viewHash = hashPresentationValue(planPayload);
  const plan = deepFreeze({
    ...planPayload,
    planId: `plan-${viewHash.slice(3)}`,
    viewHash,
  });
  return { ok: true, plan, warnings: plan.warnings };
}

export function getInstrumentCapabilities(snapshot, { lens } = {}) {
  const domain = getDomainKind(snapshot);
  const policy = snapshot.policy ?? {};
  const allowedTypes = Array.isArray(policy.allowedInstrumentTypes)
    ? new Set(policy.allowedInstrumentTypes)
    : null;
  const blocked = new Set(policy.blockedInstrumentTypes ?? []);
  return Array.from(
    new Set(
      [
        "protected-invariants",
        "pinned-context",
        ...(domain === "candidate" ? ["bias-shield"] : []),
        ...buildDefaultInstruments(snapshot, lens ?? "investigate").map((item) => item.type),
      ].filter((type) => {
        const definition = getInstrumentDefinition(type);
        if (!definition) return false;
        if (lens && !definition.lenses.includes(lens)) return false;
        if (!definition.domains.includes("*") && !definition.domains.includes(domain)) return false;
        if (allowedTypes && !allowedTypes.has(type) && !definition.protectedType) return false;
        return !blocked.has(type) || definition.protectedType;
      }),
    ),
  );
}
