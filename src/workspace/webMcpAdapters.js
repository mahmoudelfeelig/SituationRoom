import {
  canonicalHash,
  cloneValue,
  evaluateWithDomainPack,
  getDecisionHash,
  validateDecisionCase,
} from "../kernel/index.js";
import {
  CANDIDATE_REVIEW_PACK_ID,
  HEALTH_PLAN_PACK_ID,
  classifyCandidateCriterion,
  containsCandidateProtectedText,
  createDefaultDomainRegistry,
  isCandidateProtectedField,
  isOpaqueCandidateIdentifier,
  redactCandidateSourceDocuments,
  redactHealthPlanSourceDocuments,
} from "../domain-packs/index.js";
import { assessAgentArtifact } from "./agentArtifactPolicy.js";
import {
  DENSITIES,
  LAYOUT_PATTERN_BY_LENS,
  REGIONS,
  TRUSTED_INSTRUMENT_TYPES,
  getInstrumentCapabilities,
  getInstrumentDefinition,
} from "../presentation/index.js";

const DEFAULT_PERMISSIONS = Object.freeze([]);
const ACTIVE_IMPORT_PHASES = new Set([
  "queued",
  "validating",
  "fingerprinting",
  "parsing",
  "normalizing",
  "scanning",
  "committing",
]);
const REVIEW_IMPORT_PHASES = new Set(["review_required", "failed", "quarantined"]);
const KNOWN_PHASES = new Set([
  "empty",
  "intake",
  "importing",
  "import_review",
  "contract_draft",
  "analysis",
  "collaboration",
  "output",
  "frozen",
]);
const DOTTED_COMMANDS = new Set([
  "decision.proposeContract",
  "decision.upsertAlternative",
  "decision.setCriterion",
  "decision.setConstraint",
  "decision.addClaimsBatch",
  "decision.linkEvidence",
  "decision.proposeRule",
  "decision.flagConflict",
  "collaboration.addAgentComment",
  "decision.createBranch",
]);
const PROHIBITED_EXTERNAL_ACTION = /(approve|accept|reject|hire|terminate|underwrite|premium|adjudicate|claim|submit|send|publish|purchase|delete)/i;
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\./,
  /^0\./,
  /^\[?::1\]?$/i,
  /^\[?f[cd][0-9a-f]*:/i,
  /^\[?fe8[0-9a-f]:/i,
];

function adapterError(code, message, safeDetails = undefined) {
  const error = new Error(message);
  error.name = "WebMcpAdapterError";
  error.code = code;
  if (safeDetails !== undefined) error.safeDetails = safeDetails;
  return error;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw adapterError("VALIDATION_FAILED", `${label} must be an object.`);
  }
  return value;
}

function assertMethod(value, method, label) {
  if (typeof value?.[method] !== "function") {
    throw new TypeError(`${label} requires ${method}().`);
  }
}

function clone(value) {
  if (value === undefined) return undefined;
  return cloneValue(value);
}

function boundedText(value, maximum = 1_000) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function boundedArray(value, maximum = 20) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function nowIso(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : String(value);
}

function actorRecord(actor) {
  if (actor && typeof actor === "object" && ["human", "agent", "system"].includes(actor.type)) {
    return { type: actor.type, id: String(actor.id ?? "webmcp-agent") };
  }
  return { type: "agent", id: typeof actor === "string" ? actor : "webmcp-agent" };
}

function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const match = /^offset:(\d+)$/.exec(String(cursor));
  if (!match) throw adapterError("VALIDATION_FAILED", "The pagination cursor is invalid.");
  return Number(match[1]);
}

function paginate(entries, { cursor, limit = 10 } = {}) {
  const offset = parseCursor(cursor);
  const boundedLimit = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 10));
  const page = entries.slice(offset, offset + boundedLimit);
  const nextOffset = offset + page.length;
  return {
    entries: page,
    total: entries.length,
    nextCursor: nextOffset < entries.length ? `offset:${nextOffset}` : null,
  };
}

