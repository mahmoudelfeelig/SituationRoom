import { useSyncExternalStore } from "react";
import {
  DecisionRuntime,
  ERROR_CODES,
  getDecisionHash,
  SituationRoomError,
} from "../kernel/index.js";
import {
  createCandidateReviewFixture,
  createDefaultDomainRegistry,
  createGenericFixture,
  createHealthPlanFixture,
  createProcurementFixture,
} from "../domain-packs/index.js";
import { COMMIT_STATUSES, IndexedDbRepository, MemoryRepository } from "../persistence/index.js";
import { ImportCoordinator } from "../import/index.js";
import {
  compilePresentation,
  getInstrumentCapabilities,
  listLayoutDefinitions,
  REGIONS,
} from "../presentation/index.js";
import { createPresentationRecipe } from "./questionCompiler.js";
import { DOMAIN_CONFIG, getDomainConfig } from "./domainConfig.js";
import { toPresentationSnapshot } from "./presentationAdapter.js";
import { proposeCaseFromDocuments } from "./importMapper.js";
import { createDecisionPacket, serializeDecisionPacket } from "./exporter.js";
import { assessAgentArtifact } from "./agentArtifactPolicy.js";
import { proposeSemanticIntake } from "./semanticIntake.js";
import { clearWebMcpJournalDatabase } from "../webmcp.js";
import { phaseForWorkspaceRoute, workspacePathFor } from "./workspaceRouter.js";
import {
  createAgentActivityState,
  diffPresentationPlans,
  reduceAgentActivity,
} from "./agentActivity.js";

const PRESENTATION_STORAGE_KEY = "situation-room:presentation:v2";
const ACTIVE_CASE_STORAGE_KEY = "situation-room:active-case:v1";
const WEBMCP_INVOCATION_STORAGE_KEY = "situation-room:webmcp-invocations:v1";
const WEBMCP_RECEIPT_STORAGE_KEY = "situation-room:webmcp-receipts:v1";
const WORKSPACE_DATABASE_NAME = "situation-room-os-v2";
const MAX_PREPARED_OUTPUTS = 20;
const ACTOR = Object.freeze({ type: "human", id: "local-decision-owner" });
const WORKSPACE_PHASES = new Set(["contract_draft", "analysis", "collaboration", "output"]);

const listeners = new Set();
let runtime = null;
let repository = null;
let importCoordinator = null;
let initializationPromise = null;
let compositionToken = 0;
let governanceBroadcast = null;
let outputPreparationQueue = Promise.resolve();
let caseLoadQueue = Promise.resolve();
let latestCaseLoadToken = 0;
const sessionStateWriteQueues = new Map();
const sessionStateCache = new Map();
const stagedSources = new Map();
let stagedSourceIds = new WeakMap();
const pendingImportReviewContexts = new Map();
const importReviewBuilds = new Map();

const initialState = Object.freeze({
  bootStatus: "booting",
  bootError: null,
  persistenceMode: "initializing",
  persistenceWarning: null,
  workspace: { activeCaseId: null, cases: [], imports: [], domainPacks: [] },
  activeCase: null,
  evaluation: null,
  snapshot: null,
  plan: null,
  viewRevision: 1,
  lens: "investigate",
  capabilityPhase: "analysis",
  navigationSurface: "case",
  question: "",
  compositionPhase: "idle",
  compositionMessage: "",
  presentationDiff: diffPresentationPlans(null, null),
  agentActivity: createAgentActivityState(),
  frozen: false,
  governance: { id: null, version: 0, manualFrozen: false, humanCheckpoints: [] },
  pins: [],
  focusRef: null,
  activePathId: null,
  history: [],
  historyCursor: -1,
  receipts: [],
  reviewArtifacts: [],
  pendingModelProposal: null,
  outputArtifacts: [],
  activeImportReview: null,
  stagedSourceCount: 0,
  stagedDomainReservation: null,
  sourceDrawerOpen: false,
  outlineOpen: false,
  intakeOpen: false,
  auditOpen: false,
  approvalOpen: false,
  approvalTargetId: null,
  reducedMotion: false,
  webMcp: { available: false, toolCount: 0, activeTools: [], reason: "Detecting browser capabilities" },
  activeScenario: null,
  scenarioResult: null,
  lastAnnouncement: "Starting the decision runtime.",
  error: null,
});

let state = { ...initialState };

const OPEN_HUMAN_RESOLUTION_STATUSES = new Set(["awaiting-human", "under-human-review"]);

function artifactsHavePendingHumanResolution(artifacts) {
  return artifacts.some((artifact) =>
    artifact.kind === "human_resolution_request" && OPEN_HUMAN_RESOLUTION_STATUSES.has(artifact.status),
  );
}

function governanceHasPendingHumanResolution(governance) {
  return (governance?.humanCheckpoints ?? []).some((checkpoint) => OPEN_HUMAN_RESOLUTION_STATUSES.has(checkpoint.status));
}

function mergeGovernanceArtifacts(artifacts, governance) {
  const byId = new Map((artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  for (const checkpoint of governance?.humanCheckpoints ?? []) {
    byId.set(checkpoint.id, { ...(byId.get(checkpoint.id) ?? {}), ...checkpoint });
  }
  return [...byId.values()]
    .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")))
    .slice(0, 100);
}

function hasPendingHumanResolution(artifacts = state.reviewArtifacts) {
  return governanceHasPendingHumanResolution(state.governance) || artifactsHavePendingHumanResolution(artifacts);
}

export function hasPendingHumanCheckpoint() {
  return Boolean(state.approvalOpen || state.activeImportReview || hasPendingHumanResolution());
}

function defaultGovernance(caseId) {
  return { id: caseId, version: 0, manualFrozen: false, humanCheckpoints: [] };
}

async function readGovernance(caseId = state.activeCase?.id) {
  if (!caseId || !repository?.getGovernance) return defaultGovernance(caseId ?? null);
  return (await repository.getGovernance(caseId)) ?? defaultGovernance(caseId);
}

async function mutateGovernance(caseId, transform, { notify = true } = {}) {
  if (!caseId || !repository?.commitGovernanceMutation) throw new Error("Durable case governance is unavailable.");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readGovernance(caseId);
    const patch = transform({
      ...current,
      humanCheckpoints: structuredClone(current.humanCheckpoints ?? []),
    });
    const nextGovernance = {
      ...current,
      ...patch,
      id: caseId,
      version: current.version + 1,
      manualFrozen: Boolean(patch?.manualFrozen ?? current.manualFrozen),
      humanCheckpoints: structuredClone(patch?.humanCheckpoints ?? current.humanCheckpoints ?? []).slice(-100),
      updatedAt: new Date().toISOString(),
    };
    const result = await repository.commitGovernanceMutation({
      caseId,
      expectedVersion: current.version,
      nextGovernance,
    });
    if (result.status === COMMIT_STATUSES.COMMITTED) {
      if (notify && state.persistenceMode === "durable") {
        governanceBroadcast?.postMessage({ type: "governance.changed", caseId, version: nextGovernance.version });
      }
      return nextGovernance;
    }
    if (result.status !== COMMIT_STATUSES.STALE) throw new Error("Case governance could not be committed.");
  }
  throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "Case governance changed repeatedly; review the latest shared authority state and retry.");
}

async function refreshActiveGovernance(caseId = state.activeCase?.id, { announce = false } = {}) {
  if (!caseId || caseId !== state.activeCase?.id) return null;
  const governance = await readGovernance(caseId);
  if (caseId !== state.activeCase?.id) return null;
  const preferences = readPresentationPreferences()[caseId] ?? {};
  const persistedArtifacts = mergeGovernanceArtifacts(
    Array.isArray(preferences.reviewArtifacts) ? preferences.reviewArtifacts.slice(0, 100) : state.reviewArtifacts,
    governance,
  );
  const pending = governanceHasPendingHumanResolution(governance) || artifactsHavePendingHumanResolution(persistedArtifacts);
  const frozen = state.activeCase.status === "approved" || governance.manualFrozen;
  const snapshot = toPresentationSnapshot(state.activeCase, state.evaluation, {
    ...currentPresentationOverrides(),
    frozen,
  });
  setState((current) => current.activeCase?.id !== caseId ? current : ({
    ...current,
    governance,
    frozen,
    snapshot,
    reviewArtifacts: persistedArtifacts,
    capabilityPhase: pending
      ? "collaboration"
      : current.capabilityPhase === "collaboration"
        ? current.activeCase.contract.status === "draft" ? "contract_draft" : "analysis"
        : current.capabilityPhase,
    ...(announce ? { lastAnnouncement: frozen ? "Shared case governance is frozen." : pending ? "A shared human checkpoint is open." : "Shared case governance is clear." } : {}),
  }), { type: "capability-context.changed", caseId, governance });
  return governance;
}

async function getWorkspaceAuthorityContextForCase(decisionCase) {
  const caseId = decisionCase?.id ?? null;
  const localApprovalOpen = caseId === state.activeCase?.id && state.approvalOpen;
  const localImportReviewOpen = Boolean(
    state.activeImportReview &&
    (state.activeImportReview.caseId === caseId || state.activeImportReview.targetCase?.id === caseId),
  );
  const sharedAuthorityAvailable = state.persistenceMode === "durable";
  const governance = await readGovernance(caseId);
  const pendingHumanAuthorityCheckpoint = Boolean(
    localApprovalOpen || governanceHasPendingHumanResolution(governance)
  );
  return {
    frozen: Boolean(decisionCase?.status === "approved" || governance.manualFrozen),
    pendingHumanCheckpoint: Boolean(localImportReviewOpen || pendingHumanAuthorityCheckpoint),
    pendingHumanAuthorityCheckpoint,
    governanceVersion: governance.version,
    sharedAuthorityAvailable,
  };
}

export async function getWorkspaceAuthorityContext() {
  return getWorkspaceAuthorityContextForCase(state.activeCase);
}

async function assertWorkspaceNotFrozen(decisionCase = state.activeCase) {
  const authority = await getWorkspaceAuthorityContextForCase(decisionCase);
  if (authority.frozen) {
    if (decisionCase?.id === state.activeCase?.id && !state.frozen) await refreshActiveGovernance(decisionCase.id);
    throw new SituationRoomError(ERROR_CODES.CASE_FROZEN, "The room is frozen by shared human governance.");
  }
  return authority;
}