function safeId(prefix, source) {
  const slug = String(source ?? "")
    .normalize("NFKD")
    .replace(/[^a-z0-9._:-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  const suffix = canonicalHash(String(source ?? prefix)).replace(/^sha256:/, "").slice(0, 10);
  return `${prefix}:${slug || suffix}`.slice(0, 128);
}

function normalizeRuntimeError(error) {
  if (error?.code === "CASE_FROZEN") {
    throw adapterError("ROOM_FROZEN", error.message, error.details);
  }
  if (error?.code === "QUARANTINED") {
    throw adapterError("IMPORT_QUARANTINED", error.message, error.details);
  }
  if (error?.code === "IMPORT_CANCELED") {
    throw adapterError("EXECUTION_CANCELED", error.message, error.details);
  }
  throw error;
}

async function resolveMaybe(value, ...args) {
  return typeof value === "function" ? value(...args) : value;
}

function riskForCase(decisionCase, context = {}) {
  if (context.domainRisk) return context.domainRisk;
  if (["candidate-review", "health-plan"].includes(decisionCase?.domain?.packId)) return "regulated";
  return "ordinary";
}

function inferWorkspacePhase({ explicit, activeCase, imports, frozen }) {
  if (frozen) return "frozen";
  if (imports.some((entry) => REVIEW_IMPORT_PHASES.has(entry.phase))) return "import_review";
  if (imports.some((entry) => ACTIVE_IMPORT_PHASES.has(entry.phase))) return "importing";
  if (KNOWN_PHASES.has(explicit)) return explicit;
  if (explicit === "room_active" || explicit === "ready") return "analysis";
  if (!activeCase) return "empty";
  if (!activeCase.contract || activeCase.contract.status === "draft") return "contract_draft";
  return "analysis";
}

function fingerprint(value) {
  return canonicalHash(value);
}

export function createReviewArtifactStore({ now = () => new Date().toISOString(), idGenerator, limit = 200 } = {}) {
  const artifacts = new Map();
  const idempotency = new Map();
  const listeners = new Set();
  let sequence = 0;

  function makeArtifactId(kind) {
    const generated = idGenerator?.(kind) ?? `${++sequence}`;
    return safeId("review", `${kind}:${generated}`);
  }

  function emit(event) {
    for (const listener of listeners) listener(clone(event));
  }

  function stage({
    kind,
    caseId,
    payload,
    reason,
    actor,
    idempotencyKey,
    decisionRevision,
    decisionHash,
    status = "awaiting_human_review",
  }) {
    const scope = `${kind}:${caseId ?? "workspace"}:${idempotencyKey ?? ""}`;
    const contentFingerprint = fingerprint({ kind, caseId, payload, reason });
    if (idempotencyKey && idempotency.has(scope)) {
      const prior = idempotency.get(scope);
      if (prior.fingerprint !== contentFingerprint) {
        throw adapterError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different staged artifact.");
      }
      return { artifact: clone(prior.artifact), receipt: clone(prior.receipt), replayed: true };
    }

    const at = nowIso(now);
    const artifact = {
      id: makeArtifactId(kind),
      kind,
      caseId: caseId ?? null,
      status,
      staged: true,
      executable: false,
      reason: boundedText(reason, 500),
      actor: actorRecord(actor),
      createdAt: at,
      payload: clone(payload),
    };
    const receipt = {
      id: safeId("receipt", artifact.id),
      commandId: artifact.id,
      commandType: `stage_${kind}`,
      caseId: caseId ?? null,
      actor: artifact.actor,
      at,
      revisionBefore: decisionRevision ?? null,
      revisionAfter: decisionRevision ?? null,
      decisionHashBefore: decisionHash ?? null,
      decisionHashAfter: decisionHash ?? null,
      changedEntityIds: [],
      stagedArtifactIds: [artifact.id],
      auditEventId: artifact.id,
    };
    artifacts.set(artifact.id, artifact);
    while (artifacts.size > limit) artifacts.delete(artifacts.keys().next().value);
    if (idempotencyKey) {
      idempotency.set(scope, { fingerprint: contentFingerprint, artifact, receipt });
      while (idempotency.size > limit) idempotency.delete(idempotency.keys().next().value);
    }
    emit({ type: "review-artifact.staged", caseId, artifact, receipt });
    return { artifact: clone(artifact), receipt: clone(receipt), replayed: false };
  }

  return Object.freeze({
    stage,
    get(id) {
      return clone(artifacts.get(id) ?? null);
    },
    list(caseId = undefined) {
      return [...artifacts.values()]
        .filter((artifact) => caseId === undefined || artifact.caseId === caseId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(clone);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function sourceReference(decisionCase, reference) {
  if (!reference || typeof reference !== "object") return null;
  if (!["source", "fragment", "evidence"].includes(reference.kind)) return null;
  const fragment = decisionCase.fragments.find((entry) => entry.id === reference.id);
  if (!fragment) return null;
  return { documentId: fragment.documentId, fragmentId: fragment.id };
}

function assertRevision(decisionCase, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw adapterError("VALIDATION_FAILED", "expectedRevision must be a positive integer.");
  }
  if (decisionCase.revision !== expectedRevision) {
    throw adapterError("STALE_REVISION", "The decision changed before this operation could run.", {
      currentDecisionRevision: decisionCase.revision,
    });
  }
}

function proposalReason(type) {
  const reasons = {
    "decision.proposeContract": "Contract activation and authority changes require a human-reviewed canonical contract replacement.",
    "decision.setCriterion": "The WebMCP proposal does not carry a complete trusted scoring range or value-type definition.",
    "decision.setConstraint": "The WebMCP proposal does not identify the canonical criterion the constraint governs.",
    "decision.proposeRule": "Rules remain proposals until a person confirms their metric semantics and trusted operator mapping.",
    "collaboration.addAgentComment": "Agent comments are non-canonical collaboration artifacts and cannot resolve evidence or speak for a human.",
  };
  return reasons[type] ?? "The current decision system cannot commit this proposal without inventing decision rules.";
}

function stageCommand({ store, type, command, current, actor, idempotencyKey, reason }) {
  const staged = store.stage({
    kind: type.replaceAll(".", "_"),
    caseId: current.id,
    payload: command.payload,
    reason: reason ?? proposalReason(type),
    actor,
    idempotencyKey,
    decisionRevision: current.revision,
    decisionHash: getDecisionHash(current),
  });
  return {
    ok: true,
    staged: true,
    replayed: staged.replayed,
    artifact: staged.artifact,
    receipt: staged.receipt,
    message: "Proposal staged for visible human review; the canonical decision did not change.",
  };
}

function existingIdOwner(decisionCase, id) {
  if (decisionCase.contract.id === id) return "contract";
  for (const collection of [
    "alternatives",
    "criteria",
    "constraints",
    "stakeholders",
    "documents",
    "fragments",
    "claims",
    "rules",
    "scenarios",
    "decisions",
    "approvals",
    "conflicts",
    "audit",
  ]) {
    if (decisionCase[collection]?.some((entry) => entry.id === id)) return collection;
  }
  return null;
}

function candidatePayloadViolation(value, path = "command.payload", visited = new WeakSet()) {
  if (typeof value === "string") {
    return containsCandidateProtectedText(value)
      ? { path, reason: "protected-trait language" }
      : null;
  }
  if (!value || typeof value !== "object" || visited.has(value)) return null;
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (isCandidateProtectedField(key)) return { path: `${path}.${key}`, reason: "a protected-trait field" };
    const nested = candidatePayloadViolation(child, `${path}.${key}`, visited);
    if (nested) return nested;
  }
  return null;
}

function mapDottedCommand(command, current, options, reviewArtifacts) {
  const payload = assertObject(command.payload ?? {}, "command.payload");
  const type = command.type;
  const actor = actorRecord(options.actor);
  const idempotencyKey = options.idempotencyKey;
  const stage = (reason) => stageCommand({
    store: reviewArtifacts,
    type,
    command,
    current,
    actor,
    idempotencyKey,
    reason,
  });

  if (current.domain.packId === CANDIDATE_REVIEW_PACK_ID) {
    const violation = candidatePayloadViolation(payload);
    if (violation) {
      throw adapterError(
        "POLICY_DENIED",
        `Candidate-review proposals cannot retain ${violation.reason}. Submit only blinded, job-related evidence.`,
        { path: violation.path },
      );
    }
    if (type === "decision.upsertAlternative" && !isOpaqueCandidateIdentifier(payload.label)) {
      throw adapterError("POLICY_DENIED", "Candidate alternatives must use an opaque candidate or application identifier.");
    }
    if (type === "decision.setCriterion" && !classifyCandidateCriterion(payload.label)) {
      throw adapterError("POLICY_DENIED", "Candidate-review criteria must match the positive job-related evidence schema.");
    }
  }

  if (
    ["candidate-review", "health-plan"].includes(current.domain.packId) &&
    [
      "decision.upsertAlternative",
      "decision.setCriterion",
      "decision.setConstraint",
      "decision.addClaimsBatch",
      "decision.linkEvidence",
      "decision.flagConflict",
      "decision.createBranch",
    ].includes(type)
  ) {
    return { stagedResult: stage("Regulated-domain model changes require visible human structured review before any canonical revision.") };
  }

  if (type === "decision.proposeContract" || type === "decision.proposeRule" || type === "collaboration.addAgentComment") {
    return { stagedResult: stage() };
  }

  if (type === "decision.upsertAlternative") {
    const id = payload.alternativeId || safeId("alternative", payload.label);
    const owner = existingIdOwner(current, id);
    if (owner === "alternatives") {
      return { stagedResult: stage("Updating an existing alternative requires a human-reviewed replacement command.") };
    }
    if (owner) throw adapterError("VALIDATION_FAILED", `ID '${id}' is already used by ${owner}.`);
    return {
      kernelCommand: {
        type: "add_alternative",
        payload: {
          alternative: {
            id,
            label: payload.label,
            ...(payload.description ? { description: payload.description } : {}),
            ...(payload.sourceRefs?.length
              ? { proposedSourceRefs: payload.sourceRefs.map((reference) => `${reference.kind}:${reference.id}`) }
              : {}),
          },
          includeInContract: true,
        },
      },
    };
  }

  if (type === "decision.setCriterion" || type === "decision.setConstraint") {
    return { stagedResult: stage() };
  }

  if (type === "decision.addClaimsBatch") {
    const claims = payload.claims.map((claim) => {
      if (claim.subjectRef?.kind !== "alternative") {
        throw adapterError("VALIDATION_FAILED", "Claim subjects must be canonical alternatives.");
      }
      if (!current.alternatives.some((alternative) => alternative.id === claim.subjectRef.id)) {
        throw adapterError("NOT_FOUND", `Alternative '${claim.subjectRef.id}' was not found.`);
      }
      if (!current.criteria.some((criterion) => criterion.id === claim.predicate)) {
        throw adapterError("NOT_FOUND", `Criterion '${claim.predicate}' was not found.`);
      }
      const sources = (claim.sourceRefs ?? []).map((reference) => sourceReference(current, reference));
      if (sources.some((reference) => reference === null)) {
        throw adapterError("VALIDATION_FAILED", "Every claim source must resolve to an exact imported fragment.");
      }
      return {
        id: claim.claimId,
        subjectId: claim.subjectRef.id,
        criterionId: claim.predicate,
        value: claim.value,
        status: "proposed",
        confidence: claim.confidence ?? 0.5,
        sourceRefs: sources,
        origin: "webmcp_proposal",
      };
    });
    return { kernelCommand: { type: "add_claims_batch", payload: { claims } } };
  }

  if (type === "decision.linkEvidence") {
    const claimRef = [payload.from, payload.to].find((reference) => reference?.kind === "claim");
    const exactSource = sourceReference(current, payload.sourceRef);
    if (!claimRef || !exactSource) {
      return { stagedResult: stage("The relationship cannot be reduced to one canonical claim and one exact source fragment.") };
    }
    if (!current.claims.some((claim) => claim.id === claimRef.id)) {
      throw adapterError("NOT_FOUND", `Claim '${claimRef.id}' was not found.`);
    }
    return {
      kernelCommand: {
        type: "link_evidence",
        payload: { claimId: claimRef.id, sourceRef: { ...exactSource, relationship: payload.relation } },
      },
    };
  }

  if (type === "decision.flagConflict") {
    if (payload.leftRef?.kind !== "claim" || payload.rightRef?.kind !== "claim") {
      return { stagedResult: stage("Only claim-to-claim conflicts can be committed by the current decision system.") };
    }
    if (payload.leftRef.id === payload.rightRef.id) {
      throw adapterError("VALIDATION_FAILED", "A claim cannot conflict with itself.");
    }
    return {
      kernelCommand: {
        type: "flag_conflict",
        payload: {
          claimIds: [payload.leftRef.id, payload.rightRef.id],
          conflictId: safeId("conflict", `${payload.leftRef.id}:${payload.rightRef.id}:${payload.reason}`),
          reason: payload.reason,
        },
      },
    };
  }

  if (type === "decision.createBranch") {
    if (payload.fromRevision !== current.revision) {
      return { stagedResult: stage("The current decision system can create a live branch only from the current saved revision.") };
    }
    return {
      kernelCommand: {
        type: "create_scenario",
        payload: {
          scenario: {
            id: safeId("scenario", `${payload.label}:${payload.fromRevision}`),
            label: payload.label,
            description: payload.purpose,
            baseRevision: payload.fromRevision,
            claimOverrides: {},
          },
        },
      },
    };
  }

  throw adapterError("VALIDATION_FAILED", `Unsupported WebMCP command '${type}'.`);
}

function projectContract(decisionCase) {
  if (!decisionCase) return null;
  const contract = decisionCase.contract;
  return {
    ...clone(contract),
    caseId: decisionCase.id,
    domainId: decisionCase.domain.packId,
    domainRisk: riskForCase(decisionCase),
    decisionType: decisionCase.domain.packId,
    evidenceThreshold: contract.evidencePolicy.sourceRequired ? "source_required" : "declared",
    uncertaintyPolicy: contract.evidencePolicy.hardUnknownPolicy,
    authority:
      contract.authority.humanConfirmationRequired
        ? contract.authority.allowAutomatedRanking ? "human_approves" : "human_decides"
        : "advisory_only",
    prohibitedInputs: clone(contract.authority.prohibitedFields),
    alternativeCount: contract.alternativeIds.length,
    criterionCount: contract.criterionIds.length,
    constraintCount: contract.constraintIds.length,
    revision: decisionCase.revision,
    decisionHash: getDecisionHash(decisionCase),
    pendingHumanCheckpoint: false,
  };
}

function graphPage(decisionCase, evaluation, query) {
  const entityRefs = boundedArray(query.entityRefs, 40);
  const alternativeIds = entityRefs.filter((reference) => reference.kind === "alternative").map((reference) => reference.id);
  const criterionIds = entityRefs.filter((reference) => reference.kind === "criterion").map((reference) => reference.id);
  const claimIds = new Set(entityRefs.filter((reference) => reference.kind === "claim").map((reference) => reference.id));
  const fragmentIds = new Set(
    entityRefs.filter((reference) => ["source", "fragment", "evidence"].includes(reference.kind)).map((reference) => reference.id),
  );
  const constraintIds = new Set(entityRefs.filter((reference) => reference.kind === "constraint").map((reference) => reference.id));
  let paths = evaluation.paths.filter((path) =>
    (!alternativeIds.length || alternativeIds.includes(path.alternativeId)) &&
    (!criterionIds.length || criterionIds.includes(path.criterionId)) &&
    (!query.statuses?.length || query.statuses.includes(path.status)),
  );
  if (claimIds.size || fragmentIds.size || constraintIds.size) {
    paths = paths.filter((path) =>
      path.claimIds.some((id) => claimIds.has(id)) ||
      path.sourceRefs.some((reference) => fragmentIds.has(reference.fragmentId)) ||
      path.constraintIds.some((id) => constraintIds.has(id)),
    );
  }
  const page = paginate(paths, query);
  const selectedAlternativeIds = new Set(page.entries.map((path) => path.alternativeId));
  const selectedCriterionIds = new Set(page.entries.map((path) => path.criterionId));
  const selectedClaimIds = new Set(page.entries.flatMap((path) => path.claimIds));
  const selectedFragmentIds = new Set(page.entries.flatMap((path) => path.sourceRefs.map((reference) => reference.fragmentId)));
  return {
    caseId: decisionCase.id,
    revision: decisionCase.revision,
    paths: page.entries,
    alternatives: decisionCase.alternatives.filter((entry) => selectedAlternativeIds.has(entry.id)),
    criteria: decisionCase.criteria.filter((entry) => selectedCriterionIds.has(entry.id)),
    claims: decisionCase.claims.filter((entry) => selectedClaimIds.has(entry.id)),
    fragments: decisionCase.fragments.filter((entry) => selectedFragmentIds.has(entry.id)),
    totalPathCount: page.total,
    truncated: page.nextCursor !== null,
    nextCursor: page.nextCursor,
    warnings: query.relationTypes?.length
      ? [{ code: "RELATION_FILTER_UNSUPPORTED", message: "The decision system currently filters causal paths, not arbitrary relationship labels." }]
      : [],
  };
}

function boundedEvaluation(evaluation, alternativeIds) {
  if (!alternativeIds?.length) return evaluation;
  const selected = new Set(alternativeIds);
  const results = evaluation.results.filter((result) => selected.has(result.alternativeId));
  return {
    ...evaluation,
    results,
    ranking: evaluation.ranking?.filter((result) => selected.has(result.alternativeId)) ?? null,
    recommendation: evaluation.ranking?.find((result) => selected.has(result.alternativeId) && result.eligible) ?? results[0] ?? null,
    paths: evaluation.paths.filter((path) => selected.has(path.alternativeId)),
  };
}

function candidateRequirementEvaluation(evaluation, alternativeIds) {
  const selected = new Set(alternativeIds?.length ? alternativeIds : evaluation.results.map((entry) => entry.alternativeId));
  const results = evaluation.results.filter((entry) => selected.has(entry.alternativeId)).map((entry) => ({
    alternativeId: entry.alternativeId,
    label: entry.alternative?.label ?? entry.alternativeId,
    requirements: entry.criteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      label: criterion.criterion?.label ?? criterion.criterionId,
      status: criterion.status,
      measurementStatus: criterion.measurement?.status,
      value: clone(criterion.measurement?.value),
      claimIds: clone(criterion.measurement?.claimIds ?? []),
      sourceRefs: clone(criterion.measurement?.sourceRefs ?? []),
      constraints: criterion.constraints.map((constraint) => ({
        id: constraint.constraint.id,
        status: constraint.status,
        severity: constraint.constraint.severity,
      })),
    })),
  }));
  return {
    caseId: evaluation.caseId,
    revision: evaluation.revision,
    mode: "requirement_evidence_only",
    results,
    unresolvedCount: evaluation.paths.filter(
      (path) => selected.has(path.alternativeId) && ["unknown", "conflict"].includes(path.status),
    ).length,
    authority: "No aggregate candidate score, ranking, eligibility, shortlist, rejection, or recommendation is computed or exposed.",
  };
}

function compactEvaluation(evaluation, alternativeIds) {
  const selected = new Set(alternativeIds?.length ? alternativeIds : evaluation.results.map((entry) => entry.alternativeId));
  const results = evaluation.results
    .filter((entry) => selected.has(entry.alternativeId))
    .map((entry) => ({
      alternativeId: entry.alternativeId,
      label: entry.alternative?.label ?? entry.alternativeId,
      eligible: entry.eligible,
      score: entry.score,
      blockers: entry.blockers.map((blocker) => blocker.criterionId),
    }));
  return {
    results,
    ranking: evaluation.ranking
      ? evaluation.ranking.filter((entry) => selected.has(entry.alternativeId)).map((entry) => entry.alternativeId)
      : null,
    recommendation: evaluation.recommendation && selected.has(evaluation.recommendation.alternativeId)
      ? {
          alternativeId: evaluation.recommendation.alternativeId,
          eligible: evaluation.recommendation.eligible,
          score: evaluation.recommendation.score,
        }
      : null,
    blockerCount: results.reduce((sum, entry) => sum + entry.blockers.length, 0),
    unresolvedCount: evaluation.paths.filter(
      (path) => selected.has(path.alternativeId) && ["unknown", "conflict"].includes(path.status),
    ).length,
  };
}

function valueMatchesCriterion(value, criterion) {
  switch (criterion?.valueType) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "currency":
      return typeof value === "number" && Number.isFinite(value);
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "enum": {
      const allowed = Array.isArray(criterion.allowedValues)
        ? criterion.allowedValues
        : Object.keys(criterion.scoring?.values ?? {});
      return typeof value === "string" && allowed.includes(value);
    }
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function selectedAlternativeIds(decisionCase, requested) {
  const activeIds = decisionCase.contract.alternativeIds;
  const selected = requested?.length ? [...new Set(requested)] : [...activeIds];
  const unknown = selected.filter((id) => !activeIds.includes(id));
  if (unknown.length) {
    throw adapterError("NOT_FOUND", `Unknown or inactive alternative '${unknown[0]}'.`);
  }
  return selected;
}

function stageSavedScenario(staged, scenarioId) {
  if (!scenarioId) return null;
  const scenarioIndex = staged.scenarios.findIndex((entry) => entry.id === scenarioId);
  if (scenarioIndex < 0) throw adapterError("NOT_FOUND", `Scenario '${scenarioId}' was not found.`);
  const scenario = staged.scenarios[scenarioIndex];
  const overrides = new Map(Object.entries(scenario.claimOverrides ?? {}));
  staged.claims = staged.claims.map((claim) =>
    overrides.has(claim.id) ? { ...claim, value: clone(overrides.get(claim.id)) } : claim,
  );
  staged.claims.push(...clone(scenario.additionalClaims ?? []));
  staged.scenarios.splice(scenarioIndex, 1);
  return scenario;
}

function applyTypedMetricOverrides(staged, rawOverrides, requestedAlternativeIds) {
  if (!Array.isArray(rawOverrides) || rawOverrides.length < 1 || rawOverrides.length > 50) {
    throw adapterError("VALIDATION_FAILED", "A transient scenario requires between 1 and 50 typed metric overrides.");
  }
  const alternativeIds = selectedAlternativeIds(staged, requestedAlternativeIds);
  const activeCriteria = new Set(staged.contract.criterionIds);
  const criteriaById = new Map(staged.criteria.map((criterion) => [criterion.id, criterion]));
  const seenMetrics = new Set();
  const appliedOverrides = [];

  for (const raw of rawOverrides) {
    const override = assertObject(raw, "Scenario override");
    if (seenMetrics.has(override.metricId)) {
      throw adapterError("VALIDATION_FAILED", `Metric '${override.metricId}' is overridden more than once.`);
    }
    seenMetrics.add(override.metricId);
    const criterion = criteriaById.get(override.metricId);
    if (!criterion || !activeCriteria.has(criterion.id)) {
      throw adapterError("NOT_FOUND", `Metric '${override.metricId}' is not active in this decision contract.`);
    }
    if (!valueMatchesCriterion(override.value, criterion)) {
      throw adapterError(
        "VALIDATION_FAILED",
        `Override '${criterion.id}' must match criterion type '${criterion.valueType}'.`,
      );
    }
    if (override.unit !== undefined && String(override.unit) !== String(criterion.unit ?? "")) {
      throw adapterError(
        "VALIDATION_FAILED",
        `Override '${criterion.id}' must use canonical unit '${criterion.unit ?? "unitless"}'.`,
      );
    }
    const matchingClaims = staged.claims.filter(
      (claim) =>
        alternativeIds.includes(claim.subjectId) &&
        claim.criterionId === criterion.id &&
        claim.status === "accepted",
    );
    const coveredAlternatives = new Set(matchingClaims.map((claim) => claim.subjectId));
    const missing = alternativeIds.filter((alternativeId) => !coveredAlternatives.has(alternativeId));
    if (missing.length) {
      throw adapterError(
        "CAPABILITY_UNSUPPORTED",
        `Metric '${criterion.id}' has no accepted claim to override for alternative '${missing[0]}'.`,
      );
    }
    const matchingIds = new Set(matchingClaims.map((claim) => claim.id));
    staged.claims = staged.claims.map((claim) =>
      matchingIds.has(claim.id) ? { ...claim, value: clone(override.value) } : claim,
    );
    appliedOverrides.push({
      metricId: criterion.id,
      value: clone(override.value),
      unit: criterion.unit ?? null,
      alternativeIds: [...alternativeIds],
      claimIds: matchingClaims.map((claim) => claim.id),
    });
  }
  return { alternativeIds, appliedOverrides };
}

function evaluateTransientDecision(decisionCase, options, domainRegistry) {
  const staged = clone(decisionCase);
  const savedScenario = stageSavedScenario(staged, options.scenarioId);
  if (!savedScenario && options.overrides === undefined) {
    throw adapterError("VALIDATION_FAILED", "A transient scenario requires a scenarioId or typed metric overrides.");
  }
  let alternativeIds = selectedAlternativeIds(staged, options.alternativeIds);
  let appliedOverrides = [];
  if (options.overrides !== undefined) {
    ({ alternativeIds, appliedOverrides } = applyTypedMetricOverrides(
      staged,
      options.overrides,
      options.alternativeIds,
    ));
  }
  const pack = domainRegistry.get(staged.domain.packId);
  const evaluation = evaluateWithDomainPack(staged, pack);
  return { staged, savedScenario, alternativeIds, appliedOverrides, evaluation };
}

function trustedNumericRange(decisionCase, criterion, presentationSnapshot) {
  const control = presentationSnapshot?.entities?.find((entry) => {
    if (!["control", "scenario-control"].includes(entry.kind)) return false;
    const attributes = entry.attributes ?? {};
    return (
      attributes.control === "range" &&
      [entry.id, attributes.metricId, attributes.criterionId].includes(criterion.id)
    );
  });
  if (
    Number.isFinite(control?.attributes?.min) &&
    Number.isFinite(control?.attributes?.max) &&
    control.attributes.max > control.attributes.min
  ) {
    return {
      min: control.attributes.min,
      max: control.attributes.max,
      step: Number.isFinite(control.attributes.step) && control.attributes.step > 0
        ? control.attributes.step
        : null,
      unit: control.attributes.unit ?? criterion.unit ?? null,
      source: "presentation.control.range",
    };
  }
  const scoring = criterion.scoring;
  if (
    scoring?.kind === "linear" &&
    Number.isFinite(scoring.min) &&
    Number.isFinite(scoring.max) &&
    scoring.max > scoring.min
  ) {
    return {
      min: scoring.min,
      max: scoring.max,
      step: null,
      unit: criterion.unit ?? null,
      source: "criterion.scoring.linear",
    };
  }
  return null;
}

function roundedNumber(value) {
  return Number(Number(value).toPrecision(12));
}

function rangeSamples(range, requestedSamples) {
  const count = Math.max(3, Math.min(21, Number.isInteger(requestedSamples) ? requestedSamples : 11));
  if (range.step) {
    const total = Math.floor((range.max - range.min) / range.step) + 1;
    const indices = total <= count
      ? Array.from({ length: total }, (_, index) => index)
      : Array.from({ length: count }, (_, index) => Math.round((index * (total - 1)) / (count - 1)));
    return [...new Set(indices.map((index) => roundedNumber(range.min + index * range.step)))];
  }
  return Array.from(
    { length: count },
    (_, index) => roundedNumber(range.min + ((range.max - range.min) * index) / (count - 1)),
  );
}

function compactOutcomes(evaluation, alternativeIds) {
  const selected = new Set(alternativeIds);
  const ranks = new Map((evaluation.ranking ?? []).map((entry, index) => [entry.alternativeId, index + 1]));
  return evaluation.results
    .filter((entry) => selected.has(entry.alternativeId))
    .map((entry) => ({
      alternativeId: entry.alternativeId,
      score: entry.score,
      eligible: entry.eligible,
      blockerCount: entry.blockers.length,
      rank: ranks.get(entry.alternativeId) ?? null,
    }));
}

async function runSensitivityAnalysis(decisionCase, evaluation, options, domainRegistry, presentationSnapshot) {
  const alternativeIds = selectedAlternativeIds(decisionCase, options.alternativeIds);
  const criteriaById = new Map(decisionCase.criteria.map((criterion) => [criterion.id, criterion]));
  const diagnostics = [];
  const sweeps = [];
  for (const metricId of boundedArray(options.metricIds, 30)) {
    const criterion = criteriaById.get(metricId);
    if (!criterion || !decisionCase.contract.criterionIds.includes(metricId)) {
      diagnostics.push({ code: "UNKNOWN_METRIC", metricId, message: "The metric is not active in this contract." });
      continue;
    }
    const range = trustedNumericRange(decisionCase, criterion, presentationSnapshot);
    if (!range) {
      diagnostics.push({
        code: "NO_TRUSTED_NUMERIC_RANGE",
        metricId,
        message: "No canonical numeric control or scoring range is defined; this metric was diagnosed but not sampled.",
      });
      continue;
    }
    const values = rangeSamples(range, options.samples);
    const points = [];
    try {
      for (const value of values) {
        const transient = evaluateTransientDecision(
          decisionCase,
          { alternativeIds, overrides: [{ metricId, value, ...(range.unit ? { unit: range.unit } : {}) }] },
          domainRegistry,
        );
        points.push({ value, outcomes: compactOutcomes(transient.evaluation, alternativeIds) });
      }
    } catch (error) {
      diagnostics.push({
        code: error.code ?? "SWEEP_UNAVAILABLE",
        metricId,
        message: boundedText(error.message, 240),
      });
      continue;
    }
    sweeps.push({ metricId, range, points });
  }
  const sampled = sweeps.length > 0;
  return {
    caseId: decisionCase.id,
    revision: decisionCase.revision,
    decisionHash: getDecisionHash(decisionCase),
    mode: "sensitivity",
    analysisKind: sampled ? "deterministic_one_at_a_time_sweep" : "diagnostic_only",
    supported: sampled,
    sampled,
    originalDecisionUnchanged: true,
    overrideScope: "same metric value for each selected alternative",
    requestedSamples: options.samples ?? 11,
    samplesCappedAt: 21,
    alternativeIds,
    baseline: compactOutcomes(evaluation, alternativeIds),
    sweeps,
    diagnostics,
    note: sampled
      ? "Each metric was swept independently across a trusted canonical range; no combined or inferred ranges were used."
      : "Diagnostic only: no requested metric had a trusted numeric range, so no sensitivity result was claimed.",
  };
}

function finiteSearchDomain(decisionCase, criterion, presentationSnapshot, baseline, constraints) {
  if (criterion.valueType === "boolean") {
    return { values: [false, true], source: "criterion.valueType.boolean", exact: true, span: 1 };
  }
  if (criterion.valueType === "enum") {
    const values = Array.isArray(criterion.allowedValues)
      ? criterion.allowedValues
      : Object.keys(criterion.scoring?.values ?? {});
    return values.length
      ? { values: [...values], source: "criterion.allowedValues", exact: true, span: Math.max(1, values.length - 1) }
      : null;
  }
  if (!["number", "currency"].includes(criterion.valueType)) return null;
  const range = trustedNumericRange(decisionCase, criterion, presentationSnapshot);
  if (!range) return null;
  const continuousExclusion = !range.step && constraints.some((constraint) =>
    constraint.operator === "ne" ||
    (constraint.operator === "not_in" && Array.isArray(constraint.expected) && constraint.expected.some((value) => typeof value === "number")),
  );
  if (continuousExclusion) {
    return {
      unsupported: true,
      code: "CONTINUOUS_EXCLUSION_NOT_EXACT",
      message: "A numeric exclusion without a discrete step has no exact minimum change; this blocker is diagnostic only.",
    };
  }
  const strict = constraints.some((constraint) => ["gt", "lt"].includes(constraint.operator));
  let values;
  if (range.step && (range.max - range.min) / range.step <= 2_000) {
    values = [];
    for (let value = range.min; value <= range.max + range.step / 2; value += range.step) {
      values.push(roundedNumber(value));
    }
  } else {
    const epsilon = range.step ?? (range.max - range.min) / 1_000_000;
    values = [range.min, range.max, baseline];
    for (const constraint of constraints) {
      const expected = constraint.expected;
      if (typeof expected === "number" && Number.isFinite(expected)) {
        values.push(expected);
        if (constraint.operator === "gt") values.push(expected + epsilon);
        if (constraint.operator === "lt") values.push(expected - epsilon);
      }
      if (constraint.operator === "in" && Array.isArray(expected)) {
        values.push(...expected.filter((value) => typeof value === "number" && Number.isFinite(value)));
      }
    }
  }
  return {
    values: [...new Set(values.filter((value) => value >= range.min && value <= range.max).map(roundedNumber))],
    source: range.source,
    exact: !strict,
    span: range.max - range.min,
    range,
  };
}

function normalizedChange(from, to, domain) {
  if (typeof from === "number" && typeof to === "number") {
    return roundedNumber(Math.abs(to - from) / Math.max(domain.span, Number.EPSILON));
  }
  return Object.is(from, to) ? 0 : 1;
}

async function solveMinimumChange(decisionCase, evaluation, options, domainRegistry, presentationSnapshot) {
  if (options.targetStatus !== "eligible") {
    throw adapterError("VALIDATION_FAILED", "Minimum-change analysis currently supports targetStatus 'eligible' only.");
  }
  const target = evaluation.results.find((entry) => entry.alternativeId === options.alternativeId);
  if (!target) throw adapterError("NOT_FOUND", `Alternative '${options.alternativeId}' was not found.`);
  const locked = new Set(options.lockedMetricIds ?? []);
  const criteriaById = new Map(decisionCase.criteria.map((criterion) => [criterion.id, criterion]));
  const changes = [];
  const diagnostics = [];

  for (const blocker of target.blockers) {
    const metricId = blocker.criterionId;
    if (locked.has(metricId)) {
      diagnostics.push({ code: "BLOCKER_LOCKED", metricId, message: "This blocking metric was locked by the caller." });
      continue;
    }
    if (blocker.measurement.status !== "known") {
      diagnostics.push({
        code: "NON_NUMERIC_EVIDENCE_RESOLUTION_REQUIRED",
        metricId,
        message: "The blocker is unknown or disputed and cannot be solved by changing a hypothetical value.",
      });
      continue;
    }
    const criterion = criteriaById.get(metricId);
    const constraints = blocker.constraints
      .filter((entry) => entry.constraint.severity === "mandatory")
      .map((entry) => entry.constraint);
    const domain = finiteSearchDomain(
      decisionCase,
      criterion,
      presentationSnapshot,
      blocker.measurement.value,
      constraints,
    );
    if (!domain) {
      diagnostics.push({
        code: "NO_TRUSTED_SEARCH_DOMAIN",
        metricId,
        message: "No trusted finite value domain or numeric range exists; this blocker is diagnostic only.",
      });
      continue;
    }
    if (domain.unsupported) {
      diagnostics.push({ code: domain.code, metricId, message: domain.message });
      continue;
    }
    const candidates = domain.values
      .map((value) => ({ value, distance: normalizedChange(blocker.measurement.value, value, domain) }))
      .sort((left, right) => left.distance - right.distance || String(left.value).localeCompare(String(right.value)));
    let selected = null;
    for (const candidate of candidates) {
      const overrides = [
        ...changes.map((change) => ({ metricId: change.metricId, value: change.to, ...(change.unit ? { unit: change.unit } : {}) })),
        { metricId, value: candidate.value, ...(criterion.unit ? { unit: criterion.unit } : {}) },
      ];
      const transient = evaluateTransientDecision(
        decisionCase,
        { alternativeIds: [options.alternativeId], overrides },
        domainRegistry,
      );
      const result = transient.evaluation.results.find((entry) => entry.alternativeId === options.alternativeId);
      const criterionResult = result.criteria.find((entry) => entry.criterionId === metricId);
      if (criterionResult?.status === "pass") {
        selected = { candidate, result };
        break;
      }
    }
    if (!selected) {
      diagnostics.push({
        code: "NO_SOLUTION_IN_TRUSTED_DOMAIN",
        metricId,
        message: "No value in the trusted search domain clears this blocker.",
      });
      continue;
    }
    changes.push({
      metricId,
      from: clone(blocker.measurement.value),
      to: clone(selected.candidate.value),
      unit: criterion.unit ?? null,
      normalizedDelta: selected.candidate.distance,
      domainSource: domain.source,
      exactWithinDomain: domain.exact,
    });
  }

  let finalResult = target;
  if (changes.length) {
    const transient = evaluateTransientDecision(
      decisionCase,
      {
        alternativeIds: [options.alternativeId],
        overrides: changes.map((change) => ({
          metricId: change.metricId,
          value: change.to,
          ...(change.unit ? { unit: change.unit } : {}),
        })),
      },
      domainRegistry,
    );
    finalResult = transient.evaluation.results.find((entry) => entry.alternativeId === options.alternativeId);
  }
  const minimumChangeFound = finalResult.eligible && diagnostics.length === 0;
  return {
    caseId: decisionCase.id,
    revision: decisionCase.revision,
    decisionHash: getDecisionHash(decisionCase),
    mode: "minimum_change",
    analysisKind: minimumChangeFound ? "deterministic_minimum_change_search" : "diagnostic_only",
    supported: minimumChangeFound,
    minimumChangeFound,
    exactOptimizationAvailable: minimumChangeFound && changes.every((change) => change.exactWithinDomain),
    originalDecisionUnchanged: true,
    alternativeId: options.alternativeId,
    targetStatus: options.targetStatus,
    baseline: {
      eligible: target.eligible,
      score: target.score,
      blockers: target.blockers.map((entry) => entry.criterionId),
    },
    result: {
      eligible: finalResult.eligible,
      score: finalResult.score,
      blockers: finalResult.blockers.map((entry) => entry.criterionId),
    },
    changes,
    totalNormalizedChange: roundedNumber(changes.reduce((sum, change) => sum + change.normalizedDelta, 0)),
    diagnostics,
    note: minimumChangeFound
      ? "The smallest independently modeled blocker changes were found within trusted finite domains; nothing was committed."
      : "Diagnostic only: at least one blocker has no trusted solvable domain, so no minimum-change solution is claimed.",
  };
}

function analysisFallback(mode, decisionCase, evaluation, options) {
  if (mode === "missing_evidence") {
    const paths = evaluation.paths.filter((path) => ["unknown", "conflict"].includes(path.status));
    return {
      caseId: decisionCase.id,
      revision: decisionCase.revision,
      mode,
      missing: paths.slice(0, 50),
      total: paths.length,
      blockingCount: evaluation.blockerCount,
    };
  }
  if (mode === "challenge") {
    const recommendation = evaluation.recommendation;
    const result = evaluation.results.find((entry) => entry.alternativeId === recommendation?.alternativeId);
    return {
      caseId: decisionCase.id,
      revision: decisionCase.revision,
      mode,
      recommendation: recommendation
        ? { alternativeId: recommendation.alternativeId, label: recommendation.alternative.label, score: recommendation.score }
        : null,
      materialChallenges: boundedArray(
        result?.criteria.filter((entry) => entry.status !== "pass").map((entry) => ({
          criterionId: entry.criterionId,
          status: entry.status,
          claimIds: entry.measurement.claimIds,
          sourceRefs: entry.measurement.sourceRefs,
        })),
        30,
      ),
      note: "This is a deterministic review of canonical blockers and uncertainty, not an autonomous reversal of the recommendation.",
    };
  }
  return { caseId: decisionCase.id, revision: decisionCase.revision, mode, supported: false };
}

export function createRuntimeWebMcpAdapter({
  runtime,
  imports,
  presentation,
  domainRegistry = createDefaultDomainRegistry(),
  reviewArtifacts = createReviewArtifactStore(),
  getWorkspaceContext,
  permissions = DEFAULT_PERMISSIONS,
} = {}) {
  assertMethod(runtime, "getWorkspaceState", "createRuntimeWebMcpAdapter");
  for (const method of ["getCase", "getActiveContract", "queryGraph", "evaluate", "executeCommand", "subscribe"]) {
    assertMethod(runtime, method, "createRuntimeWebMcpAdapter");
  }

  const adapter = {
    async getWorkspaceState() {
      const raw = await runtime.getWorkspaceState();
      const activeCaseId = raw.activeCaseId ?? null;
      const activeCase = activeCaseId ? await runtime.getCase(activeCaseId) : null;
      const importResult = imports ? await imports.listImports(activeCaseId) : raw.imports ?? [];
      const importEntries = Array.isArray(importResult) ? importResult : importResult.entries ?? [];
      const context = (await resolveMaybe(getWorkspaceContext, { raw, activeCase })) ?? {};
      const declaredPermissions = await resolveMaybe(context.permissions ?? permissions, { raw, activeCase });
      const frozen = Boolean(context.frozen ?? activeCase?.status === "approved");
      const phase = inferWorkspacePhase({
        explicit: context.phase ?? context.workspacePhase ?? raw.capabilityPhase ?? raw.workspacePhase,
        activeCase,
        imports: importEntries,
        frozen,
      });
      const presentationSnapshot = presentation ? await presentation.getPresentationSnapshot() : null;
      return {
        ...raw,
        workspacePhase: phase,
        activeCaseId,
        domainId: activeCase?.domain?.packId ?? null,
        domainRisk: riskForCase(activeCase, context),
        role: context.role ?? "decision-owner",
        permissions: Array.isArray(declaredPermissions) ? [...new Set(declaredPermissions)] : [],
        frozen,
        pendingHumanCheckpoint: Boolean(context.pendingHumanCheckpoint),
        governanceVersion: Number.isInteger(context.governanceVersion) ? context.governanceVersion : 0,
        sharedAuthorityAvailable: context.sharedAuthorityAvailable !== false,
        governedAgentMutationsBlocked: Boolean(context.governedAgentMutationsBlocked),
        decisionRevision: activeCase?.revision ?? 0,
        decisionHash: activeCase ? getDecisionHash(activeCase) : null,
        viewRevision: presentationSnapshot?.viewRevision ?? context.viewRevision ?? 0,
        viewHash: presentationSnapshot?.viewHash ?? context.viewHash ?? null,
        stagedSourceCount: Number(context.stagedSourceCount ?? 0),
        presentationCapabilities: presentationSnapshot?.capabilities,
      };
    },

    async getActiveContract(caseId) {
      const decisionCase = await runtime.getCase(caseId);
      if (!decisionCase) return null;
      return projectContract(decisionCase);
    },

    async queryGraph(query = {}) {
      const caseId = query.caseId ?? (await runtime.getWorkspaceState()).activeCaseId;
      const decisionCase = await runtime.getCase(caseId);
      if (!decisionCase) throw adapterError("NOT_FOUND", `Case '${caseId}' was not found.`);
      if (query.mode === "validate_model") {
        const diagnostics = validateDecisionCase(decisionCase);
        return {
          caseId,
          revision: decisionCase.revision,
          valid: diagnostics.every((entry) => entry.severity !== "error"),
          diagnostics: diagnostics.slice(0, 50),
          counts: {
            alternatives: decisionCase.alternatives.length,
            criteria: decisionCase.criteria.length,
            constraints: decisionCase.constraints.length,
            claims: decisionCase.claims.length,
          },
        };
      }
      if (query.mode === "replay_revision") {
        const events = typeof runtime.listEvents === "function" ? await runtime.listEvents(caseId) : [];
        const selected = events.filter((event) => event.revision === query.decisionRevision);
        return { caseId, decisionRevision: query.decisionRevision, ...paginate(selected, query) };
      }
      const evaluation = await runtime.evaluate(caseId);
      return graphPage(decisionCase, evaluation, query);
    },

    async evaluate(caseId, options = {}) {
      const decisionCase = await runtime.getCase(caseId);
      if (!decisionCase) throw adapterError("NOT_FOUND", `Case '${caseId}' was not found.`);
      const mode = options.mode ?? "evaluate";
      if (mode === "scenario") {
        const beforeHash = getDecisionHash(decisionCase);
        const transient = evaluateTransientDecision(decisionCase, options, domainRegistry);
        const savedScenarioApplied = Boolean(transient.savedScenario);
        const typedOverridesApplied = transient.appliedOverrides.length > 0;
        const analysisKind = savedScenarioApplied
          ? typedOverridesApplied ? "saved_scenario_with_typed_overrides" : "saved_scenario_evaluation"
          : "transient_typed_scenario";
        return {
          caseId,
          revision: decisionCase.revision,
          mode,
          analysisKind,
          supported: true,
          originalDecisionUnchanged: true,
          decisionHashBefore: beforeHash,
          decisionHashAfter: getDecisionHash(decisionCase),
          scenarioId: transient.savedScenario?.id ?? null,
          savedScenarioApplied,
          savedOverrideCount: Object.keys(transient.savedScenario?.claimOverrides ?? {}).length,
          savedAdditionalClaimCount: transient.savedScenario?.additionalClaims?.length ?? 0,
          overrideScope: savedScenarioApplied
            ? typedOverridesApplied
              ? "saved scenario values followed by typed refinements on selected alternatives"
              : "stored canonical scenario values on a transient decision clone"
            : "same typed metric value for each selected alternative",
          appliedOverrides: transient.appliedOverrides,
          evaluation: compactEvaluation(transient.evaluation, transient.alternativeIds),
          note: "Scenario values were evaluated only on a decision clone; the canonical case was not written.",
        };
      }
      if (mode === "compare_branches") {
        if (typeof runtime.evaluateScenario !== "function") {
          throw adapterError("CAPABILITY_UNSUPPORTED", "The runtime does not expose saved scenario evaluation.");
        }
        const branches = await Promise.all((options.branchIds ?? []).map(async (branchId) => {
          const result = await runtime.evaluateScenario(caseId, branchId);
          if (!result) throw adapterError("NOT_FOUND", `Scenario '${branchId}' was not found.`);
          return {
            branchId,
            recommendation: result.evaluation.recommendation
              ? {
                  alternativeId: result.evaluation.recommendation.alternativeId,
                  score: result.evaluation.recommendation.score,
                  eligible: result.evaluation.recommendation.eligible,
                }
              : null,
            blockerCount: result.evaluation.blockerCount,
            unresolvedCount: result.evaluation.unresolvedCount,
          };
        }));
        return { caseId, revision: decisionCase.revision, mode, originalDecisionUnchanged: true, branches };
      }
      const evaluation = await runtime.evaluate(caseId);
      if (decisionCase.domain.packId === "candidate-review") {
        if (mode === "evaluate") return candidateRequirementEvaluation(evaluation, options.alternativeIds);
        if (!["missing_evidence"].includes(mode)) {
          throw adapterError("POLICY_DENIED", "Candidate review exposes requirement evidence only; outcome, scenario, sensitivity, and minimum-change analysis are human-prohibited.");
        }
      }
      if (mode === "evaluate") return boundedEvaluation(evaluation, options.alternativeIds);
      const presentationSnapshot = presentation ? await presentation.getPresentationSnapshot() : null;
      if (mode === "sensitivity") {
        return runSensitivityAnalysis(decisionCase, evaluation, options, domainRegistry, presentationSnapshot);
      }
      if (mode === "minimum_change") {
        return solveMinimumChange(decisionCase, evaluation, options, domainRegistry, presentationSnapshot);
      }
      return analysisFallback(mode, decisionCase, evaluation, options);
    },

    async executeCommand(command, options = {}) {
      if (!DOTTED_COMMANDS.has(command?.type)) {
        throw adapterError("POLICY_DENIED", "Only the governed WebMCP draft-command catalog is accepted by this adapter.");
      }
      const caseId = command.caseId ?? options.caseId;
      const current = await runtime.getCase(caseId);
      if (!current) throw adapterError("NOT_FOUND", `Case '${caseId}' was not found.`);
      const latestAuthority = (await resolveMaybe(getWorkspaceContext, {
        raw: await runtime.getWorkspaceState(),
        activeCase: current,
      })) ?? {};
      if (latestAuthority.frozen) {
        throw adapterError("CASE_FROZEN", "Shared human governance froze this case before the mutation could execute.");
      }
      if (latestAuthority.pendingHumanCheckpoint) {
        throw adapterError("HUMAN_CHECKPOINT_REQUIRED", "A shared human-resolution checkpoint must close before decision mutations resume.");
      }
      assertRevision(current, options.expectedRevision);
      const mapped = mapDottedCommand(command, current, options, reviewArtifacts);
      if (mapped.stagedResult) return mapped.stagedResult;
      try {
        return await runtime.executeCommand(mapped.kernelCommand, {
          caseId,
          expectedRevision: options.expectedRevision,
          idempotencyKey: options.idempotencyKey,
          actor: actorRecord(options.actor),
        });
      } catch (error) {
        return normalizeRuntimeError(error);
      }
    },

    async getRecentChanges(caseId, options = {}) {
      const events = typeof runtime.listEvents === "function" ? await runtime.listEvents(caseId) : [];
      const artifacts = reviewArtifacts.list(caseId).map((artifact) => ({
        id: artifact.id,
        caseId,
        at: artifact.createdAt,
        type: "review-artifact.staged",
        action: artifact.kind,
        status: artifact.status,
      }));
      const entries = [...events, ...artifacts].sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
      return paginate(entries, options);
    },

    subscribe(listener) {
      const unsubscribeRuntime = runtime.subscribe(listener);
      const unsubscribeArtifacts = reviewArtifacts.subscribe(listener);
      return () => {
        unsubscribeRuntime?.();
        unsubscribeArtifacts?.();
      };
    },
  };
  return Object.freeze(adapter);
}

function isSafeRemoteUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw adapterError("VALIDATION_FAILED", "Import URL is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw adapterError("VALIDATION_FAILED", "Remote imports require HTTPS URLs.");
  }
  if (parsed.username || parsed.password) {
    throw adapterError("VALIDATION_FAILED", "Import URLs cannot contain embedded credentials.");
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    throw adapterError("VALIDATION_FAILED", "Private, loopback, and local-network import URLs are not allowed.");
  }
  return parsed.href;
}

function assertResolvedImportInput(value, label) {
  if (typeof value === "string" || value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (!value || typeof value !== "object") {
    throw adapterError("VALIDATION_FAILED", `${label} did not resolve to readable content.`);
  }
  if (typeof value.path === "string" || typeof value.url === "string") {
    throw adapterError("VALIDATION_FAILED", `${label} returned an unresolved path or URL instead of staged bytes or text.`);
  }
  const readable =
    typeof value.text === "string" ||
    value.bytes instanceof Uint8Array ||
    value.bytes instanceof ArrayBuffer ||
    typeof value.arrayBuffer === "function";
  if (!readable) throw adapterError("VALIDATION_FAILED", `${label} did not resolve to readable bytes or text.`);
  return value;
}

function projectImport(job) {
  if (!job) return job;
  const projected = clone(job);
  delete projected.startRequest;
  delete projected.intakeContext;
  delete projected.commitIntent;
  if (job.domainHint === CANDIDATE_REVIEW_PACK_ID && Array.isArray(projected.inputSummaries)) {
    projected.inputSummaries = projected.inputSummaries.map((summary, index) => ({
      ...summary,
      name: `Candidate source ${index + 1}`,
    }));
    projected.diagnostics = (projected.diagnostics ?? []).map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: "Candidate-source diagnostic retained without identifying source metadata.",
    }));
    if (projected.error) {
      projected.error = {
        code: projected.error.code ?? "IMPORT_ERROR",
        message: "Candidate-source import requires a human recovery decision.",
        ...(projected.error.details?.action ? { details: { action: projected.error.details.action } } : {}),
      };
    }
  }
  return {
    ...projected,
    jobId: job.id,
    version: job.version ?? 0,
    importVersion: job.version ?? 0,
    documentCount: job.documentIds?.length ?? 0,
    warningCount: job.diagnostics?.filter((entry) => entry.severity === "warning").length ?? 0,
  };
}

export function createImportWebMcpAdapter({
  importCoordinator,
  reviewArtifacts = createReviewArtifactStore(),
  resolveStagedSource,
  reserveImportCaseId,
  resolveCaseDomain,
  getCase,
  now = () => new Date().toISOString(),
} = {}) {
  assertMethod(importCoordinator, "startImport", "createImportWebMcpAdapter");
  for (const method of ["listImports", "getImport", "cancelImport", "inspectDocument", "searchFragments", "mapTableSchema", "retryImport", "subscribe"]) {
    assertMethod(importCoordinator, method, "createImportWebMcpAdapter");
  }
  const starts = new Map();
  const listeners = new Set();
  const unsubscribeCoordinator = importCoordinator.subscribe((event) => {
    for (const listener of listeners) listener(event);
  });
  const unsubscribeArtifacts = reviewArtifacts.subscribe((event) => {
    for (const listener of listeners) listener(event);
  });

  async function assertImportVersion(jobId, expected) {
    const job = await importCoordinator.getImport(jobId);
    if (!job) throw adapterError("NOT_FOUND", `Import '${jobId}' was not found.`);
    const current = job.version ?? 0;
    if (expected !== undefined && current !== expected) {
      throw adapterError("STALE_REVISION", "The import changed before this operation could run.", { currentImportVersion: current });
    }
    return job;
  }

  function sourceScopeError(message) {
    return adapterError("NOT_FOUND", message);
  }

  async function requireCanonicalCase(caseId) {
    if (!caseId) throw adapterError("VALIDATION_FAILED", "A caseId is required for every source read.");
    if (typeof getCase !== "function") {
      throw adapterError("CAPABILITY_UNSUPPORTED", "Canonical case evidence is not connected to this import adapter.");
    }
    const decisionCase = await getCase(caseId);
    if (!decisionCase) throw sourceScopeError(`Case '${caseId}' was not found.`);
    return decisionCase;
  }

  function canonicalDocuments(decisionCase) {
    return (decisionCase.documents ?? []).map((document) => ({
      ...clone(document),
      caseId: decisionCase.id,
      fingerprint: document.fingerprint ?? document.byteHash ?? null,
      blocks: (decisionCase.fragments ?? [])
        .filter((fragment) => fragment.documentId === document.id)
        .map(clone),
    }));
  }

  async function transientDocuments(caseId, jobId) {
    if (!jobId) throw adapterError("VALIDATION_FAILED", "A jobId is required for transient import-source reads.");
    const job = await importCoordinator.getImport(jobId);
    if (!job || !caseId || job.caseId !== caseId) {
      throw sourceScopeError("The requested import job is not part of the authorized case scope.");
    }
    if (!["review_required", "failed", "quarantined"].includes(job.phase)) {
      throw sourceScopeError("Transient import sources are available only while that import is in human review or recovery.");
    }
    const documents = [];
    for (const documentId of job.documentIds ?? []) {
      const document = await importCoordinator.inspectDocument(documentId);
      if (document?.id !== documentId || document.importId !== job.id || document.caseId !== caseId) {
        throw sourceScopeError("An import source failed its case and job ownership check.");
      }
      documents.push(document);
    }
    return { caseId, jobId: job.id, domainId: job.domainHint, documents };
  }

  async function sourceScope(caseId, jobId) {
    if (jobId) return transientDocuments(caseId, jobId);
    const decisionCase = await requireCanonicalCase(caseId);
    return {
      caseId: decisionCase.id,
      jobId: null,
      domainId: decisionCase.domain?.packId,
      documents: canonicalDocuments(decisionCase),
    };
  }

  function projectSourceDocuments(documents, domainId) {
    const safeDocuments = documents.map(clone);
    if (domainId === CANDIDATE_REVIEW_PACK_ID) return redactCandidateSourceDocuments(safeDocuments).documents;
    if (domainId === HEALTH_PLAN_PACK_ID) return redactHealthPlanSourceDocuments(safeDocuments).documents;
    return safeDocuments;
  }

  async function scopedDocuments({ caseId, jobId, documentIds } = {}) {
    const scope = await sourceScope(caseId, jobId);
    const projected = projectSourceDocuments(scope.documents, scope.domainId);
    if (!documentIds?.length) return { ...scope, documents: projected };
    const allowed = new Map(projected.map((document) => [document.id, document]));
    if (documentIds.some((documentId) => !allowed.has(documentId))) {
      throw sourceScopeError("One or more requested documents are outside the authorized source scope.");
    }
    return { ...scope, documents: documentIds.map((documentId) => allowed.get(documentId)) };
  }

  async function scopedDocument(documentId, options = {}) {
    const scoped = await scopedDocuments({
      caseId: options.caseId,
      jobId: options.jobId,
      documentIds: [documentId],
    });
    return { ...scoped, document: scoped.documents[0] };
  }

  async function resolveInput(input, signal) {
    if (input.kind === "inline_text") {
      return { value: { name: "agent-inline-text.txt", mimeType: "text/plain", text: input.text }, domainReservation: null };
    }
    if (input.kind === "staged_source") {
      if (typeof resolveStagedSource !== "function") {
        throw adapterError("CAPABILITY_UNSUPPORTED", "No staged-source resolver is connected to this workspace.");
      }
      const resolved = await resolveStagedSource(input.sourceId, { signal });
      const value = resolved?.input ?? resolved?.source ?? resolved;
      return {
        value: assertResolvedImportInput(value, `Staged source '${input.sourceId}'`),
        domainReservation: typeof resolved?.domainReservation === "string" ? resolved.domainReservation : null,
      };
    }
    if (input.kind === "url") {
      isSafeRemoteUrl(input.url);
      throw adapterError(
        "POLICY_DENIED",
        "Agents cannot initiate arbitrary outbound URL requests. A person must first fetch or stage the source locally and confirm its policy domain.",
      );
    }
    return { value: assertResolvedImportInput(input, "Import input"), domainReservation: null };
  }

  const adapter = {
    async startImport(inputs, options = {}) {
      if (!Array.isArray(inputs) || !inputs.length) throw adapterError("VALIDATION_FAILED", "At least one import input is required.");
      const key = options.idempotencyKey;
      const inputFingerprint = fingerprint({ inputs, caseId: options.caseId, domainHint: options.domainHint });
      const caseId = options.caseId ?? (typeof reserveImportCaseId === "function"
        ? await reserveImportCaseId({ domainHint: options.domainHint, actor: options.actor })
        : undefined);
      const authoritativeDomain = caseId && typeof resolveCaseDomain === "function"
        ? await resolveCaseDomain(caseId)
        : null;
      if (authoritativeDomain && options.domainHint && authoritativeDomain !== options.domainHint) {
        throw adapterError("POLICY_DENIED", `Import domain '${options.domainHint}' does not match the target case policy.`);
      }
      let effectiveDomain = authoritativeDomain ?? options.domainHint;
      let prior = key ? starts.get(key) : null;
      if (key && !prior) {
        const durable = (await importCoordinator.listImports()).find((entry) => entry.startRequest?.idempotencyKey === key);
        if (durable) prior = { fingerprint: durable.startRequest.fingerprint, jobId: durable.id };
      }
      if (key && prior) {
        if (prior.fingerprint !== inputFingerprint) {
          throw adapterError("IDEMPOTENCY_CONFLICT", "This import idempotency key was reused with different sources.");
        }
        starts.set(key, prior);
        return projectImport(await importCoordinator.getImport(prior.jobId));
      }
      const resolved = [];
      const reservations = new Set();
      let stagedReservationCount = 0;
      for (const input of inputs) {
        if (options.signal?.aborted) throw adapterError("EXECUTION_CANCELED", "The import was canceled before intake began.");
        const entry = await resolveInput(input, options.signal);
        resolved.push(entry.value);
        if (input.kind === "staged_source" && entry.domainReservation) {
          reservations.add(entry.domainReservation);
          stagedReservationCount += 1;
        }
      }
      const stagedInputCount = inputs.filter((input) => input.kind === "staged_source").length;
      if (authoritativeDomain && stagedInputCount) {
        if (
          stagedReservationCount !== stagedInputCount ||
          reservations.size !== 1 ||
          !reservations.has(authoritativeDomain)
        ) {
          throw adapterError(
            "POLICY_DENIED",
            "Every staged source must carry a human-confirmed policy domain matching the authoritative target case.",
            { authoritativeDomain },
          );
        }
      }
      if (!authoritativeDomain) {
        if (inputs.some((input) => input.kind !== "staged_source") || stagedReservationCount !== stagedInputCount || reservations.size !== 1) {
          throw adapterError(
            "POLICY_DENIED",
            "A new-case agent import requires only human-staged opaque sources carrying one confirmed policy-domain reservation.",
          );
        }
        const reservedDomain = [...reservations][0];
        if (!options.domainHint || options.domainHint !== reservedDomain) {
          throw adapterError(
            "POLICY_DENIED",
            "The declared import domain must exactly match the human-confirmed staged-source policy domain.",
            { reservedDomain },
          );
        }
        effectiveDomain = reservedDomain;
      }
      const job = await importCoordinator.startImport(resolved, {
        caseId,
        domainHint: effectiveDomain,
        actor: actorRecord(options.actor),
        intakeContext: { source: "agent" },
        ...(key ? { startRequest: { idempotencyKey: key, fingerprint: inputFingerprint } } : {}),
      });
      if (key) starts.set(key, { fingerprint: inputFingerprint, jobId: job.id });
      return projectImport(job);
    },

    async listImports(caseId, options = {}) {
      const jobs = await importCoordinator.listImports(caseId);
      const page = paginate(jobs, options);
      return {
        ...page,
        entries: page.entries.map((job) => projectImport(job)),
      };
    },

    async getImport(jobId) {
      const job = await importCoordinator.getImport(jobId);
      if (!job) throw adapterError("NOT_FOUND", `Import '${jobId}' was not found.`);
      return projectImport(job);
    },

    async cancelImport(jobId, options = {}) {
      const job = await assertImportVersion(jobId, options.expectedImportVersion);
      if (["complete", "committing"].includes(job.phase)) {
        throw adapterError("IMPORT_NOT_CANCELABLE", `Import '${jobId}' is already ${job.phase}.`);
      }
      const result = await importCoordinator.cancelImport(jobId);
      if (!result?.ok) throw adapterError("IMPORT_NOT_CANCELABLE", `Import '${jobId}' can no longer be canceled.`);
      return projectImport(result.job);
    },

    async inspectDocument(documentId, options = {}) {
      const scoped = await scopedDocument(documentId, options);
      const { document } = scoped;
      const blocks = options.includeRegions === false ? [] : document.blocks ?? [];
      const page = paginate(blocks, options);
      return {
        id: document.id,
        documentId: document.id,
        caseId: document.caseId,
        name: boundedText(document.name, 240),
        format: document.format,
        mimeType: document.mimeType,
        size: document.size,
        fingerprint: document.fingerprint,
        securityStatus: document.securityStatus,
        diagnostics: boundedArray(document.diagnostics, 50),
        metadata: clone(document.metadata ?? {}),
        regions: page.entries.map((block) => ({
          anchor: block.id,
          kind: block.kind,
          locator: clone(block.locator),
          excerpt: boundedText(block.text, 800),
          confidence: block.confidence,
        })),
        regionCount: blocks.length,
        nextCursor: page.nextCursor,
        sourceScope: {
          kind: scoped.jobId ? "import_job" : "canonical_case",
          caseId: scoped.caseId,
          ...(scoped.jobId ? { jobId: scoped.jobId } : {}),
        },
      };
    },

    async searchFragments(input = {}) {
      const sanitizedNeedle = String(input.query ?? input.text ?? "").trim().toLocaleLowerCase();
      if (!sanitizedNeedle) throw adapterError("VALIDATION_FAILED", "Search text is required.");
      const scoped = await scopedDocuments({
        caseId: input.caseId,
        jobId: input.jobId,
        documentIds: input.documentIds,
      });
      const projectedResults = [];
      for (const document of scoped.documents) {
        for (const block of document.blocks ?? []) {
          const blockText = String(block.text ?? "");
          const matchIndex = blockText.toLocaleLowerCase().indexOf(sanitizedNeedle);
          if (
            matchIndex < 0 ||
            block.metadata?.protectedFieldRedacted === true ||
            block.metadata?.candidateSourceWithheld === true ||
            block.metadata?.candidateIdentifierBlinded === true ||
            block.metadata?.healthSourceWithheld === true
          ) continue;
          projectedResults.push({
            documentId: document.id,
            documentName: boundedText(document.name, 240),
            fragmentId: block.id,
            kind: block.kind,
            locator: clone(block.locator),
            excerpt: boundedText(
              blockText.slice(Math.max(0, matchIndex - 80), Math.min(blockText.length, matchIndex + sanitizedNeedle.length + 80)),
              800,
            ),
            confidence: block.confidence,
          });
        }
      }
      const page = paginate(projectedResults, input);
      return {
        results: page.entries,
        total: page.total,
        nextCursor: page.nextCursor,
        truncated: page.nextCursor !== null,
        sourceScope: {
          kind: scoped.jobId ? "import_job" : "canonical_case",
          caseId: scoped.caseId,
          ...(scoped.jobId ? { jobId: scoped.jobId } : {}),
        },
      };
    },

    async readSourceSpans(documentId, anchors, options = {}) {
      const scoped = await scopedDocument(documentId, options);
      const { document } = scoped;
      const wanted = new Set(anchors);
      const spans = (document.blocks ?? [])
        .filter((block) => wanted.has(block.id))
        .slice(0, 20)
        .map((block) => ({
          documentId,
          anchor: block.id,
          kind: block.kind,
          locator: clone(block.locator),
          text: boundedText(block.text, 2_000),
          confidence: block.confidence,
          untrusted: true,
        }));
      const missingAnchors = anchors.filter((anchor) => !spans.some((span) => span.anchor === anchor));
      return {
        documentId,
        spans,
        missingAnchors,
        sourceScope: {
          kind: scoped.jobId ? "import_job" : "canonical_case",
          caseId: scoped.caseId,
          ...(scoped.jobId ? { jobId: scoped.jobId } : {}),
        },
      };
    },

    async mapTableSchema(documentId, mapping, options = {}) {
      const job = await assertImportVersion(options.jobId, options.expectedImportVersion);
      const scope = await transientDocuments(job.caseId, job.id);
      if (!scope.documents.some((document) => document.id === documentId)) {
        throw sourceScopeError("The selected document is outside the authorized import job.");
      }
      const canonicalMapping = {
        sheetName: options.sheetName ?? null,
        headerRow: options.headerRow ?? 1,
        columns: Object.fromEntries(mapping.map((entry) => [
          entry.sourceColumn,
          { targetField: entry.targetField, semanticType: entry.semanticType },
        ])),
      };
      const result = await importCoordinator.mapTableSchema(documentId, canonicalMapping, {
        expectedImportVersion: options.expectedImportVersion,
        expectedImportId: job.id,
      });
      const updatedJob = await importCoordinator.getImport(job.id);
      const updatedDocument = await importCoordinator.inspectDocument(documentId);
      if (!updatedJob || updatedDocument.importId !== job.id || updatedDocument.caseId !== job.caseId) {
        throw sourceScopeError("The mapped document failed its import job ownership check.");
      }
      const event = {
        type: "import.mapping_changed",
        jobId: job.id,
        documentId,
        importVersion: updatedJob.version ?? 0,
      };
      for (const listener of listeners) listener(event);
      return {
        ok: true,
        jobId: job.id,
        documentId,
        mapping: result,
        importVersion: updatedJob.version ?? 0,
      };
    },

    ...(typeof importCoordinator.stageSemanticSuggestions === "function" ? {
      async proposeSemanticMapping(jobId, suggestions, options = {}) {
        const job = await assertImportVersion(jobId, options.expectedImportVersion);
        const scope = await transientDocuments(job.caseId, job.id);
        const knownFragments = new Set(scope.documents.flatMap((document) =>
          (document.blocks ?? []).map((block) => `${document.id}\u0000${block.id}`),
        ));
        for (const suggestion of suggestions) {
          for (const reference of suggestion.sourceRefs ?? []) {
            if (!knownFragments.has(`${reference.documentId}\u0000${reference.fragmentId}`)) {
              throw sourceScopeError("A semantic suggestion cites a fragment outside the authorized import job.");
            }
          }
        }
        const updated = await importCoordinator.stageSemanticSuggestions(jobId, suggestions, {
          expectedImportVersion: options.expectedImportVersion,
        });
        return {
          ok: true,
          jobId,
          caseId: updated.caseId,
          importVersion: updated.version,
          suggestionCount: suggestions.length,
          awaitingHuman: true,
          announcement: `${suggestions.length} semantic ${suggestions.length === 1 ? "suggestion is" : "suggestions are"} visible for human review.`,
        };
      },
    } : {}),

    async retryImport(jobId, options = {}) {
      await assertImportVersion(jobId, options.expectedImportVersion);
      try {
        const retried = await importCoordinator.retryImport(jobId);
        return projectImport(retried);
      } catch (error) {
        return normalizeRuntimeError(error);
      }
    },

    async requestHumanReview(input) {
      const job = await importCoordinator.getImport(input.jobId);
      if (!job) throw adapterError("NOT_FOUND", `Import '${input.jobId}' was not found.`);
      const staged = reviewArtifacts.stage({
        kind: "import_review_request",
        caseId: job.caseId,
        payload: { jobId: job.id, note: input.note ?? "", importVersion: job.version ?? 0 },
        reason: "A person must inspect source diagnostics and explicitly accept or reject the import.",
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        decisionRevision: null,
        decisionHash: null,
      });
      return { ok: true, awaitingHuman: true, artifact: staged.artifact, receipt: staged.receipt };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      unsubscribeCoordinator?.();
      unsubscribeArtifacts?.();
      listeners.clear();
    },
  };
  return Object.freeze(adapter);
}