function initializeGovernanceBroadcast() {
  if (
    state.persistenceMode !== "durable" ||
    governanceBroadcast ||
    typeof window === "undefined" ||
    typeof BroadcastChannel !== "function"
  ) return;
  governanceBroadcast = new BroadcastChannel("situation-room-governance-v1");
  governanceBroadcast.onmessage = (event) => {
    if (event.data?.type !== "governance.changed" || event.data.caseId !== state.activeCase?.id) return;
    void refreshActiveGovernance(event.data.caseId, { announce: true }).catch((error) => {
      setState({
        lastAnnouncement: "Shared governance changed, but this tab could not refresh it. Agent mutations remain unavailable until reload.",
        frozen: true,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

function emit(event = null) {
  listeners.forEach((listener) => listener());
  if (event) workspacePortListeners.forEach((listener) => listener(event));
}

function setState(update, event = null) {
  state = typeof update === "function" ? update(state) : { ...state, ...update };
  emit(event);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function makeId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${suffix}`;
}

function outputBlobId(caseId, artifactId) {
  return `output:${caseId}:${artifactId}`;
}

function sessionStateBlobId(caseId) {
  return `workspace-session:${caseId}`;
}

function readPresentationPreferences() {
  try {
    if (typeof localStorage === "undefined") return {};
    return JSON.parse(localStorage.getItem(PRESENTATION_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writePresentationPreferences(caseId, patch) {
  if (!caseId) return;
  const current = readPresentationPreferences();
  const value = {
    ...(sessionStateCache.get(caseId) ?? {}),
    ...(current[caseId] ?? {}),
    ...patch,
    savedAt: new Date().toISOString(),
  };
  sessionStateCache.set(caseId, value);
  try {
    if (typeof localStorage !== "undefined") {
      current[caseId] = value;
      localStorage.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify(current));
    }
  } catch {
    setState((current) => ({
      ...current,
      lastAnnouncement: "Browser preferences could not be mirrored to local storage; durable workspace storage will still be attempted.",
    }));
  }
  if (state.persistenceMode !== "durable" || !repository?.putBlob) return;
  const previous = sessionStateWriteQueues.get(caseId) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(() => repository.putBlob(sessionStateBlobId(caseId), value));
  sessionStateWriteQueues.set(caseId, write);
  void write.catch((error) => {
    setState({
      lastAnnouncement: `The review history and saved views could not be saved. ${error instanceof Error ? error.message : String(error)}`,
    }, { type: "workspace.session-state-save-failed", caseId });
  }).finally(() => {
    if (sessionStateWriteQueues.get(caseId) === write) sessionStateWriteQueues.delete(caseId);
  });
}

function readLastActiveCaseId() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(ACTIVE_CASE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastActiveCaseId(caseId) {
  try {
    if (typeof localStorage !== "undefined" && caseId) localStorage.setItem(ACTIVE_CASE_STORAGE_KEY, caseId);
  } catch {
    // Case continuity is a convenience; the canonical repository remains authoritative.
  }
}

function persistCaseSessionState(caseId = state.activeCase?.id) {
  if (!caseId) return;
  writePresentationPreferences(caseId, {
    history: state.history.slice(-24),
    receipts: state.receipts
      .filter((entry) => !entry.caseId || entry.caseId === caseId)
      .slice(0, 100),
    reviewArtifacts: state.reviewArtifacts
      .filter((entry) => !entry.caseId || entry.caseId === caseId)
      .slice(0, 100),
    pendingModelProposalId: state.pendingModelProposal?.id ?? null,
    outputArtifactIds: state.outputArtifacts
      .filter((entry) => entry.caseId === caseId)
      .slice(0, 20)
      .map((entry) => entry.id),
  });
}

function persistInactiveCaseReceipt(caseId, receipt) {
  if (!caseId || !receipt) return;
  const preferences = sessionStateCache.get(caseId) ?? readPresentationPreferences()[caseId] ?? {};
  const priorReceipts = Array.isArray(preferences.receipts) ? preferences.receipts : [];
  writePresentationPreferences(caseId, {
    receipts: [receipt, ...priorReceipts.filter((entry) => entry?.id !== receipt.id)]
      .filter((entry) => !entry.caseId || entry.caseId === caseId)
      .slice(0, 100),
  });
}

async function createRepository() {
  if (typeof indexedDB !== "undefined") {
    try {
      const indexed = new IndexedDbRepository({ dbName: WORKSPACE_DATABASE_NAME });
      await indexed.initialize();
      return { repository: indexed, mode: "durable", warning: null };
    } catch (error) {
      const memory = new MemoryRepository();
      await memory.initialize();
      return {
        repository: memory,
        mode: "session-only",
        warning: `Durable browser storage is unavailable. This tab still works, but cases, imports, receipts, and prepared outputs may disappear when it closes. Cross-tab authority is unavailable, so governed agent mutations are disabled. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const memory = new MemoryRepository();
  await memory.initialize();
  return {
    repository: memory,
    mode: "session-only",
    warning: "Durable browser storage is unavailable. This tab still works, but cases, imports, receipts, and prepared outputs may disappear when it closes. Cross-tab authority is unavailable, so governed agent mutations are disabled.",
  };
}

function createSeedCases() {
  return [
    createProcurementFixture(),
    createCandidateReviewFixture(),
    createHealthPlanFixture(),
    createGenericFixture(),
  ];
}

function sanitizedDocumentsForProposal(documents, mapped) {
  const fragmentsByDocument = new Map();
  for (const fragment of mapped.fragments ?? []) {
    const fragments = fragmentsByDocument.get(fragment.documentId) ?? [];
    fragments.push({
      id: fragment.id,
      documentId: fragment.documentId,
      kind: fragment.kind,
      text: fragment.text,
      locator: fragment.locator,
      confidence: fragment.confidence,
      metadata: fragment.metadata,
    });
    fragmentsByDocument.set(fragment.documentId, fragments);
  }
  const rawById = new Map(documents.map((document) => [document.id, document]));
  return (mapped.documents ?? []).map((document) => ({
    ...document,
    caseId: rawById.get(document.id)?.caseId ?? null,
    blocks: fragmentsByDocument.get(document.id) ?? [],
    metadata: document.metadata ?? {},
  }));
}

async function materializeImportReview(jobOrId, context = {}) {
  if (!runtime || !importCoordinator) throw new Error("The decision and import runtimes must be ready.");
  let job = typeof jobOrId === "string" ? await importCoordinator.getImport(jobOrId) : jobOrId;
  if (!job) throw new Error(`Import '${String(jobOrId)}' was not found.`);
  if (job.phase !== "review_required") {
    return { ok: false, job, documents: [], proposal: null, caseId: job.caseId };
  }
  if (!job.caseId) job = await importCoordinator.assignImportCaseId(job.id, reserveAgentImportCaseId());
  const mergedContext = {
    source: "agent",
    ...(job.intakeContext ?? {}),
    ...(pendingImportReviewContexts.get(job.id) ?? {}),
    ...context,
  };
  if (!context.force && importReviewBuilds.has(job.id)) return importReviewBuilds.get(job.id);
  const build = (async () => {
    const rawDocuments = await Promise.all(
      job.documentIds.map((documentId) => importCoordinator.inspectDocument(documentId)),
    );
    const existingCase = job.caseId ? await runtime.getCase(job.caseId) : null;
    const domainId = existingCase?.domain?.packId ?? mergedContext.domainId ?? job.domainHint ?? "generic";
    const pack = createDefaultDomainRegistry().get(domainId);
    const mapped = await pack.mapImportedDocuments(rawDocuments, {});
    const mappingErrors = (mapped.diagnostics ?? []).filter((entry) => entry.severity === "error");
    const documents = sanitizedDocumentsForProposal(rawDocuments, mapped);
    const semanticProposal = proposeSemanticIntake({
      documents,
      agentSuggestions: job.semanticAgentSuggestions ?? [],
    });
    if (mappingErrors.length) {
      const recovery = {
        ok: false,
        recovery: true,
        mappingError: true,
        job,
        documents,
        proposal: null,
        caseId: job.caseId,
        source: mergedContext.source,
        recoveryAction: mappingErrors[0]?.details?.action ?? "revise_or_discard_mapping",
        mappingDiagnostics: mappingErrors,
        canRetry: false,
        canResumeCommit: false,
        canDiscard: true,
      };
      setState({
        activeImportReview: recovery,
        intakeOpen: true,
        lastAnnouncement: `Import ${job.id} is isolated behind a human recovery checkpoint because its domain-safe mapping cannot proceed.`,
      }, { type: "import.mapping-recovery-required", jobId: job.id, diagnostics: mappingErrors });
      return recovery;
    }
    const targetMode = existingCase ? "existing-case" : "new-case";
    const proposal = existingCase
      ? {
          caseInput: existingCase,
          claims: [],
          summary: {
            alternatives: existingCase.alternatives.length,
            criteria: existingCase.criteria.length,
            constraints: existingCase.constraints.length,
            claims: 0,
            documents: documents.length,
          },
          warnings: ["This import targets an existing room. Confirmation adds reviewed documents and fragments only; it does not infer new claims."],
        }
      : proposeCaseFromDocuments({
          caseId: job.caseId,
          title: mergedContext.title || "Imported decision room",
          objective: mergedContext.objective || "Review imported evidence against explicit alternatives, constraints, and human authority.",
          domainId,
          documents,
        });
    const review = {
      ok: true,
      job,
      documents,
      proposal,
      semanticProposal,
      caseId: job.caseId,
      targetMode,
      source: mergedContext.source,
      domainDiagnostics: mapped.diagnostics ?? [],
    };
    setState({
      activeImportReview: review,
      intakeOpen: true,
      lastAnnouncement: `Import review is ready: ${proposal.summary.alternatives} alternatives, ${proposal.summary.criteria} criteria, and ${semanticProposal.summary.conflicts} unresolved semantic conflicts visible for human confirmation.`,
    }, { type: "import.review-ready", job, proposal: proposal.summary, semantic: semanticProposal.summary, source: mergedContext.source });
    return review;
  })();
  importReviewBuilds.set(job.id, build);
  try {
    return await build;
  } catch (error) {
    importReviewBuilds.delete(job.id);
    const latest = await importCoordinator.getImport(job.id).catch(() => job);
    const recovery = {
      ok: false,
      recovery: true,
      reviewPreparationError: true,
      job: latest ?? job,
      documents: [],
      proposal: null,
      caseId: job.caseId,
      recoveryAction: "discard_unreadable_review",
      preparationError: error instanceof Error ? error.message : String(error),
      canRetry: false,
      canResumeCommit: false,
      canDiscard: true,
    };
    setState({
      activeImportReview: recovery,
      intakeOpen: true,
      lastAnnouncement: `Import ${job.id} could not be prepared for visible review. It remains isolated and can be discarded without blocking the workspace.`,
    }, { type: "import.review-preparation-recovery-required", jobId: job.id });
    return recovery;
  }
}

export function reserveAgentImportCaseId() {
  return makeId("case").slice(0, 120);
}

async function materializeRecoverableImport(jobOrId) {
  const job = typeof jobOrId === "string" ? await importCoordinator.getImport(jobOrId) : jobOrId;
  const cleanupPending = job?.phase === "complete" && job.rawInputCleanup?.status === "pending";
  if (!job || (!cleanupPending && !["failed", "quarantined"].includes(job.phase))) return null;
  const documents = (await Promise.all(
    (job.documentIds ?? []).map((documentId) => importCoordinator.inspectDocument(documentId).catch(() => null)),
  )).filter(Boolean);
  const action = cleanupPending ? "retry_raw_cleanup" : job.error?.details?.action ?? "reselect_inputs";
  const recovery = {
    ok: false,
    recovery: true,
    job,
    documents,
    proposal: null,
    caseId: job.caseId,
    recoveryAction: action,
    cleanupPending,
    canRetry: action === "retry_raw_cleanup" || (action === "retry_import" && Boolean(job.rawInputBlobIds?.length)),
    canResumeCommit:
      (action === "resume_commit" && Boolean(job.commitIntent)) ||
      (action === "reconcile_committed_receipt" && Boolean(job.receipt)),
    canDiscard: !cleanupPending && !["resume_commit", "reconcile_committed_receipt"].includes(action),
  };
  setState({
    activeImportReview: recovery,
    intakeOpen: true,
    lastAnnouncement: cleanupPending
      ? "The canonical import commit succeeded, but retained source cleanup is still pending. Retry cleanup to remove the remaining local source data."
      : ["resume_commit", "reconcile_committed_receipt"].includes(action)
      ? "An interrupted save must be safely reconciled before this import can continue."
      : `Import ${job.id} requires a person to retry or discard its retained source data.`,
  }, { type: "import.recovery-required", jobId: job.id, action });
  return recovery;
}

async function surfaceNextImportReview() {
  if (!importCoordinator || state.activeImportReview) return state.activeImportReview;
  const imports = await importCoordinator.listImports();
  const cleanupPending = imports
    .filter((job) => job.phase === "complete" && job.rawInputCleanup?.status === "pending")
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0];
  if (cleanupPending) return materializeRecoverableImport(cleanupPending);
  const pending = imports
    .filter((job) => job.phase === "review_required")
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  if (pending.length) return materializeImportReview(pending[0]);
  const interrupted = imports
    .filter((job) => ["failed", "quarantined"].includes(job.phase) && !job.retryChildId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0];
  if (!interrupted) return null;
  return materializeRecoverableImport(interrupted);
}

function currentPresentationOverrides(extra = {}) {
  const domain = getDomainConfig(state.activeCase?.domain?.packId);
  return {
    viewRevision: state.viewRevision,
    pins: state.pins,
    frozen: state.frozen,
    focusRef: state.focusRef,
    domainLabel: domain.label,
    riskLevel: domain.riskLevel,
    maxInstrumentCount: 10,
    permissions: {
      canCompose: !state.frozen,
      canAnalyze: true,
      canSimulate: !state.frozen,
      canEditContract: !state.frozen,
      canApprove:
        !state.frozen &&
        state.activeCase?.domain?.packId !== "candidate-review" &&
        state.activeCase?.contract?.status === "active" &&
        Boolean(state.evaluation?.recommendation?.eligible),
    },
    activeScenario: state.activeScenario,
    scenarioResult: state.scenarioResult,
    ...extra,
  };
}

function projectSnapshot(decisionCase = state.activeCase, evaluation = state.evaluation, extra = {}) {
  return toPresentationSnapshot(decisionCase, evaluation, currentPresentationOverrides(extra));
}

function capturePresentationContext() {
  if (!state.activeCase) throw new Error("The decision runtime is not ready.");
  return {
    caseId: state.activeCase.id,
    decisionCase: state.activeCase,
    decisionRevision: state.activeCase.revision,
    decisionHash: getDecisionHash(state.activeCase),
    viewRevision: state.viewRevision,
    caseLoadToken: latestCaseLoadToken,
  };
}

function presentationContextError(context, token) {
  if (token !== compositionToken) {
    return new SituationRoomError("EXECUTION_CANCELED", "A newer composition replaced this request.");
  }
  if (context.caseLoadToken !== latestCaseLoadToken || state.activeCase?.id !== context.caseId) {
    return new SituationRoomError("EXECUTION_CANCELED", "The active case changed while the room was being composed.");
  }
  if (
    state.activeCase.revision !== context.decisionRevision ||
    getDecisionHash(state.activeCase) !== context.decisionHash
  ) {
    return new SituationRoomError(ERROR_CODES.STALE_REVISION, "The decision changed while the room was being composed.");
  }
  if (state.viewRevision !== context.viewRevision) {
    return new SituationRoomError(ERROR_CODES.STALE_REVISION, "The view changed while the room was being composed.");
  }
  return null;
}

function assertPresentationContext(context, token) {
  const error = presentationContextError(context, token);
  if (error) throw error;
}

function rejectPendingComposition(context, token, error) {
  if (token === compositionToken && state.activeCase?.id === context.caseId) {
    setState({
      compositionPhase: "idle",
      compositionMessage: "",
      lastAnnouncement: error.message,
      error: null,
    }, { type: "presentation.canceled", caseId: context.caseId, code: error.code });
  }
  throw error;
}

function receiptForPresentation(plan, source, actor, context) {
  return {
    id: makeId("view-receipt"),
    type: "presentation.committed",
    source,
    actor,
    caseId: context.caseId,
    at: new Date().toISOString(),
    decisionRevision: context.decisionRevision,
    decisionHash: context.decisionHash,
    viewRevisionBefore: context.viewRevision,
    viewRevisionAfter: plan.nextViewRevision,
    viewHash: plan.viewHash,
    changedInstrumentIds: plan.instruments.map((instrument) => instrument.id),
    retainedPins: state.pins.length,
    status: "committed",
  };
}

async function loadCaseNow(caseId, {
  announce = true,
  lens: requestedLens,
  capabilityPhase: requestedCapabilityPhase,
} = {}, loadToken) {
  await runtime.setActiveCase(caseId);
  const [decisionCase, evaluation, workspace, governance] = await Promise.all([
    runtime.getCase(caseId),
    runtime.evaluate(caseId),
    runtime.getWorkspaceState(),
    readGovernance(caseId),
  ]);
  await (sessionStateWriteQueues.get(caseId) ?? Promise.resolve()).catch(() => undefined);
  const localPreferences = readPresentationPreferences()[caseId] ?? null;
  const durablePreferences = state.persistenceMode === "durable" && repository?.getBlob
    ? await repository.getBlob(sessionStateBlobId(caseId)).catch(() => null)
    : null;
  const localSavedAt = Date.parse(localPreferences?.savedAt ?? "") || 0;
  const durableSavedAt = Date.parse(durablePreferences?.savedAt ?? "") || 0;
  const preferences = durablePreferences && durableSavedAt >= localSavedAt
    ? durablePreferences
    : localPreferences ?? durablePreferences ?? {};
  sessionStateCache.set(caseId, preferences);
  const domain = getDomainConfig(decisionCase.domain.packId);
  const viewRevision = Number.isInteger(preferences.viewRevision) ? preferences.viewRevision : 1;
  const pins = Array.isArray(preferences.pins) ? preferences.pins : [];
  const frozen = decisionCase.status === "approved" || governance.manualFrozen === true;
  const lens = requestedLens && ["investigate", "compare", "simulate", "brief"].includes(requestedLens)
    ? requestedLens
    : preferences.lens && ["investigate", "compare", "simulate", "brief"].includes(preferences.lens)
      ? preferences.lens
    : "investigate";
  const question = preferences.question || domain.defaultQuestion || decisionCase.contract.question;
  const decisionHash = getDecisionHash(decisionCase);
  const history = Array.isArray(preferences.history)
    ? preferences.history.filter((entry) =>
      entry?.plan?.baseDecisionRevision === decisionCase.revision &&
      entry.plan.decisionHash === decisionHash &&
      Number.isInteger(entry.plan.nextViewRevision),
    ).slice(-24)
    : [];
  const receipts = Array.isArray(preferences.receipts) ? preferences.receipts.slice(0, 100) : [];
  const reviewArtifacts = mergeGovernanceArtifacts(
    Array.isArray(preferences.reviewArtifacts) ? preferences.reviewArtifacts.slice(0, 100) : [],
    governance,
  );
  const pendingHumanResolution = governanceHasPendingHumanResolution(governance) || artifactsHavePendingHumanResolution(reviewArtifacts);
  const pendingModelProposal = reviewArtifacts.find((artifact) =>
    artifact.id === preferences.pendingModelProposalId && artifact.status === "under-human-review",
  ) ?? null;
  const outputArtifactIds = Array.isArray(preferences.outputArtifactIds) ? preferences.outputArtifactIds.slice(0, 20) : [];
  const outputArtifacts = repository?.getBlob
    ? (await Promise.all(outputArtifactIds.map((artifactId) => repository.getBlob(outputBlobId(caseId, artifactId))))).filter(Boolean)
    : [];
  if (loadToken !== latestCaseLoadToken) return { superseded: true, caseId };
  const focusRef = preferences.focusRef?.kind && preferences.focusRef?.id
    ? { kind: String(preferences.focusRef.kind), id: String(preferences.focusRef.id) }
    : null;
  const activePathId = evaluation.paths?.some((path) => path.id === preferences.activePathId)
    ? preferences.activePathId
    : evaluation.paths?.[0]?.id ?? null;

  const automaticCapabilityPhase = pendingHumanResolution
    ? "collaboration"
    : frozen
      ? "analysis"
    : decisionCase.contract?.status === "draft" ? "contract_draft" : "analysis";
  const capabilityPhase = pendingHumanResolution
    ? "collaboration"
    : frozen
      ? "analysis"
      : WORKSPACE_PHASES.has(requestedCapabilityPhase)
      ? requestedCapabilityPhase
      : automaticCapabilityPhase;

  state = {
    ...state,
    workspace,
    activeCase: decisionCase,
    evaluation,
    governance,
    viewRevision,
    pins,
    frozen,
    lens,
    capabilityPhase,
    question,
    focusRef,
    activePathId,
    history,
    historyCursor: history.length - 1,
    receipts,
    reviewArtifacts,
    pendingModelProposal,
    outputArtifacts,
    sourceDrawerOpen: false,
    outlineOpen: false,
    approvalOpen: false,
    approvalTargetId: null,
    activeScenario: null,
    scenarioResult: null,
    error: null,
  };
  const snapshot = projectSnapshot(decisionCase, evaluation, { viewRevision, pins, frozen });
  // Freeze is an authority boundary for mutations, not a reason to stop rendering
  // canonical evidence. Compile through an ephemeral, compose-enabled projection so
  // the pure compiler can rebuild this case's room without reopening the real case.
  // Never retain state.plan here: it may belong to the case that was open previously.
  const compilationSnapshot = frozen
    ? {
        ...snapshot,
        frozen: false,
        permissions: { ...snapshot.permissions, canCompose: true },
      }
    : snapshot;
  const recipe = createPresentationRecipe(compilationSnapshot, question, {
    lens,
    pathId: activePathId,
    focusRef,
  });
  const compiled = compilePresentation(compilationSnapshot, recipe, { maxInstrumentCount: 10 });
  if (!compiled.ok) {
    throw new Error(`Unable to compile the initial room: ${compiled.errors.join(" ")}`);
  }
  const plan = compiled.plan;
  state = {
    ...state,
    snapshot,
    plan,
    bootStatus: "ready",
    lastAnnouncement: announce
      ? decisionCase.domain.packId === "candidate-review"
        ? `${domain.label} room loaded. Requirement evidence is organized for human panel review; no employment outcome is computed.`
        : `${domain.label} room loaded. ${evaluation.blockerCount} mandatory blocker${evaluation.blockerCount === 1 ? "" : "s"}.`
      : state.lastAnnouncement,
  };
  emit({ type: "workspace.case-loaded", caseId, domainPackId: decisionCase.domain.packId });
  writeLastActiveCaseId(caseId);
  return { superseded: false, caseId };
}

function loadCase(caseId, options = {}) {
  const loadToken = ++latestCaseLoadToken;
  const operation = caseLoadQueue
    .catch(() => undefined)
    .then(() => loadCaseNow(caseId, options, loadToken));
  caseLoadQueue = operation.catch(() => undefined);
  return operation;
}

async function refreshCaseAfterMutation(caseId, capturedLoadToken) {
  if (capturedLoadToken !== latestCaseLoadToken || state.activeCase?.id !== caseId) return false;
  const result = await loadCase(caseId, { announce: false });
  return !result?.superseded && state.activeCase?.id === caseId;
}

export async function initializeWorkspace({ initialRoute } = {}) {
  if (initializationPromise) return initializationPromise;
  setState({
    bootStatus: "booting",
    bootError: null,
  }, { type: "workspace.boot-started" });
  initializationPromise = (async () => {
    try {
      const persistence = await createRepository();
      repository = persistence.repository;
      setState({
        persistenceMode: persistence.mode,
        persistenceWarning: persistence.warning,
        lastAnnouncement: persistence.mode === "durable"
          ? "Durable local decision storage is ready."
          : "Session-only storage is active; export important work before closing this page.",
      }, { type: "workspace.persistence-ready", mode: persistence.mode });
      runtime = new DecisionRuntime({
        repository,
        domainRegistry: createDefaultDomainRegistry(),
        broadcastChannelName: "situation-room-os-v2",
      });
      await runtime.initialize({ seedCases: createSeedCases(), activeCaseId: "procurement-demo" });
      importCoordinator = new ImportCoordinator({
        repository,
        domainRegistry: createDefaultDomainRegistry(),
      });
      await importCoordinator.initialize();
      initializeGovernanceBroadcast();
      importCoordinator.subscribe((event) => {
        void (async () => {
          const workspace = await runtime.getWorkspaceState();
          setState({ workspace }, event);
          if (["import.review_required", "import.mapping_changed", "import.semantic_suggestions_changed"].includes(event?.type) && event.jobId) {
            if (state.activeImportReview && state.activeImportReview.job.id !== event.jobId) {
              setState({ lastAnnouncement: "Another agent import is queued behind the visible human review." }, event);
              return;
            }
            if (["import.mapping_changed", "import.semantic_suggestions_changed"].includes(event.type)) importReviewBuilds.delete(event.jobId);
            await materializeImportReview(event.jobId, { force: ["import.mapping_changed", "import.semantic_suggestions_changed"].includes(event.type) });
          }
        })().catch((error) => {
          setState({
            lastAnnouncement: "An import reached review, but its visible proposal could not be prepared.",
            error: error instanceof Error ? error.message : String(error),
          }, { type: "import.review-surface-failed", jobId: event?.jobId });
        });
      });
      runtime.subscribe(async (event) => {
        if (event.remote && event.caseId && event.caseId === state.activeCase?.id) {
          await loadCase(event.caseId, { announce: false });
        }
        emit(event);
      });
      const workspace = await runtime.getWorkspaceState();
      const requestedCaseId = initialRoute?.kind === "case" ? initialRoute.caseId : null;
      const persistedCaseId = readLastActiveCaseId();
      const preferredCaseId = workspace.cases.some((item) => item.id === requestedCaseId)
        ? requestedCaseId
        : workspace.cases.some((item) => item.id === persistedCaseId)
          ? persistedCaseId
        : workspace.cases.some((item) => item.id === "procurement-demo")
          ? "procurement-demo"
          : workspace.activeCaseId;
      const initialRouteMatchesCase = initialRoute?.kind === "case" && initialRoute.caseId === preferredCaseId;
      await loadCase(preferredCaseId, initialRouteMatchesCase ? {
        lens: initialRoute.workspace === "analyze" ? initialRoute.lens : undefined,
        capabilityPhase: phaseForWorkspaceRoute(initialRoute),
      } : undefined);
      if (initialRoute?.kind === "new") toggleIntake(true);
      await surfaceNextImportReview();
      setNavigationSurface(
        state.activeImportReview || state.intakeOpen
          ? "new"
          : initialRoute?.kind === "archive"
            ? "archive"
            : initialRoute?.kind === "not-found"
              ? "not-found"
              : initialRoute?.kind === "case" && !initialRouteMatchesCase
                ? "not-found"
              : "case",
      );
      return { runtime, repository };
    } catch (error) {
      runtime?.close?.();
      repository?.close?.();
      governanceBroadcast?.close?.();
      governanceBroadcast = null;
      runtime = null;
      repository = null;
      importCoordinator = null;
      caseLoadQueue = Promise.resolve();
      latestCaseLoadToken = 0;
      initializationPromise = null;
      setState({
        bootStatus: "error",
        bootError: error instanceof Error ? error.message : String(error),
        lastAnnouncement: "The decision runtime could not start.",
      });
      throw error;
    }
  })();
  return initializationPromise;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const workspacePortListeners = new Set();

export function subscribeWorkspaceEvents(listener) {
  workspacePortListeners.add(listener);
  return () => workspacePortListeners.delete(listener);
}

export function getWorkspaceStoreState() {
  return state;
}

export function setNavigationSurface(surface) {
  const normalized = ["case", "archive", "new", "not-found", "transition"].includes(surface)
    ? surface
    : "not-found";
  if (state.navigationSurface === normalized) return;
  setState(
    { navigationSurface: normalized },
    { type: "capability-context.changed", navigationSurface: normalized },
  );
}

function stagedSourceId(file) {
  if (!file || (typeof file !== "object" && typeof file !== "function")) return makeId("staged");
  let sourceId = stagedSourceIds.get(file);
  if (!sourceId) {
    sourceId = makeId("staged");
    stagedSourceIds.set(file, sourceId);
  }
  return sourceId;
}

export function stageLocalSources(files) {
  const entries = [];
  for (const file of files ?? []) {
    if (!file || typeof file.arrayBuffer !== "function") continue;
    const sourceId = stagedSourceId(file);
    const prior = stagedSources.get(sourceId);
    stagedSources.set(sourceId, { file, domainReservation: prior?.domainReservation ?? null });
    entries.push({ sourceId, size: file.size, mimeType: file.type || "application/octet-stream" });
  }
  const reservations = new Set([...stagedSources.values()].map((entry) => entry.domainReservation).filter(Boolean));
  setState({
    stagedSourceCount: stagedSources.size,
    stagedDomainReservation: reservations.size === 1 && [...stagedSources.values()].every((entry) => entry.domainReservation)
      ? [...reservations][0]
      : null,
  }, { type: "intake.sources-staged", entries });
  return entries;
}

export function unstageLocalSources(files) {
  for (const file of files ?? []) stagedSources.delete(stagedSourceId(file));
  const reservations = new Set([...stagedSources.values()].map((entry) => entry.domainReservation).filter(Boolean));
  setState({
    stagedSourceCount: stagedSources.size,
    stagedDomainReservation: stagedSources.size && reservations.size === 1 && [...stagedSources.values()].every((entry) => entry.domainReservation)
      ? [...reservations][0]
      : null,
  }, { type: "intake.sources-unstaged" });
}

export function sourceIdForLocalFile(file) {
  return stagedSourceId(file);
}

export async function resolveStagedSource(sourceId) {
  const entry = stagedSources.get(sourceId);
  if (!entry) throw new Error(`Staged source '${sourceId}' is unavailable; choose the file again.`);
  return { input: entry.file, domainReservation: entry.domainReservation };
}

export function confirmStagedSourceDomain(files, domainId) {
  const normalized = String(domainId ?? "").trim();
  if (!DOMAIN_CONFIG[normalized]) throw new Error("Choose a recognized policy domain before confirming staged agent access.");
  const sourceIds = [];
  for (const file of files ?? []) {
    const sourceId = stagedSourceId(file);
    const entry = stagedSources.get(sourceId);
    if (!entry) continue;
    stagedSources.set(sourceId, { ...entry, domainReservation: normalized });
    sourceIds.push(sourceId);
  }
  setState({
    stagedSourceCount: stagedSources.size,
    stagedDomainReservation: sourceIds.length ? normalized : null,
    lastAnnouncement: sourceIds.length
      ? `${getDomainConfig(normalized).label} policy confirmed for ${sourceIds.length} opaque staged source handle${sourceIds.length === 1 ? "" : "s"}.`
      : "No staged file source was available to authorize.",
  }, { type: "intake.source-domain-confirmed", domainId: normalized, sourceIds });
  return { ok: sourceIds.length > 0, domainId: normalized, sourceIds };
}

export function clearStagedSourceDomain(files) {
  for (const file of files ?? []) {
    const sourceId = stagedSourceId(file);
    const entry = stagedSources.get(sourceId);
    if (entry) stagedSources.set(sourceId, { ...entry, domainReservation: null });
  }
  setState({ stagedDomainReservation: null }, { type: "intake.source-domain-cleared" });
}

export function useWorkspaceStore(selector = (value) => value) {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export async function switchCase(caseId, options = {}) {
  if (!runtime || caseId === state.activeCase?.id) return;
  cancelComposition();
  setState({ compositionPhase: "planning", compositionMessage: "Opening the selected case graph." });
  const result = await loadCase(caseId, options);
  if (result?.superseded) return;
  setState({ compositionPhase: "idle", compositionMessage: "" });
}

export async function navigateWorkspaceRoute(route) {
  if (!runtime || route?.kind !== "case") throw new Error("A case workspace route is required.");
  if (workspacePathFor(route) === null) return { ok: false, reason: "invalid-route" };
  if (!state.workspace.cases.some((item) => item.id === route.caseId)) {
    return { ok: false, reason: "unknown-case", caseId: route.caseId };
  }
  const capabilityPhase = phaseForWorkspaceRoute(route);
  const lens = route.workspace === "analyze" ? route.lens : undefined;

  if (route.caseId !== state.activeCase?.id) {
    await switchCase(route.caseId, { capabilityPhase, lens });
    if (state.activeCase?.id !== route.caseId) {
      return { ok: false, reason: "case-not-loaded", caseId: route.caseId };
    }
    if (state.frozen && route.workspace !== "analyze") {
      return {
        ok: false,
        reason: "frozen",
        caseId: route.caseId,
        capabilityPhase: state.capabilityPhase,
        lens: state.lens,
      };
    }
    if (state.capabilityPhase !== capabilityPhase) {
      return {
        ok: false,
        reason: state.frozen ? "frozen" : hasPendingHumanResolution() ? "pending-checkpoint" : "phase-normalized",
        caseId: route.caseId,
        capabilityPhase: state.capabilityPhase,
        lens: state.lens,
      };
    }
    return { ok: true, caseId: route.caseId, capabilityPhase, lens: state.lens };
  }

  if (hasPendingHumanResolution() && route.workspace !== "review") {
    return { ok: false, reason: "pending-checkpoint", caseId: route.caseId };
  }

  if (state.frozen && route.workspace !== "analyze") {
    return { ok: false, reason: "frozen", caseId: route.caseId };
  }

  if (state.frozen && lens && lens !== state.lens) {
    cancelComposition();
    const result = await loadCase(route.caseId, { announce: false, capabilityPhase, lens });
    return {
      ok: !result?.superseded && state.capabilityPhase === capabilityPhase,
      caseId: route.caseId,
      capabilityPhase: state.capabilityPhase,
      lens: state.lens,
      readOnly: true,
    };
  }

  if (capabilityPhase && capabilityPhase !== state.capabilityPhase) {
    applyCapabilityPhase(capabilityPhase, "route");
  }
  if (lens && lens !== state.lens) await setManualLens(lens);
  return { ok: true, caseId: route.caseId, capabilityPhase, lens: lens ?? state.lens };
}

async function commitPresentation(plan, { source = "manual", actor = ACTOR, context, token } = {}) {
  assertPresentationContext(context, token);
  if (
    plan.baseDecisionRevision !== context.decisionRevision ||
    plan.decisionHash !== context.decisionHash ||
    plan.baseViewRevision !== context.viewRevision ||
    plan.nextViewRevision !== context.viewRevision + 1
  ) {
    throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The compiled room no longer matches its captured decision and view revisions.");
  }
  const receipt = receiptForPresentation(plan, source, actor, context);
  const nextSnapshot = projectSnapshot(state.activeCase, state.evaluation, {
    viewRevision: plan.nextViewRevision,
  });
  const historyEntry = { plan, receipt };
  const truncatedHistory = state.history.slice(0, state.historyCursor + 1);
  const history = [...truncatedHistory, historyEntry].slice(-24);
  const presentationDiff = diffPresentationPlans(state.plan, plan);
  const commitState = () => setState((current) => ({
      ...current,
      plan,
      snapshot: nextSnapshot,
      viewRevision: plan.nextViewRevision,
      lens: plan.lens,
      question: plan.question,
      focusRef: plan.focus?.entityRef ?? current.focusRef,
      activePathId: plan.focus?.pathId ?? current.activePathId,
      history,
      historyCursor: history.length - 1,
      receipts: [receipt, ...current.receipts].slice(0, 100),
      compositionPhase: "idle",
      compositionMessage: "",
      presentationDiff,
      lastAnnouncement: `${plan.lens} room committed at view revision ${plan.nextViewRevision}. ${plan.preservedPins.length} human pin${plan.preservedPins.length === 1 ? "" : "s"} preserved.`,
      error: null,
    }), { type: "presentation.committed", receipt, plan, presentationDiff });
  if (!state.reducedMotion && typeof globalThis.document?.startViewTransition === "function") {
    const transition = globalThis.document.startViewTransition(commitState);
    await transition.updateCallbackDone;
  } else {
    commitState();
  }
  writePresentationPreferences(context.caseId, {
    viewRevision: plan.nextViewRevision,
    lens: plan.lens,
    question: plan.question,
    pins: state.pins,
    history: state.history,
    receipts: state.receipts,
    reviewArtifacts: state.reviewArtifacts,
  });
  return { ok: true, receipt, plan };
}

export async function applyPresentationRecipe(recipe, actor = { type: "agent", id: "webmcp-agent" }, options = {}) {
  const context = capturePresentationContext();
  const token = ++compositionToken;
  setState({
    compositionPhase: "interpreting",
    compositionMessage: "Checking shared authority before resolving the question.",
    error: null,
  });
  let initialAuthority;
  try {
    initialAuthority = await assertWorkspaceNotFrozen(context.decisionCase);
    assertPresentationContext(context, token);
  } catch (error) {
    return rejectPendingComposition(context, token, error);
  }
  setState({
    compositionPhase: "interpreting",
    compositionMessage: "Resolving the question against the active evidence graph.",
    error: null,
  });
  if (!options.immediate) await delay(state.reducedMotion ? 0 : 90);
  try {
    assertPresentationContext(context, token);
  } catch (error) {
    return rejectPendingComposition(context, token, error);
  }
  const currentSnapshot = projectSnapshot();
  setState({ compositionPhase: "planning", compositionMessage: "Selecting governed instruments and protected context." });
  const compiled = compilePresentation(currentSnapshot, recipe, { maxInstrumentCount: 10 });
  if (!compiled.ok) {
    setState({
      compositionPhase: "rejected",
      compositionMessage: compiled.error,
      error: compiled.errors,
      lastAnnouncement: `Composition rejected. ${compiled.error}`,
    }, { type: "presentation.rejected", errors: compiled.errors });
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, compiled.error, { errors: compiled.errors });
  }
  if (!options.immediate) await delay(state.reducedMotion ? 0 : 90);
  try {
    assertPresentationContext(context, token);
  } catch (error) {
    return rejectPendingComposition(context, token, error);
  }
  setState({ compositionPhase: "arranging", compositionMessage: "Rebuilding the causal stage around the selected evidence." });
  if (!options.immediate) await delay(state.reducedMotion ? 0 : 100);
  try {
    assertPresentationContext(context, token);
  } catch (error) {
    return rejectPendingComposition(context, token, error);
  }
  const latestCase = await runtime.getCase(context.caseId);
  try {
    assertPresentationContext(context, token);
  } catch (error) {
    return rejectPendingComposition(context, token, error);
  }
  if (
    !latestCase ||
    latestCase.revision !== context.decisionRevision ||
    getDecisionHash(latestCase) !== context.decisionHash
  ) {
    return rejectPendingComposition(
      context,
      token,
      new SituationRoomError(ERROR_CODES.STALE_REVISION, "The canonical decision changed before the room could commit."),
    );
  }
  const finalAuthority = await getWorkspaceAuthorityContextForCase(latestCase);
  try {
    assertPresentationContext(context, token);
  } catch (error) {
    return rejectPendingComposition(context, token, error);
  }
  if (finalAuthority.frozen) {
    if (state.activeCase?.id === context.caseId && !state.frozen) await refreshActiveGovernance(context.caseId);
    return rejectPendingComposition(
      context,
      token,
      new SituationRoomError(ERROR_CODES.CASE_FROZEN, "The room was frozen before the composed view could commit."),
    );
  }
  if (finalAuthority.governanceVersion !== initialAuthority.governanceVersion) {
    return rejectPendingComposition(
      context,
      token,
      new SituationRoomError("EXECUTION_CANCELED", "Shared case governance changed while the room was being composed."),
    );
  }
  return commitPresentation(compiled.plan, { source: options.source ?? "agent", actor, context, token });
}

export async function submitDecisionQuestion(question, options = {}) {
  const snapshot = projectSnapshot();
  const recipe = createPresentationRecipe(snapshot, question, {
    lens: options.lens,
    focusRef: options.focusRef ?? state.focusRef,
    pathId: options.pathId ?? state.activePathId,
    framing: options.framing,
  });
  return applyPresentationRecipe(recipe, ACTOR, { source: options.source ?? "question" });
}

export function cancelComposition() {
  compositionToken += 1;
  setState({
    compositionPhase: "idle",
    compositionMessage: "",
    lastAnnouncement: "Composition canceled; the previous room remains active.",
  }, { type: "presentation.canceled" });
}

export async function setManualLens(lens) {
  return submitDecisionQuestion(state.question, { lens, source: "manual-lens" });
}

function applyCapabilityPhase(phase, source = "manual") {
  if (!WORKSPACE_PHASES.has(phase)) throw new Error(`Unsupported workflow phase '${String(phase)}'.`);
  setState({
    capabilityPhase: phase,
    lastAnnouncement: `${phase.replaceAll("_", " ")} tools are now available to both people and connected agents.`,
  }, { type: "workspace.phase-changed", phase, source });
  return { ok: true, phase };
}

export function setCapabilityPhase(phase) {
  if (!WORKSPACE_PHASES.has(phase)) throw new Error(`Unsupported workflow phase '${String(phase)}'.`);
  if (state.frozen) return { ok: false, reason: "frozen" };
  return applyCapabilityPhase(phase);
}

export async function updateDecisionContract({ question, objective, activate = false }) {
  if (!runtime || !state.activeCase) throw new Error("The decision runtime is not ready.");
  const targetCase = state.activeCase;
  const targetCaseId = targetCase.id;
  const targetRevision = targetCase.revision;
  const capturedLoadToken = latestCaseLoadToken;
  await assertWorkspaceNotFrozen(targetCase);
  const nextQuestion = String(question ?? "").trim();
  const nextObjective = String(objective ?? "").trim();
  if (nextQuestion.length < 4 || nextQuestion.length > 500) {
    throw new Error("The decision question must contain 4 to 500 characters.");
  }
  if (nextObjective.length < 8 || nextObjective.length > 800) {
    throw new Error("The objective must contain 8 to 800 characters.");
  }
  const contract = {
    ...targetCase.contract,
    version: targetCase.contract.version + 1,
    status: activate ? "active" : "draft",
    question: nextQuestion,
    objective: nextObjective,
  };
  const result = await runtime.executeCommand(
    { type: "replace_contract", payload: { contract } },
    {
      caseId: targetCaseId,
      expectedRevision: targetRevision,
      idempotencyKey: makeId(activate ? "activate-contract" : "revise-contract"),
      actor: ACTOR,
    },
  );
  const receipt = {
    ...result.receipt,
    type: activate ? "contract.activated" : "contract.revised",
    status: "committed",
  };
  const refreshed = await refreshCaseAfterMutation(targetCaseId, capturedLoadToken);
  if (!refreshed) {
    persistInactiveCaseReceipt(targetCaseId, receipt);
    return { ok: true, receipt };
  }
  setState((current) => ({
    ...current,
    capabilityPhase: activate ? "analysis" : "contract_draft",
    pendingModelProposal: current.pendingModelProposal?.kind === "decision_proposeContract"
      ? null
      : current.pendingModelProposal,
    reviewArtifacts: current.reviewArtifacts.map((artifact) =>
      artifact.id === current.pendingModelProposal?.id && artifact.kind === "decision_proposeContract"
        ? { ...artifact, status: "incorporated-by-human", resolvedAt: new Date().toISOString() }
        : artifact,
    ),
    receipts: [receipt, ...current.receipts].slice(0, 100),
    lastAnnouncement: activate
      ? `Contract version ${contract.version} activated by the decision owner.`
      : `Contract version ${contract.version} saved as a draft for review.`,
  }), { type: activate ? "contract.activated" : "contract.revised", receipt });
  persistCaseSessionState(targetCaseId);
  return { ok: true, receipt };
}

export async function replaceDecisionModel(model) {
  if (!runtime || !state.activeCase) throw new Error("The decision runtime is not ready.");
  const targetCase = state.activeCase;
  const targetCaseId = targetCase.id;
  const targetRevision = targetCase.revision;
  const capturedLoadToken = latestCaseLoadToken;
  await assertWorkspaceNotFrozen(targetCase);
  const result = await runtime.executeCommand(
    { type: "replace_model", payload: { model } },
    {
      caseId: targetCaseId,
      expectedRevision: targetRevision,
      idempotencyKey: makeId("replace-model"),
      actor: ACTOR,
    },
  );
  const receipt = { ...result.receipt, type: "model.replaced", status: "committed" };
  const refreshed = await refreshCaseAfterMutation(targetCaseId, capturedLoadToken);
  if (!refreshed) {
    persistInactiveCaseReceipt(targetCaseId, receipt);
    return { ok: true, receipt };
  }
  setState((current) => ({
    ...current,
    capabilityPhase: "contract_draft",
    pendingModelProposal: current.pendingModelProposal?.kind !== "decision_proposeContract"
      ? null
      : current.pendingModelProposal,
    reviewArtifacts: current.reviewArtifacts.map((artifact) =>
      artifact.id === current.pendingModelProposal?.id && artifact.kind !== "decision_proposeContract"
        ? { ...artifact, status: "incorporated-by-human", resolvedAt: new Date().toISOString() }
        : artifact,
    ),
    receipts: [receipt, ...current.receipts].slice(0, 100),
    lastAnnouncement: `Typed model committed at revision ${result.receipt.revisionAfter}. Re-activate the contract after review.`,
  }), { type: "model.replaced", receipt });
  persistCaseSessionState(targetCaseId);
  return { ok: true, receipt };
}

export function stageReviewArtifact({ id = makeId("review"), kind = "comment", body, entityRefs = [], source = "human" }) {
  const text = String(body ?? "").trim();
  if (!text || text.length > 1_000) throw new Error("Review notes must contain 1 to 1,000 characters.");
  if (source === "agent") {
    const policy = assessAgentArtifact({
      decisionCase: state.activeCase,
      evaluation: state.evaluation,
      presentation: state.plan,
      texts: [text],
      entityRefs,
    });
    if (!policy.ok) throw new SituationRoomError(ERROR_CODES[policy.code] ?? policy.code, policy.message);
  }
  const artifact = {
    id,
    kind,
    body: text,
    entityRefs: entityRefs.filter((reference) => reference?.kind && reference?.id).slice(0, 20),
    source,
    actor: source === "agent" ? { type: "agent", id: "webmcp-agent" } : ACTOR,
    caseId: state.activeCase?.id ?? null,
    decisionRevision: state.activeCase?.revision ?? null,
    at: new Date().toISOString(),
    status: "awaiting-human",
  };
  const receipt = {
    ...artifact,
    type: `review.${kind}`,
    status: "staged",
  };
  setState((current) => ({
    ...current,
    reviewArtifacts: [artifact, ...current.reviewArtifacts].slice(0, 100),
    receipts: [receipt, ...current.receipts].slice(0, 100),
    lastAnnouncement: `${kind.replaceAll("_", " ")} staged for visible human review.`,
  }), { type: "review.artifact-staged", artifact, receipt });
  persistCaseSessionState();
  return { ok: true, artifact, receipt };
}

export function decideModelProposal(artifactId, action) {
  const artifact = state.reviewArtifacts.find((entry) => entry.id === artifactId);
  if (!artifact || artifact.source !== "agent" || !String(artifact.kind).startsWith("decision_")) {
    throw new Error("The selected agent model proposal is no longer available.");
  }
  if (artifact.caseId && artifact.caseId !== state.activeCase?.id) {
    throw new Error("Switch to the proposal's decision case before reviewing it.");
  }
  if (!['review', 'reject', 'defer'].includes(action)) throw new Error("Unsupported proposal decision.");
  const at = new Date().toISOString();
  const nextStatus = action === "review"
    ? "under-human-review"
    : action === "reject"
      ? "rejected-by-human"
      : "awaiting-human";
  const updated = { ...artifact, status: nextStatus, reviewedAt: at };
  const receipt = {
    id: makeId("proposal-review"),
    type: `review.model-proposal-${action}`,
    source: "human",
    actor: ACTOR,
    caseId: state.activeCase?.id ?? null,
    at,
    revisionBefore: state.activeCase?.revision ?? null,
    revisionAfter: state.activeCase?.revision ?? null,
    decisionHashBefore: state.activeCase ? getDecisionHash(state.activeCase) : null,
    decisionHashAfter: state.activeCase ? getDecisionHash(state.activeCase) : null,
    artifactId,
    status: "committed",
  };
  setState((current) => ({
    ...current,
    capabilityPhase: action === "review" ? "contract_draft" : action === "defer" ? "collaboration" : current.capabilityPhase,
    pendingModelProposal: action === "review" ? updated : null,
    reviewArtifacts: current.reviewArtifacts.map((entry) => entry.id === artifactId ? updated : entry),
    receipts: [receipt, ...current.receipts].slice(0, 100),
    lastAnnouncement: action === "review"
      ? "Agent proposal opened beside the human-only typed model editor. No canonical value changed."
      : action === "reject"
        ? "Agent proposal rejected by the decision owner without changing the canonical model."
        : "Agent proposal returned to the review exchange without changing the canonical model.",
  }), { type: `review.model-proposal-${action}`, artifact: updated, receipt });
  persistCaseSessionState();
  return { ok: true, artifact: updated, receipt };
}

export async function decideHumanResolution(artifactId, action, response = "") {
  const activeCase = state.activeCase;
  const caseId = activeCase?.id;
  const artifact = state.reviewArtifacts.find((entry) => entry.id === artifactId)
    ?? state.governance?.humanCheckpoints?.find((entry) => entry.id === artifactId);
  if (!artifact || artifact.kind !== "human_resolution_request") {
    throw new Error("The selected human-resolution checkpoint is no longer available.");
  }
  if (artifact.caseId && artifact.caseId !== caseId) {
    throw new Error("Switch to the checkpoint's decision case before resolving it.");
  }
  if (!["resolve", "reject", "defer"].includes(action)) throw new Error("Unsupported resolution action.");
  const text = String(response ?? "").trim();
  if (action !== "defer" && (text.length < 4 || text.length > 1_000)) {
    throw new Error("A resolution or rejection must include 4 to 1,000 characters of human rationale.");
  }
  if (!caseId) throw new Error("No active decision case is available.");
  const at = new Date().toISOString();
  let updated = null;
  const governance = await mutateGovernance(caseId, (current) => {
    const durable = (current.humanCheckpoints ?? []).find((checkpoint) => checkpoint.id === artifactId);
    const checkpoint = durable ?? artifact;
    if (!checkpoint || checkpoint.kind !== "human_resolution_request" || checkpoint.caseId !== caseId) {
      throw new Error("The selected human-resolution checkpoint is no longer available.");
    }
    if (!OPEN_HUMAN_RESOLUTION_STATUSES.has(checkpoint.status)) {
      throw new Error("This human-resolution checkpoint has already been closed in another tab.");
    }
    const status = action === "resolve"
      ? "resolved-by-human"
      : action === "reject" ? "rejected-by-human" : "awaiting-human";
    updated = {
      ...checkpoint,
      status,
      ...(text ? { humanResponse: text } : {}),
      reviewedAt: at,
      ...(action === "defer" ? { deferredAt: at } : { resolvedAt: at }),
    };
    return {
      humanCheckpoints: [
        ...(current.humanCheckpoints ?? []).filter((checkpoint) => checkpoint.id !== artifactId),
        updated,
      ],
    };
  });
  const receipt = {
    id: makeId("human-resolution"),
    type: `review.human-resolution-${action}`,
    source: "human",
    actor: ACTOR,
    caseId,
    at,
    decisionRevision: activeCase?.revision ?? null,
    decisionHash: activeCase ? getDecisionHash(activeCase) : null,
    artifactId,
    status: "committed",
  };
  if (state.activeCase?.id !== caseId) {
    return { ok: true, awaitingHuman: governanceHasPendingHumanResolution(governance), artifact: updated, receipt, caseChanged: true };
  }
  const artifacts = mergeGovernanceArtifacts(state.reviewArtifacts, governance);
  const stillPending = governanceHasPendingHumanResolution(governance) || artifactsHavePendingHumanResolution(artifacts);
  setState((current) => ({
    ...current,
    governance,
    reviewArtifacts: artifacts,
    receipts: [receipt, ...current.receipts].slice(0, 100),
    capabilityPhase: stillPending
      ? "collaboration"
      : current.activeCase?.contract?.status === "draft" ? "contract_draft" : "analysis",
    lastAnnouncement: action === "resolve"
      ? "The cited checkpoint was resolved by the decision owner. Governed agent mutations may resume if no other checkpoint is open."
      : action === "reject"
        ? "The agent's resolution request was rejected with human rationale and closed."
        : "The human-resolution checkpoint remains open and governed mutations stay retired.",
  }), { type: `review.human-resolution-${action}`, artifact: updated, receipt });
  persistCaseSessionState();
  return { ok: true, awaitingHuman: stillPending, artifact: updated, receipt };
}

async function prepareCaseExportNow(format = "json", options = {}) {
  if (!state.activeCase) throw new Error("No active case is available to export.");
  if (options.expectedCaseId && options.expectedCaseId !== state.activeCase.id) {
    throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The active decision case changed before the export could be prepared.");
  }
  if (
    options.expectedDecisionRevision !== undefined &&
    options.expectedDecisionRevision !== state.activeCase.revision
  ) {
    throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The decision changed before the export could be prepared.");
  }
  const decisionCase = state.activeCase;
  const evaluation = state.evaluation;
  const packet = createDecisionPacket(decisionCase, evaluation, {
    includeAppendix: options.includeAppendix !== false,
  });
  const serialized = serializeDecisionPacket(packet, format);
  const artifact = {
    id: makeId("output"),
    kind: "decision-packet",
    caseId: decisionCase.id,
    decisionRevision: decisionCase.revision,
    decisionHash: getDecisionHash(decisionCase),
    createdAt: new Date().toISOString(),
    source: options.source ?? "human",
    ...serialized,
  };
  const receipt = {
    id: makeId("output-receipt"),
    type: "output.prepared",
    source: artifact.source,
    caseId: artifact.caseId,
    at: artifact.createdAt,
    decisionRevision: artifact.decisionRevision,
    decisionHash: artifact.decisionHash,
    artifactId: artifact.id,
    format,
    status: "staged",
  };
  const previousArtifacts = state.outputArtifacts;
  const nextArtifacts = [artifact, ...previousArtifacts].slice(0, MAX_PREPARED_OUTPUTS);
  const retainedIds = new Set(nextArtifacts.map((entry) => entry.id));
  const evictedArtifacts = previousArtifacts.filter((entry) => !retainedIds.has(entry.id));
  setState((current) => ({
    ...current,
    outputArtifacts: nextArtifacts,
    receipts: [receipt, ...current.receipts].slice(0, 100),
    lastAnnouncement: `${format.toUpperCase()} decision report prepared at revision ${artifact.decisionRevision}; download still requires a person.`,
  }), { type: "output.prepared", artifact: { ...artifact, bytes: undefined, text: undefined }, receipt });
  persistCaseSessionState(artifact.caseId);
  const storageFailures = [];
  try {
    await repository?.putBlob?.(outputBlobId(artifact.caseId, artifact.id), artifact);
  } catch (error) {
    storageFailures.push(error);
  }
  for (const evicted of evictedArtifacts) {
    try {
      await repository?.deleteBlob?.(outputBlobId(evicted.caseId, evicted.id));
    } catch (error) {
      storageFailures.push(error);
    }
  }
  if (storageFailures.length && state.activeCase?.id === artifact.caseId) {
    setState({
      lastAnnouncement: `${artifact.fileName} is ready for this session, but durable output retention cleanup needs a workspace reset.`,
    });
  }
  return { ok: true, artifact, receipt, retentionWarning: storageFailures.length > 0 };
}

export function prepareCaseExport(format = "json", options = {}) {
  const operation = outputPreparationQueue.then(() => prepareCaseExportNow(format, options));
  outputPreparationQueue = operation.catch(() => undefined);
  return operation;
}

export function downloadPreparedOutput(artifactId) {
  const artifact = state.outputArtifacts.find((entry) => entry.id === artifactId);
  if (!artifact) throw new Error("The prepared output is no longer available.");
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    return { ok: false, reason: "browser-download-unavailable" };
  }
  const blob = new Blob([artifact.bytes], { type: artifact.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
  setState({ lastAnnouncement: `${artifact.fileName} downloaded after human confirmation.` });
  return { ok: true, artifactId, fileName: artifact.fileName };
}

export async function togglePin(reference) {
  if (!state.activeCase) throw new Error("The decision runtime is not ready.");
  const targetCase = state.activeCase;
  const targetCaseId = targetCase.id;
  const targetRevision = targetCase.revision;
  const targetDecisionHash = getDecisionHash(targetCase);
  const targetViewRevision = state.viewRevision;
  const capturedLoadToken = latestCaseLoadToken;
  await assertWorkspaceNotFrozen(targetCase);
  if (
    capturedLoadToken !== latestCaseLoadToken ||
    state.activeCase?.id !== targetCaseId ||
    state.activeCase.revision !== targetRevision ||
    getDecisionHash(state.activeCase) !== targetDecisionHash ||
    state.viewRevision !== targetViewRevision
  ) {
    return { ok: false, canceled: true };
  }
  const key = `${reference.kind}:${reference.id}`;
  const exists = state.pins.some((pin) => `${pin.kind}:${pin.id}` === key);
  const pins = exists
    ? state.pins.filter((pin) => `${pin.kind}:${pin.id}` !== key)
    : [...state.pins, reference];
  state = { ...state, pins };
  writePresentationPreferences(targetCaseId, { pins });
  emit({ type: "presentation.pins-changed", caseId: targetCaseId, pins });
  try {
    return await submitDecisionQuestion(state.question, { lens: state.lens, source: "human-pin" });
  } catch (error) {
    if (error?.code === "EXECUTION_CANCELED") return { ok: false, canceled: true };
    throw error;
  }
}

export function focusEntity(reference, pathId = null) {
  const activePathId = pathId ?? state.activePathId;
  setState({
    focusRef: reference,
    activePathId,
    lastAnnouncement: `Focused ${reference.kind} ${reference.id}.`,
  }, { type: "presentation.focused", reference, pathId });
  writePresentationPreferences(state.activeCase?.id, { focusRef: reference, activePathId });
  return { ok: true, reference, pathId, viewRevision: state.viewRevision };
}

export function toggleSourceDrawer(force) {
  setState((current) => ({
    ...current,
    sourceDrawerOpen: typeof force === "boolean" ? force : !current.sourceDrawerOpen,
  }));
}

export function toggleOutline(force) {
  setState((current) => ({
    ...current,
    outlineOpen: typeof force === "boolean" ? force : !current.outlineOpen,
  }));
}

export function toggleIntake(force) {
  const intakeOpen = typeof force === "boolean" ? force : !state.intakeOpen;
  setState(
    { intakeOpen },
    { type: "capability-context.changed", phase: intakeOpen ? "intake" : state.capabilityPhase },
  );
}

export function toggleAudit(force) {
  setState((current) => ({
    ...current,
    auditOpen: typeof force === "boolean" ? force : !current.auditOpen,
  }));
}

export function toggleReducedMotion() {
  setState((current) => ({
    ...current,
    reducedMotion: !current.reducedMotion,
    lastAnnouncement: `Reduced motion ${!current.reducedMotion ? "enabled" : "disabled"}.`,
  }));
}

export async function startImportReview({ files = [], pastedText = "", domainId = "generic", title = "", objective = "", onJob }) {
  if (!importCoordinator) throw new Error("The import runtime is not ready.");
  const inputs = [...files];
  if (pastedText.trim()) {
    inputs.push({
      name: "pasted-evidence.txt",
      mimeType: "text/plain",
      text: pastedText.trim(),
    });
  }
  if (!inputs.length) throw new Error("Choose at least one file or paste source text.");
  const caseId = reserveAgentImportCaseId();
  const job = await importCoordinator.startImport(inputs, {
    caseId,
    domainHint: domainId,
    intakeContext: { source: "human", title, objective },
  });
  pendingImportReviewContexts.set(job.id, { source: "human", domainId, title, objective });
  onJob?.(job);
  setState({
    lastAnnouncement: `Import ${job.id} started with ${inputs.length} source${inputs.length === 1 ? "" : "s"}.`,
  }, { type: "import.started", job });
  const completed = await importCoordinator.waitForImport(job.id);
  if (completed.phase !== "review_required") {
    return { ok: false, job: completed, documents: [], proposal: null, caseId };
  }
  importReviewBuilds.delete(job.id);
  return materializeImportReview(completed, { source: "human", domainId, title, objective, force: true });
}

export async function cancelImport(jobId) {
  if (!importCoordinator) return { ok: false, phase: "unavailable" };
  let result;
  try {
    result = await importCoordinator.cancelImport(jobId);
  } catch (error) {
    const latest = await importCoordinator.getImport(jobId).catch(() => null);
    if (latest) await materializeRecoverableImport(latest);
    setState({
      lastAnnouncement: "Source deletion could not be verified. The retained-data recovery checkpoint remains visible and agent mutations stay retired.",
      error: error instanceof Error ? error.message : String(error),
    }, { type: "import.discard-recovery-required", jobId });
    throw error;
  }
  pendingImportReviewContexts.delete(jobId);
  importReviewBuilds.delete(jobId);
  setState((current) => ({
    ...current,
    activeImportReview: current.activeImportReview?.job?.id === jobId ? null : current.activeImportReview,
    lastAnnouncement: result.ok ? "Import canceled before canonical commit." : `Import is already ${result.phase}.`,
  }));
  await surfaceNextImportReview();
  return result;
}

export async function recoverImportReview(jobId) {
  if (!runtime || !importCoordinator) throw new Error("The decision and import runtimes must be ready.");
  const job = await importCoordinator.getImport(jobId);
  if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
  setState({
    activeImportReview: null,
    lastAnnouncement: job.phase === "complete" && job.rawInputCleanup?.status === "pending"
      ? "Retrying deletion of retained source bytes from the completed import."
      : ["resume_commit", "reconcile_committed_receipt"].includes(job.error?.details?.action)
      ? "Reconciling the interrupted commit with its durable idempotency receipt."
      : "Retrying the retained source through the bounded import pipeline.",
  }, { type: "import.recovery-started", jobId });
  if (job.phase === "complete" && job.rawInputCleanup?.status === "pending") {
    const cleaned = await importCoordinator.retrySourceCleanup(jobId);
    if (!cleaned.ok) return materializeRecoverableImport(cleaned.job);
    setState({
      intakeOpen: false,
      activeImportReview: null,
      lastAnnouncement: "Retained raw and parsed source copies were removed. The canonical sanitized decision revision was not re-executed.",
    }, { type: "import.source-cleanup-completed", jobId });
    await surfaceNextImportReview();
    return { ok: true, cleanupCompleted: true, job: cleaned.job };
  }
  if (["resume_commit", "reconcile_committed_receipt"].includes(job.error?.details?.action)) {
    const accepted = await importCoordinator.resumeImportCommit(jobId, { runtime });
    await loadCase(job.caseId, { announce: false });
    const receipt = { ...accepted.receipt, type: "import.commit-reconciled", status: "committed" };
    setState((current) => ({
      ...current,
      intakeOpen: false,
      activeImportReview: null,
      receipts: [receipt, ...current.receipts].slice(0, 100),
      lastAnnouncement: `Interrupted import commit reconciled at revision ${accepted.receipt.revisionAfter}.`,
    }), { type: "import.commit-reconciled", jobId, receipt });
    persistCaseSessionState(job.caseId);
    await surfaceNextImportReview();
    return { ok: true, committed: true, receipt };
  }
  const retried = await importCoordinator.retryImport(jobId);
  const completed = await importCoordinator.waitForImport(retried.id);
  if (completed.phase === "review_required") {
    return materializeImportReview(completed, { force: true });
  }
  return materializeRecoverableImport(completed);
}

export async function confirmImportProposal(review) {
  if (!runtime || !importCoordinator) throw new Error("The decision and import runtimes must be ready.");
  if (!review?.proposal?.caseInput || !review?.job?.id) throw new Error("The import review is incomplete.");
  const latestJob = await importCoordinator.getImport(review.job.id);
  if (!latestJob || latestJob.phase !== "review_required" || latestJob.version !== review.job.version) {
    importReviewBuilds.delete(review.job.id);
    if (latestJob?.phase === "review_required") await materializeImportReview(latestJob, { force: true });
    throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The import mapping changed during review. Recheck the refreshed proposal before confirming it.");
  }
  const idempotencyRoot = `confirm:${review.job.id}`;
  let accepted;
  try {
    accepted = review.targetMode === "existing-case"
      ? await (async () => {
          const current = await runtime.getCase(review.caseId);
          if (!current) throw new Error(`Case '${review.caseId}' is no longer available.`);
          return importCoordinator.acceptImport(review.job.id, {
            runtime,
            expectedRevision: current.revision,
            expectedImportVersion: review.job.version,
            idempotencyKey: `${idempotencyRoot}:existing-case`,
            actor: ACTOR,
          });
        })()
      : await importCoordinator.acceptImportAsNewCase(review.job.id, {
          runtime,
          caseInput: review.proposal.caseInput,
          claims: review.proposal.claims,
          expectedImportVersion: review.job.version,
          idempotencyKey: `${idempotencyRoot}:atomic-case`,
          actor: ACTOR,
        });
  } catch (error) {
    const recoverable = await importCoordinator.getImport(review.job.id);
    if (recoverable?.phase === "review_required") {
      importReviewBuilds.delete(review.job.id);
      await materializeImportReview(recoverable, { force: true });
    }
    throw error;
  }
  const revision = accepted.receipt.revisionAfter;
  await loadCase(review.caseId, { announce: false });
  const receipts = [{
    ...accepted.receipt,
    type: review.targetMode === "existing-case" ? "import.accepted" : "case.created-with-import",
    status: "committed",
  }];
  pendingImportReviewContexts.delete(review.job.id);
  importReviewBuilds.delete(review.job.id);
  const cleanupPending = accepted.cleanupPending || accepted.job?.rawInputCleanup?.status === "pending";
  if (cleanupPending) {
    const recovery = await materializeRecoverableImport(accepted.job);
    setState((current) => ({
      ...current,
      receipts: [...receipts, ...current.receipts].slice(0, 100),
      lastAnnouncement: `Imported decision room committed at revision ${revision}, but retained source cleanup is pending. The recovery checkpoint remains open until those local copies are removed.`,
      activeImportReview: recovery,
      intakeOpen: true,
    }), { type: "import.completed-cleanup-pending", caseId: review.caseId, revision, jobId: review.job.id });
  } else {
    setState((current) => ({
      ...current,
      intakeOpen: false,
      activeImportReview: null,
      receipts: [...receipts, ...current.receipts].slice(0, 100),
      lastAnnouncement: `Imported decision room committed at revision ${revision}. Every material claim remains linked to its sanitized canonical source block.`,
    }), { type: "import.completed", caseId: review.caseId, revision });
  }
  persistCaseSessionState(review.caseId);
  if (!cleanupPending) await surfaceNextImportReview();
  return {
    ok: true,
    caseId: review.caseId,
    revision,
    receipts,
    cleanupPending,
    recovery: cleanupPending ? state.activeImportReview : null,
  };
}

export async function toggleFreeze() {
  if (state.activeCase?.status === "approved") return { ok: false, reason: "approved-case" };
  const caseId = state.activeCase?.id;
  const current = await readGovernance(caseId);
  const nextFrozen = !current.manualFrozen;
  const governance = await mutateGovernance(caseId, () => ({ manualFrozen: nextFrozen }));
  await refreshActiveGovernance(caseId);
  if (state.activeCase?.id === caseId) {
    const shared = state.persistenceMode === "durable";
    setState({
      lastAnnouncement: nextFrozen
        ? shared ? "Room frozen by the decision owner across every open tab." : "Room frozen in this session-only tab."
        : shared ? "Room reopened by the decision owner across every open tab." : "Room reopened in this session-only tab.",
    }, { type: "workspace.freeze-changed", frozen: nextFrozen, governanceVersion: governance.version });
  }
  return { ok: true, frozen: nextFrozen, governanceVersion: governance.version };
}

export function openApprovalPreview(alternativeId = state.evaluation?.recommendation?.alternativeId) {
  if (!alternativeId || state.activeCase?.contract?.status !== "active" || state.activeCase?.domain?.packId === "candidate-review") return false;
  setState({ approvalOpen: true, approvalTargetId: alternativeId });
  return true;
}

export function closeApprovalPreview() {
  setState({ approvalOpen: false, approvalTargetId: null });
}

export async function commitHumanApproval() {
  if (!runtime || !state.activeCase) throw new Error("The decision runtime is not ready.");
  const targetCase = state.activeCase;
  const targetCaseId = targetCase.id;
  const targetRevision = targetCase.revision;
  const capturedLoadToken = latestCaseLoadToken;
  const alternativeId = state.approvalTargetId;
  if (!alternativeId) throw new Error("No approval target is selected.");
  const decisionHash = getDecisionHash(targetCase);
  await assertWorkspaceNotFrozen(targetCase);
  const result = await runtime.executeCommand(
    {
      type: "approve_decision",
      payload: {
        alternativeId,
        approvalId: makeId("approval"),
        expectedDecisionHash: decisionHash,
      },
    },
    {
      caseId: targetCaseId,
      expectedRevision: targetRevision,
      idempotencyKey: makeId("human-approval"),
      actor: ACTOR,
    },
  );
  const receipt = { ...result.receipt, type: "decision.approved", status: "committed" };
  const refreshed = await refreshCaseAfterMutation(targetCaseId, capturedLoadToken);
  if (!refreshed) {
    persistInactiveCaseReceipt(targetCaseId, receipt);
    return { ok: true, receipt };
  }
  setState((current) => ({
    ...current,
    approvalOpen: false,
    approvalTargetId: null,
    frozen: true,
    receipts: [receipt, ...current.receipts].slice(0, 100),
    lastAnnouncement: "The human decision was committed to the exact decision digest and the case is now frozen.",
  }), { type: "decision.approved", receipt });
  persistCaseSessionState(targetCaseId);
  return { ok: true, receipt };
}

export async function runScenario(scenarioId) {
  if (!runtime || !state.activeCase) throw new Error("The decision runtime is not ready.");
  const targetCaseId = state.activeCase.id;
  const targetRevision = state.activeCase.revision;
  const result = await runtime.evaluateScenario(targetCaseId, scenarioId);
  if (state.activeCase?.id !== targetCaseId || state.activeCase.revision !== targetRevision) return result;
  const snapshot = projectSnapshot(state.activeCase, state.evaluation, {
    activeScenario: scenarioId,
    scenarioResult: result,
  });
  setState({
    activeScenario: scenarioId,
    scenarioResult: result,
    snapshot,
    lastAnnouncement: `${result.scenario.label} evaluated without changing the canonical decision.`,
  }, { type: "scenario.evaluated", caseId: targetCaseId, decisionRevision: targetRevision, scenarioId, result });
  return result;
}

export async function restoreViewRevision(viewRevision) {
  const entry = state.history.find((item) => item.plan.nextViewRevision === viewRevision);
  if (!entry) throw new Error(`View revision ${viewRevision} is not available in local history.`);
  return submitDecisionQuestion(entry.plan.question, {
    lens: entry.plan.lens,
    source: "history-restore",
  });
}

export function saveCurrentView() {
  const receipt = {
    id: makeId("saved-view"),
    type: "presentation.saved",
    at: new Date().toISOString(),
    caseId: state.activeCase.id,
    viewRevision: state.viewRevision,
    viewHash: state.plan?.viewHash ?? null,
    status: "committed",
  };
  setState((current) => {
    const alreadyRecorded = current.history.some((entry) => entry.plan?.nextViewRevision === current.viewRevision);
    const savedPlan = current.plan ? { ...current.plan, nextViewRevision: current.viewRevision } : null;
    const history = alreadyRecorded || !current.plan
      ? current.history
      : [...current.history, { plan: savedPlan, receipt }].slice(-24);
    return {
      ...current,
      history,
      historyCursor: history.length - 1,
      receipts: [receipt, ...current.receipts].slice(0, 100),
      lastAnnouncement: `View version ${current.viewRevision} saved to this decision's history.`,
    };
  }, { type: "presentation.saved", receipt });
  persistCaseSessionState();
  return { ok: true, receipt };
}

export function setWebMcpStatus(status) {
  // Registration status is presentation feedback, not a capability-context input.
  // Broadcasting it back through the ports would make gateway reconciliation
  // schedule itself indefinitely.
  setState({ webMcp: { ...state.webMcp, ...status } });
}

export function addExternalReceipt(receipt) {
  const id = receipt?.id ?? receipt?.operationId;
  if (!id) return;
  const normalized = { ...receipt, id };
  setState((current) => ({
    ...current,
    receipts: current.receipts.some((entry) => entry.id === id)
      ? current.receipts
      : [normalized, ...current.receipts].slice(0, 100),
  }));
  persistCaseSessionState();
}

export function recordAgentActivity(event) {
  setState((current) => ({
    ...current,
    agentActivity: reduceAgentActivity(current.agentActivity, event),
  }));
}

export function addExternalReviewArtifact(event) {
  const incoming = event?.artifact ?? event;
  if (!incoming?.id || !incoming?.kind) return;
  const payload = incoming.payload && typeof incoming.payload === "object" ? incoming.payload : {};
  let body = incoming.reason || payload.note || payload.summary || payload.purpose || "Agent proposal staged for human review.";
  if (typeof body !== "string") body = JSON.stringify(body);
  const artifact = {
    id: incoming.id,
    kind: incoming.kind,
    body: body.slice(0, 1_000),
    entityRefs: Array.isArray(payload.entityRefs)
      ? payload.entityRefs.filter((reference) => reference?.kind && reference?.id).slice(0, 20)
      : [],
    source: "agent",
    actor: incoming.actor ?? { type: "agent", id: "webmcp-agent" },
    caseId: incoming.caseId ?? state.activeCase?.id ?? null,
    decisionRevision: event?.receipt?.revisionBefore ?? state.activeCase?.revision ?? null,
    at: incoming.createdAt ?? new Date().toISOString(),
    status: incoming.status ?? "awaiting-human",
    proposal: payload,
  };
  setState((current) => ({
    ...current,
    reviewArtifacts: current.reviewArtifacts.some((entry) => entry.id === artifact.id)
      ? current.reviewArtifacts
      : [artifact, ...current.reviewArtifacts].slice(0, 100),
    lastAnnouncement: `${artifact.kind.replaceAll("_", " ")} staged by the browser agent for visible human review.`,
  }));
  persistCaseSessionState();
}

export async function resetLocalDemoData() {
  cancelComposition();
  runtime?.close?.();
  repository?.close?.();
  governanceBroadcast?.close?.();
  governanceBroadcast = null;
  if (state.persistenceMode === "durable") {
    await clearWebMcpJournalDatabase();
  } else if (typeof indexedDB !== "undefined") {
    await clearWebMcpJournalDatabase().catch(() => undefined);
  }
  try {
    localStorage.removeItem(PRESENTATION_STORAGE_KEY);
    localStorage.removeItem(ACTIVE_CASE_STORAGE_KEY);
    localStorage.removeItem(WEBMCP_INVOCATION_STORAGE_KEY);
    localStorage.removeItem(WEBMCP_RECEIPT_STORAGE_KEY);
  } catch {
    // IndexedDB is authoritative; view preferences can safely expire separately.
  }
  if (typeof indexedDB !== "undefined") {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(WORKSPACE_DATABASE_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("The local decision workspace could not be erased."));
      request.onblocked = () => reject(new Error("Another SituationRoom tab is using this workspace. Close it and retry the reset."));
    });
  }
  window.location.reload();
}

export function getRuntime() {
  return runtime;
}

export function getImportCoordinator() {
  return importCoordinator;
}

export function getPresentationPort() {
  return {
    getPresentationSnapshot: () => {
      const snapshot = projectSnapshot();
      const plan = state.plan;
      return {
        ...snapshot,
        lens: plan?.lens ?? state.lens,
        layoutId: plan?.layout?.pattern ?? null,
        density: plan?.layout?.density ?? null,
        question: plan?.question ?? state.question,
        framing: plan?.framing ?? null,
        viewHash: plan?.viewHash ?? null,
        renderedInstrumentIds: plan?.instruments?.map((instrument) => instrument.id) ?? [],
        preservedPins: state.pins.length,
        omittedEntityCount: plan?.omitted?.entityCount ?? 0,
        sourceDrawerOpen: state.sourceDrawerOpen,
        capabilities: {
          instrumentTypes: getInstrumentCapabilities(snapshot, { lens: plan?.lens ?? state.lens }),
          layoutIds: listLayoutDefinitions().map((layout) => layout.pattern),
          regions: REGIONS,
        },
      };
    },
    applyPresentationRecipe,
    focusEntity,
    saveView: saveCurrentView,
    restoreViewRevision,
    waitForSettled: async () => ({ settled: state.compositionPhase === "idle", viewRevision: state.viewRevision }),
    requestHumanCheckpoint: async (request = {}) => {
      const activeCase = state.activeCase;
      const caseId = activeCase?.id;
      const decisionRevision = activeCase?.revision;
      if (!activeCase || request.caseId !== caseId) {
        throw new SituationRoomError(ERROR_CODES.NOT_FOUND, "The requested decision case is not active.");
      }
      if (request.expectedDecisionRevision !== decisionRevision) {
        throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The decision changed before the human-resolution request became visible.");
      }
      const body = String(request.question ?? "").trim();
      if (!body || body.length > 1_000) throw new Error("Human-resolution questions must contain 1 to 1,000 characters.");
      const policy = assessAgentArtifact({
        decisionCase: activeCase,
        evaluation: state.evaluation,
        presentation: state.plan,
        texts: [body],
        entityRefs: request.entityRefs ?? [],
      });
      if (!policy.ok) throw new SituationRoomError(ERROR_CODES[policy.code] ?? policy.code, policy.message);
      const artifactId = makeId("review");
      const checkpoint = {
        id: artifactId,
        kind: "human_resolution_request",
        body,
        entityRefs: policy.entityRefs.slice(0, 20),
        source: "agent",
        actor: { type: "agent", id: "webmcp-agent" },
        caseId,
        decisionRevision,
        at: new Date().toISOString(),
        status: "awaiting-human",
      };
      const governance = await mutateGovernance(caseId, (current) => ({
        humanCheckpoints: [...(current.humanCheckpoints ?? []).filter((entry) => entry.id !== artifactId), checkpoint],
      }), { notify: false });
      if (state.activeCase?.id !== caseId || state.activeCase?.revision !== decisionRevision) {
        if (state.persistenceMode === "durable") {
          governanceBroadcast?.postMessage({ type: "governance.changed", caseId, version: governance.version });
        }
        return { ok: true, awaitingHuman: true, artifact: checkpoint, caseChanged: true };
      }
      let staged;
      try {
        staged = stageReviewArtifact({
          id: artifactId,
          kind: checkpoint.kind,
          body,
          entityRefs: checkpoint.entityRefs,
          source: "agent",
        });
      } catch (error) {
        await mutateGovernance(caseId, (current) => ({
          humanCheckpoints: (current.humanCheckpoints ?? []).filter((entry) => entry.id !== artifactId),
        }));
        throw error;
      }
      if (state.persistenceMode === "durable") {
        governanceBroadcast?.postMessage({ type: "governance.changed", caseId, version: governance.version });
      }
      setState((current) => ({
        ...current,
        governance,
        capabilityPhase: "collaboration",
        lastAnnouncement: "A cited agent question is visible in the Review exchange for human resolution.",
      }), { type: "review.human-resolution-requested", artifact: staged.artifact, receipt: staged.receipt });
      persistCaseSessionState();
      return { ok: true, awaitingHuman: true, artifact: staged.artifact, receipt: staged.receipt };
    },
    subscribe: subscribeWorkspaceEvents,
  };
}

export function getWorkspaceRuntimePort() {
  if (!runtime) return null;
  return {
    getWorkspaceState: async () => {
      const workspace = await runtime.getWorkspaceState();
      const authority = await getWorkspaceAuthorityContext();
      return {
        ...workspace,
        workspacePhase: state.activeImportReview ? "import_review" : state.intakeOpen ? "intake" : state.activeCase ? state.capabilityPhase : "empty",
        activeCaseId: state.activeCase?.id ?? null,
        domainId: state.activeCase?.domain?.packId ?? null,
        domainRisk: state.snapshot?.domain?.riskLevel ?? "standard",
        role: "decision-owner",
        permissions: ["*"],
        frozen: authority.frozen || !authority.sharedAuthorityAvailable,
        sharedAuthorityAvailable: authority.sharedAuthorityAvailable,
        governedAgentMutationsBlocked: !authority.sharedAuthorityAvailable,
        pendingHumanCheckpoint: authority.pendingHumanCheckpoint || hasPendingHumanCheckpoint(),
        pendingHumanAuthorityCheckpoint: authority.pendingHumanAuthorityCheckpoint,
        governanceVersion: authority.governanceVersion,
        decisionRevision: state.activeCase?.revision ?? null,
        decisionHash: state.activeCase ? getDecisionHash(state.activeCase) : null,
        viewRevision: state.viewRevision,
        stagedSourceCount: state.stagedSourceCount,
      };
    },
    getActiveContract: (caseId) => runtime.getActiveContract(caseId),
    queryGraph: (query) => runtime.queryGraph(query),
    evaluate: (caseId, _options) => runtime.evaluate(caseId),
    executeCommand: (command, options) => runtime.executeCommand(command, options),
    getRecentChanges: async () => state.receipts.slice(0, 12),
    subscribe: subscribeWorkspaceEvents,
  };
}

export function resetWorkspaceForTesting() {
  compositionToken += 1;
  governanceBroadcast?.close?.();
  governanceBroadcast = null;
  outputPreparationQueue = Promise.resolve();
  caseLoadQueue = Promise.resolve();
  latestCaseLoadToken = 0;
  sessionStateWriteQueues.clear();
  sessionStateCache.clear();
  state = { ...initialState };
  initializationPromise = null;
  runtime?.close?.();
  runtime = null;
  repository = null;
  importCoordinator = null;
  pendingImportReviewContexts.clear();
  importReviewBuilds.clear();
  stagedSources.clear();
  stagedSourceIds = new WeakMap();
  emit();
}