function translateIntent(intent) {
  if (["compare", "simulate", "brief", "explain"].includes(intent)) return intent;
  if (intent === "investigate") return "explain";
  throw adapterError("VALIDATION_FAILED", `Unsupported presentation intent '${String(intent)}'.`);
}

function translateInstrumentOptions(instrument) {
  const definition = getInstrumentDefinition(instrument.type);
  if (!definition) throw adapterError("VALIDATION_FAILED", `Unknown trusted instrument '${instrument.type}'.`);
  const source = instrument.options ?? {};
  const translated = {};
  if (definition.optionKeys.includes("compact") && source.compact !== undefined) translated.compact = source.compact;
  if (definition.optionKeys.includes("density") && source.compact !== undefined) {
    translated.density = source.compact ? "compact" : "standard";
  }
  if (definition.optionKeys.includes("showCitations") && source.showSources !== undefined) {
    translated.showCitations = source.showSources;
  }
  if (definition.optionKeys.includes("sort")) {
    if (source.sortBy === "status") translated.sort = "status";
    else if (source.sortBy === "label") translated.sort = "label";
    else if (source.sortBy === "value") translated.sort = source.sortDirection === "asc" ? "value-asc" : "value-desc";
  }
  return translated;
}

function snapshotHasRef(snapshot, reference) {
  if (!reference) return false;
  const collections = [
    ...(snapshot.entities ?? []),
    ...(snapshot.results ?? []),
    ...(snapshot.sources ?? []),
  ];
  return collections.some((entry) => (entry.kind ?? "entity") === reference.kind && entry.id === reference.id);
}

export function translatePresentationRecipeV1(input, snapshot) {
  assertObject(input, "WebMCP presentation recipe");
  if (input.recipeVersion !== 1) throw adapterError("VALIDATION_FAILED", "Only WebMCP presentation recipeVersion 1 is supported.");
  if (!snapshot || typeof snapshot !== "object") throw adapterError("CAPABILITY_UNSUPPORTED", "No presentation snapshot is available.");
  if (!LAYOUT_PATTERN_BY_LENS[input.lens]) throw adapterError("VALIDATION_FAILED", `Unsupported lens '${String(input.lens)}'.`);
  if (!DENSITIES.includes(input.density)) throw adapterError("VALIDATION_FAILED", `Unsupported density '${String(input.density)}'.`);
  if (input.layoutId !== LAYOUT_PATTERN_BY_LENS[input.lens]) {
    throw adapterError("VALIDATION_FAILED", `${input.lens} compositions must use the ${LAYOUT_PATTERN_BY_LENS[input.lens]} layout.`);
  }
  if (typeof input.framing === "string" && input.framing.length > 180) {
    throw adapterError("VALIDATION_FAILED", "Presentation framing cannot exceed 180 characters in the trusted recipe schema.");
  }
  const focusPath = input.focusPathIds?.find((pathId) => snapshot.paths?.some((path) => path.id === pathId));
  if (input.focusPathIds?.length && !focusPath) {
    throw adapterError("NOT_FOUND", "None of the requested focus paths exists in the current canonical graph.");
  }
  const instruments = input.instruments.map((instrument) => {
    if (!REGIONS.includes(instrument.region)) throw adapterError("VALIDATION_FAILED", `Unsupported instrument region '${instrument.region}'.`);
    const entityRefs = [...instrument.entityRefs];
    for (const metricId of instrument.options?.metricIds ?? []) {
      const reference = { kind: "criterion", id: metricId };
      if (snapshotHasRef(snapshot, reference) && !entityRefs.some((entry) => entry.kind === reference.kind && entry.id === reference.id)) {
        entityRefs.push(reference);
      }
    }
    const translated = {
      id: instrument.id,
      type: instrument.type,
      region: instrument.region,
      priority: instrument.priority,
      entityRefs,
      options: translateInstrumentOptions(instrument),
    };
    if (focusPath && instrument.type === "causal-trace") translated.pathId = focusPath;
    return translated;
  });
  const focusEntity = instruments.flatMap((instrument) => instrument.entityRefs).find((reference) => snapshotHasRef(snapshot, reference));
  return {
    schemaVersion: "1.0",
    recipeId: safeId("webmcp-recipe", fingerprint(input).slice(-24)),
    intent: translateIntent(input.intent),
    lens: input.lens,
    question: input.question,
    ...(input.framing !== undefined ? { framing: input.framing } : {}),
    layout: { pattern: input.layoutId, density: input.density },
    instruments,
    ...((focusEntity || focusPath)
      ? { focus: { ...(focusEntity ? { entityRef: focusEntity } : {}), ...(focusPath ? { pathId: focusPath } : {}) } }
      : {}),
    expectedDecisionRevision: input.expectedDecisionRevision,
    expectedViewRevision: input.expectedViewRevision,
  };
}

export function createPresentationWebMcpAdapter({ presentation, reviewArtifacts = createReviewArtifactStore() } = {}) {
  for (const method of ["getPresentationSnapshot", "applyPresentationRecipe", "focusEntity", "saveView", "restoreViewRevision"]) {
    assertMethod(presentation, method, "createPresentationWebMcpAdapter");
  }
  let latestPlan = null;
  let latestLens = "investigate";

  async function getSnapshot() {
    const snapshot = await presentation.getPresentationSnapshot();
    const effectiveLens = latestPlan?.lens ?? snapshot?.lens ?? latestLens;
    const declaredByLens = snapshot?.capabilities?.instrumentTypesByLens;
    const instrumentTypesByLens = Object.fromEntries(
      Object.keys(LAYOUT_PATTERN_BY_LENS).map((lens) => {
        const governed = getInstrumentCapabilities(snapshot, { lens });
        const declared = declaredByLens?.[lens];
        return [
          lens,
          Array.isArray(declared)
            ? declared.filter((type) => governed.includes(type))
            : governed,
        ];
      }),
    );
    const instrumentTypes = instrumentTypesByLens[effectiveLens] ?? [];
    return {
      ...snapshot,
      lens: effectiveLens,
      layoutId: latestPlan?.layout?.pattern ?? snapshot?.layoutId ?? LAYOUT_PATTERN_BY_LENS[latestLens],
      density: latestPlan?.layout?.density ?? snapshot?.density ?? "balanced",
      question: latestPlan?.question ?? snapshot?.question ?? snapshot?.contract?.question,
      framing: latestPlan?.framing ?? snapshot?.framing,
      viewHash: latestPlan?.viewHash ?? snapshot?.viewHash ?? null,
      renderedInstrumentIds: latestPlan?.instruments?.map((instrument) => instrument.id) ?? snapshot?.renderedInstrumentIds ?? [],
      preservedPins: latestPlan?.preservedPins?.length ?? snapshot?.pins?.length ?? 0,
      omittedEntityCount: latestPlan?.omitted?.entityCount ?? snapshot?.protected?.omittedEntityCount ?? 0,
      capabilities: {
        ...(snapshot?.capabilities ?? {}),
        instrumentTypes,
        instrumentTypesByLens,
        layoutIds: snapshot?.capabilities?.layoutIds ?? Object.values(LAYOUT_PATTERN_BY_LENS),
        regions: snapshot?.capabilities?.regions ?? [...REGIONS],
      },
    };
  }

  const adapter = {
    getPresentationSnapshot: getSnapshot,

    async applyPresentationRecipe(input, actor) {
      const before = await getSnapshot();
      const recipe = translatePresentationRecipeV1(input, before);
      let applied;
      try {
        applied = await presentation.applyPresentationRecipe(recipe, actor);
      } catch (error) {
        return normalizeRuntimeError(error);
      }
      if (applied?.ok === false) return applied;
      const plan = applied?.plan ?? applied?.data?.plan;
      if (!plan) throw adapterError("INTERNAL_ERROR", "The presentation port did not return a compiled plan.");
      latestPlan = plan;
      latestLens = plan.lens;
      const after = await getSnapshot();
      if (after.decisionRevision !== before.decisionRevision || after.decisionHash !== before.decisionHash) {
        throw adapterError("POLICY_DENIED", "The presentation port violated decision/presentation revision separation.");
      }
      return {
        ok: true,
        planId: plan.planId,
        viewHash: plan.viewHash,
        decisionHashBefore: before.decisionHash,
        decisionHashAfter: after.decisionHash,
        baseDecisionRevision: plan.baseDecisionRevision,
        baseViewRevision: plan.baseViewRevision,
        nextViewRevision: plan.nextViewRevision,
        renderedInstrumentIds: plan.instruments.map((instrument) => instrument.id),
        preservedPins: plan.preservedPins,
        warnings: plan.warnings ?? [],
        omitted: plan.omitted ?? { instrumentIds: [], entityCount: 0 },
        receipt: {
          ...(applied.receipt ?? {}),
          revisionBefore: before.decisionRevision,
          revisionAfter: after.decisionRevision,
          decisionHashBefore: before.decisionHash,
          decisionHashAfter: after.decisionHash,
          viewRevisionBefore: before.viewRevision,
          viewRevisionAfter: after.viewRevision,
          changedEntityIds: [],
        },
        message: `The ${plan.lens} room is visible at view revision ${after.viewRevision}.`,
      };
    },

    focusEntity(reference, pathId) {
      return presentation.focusEntity(reference, pathId);
    },

    saveView(input) {
      return presentation.saveView(input);
    },

    async restoreViewRevision(targetViewRevision) {
      const result = await presentation.restoreViewRevision(targetViewRevision);
      const snapshot = await getSnapshot();
      if (snapshot.lens) latestLens = snapshot.lens;
      return result;
    },

    async requestHumanCheckpoint(input) {
      if (typeof presentation.requestHumanCheckpoint === "function") {
        return presentation.requestHumanCheckpoint(input);
      }
      const snapshot = await getSnapshot();
      const { signal: _signal, actor: _actor, ...checkpoint } = input;
      const staged = reviewArtifacts.stage({
        kind: "human_checkpoint",
        caseId: snapshot.caseId,
        payload: clone(checkpoint),
        reason: "The agent requested a visible human decision checkpoint.",
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        decisionRevision: snapshot.decisionRevision,
        decisionHash: snapshot.decisionHash,
      });
      return { ok: true, awaitingHuman: true, artifact: staged.artifact, receipt: staged.receipt };
    },

    async waitForSettled(options) {
      if (typeof presentation.waitForSettled === "function") return presentation.waitForSettled(options);
      return { settled: true, viewRevision: (await getSnapshot()).viewRevision };
    },

    subscribe(listener) {
      const unsubscribePresentation = presentation.subscribe?.(listener);
      const unsubscribeArtifacts = reviewArtifacts.subscribe(listener);
      return () => {
        unsubscribePresentation?.();
        unsubscribeArtifacts?.();
      };
    },
  };
  return Object.freeze(adapter);
}

function assertOutputRevision(decisionCase, expectedRevision) {
  if (expectedRevision !== decisionCase.revision) {
    throw adapterError("STALE_REVISION", "The decision changed before this output could be prepared.", {
      currentDecisionRevision: decisionCase.revision,
    });
  }
}

function decisionPacketPreview(decisionCase, evaluation, input) {
  const candidateReview = decisionCase.domain.packId === "candidate-review";
  return {
    status: "preview",
    executable: false,
    caseId: decisionCase.id,
    format: input.format,
    decisionRevision: decisionCase.revision,
    decisionHash: getDecisionHash(decisionCase),
    title: boundedText(decisionCase.title, 240),
    question: boundedText(decisionCase.contract.question, 500),
    objective: boundedText(decisionCase.contract.objective, 500),
    ...(!candidateReview ? {
      recommendation: evaluation.recommendation
        ? {
            alternativeId: evaluation.recommendation.alternativeId,
            label: boundedText(evaluation.recommendation.alternative.label, 160),
            score: evaluation.recommendation.score,
            eligible: evaluation.recommendation.eligible,
          }
        : null,
    } : {}),
    alternatives: evaluation.results.slice(0, 12).map((result) => candidateReview
      ? {
          id: result.alternativeId,
          label: boundedText(result.alternative.label, 160),
          requirementCount: result.criteria.length,
          unresolvedRequirementCount: result.criteria.filter((entry) => ["unknown", "conflict"].includes(entry.status)).length,
        }
      : {
          id: result.alternativeId,
          label: boundedText(result.alternative.label, 160),
          eligible: result.eligible,
          score: result.score,
          blockerCount: result.blockers.length,
        }),
    ...(!candidateReview ? { blockerCount: evaluation.blockerCount } : {}),
    unresolvedCount: evaluation.unresolvedCount,
    sourceCount: decisionCase.fragments.length,
    includeAppendix: Boolean(input.includeAppendix),
    note: "Preview only. No file was written, downloaded, published, or sent.",
  };
}

export function createOutputWebMcpAdapter({
  runtime,
  reviewArtifacts = createReviewArtifactStore(),
  handlers = {},
} = {}) {
  assertMethod(runtime, "getCase", "createOutputWebMcpAdapter");
  assertMethod(runtime, "evaluate", "createOutputWebMcpAdapter");

  async function caseContext(input) {
    const decisionCase = await runtime.getCase(input.caseId);
    if (!decisionCase) throw adapterError("NOT_FOUND", `Case '${input.caseId}' was not found.`);
    assertOutputRevision(decisionCase, input.expectedDecisionRevision);
    return { decisionCase, evaluation: await runtime.evaluate(input.caseId) };
  }

  async function delegateOrStage(method, input, invocation, kind, payload, reason) {
    const context = await caseContext(input);
    const policy = assessAgentArtifact({
      ...context,
      texts: method === "draftRequest"
        ? [input.purpose]
        : method === "prepareExternalAction" ? [input.actionType, input.summary] : [],
      entityRefs: input.entityRefs ?? [],
    });
    if (!policy.ok) throw adapterError(policy.code, policy.message);
    if (typeof handlers?.[method] === "function") {
      return handlers[method](input, { ...invocation, ...context });
    }
    const { decisionCase } = context;
    const staged = reviewArtifacts.stage({
      kind,
      caseId: decisionCase.id,
      payload,
      reason,
      actor: invocation?.actor,
      idempotencyKey: input.idempotencyKey,
      decisionRevision: decisionCase.revision,
      decisionHash: getDecisionHash(decisionCase),
    });
    return {
      ok: true,
      status: "draft",
      awaitingHuman: true,
      executable: false,
      artifact: staged.artifact,
      receipt: staged.receipt,
      message: "A bounded draft is visible for human review; nothing was sent or submitted.",
    };
  }

  const adapter = {
    async previewDecisionPacket(input, invocation) {
      const { decisionCase, evaluation } = await caseContext(input);
      if (typeof handlers.previewDecisionPacket === "function") {
        return handlers.previewDecisionPacket(input, { ...invocation, decisionCase, evaluation });
      }
      return decisionPacketPreview(decisionCase, evaluation, input);
    },

    async exportCase(input, invocation) {
      return delegateOrStage(
        "exportCase",
        input,
        invocation,
        "case_export_draft",
        {
          format: input.format,
          manifest: { caseId: input.caseId, decisionRevision: input.expectedDecisionRevision },
          requiresManualExport: true,
        },
        "A trusted local exporter is not connected; this manifest is staged for the visible manual export flow.",
      );
    },

    async draftRequest(input, invocation) {
      const refs = boundedArray(input.entityRefs, 30).map((reference) => `${reference.kind}:${reference.id}`);
      return delegateOrStage(
        "draftRequest",
        input,
        invocation,
        "information_request_draft",
        {
          recipientRole: boundedText(input.recipientRole, 120),
          purpose: boundedText(input.purpose, 500),
          entityRefs: boundedArray(input.entityRefs, 30),
          body: boundedText(
            `Request for ${input.recipientRole}\n\nPurpose: ${input.purpose}${refs.length ? `\n\nReferenced records: ${refs.join(", ")}` : ""}\n\nDraft only. This request has not been sent.`,
            1_800,
          ),
        },
        "Requests remain drafts until a person selects a recipient and sends them through an approved channel.",
      );
    },

    async prepareExternalAction(input, invocation) {
      if (PROHIBITED_EXTERNAL_ACTION.test(input.actionType)) {
        throw adapterError("POLICY_DENIED", "This action type would cross a prohibited human-authority or external-execution boundary.");
      }
      return delegateOrStage(
        "prepareExternalAction",
        input,
        invocation,
        "external_action_draft",
        {
          actionType: input.actionType,
          summary: boundedText(input.summary, 700),
          entityRefs: boundedArray(input.entityRefs, 30),
          executable: false,
          submitted: false,
        },
        "External actions require explicit human review and execution outside the agent capability gateway.",
      );
    },

    subscribe(listener) {
      const unsubscribeHandler = handlers.subscribe?.(listener);
      const unsubscribeArtifacts = reviewArtifacts.subscribe(listener);
      return () => {
        unsubscribeHandler?.();
        unsubscribeArtifacts?.();
      };
    },
  };
  return Object.freeze(adapter);
}

export function createWebMcpPorts({
  runtime,
  domainRegistry,
  importCoordinator,
  presentation,
  getWorkspaceContext,
  resolveStagedSource,
  reserveImportCaseId,
  reviewArtifacts = createReviewArtifactStore(),
  outputs,
  outputHandlers,
  permissions = DEFAULT_PERMISSIONS,
  now,
} = {}) {
  if (!runtime) throw new TypeError("createWebMcpPorts requires a DecisionRuntime-compatible runtime.");
  const presentationAdapter = presentation
    ? createPresentationWebMcpAdapter({ presentation, reviewArtifacts })
    : undefined;
  const importAdapter = importCoordinator
    ? createImportWebMcpAdapter({
        importCoordinator,
        reviewArtifacts,
        resolveStagedSource,
        reserveImportCaseId,
        resolveCaseDomain: async (caseId) => (await runtime.getCase(caseId))?.domain?.packId ?? null,
        getCase: (caseId) => runtime.getCase(caseId),
        ...(now ? { now } : {}),
      })
    : undefined;
  const runtimeAdapter = createRuntimeWebMcpAdapter({
    runtime,
    imports: importAdapter,
    presentation: presentationAdapter,
    ...(domainRegistry ? { domainRegistry } : {}),
    reviewArtifacts,
    getWorkspaceContext,
    permissions,
  });
  const outputAdapter = createOutputWebMcpAdapter({
    runtime,
    reviewArtifacts,
    handlers: outputHandlers ?? outputs ?? {},
  });
  return Object.freeze({
    runtime: runtimeAdapter,
    ...(importAdapter ? { imports: importAdapter } : {}),
    ...(presentationAdapter ? { presentation: presentationAdapter } : {}),
    outputs: outputAdapter,
    reviewArtifacts,
  });
}

export const WEBMCP_ADAPTER_DEFAULTS = Object.freeze({
  permissions: DEFAULT_PERMISSIONS,
  trustedInstrumentTypes: TRUSTED_INSTRUMENT_TYPES,
  layoutPatternByLens: LAYOUT_PATTERN_BY_LENS,
  regions: REGIONS,
});
