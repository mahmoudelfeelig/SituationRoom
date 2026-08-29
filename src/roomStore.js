import { useSyncExternalStore } from "react";
import {
  CASE_INFO,
  DEFAULT_PINNED_REQUIREMENTS,
  DEFAULT_QUESTION,
  EVIDENCE,
  REQUIREMENTS,
  VENDORS,
} from "./data/caseData.js";
import {
  createViewRecipe,
  evaluateCase,
  getDecisionHash,
  hashValue,
  runScenario,
  validateViewRecipe,
} from "./decisionEngine.js";

const DEFAULT_SCENARIO = Object.freeze({
  totalCost: 305000,
  operations: {
    coverage: "business-hours",
    namedEngineer: false,
    acknowledgementMinutes: 60,
    continuousEngagement: false,
    euResidency: true,
    deploymentWeeks: 11,
  },
});

function readReducedMotion() {
  if (typeof window === "undefined") return false;
  const saved = window.localStorage.getItem("situation-room:reduced-motion");
  if (saved !== null) return saved === "true";
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function createInitialState() {
  const initialRecipe = createViewRecipe(DEFAULT_QUESTION, 1);
  const initialView = {
    lens: "investigate",
    question: DEFAULT_QUESTION,
    framing: "Follow the decisive evidence from proposal language to mandatory gates.",
    activeVendorIds: ["vendor-b"],
    activeRequirementIds: REQUIREMENTS.map((requirement) => requirement.id),
    stakeholderIds: [],
    modules: initialRecipe.modules,
    density: "focused",
    source: "default",
  };

  return {
    caseRevision: CASE_INFO.canonicalRevision,
    viewRevision: 1,
    decisionHash: getDecisionHash(),
    view: initialView,
    history: [
      {
        id: "view-1",
        viewRevision: 1,
        createdAt: CASE_INFO.updatedAt,
        label: "Canonical investigation",
        view: initialView,
        source: "default",
      },
    ],
    historyCursor: 0,
    pinnedEvidenceIds: [],
    pinnedRequirementIds: [...DEFAULT_PINNED_REQUIREMENTS],
    expandedEvidenceIds: ["b-response"],
    challengedEvidenceIds: [],
    disputedEvidenceIds: [],
    lockedInterpretationIds: [],
    focusedEvidenceId: "b-response",
    sourceDrawerOpen: false,
    outlineOpen: false,
    reducedMotion: readReducedMotion(),
    frozen: false,
    compositionPhase: "idle",
    pendingRecipe: null,
    compositionMessage: "Room ready",
    compositionError: null,
    viewStale: false,
    omittedEntityCount: 31 - 7,
    lastAnnouncement: "SituationRoom loaded. Vendor B has two mandatory blockers.",
    webMcpAvailable: false,
    webMcpToolCount: 0,
    approval: {
      status: "unapproved",
      previewOpen: false,
      vendorId: null,
      approvedAt: null,
      digest: null,
    },
    decisionAudit: [
      {
        id: "audit-12-created",
        revision: 12,
        at: "2026-08-26T09:15:00.000Z",
        actor: "Procurement team",
        action: "Case created and mandatory policy imported",
      },
      {
        id: "audit-16-evidence-lock",
        revision: 16,
        at: CASE_INFO.evidenceLockedAt,
        actor: "Evidence custodian",
        action: "Proposal evidence locked",
      },
      {
        id: "audit-17-interpretation",
        revision: 17,
        at: CASE_INFO.updatedAt,
        actor: "Analyst JH",
        action: "Mapped 24/7 monitoring separately from human incident response",
      },
    ],
    scenario: {
      open: false,
      saved: false,
      ...structuredClone(DEFAULT_SCENARIO),
    },
  };
}

let state = createInitialState();
let compositionToken = 0;
const listeners = new Set();

function emit() {
  listeners.forEach((listener) => listener());
}

function setState(updater) {
  state = typeof updater === "function" ? updater(state) : updater;
  emit();
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function presentationHash(view) {
  return hashValue({
    lens: view.lens,
    question: view.question,
    framing: view.framing,
    activeVendorIds: view.activeVendorIds,
    activeRequirementIds: view.activeRequirementIds,
    stakeholderIds: view.stakeholderIds,
    modules: view.modules,
    density: view.density,
  });
}

function recipeToView(recipe, source) {
  return {
    lens: recipe.lens,
    question: recipe.question,
    framing:
      recipe.framing ??
      (recipe.lens === "compare"
        ? "Align every vendor against the same mandatory gates."
        : recipe.lens === "simulate"
          ? "Stage the smallest changes that could alter eligibility."
          : recipe.lens === "brief"
            ? "Convene stakeholder mandates around the protected decision."
            : "Follow the decisive evidence from proposal language to mandatory gates."),
    activeVendorIds: recipe.vendorIds,
    activeRequirementIds: recipe.requirementIds,
    stakeholderIds: recipe.stakeholderIds,
    modules: recipe.modules,
    density: recipe.density,
    source,
  };
}

function buildViewEntry(nextView, nextRevision, source) {
  const labels = {
    investigate: "Causal investigation",
    compare: "Vendor comparison",
    simulate: "Counterfactual fork",
    brief: "Decision council brief",
  };
  return {
    id: `view-${nextRevision}-${Date.now()}`,
    viewRevision: nextRevision,
    createdAt: new Date().toISOString(),
    label: labels[nextView.lens],
    view: nextView,
    viewHash: presentationHash(nextView),
    source,
  };
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRoomState() {
  return state;
}

export function useRoomStore(selector = (value) => value) {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export async function composeRoomView(recipe, source = "agent") {
  if (state.frozen) {
    return { ok: false, error: "The room is frozen by a human reviewer." };
  }
  const validation = validateViewRecipe(recipe, state.viewRevision, state.caseRevision);
  if (!validation.ok) {
    setState((current) => ({
      ...current,
      compositionPhase: "rejected",
      pendingRecipe: null,
      compositionError: validation.error,
      compositionMessage: "View recipe rejected; the existing room was preserved",
      lastAnnouncement: `View change rejected. ${validation.error}`,
    }));
    return validation;
  }

  const token = ++compositionToken;
  const nextView = recipeToView(recipe, source);
  setState((current) => ({
    ...current,
    compositionPhase: "interpreting",
    pendingRecipe: recipe,
    compositionError: null,
    compositionMessage: "Reading cited evidence",
    lastAnnouncement: `Preparing a ${recipe.lens} view for: ${recipe.question}`,
  }));

  if (!state.reducedMotion) await delay(180);
  if (token !== compositionToken) return { ok: false, error: "Composition cancelled." };
  setState((current) => ({
    ...current,
    compositionPhase: "planning",
    compositionMessage: `Planning ${Math.min(7, recipe.requirementIds.length + 3)} exhibits around mandatory gates`,
  }));

  if (!state.reducedMotion) await delay(180);
  if (token !== compositionToken) return { ok: false, error: "Composition cancelled." };
  setState((current) => ({
    ...current,
    compositionPhase: "arranging",
    compositionMessage: "Arranging evidence; pinned policy will remain",
  }));

  if (!state.reducedMotion) await delay(220);
  if (token !== compositionToken) return { ok: false, error: "Composition cancelled." };

  const previousDecisionHash = state.decisionHash;
  const commitView = () => setState((current) => {
    const nextRevision = current.viewRevision + 1;
    const entry = buildViewEntry(nextView, nextRevision, source);
    const retainedHistory = current.history.slice(0, current.historyCursor + 1);
    const history = [...retainedHistory, entry].slice(-12);
    return {
      ...current,
      viewRevision: nextRevision,
      view: nextView,
      history,
      historyCursor: history.length - 1,
      compositionPhase: "settled",
      pendingRecipe: null,
      compositionMessage: "Room composed; decision facts unchanged",
      lastAnnouncement: `${entry.label} ready. ${current.omittedEntityCount} contextual entities are omitted. Decision revision ${current.caseRevision} is unchanged.`,
      sourceDrawerOpen: false,
      outlineOpen: false,
      scenario: {
        ...current.scenario,
        open: recipe.lens === "simulate",
      },
      viewStale: false,
    };
  });
  if (!state.reducedMotion && typeof document.startViewTransition === "function") {
    document.startViewTransition(commitView);
  } else {
    commitView();
  }

  if (!state.reducedMotion) await delay(320);
  if (token === compositionToken) {
    setState((current) => ({ ...current, compositionPhase: "idle" }));
  }

  return {
    ok: true,
    lens: nextView.lens,
    renderedModules: nextView.modules,
    referencedVendorIds: nextView.activeVendorIds,
    preservedPinnedEvidenceIds: [...state.pinnedEvidenceIds],
    preservedPinnedRequirementIds: [...state.pinnedRequirementIds],
    decisionHashBefore: previousDecisionHash,
    decisionHashAfter: state.decisionHash,
    viewRevision: state.viewRevision,
    viewHash: presentationHash(state.view),
  };
}

export async function submitQuestion(question) {
  const trimmed = question.trim();
  if (!trimmed) return { ok: false, error: "Enter a decision question first." };
  return composeRoomView(
    createViewRecipe(trimmed, state.viewRevision, state.caseRevision),
    "human-request",
  );
}

export function cancelComposition() {
  compositionToken += 1;
  setState((current) => ({
    ...current,
    compositionPhase: "idle",
    pendingRecipe: null,
    compositionMessage: "Composition cancelled; previous room preserved",
    lastAnnouncement: "Composition cancelled. The previous room is unchanged.",
  }));
}

export function setManualLens(lens) {
  const questions = {
    investigate: DEFAULT_QUESTION,
    compare: "Compare all vendors against the mandatory gates.",
    simulate: "What must Vendor B change to become eligible?",
    brief: "Brief Finance, Clinical Operations, and Information Security.",
  };
  return composeRoomView(
    createViewRecipe(questions[lens], state.viewRevision, state.caseRevision),
    "manual",
  );
}

export function togglePinEvidence(evidenceId) {
  if (!EVIDENCE.some((evidence) => evidence.id === evidenceId)) return;
  setState((current) => {
    const pinned = current.pinnedEvidenceIds.includes(evidenceId)
      ? current.pinnedEvidenceIds.filter((id) => id !== evidenceId)
      : [...current.pinnedEvidenceIds, evidenceId];
    return {
      ...current,
      pinnedEvidenceIds: pinned,
      lastAnnouncement: pinned.includes(evidenceId)
        ? "Evidence pinned. It will survive future compositions."
        : "Evidence unpinned.",
    };
  });
}

export function togglePinRequirement(requirementId) {
  if (!REQUIREMENTS.some((requirement) => requirement.id === requirementId)) return;
  setState((current) => {
    const pinned = current.pinnedRequirementIds.includes(requirementId)
      ? current.pinnedRequirementIds.filter((id) => id !== requirementId)
      : [...current.pinnedRequirementIds, requirementId];
    return { ...current, pinnedRequirementIds: pinned };
  });
}

export function toggleExpandedEvidence(evidenceId) {
  setState((current) => ({
    ...current,
    expandedEvidenceIds: current.expandedEvidenceIds.includes(evidenceId)
      ? current.expandedEvidenceIds.filter((id) => id !== evidenceId)
      : [...current.expandedEvidenceIds, evidenceId],
    focusedEvidenceId: evidenceId,
  }));
}

export function focusEvidence(evidenceId) {
  setState((current) => ({
    ...current,
    focusedEvidenceId: current.focusedEvidenceId === evidenceId ? null : evidenceId,
    lastAnnouncement: evidenceId
      ? "The complete source-to-outcome path is highlighted."
      : "Causal-path focus cleared.",
  }));
}

export function toggleChallengeEvidence(evidenceId) {
  setState((current) => ({
    ...current,
    challengedEvidenceIds: current.challengedEvidenceIds.includes(evidenceId)
      ? current.challengedEvidenceIds.filter((id) => id !== evidenceId)
      : [...current.challengedEvidenceIds, evidenceId],
    focusedEvidenceId: evidenceId,
    lastAnnouncement: "Contradictory evidence has been staged beside the selected claim.",
  }));
}

export function toggleEvidenceDispute(evidenceId) {
  if (!EVIDENCE.some((evidence) => evidence.id === evidenceId)) return;
  setState((current) => {
    const wasDisputed = current.disputedEvidenceIds.includes(evidenceId);
    const disputedEvidenceIds = wasDisputed
      ? current.disputedEvidenceIds.filter((id) => id !== evidenceId)
      : [...current.disputedEvidenceIds, evidenceId];
    const nextRevision = current.caseRevision + 1;
    const event = {
      id: `audit-${nextRevision}-${Date.now()}`,
      revision: nextRevision,
      at: new Date().toISOString(),
      actor: "Human reviewer",
      action: `${wasDisputed ? "Resolved dispute on" : "Flagged disputed interpretation for"} ${getEvidenceLabel(evidenceId)}`,
    };
    return {
      ...current,
      caseRevision: nextRevision,
      decisionHash: hashValue({
        previous: current.decisionHash,
        disputedEvidenceIds,
        nextRevision,
      }),
      disputedEvidenceIds,
      viewStale: true,
      decisionAudit: [...current.decisionAudit, event],
      lastAnnouncement: wasDisputed
        ? "Evidence dispute resolved. Dependent views should be recomposed from the new revision."
        : "Evidence interpretation marked disputed. Approval is blocked until it is resolved.",
    };
  });
}

function getEvidenceLabel(evidenceId) {
  return EVIDENCE.find((evidence) => evidence.id === evidenceId)?.title ?? evidenceId;
}

export function toggleInterpretationLock(evidenceId) {
  if (!EVIDENCE.some((evidence) => evidence.id === evidenceId)) return;
  setState((current) => {
    const wasLocked = current.lockedInterpretationIds.includes(evidenceId);
    const lockedInterpretationIds = wasLocked
      ? current.lockedInterpretationIds.filter((id) => id !== evidenceId)
      : [...current.lockedInterpretationIds, evidenceId];
    const nextRevision = current.caseRevision + 1;
    return {
      ...current,
      caseRevision: nextRevision,
      decisionHash: hashValue({
        previous: current.decisionHash,
        lockedInterpretationIds,
        nextRevision,
      }),
      lockedInterpretationIds,
      viewStale: true,
      decisionAudit: [
        ...current.decisionAudit,
        {
          id: `audit-${nextRevision}-${Date.now()}`,
          revision: nextRevision,
          at: new Date().toISOString(),
          actor: "Human reviewer",
          action: `${wasLocked ? "Unlocked" : "Locked"} interpretation for ${getEvidenceLabel(evidenceId)}`,
        },
      ],
      lastAnnouncement: wasLocked
        ? "Interpretation unlocked."
        : "Interpretation human-locked. The agent cannot replace this mapping.",
    };
  });
}

export function toggleSources() {
  setState((current) => ({ ...current, sourceDrawerOpen: !current.sourceDrawerOpen }));
}

export function toggleOutline() {
  setState((current) => ({
    ...current,
    outlineOpen: !current.outlineOpen,
    lastAnnouncement: current.outlineOpen
      ? "Spatial view restored."
      : "Outline view opened in causal reading order.",
  }));
}

export function toggleReducedMotion() {
  setState((current) => {
    const reducedMotion = !current.reducedMotion;
    window.localStorage.setItem("situation-room:reduced-motion", String(reducedMotion));
    return { ...current, reducedMotion };
  });
}

export function toggleFreeze() {
  if (state.approval.status === "approved") {
    setState((current) => ({
      ...current,
      frozen: true,
      lastAnnouncement: "An approved award keeps the room frozen. Create a new revision to continue.",
    }));
    return;
  }
  setState((current) => ({
    ...current,
    frozen: !current.frozen,
    lastAnnouncement: current.frozen
      ? "Room unfrozen. Agent composition is available."
      : "Room frozen by a human reviewer. Agent composition is disabled.",
  }));
}

export function undoView() {
  if (state.historyCursor <= 0) return false;
  const cursor = state.historyCursor - 1;
  const entry = state.history[cursor];
  setState((current) => ({
    ...current,
    view: entry.view,
    historyCursor: cursor,
    viewRevision: current.viewRevision + 1,
    compositionMessage: "Previous room restored",
    lastAnnouncement: `${entry.label} restored. Decision facts are unchanged.`,
    scenario: { ...current.scenario, open: entry.view.lens === "simulate" },
  }));
  return true;
}

export function restoreDefaultView() {
  const first = state.history[0];
  setState((current) => ({
    ...current,
    view: first.view,
    historyCursor: 0,
    viewRevision: current.viewRevision + 1,
    focusedEvidenceId: "b-response",
    expandedEvidenceIds: ["b-response"],
    sourceDrawerOpen: false,
    outlineOpen: false,
    scenario: { ...current.scenario, open: false },
    compositionPhase: "idle",
    compositionError: null,
    lastAnnouncement: "The canonical investigation room has been restored.",
  }));
}

export function restoreHistoryEntry(index) {
  const entry = state.history[index];
  if (!entry) return;
  setState((current) => ({
    ...current,
    view: entry.view,
    historyCursor: index,
    viewRevision: current.viewRevision + 1,
    scenario: { ...current.scenario, open: entry.view.lens === "simulate" },
    lastAnnouncement: `${entry.label} restored from view history.`,
  }));
}

export function openScenario() {
  const recipe = createViewRecipe(
    "What must Vendor B change to become eligible?",
    state.viewRevision,
    state.caseRevision,
  );
  return composeRoomView(recipe, "fork-scenario");
}

export function closeScenario() {
  setState((current) => ({
    ...current,
    scenario: { ...current.scenario, open: false },
    lastAnnouncement: "Scenario fork closed. The canonical record remains unchanged.",
  }));
}

export function updateScenario(patch) {
  setState((current) => ({
    ...current,
    scenario: {
      ...current.scenario,
      ...patch,
      operations: {
        ...current.scenario.operations,
        ...(patch.operations ?? {}),
      },
      saved: false,
    },
    lastAnnouncement: "Scenario recalculated. The canonical decision is unchanged.",
  }));
}

export function resetScenario() {
  setState((current) => ({
    ...current,
    scenario: {
      open: true,
      saved: false,
      ...structuredClone(DEFAULT_SCENARIO),
    },
    lastAnnouncement: "Scenario reset to Vendor B's submitted proposal.",
  }));
}

export function saveScenario() {
  setState((current) => ({
    ...current,
    scenario: { ...current.scenario, saved: true, savedAt: new Date().toISOString() },
    lastAnnouncement: "Scenario saved as a hypothetical exhibit. The original decision is unchanged.",
  }));
}

export function setWebMcpStatus(available, toolCount = 0) {
  setState((current) => ({
    ...current,
    webMcpAvailable: available,
    webMcpToolCount: toolCount,
  }));
}

export function openApprovalPreview(vendorId) {
  const evaluation = evaluateCase().evaluations.find((entry) => entry.vendorId === vendorId);
  const disputedVendorEvidence = state.disputedEvidenceIds.some(
    (evidenceId) => EVIDENCE.find((evidence) => evidence.id === evidenceId)?.vendorId === vendorId,
  );
  if (!evaluation?.eligible || disputedVendorEvidence) {
    setState((current) => ({
      ...current,
      lastAnnouncement: disputedVendorEvidence
        ? "Approval is blocked until disputed evidence is resolved."
        : "Approval is blocked until every mandatory gate passes.",
    }));
    return false;
  }
  setState((current) => ({
    ...current,
    approval: {
      ...current.approval,
      previewOpen: true,
      vendorId,
      digest: hashValue({
        vendorId,
        decisionRevision: current.caseRevision,
        decisionHash: current.decisionHash,
        evaluation,
      }),
    },
    lastAnnouncement: "Approval preview opened. Only a human can commit this award.",
  }));
  return true;
}

export function closeApprovalPreview() {
  setState((current) => ({
    ...current,
    approval: { ...current.approval, previewOpen: false },
  }));
}

export function commitApproval() {
  const vendorId = state.approval.vendorId;
  const evaluation = evaluateCase().evaluations.find((entry) => entry.vendorId === vendorId);
  if (!state.approval.previewOpen || !evaluation?.eligible) {
    return { ok: false, error: "No current eligible award is ready for approval." };
  }
  const approvedAt = new Date().toISOString();
  setState((current) => {
    const nextRevision = current.caseRevision + 1;
    const approval = {
      ...current.approval,
      status: "approved",
      previewOpen: false,
      approvedAt,
    };
    return {
      ...current,
      caseRevision: nextRevision,
      decisionHash: hashValue({ base: current.decisionHash, approval, nextRevision }),
      approval,
      viewStale: true,
      decisionAudit: [
        ...current.decisionAudit,
        {
          id: `audit-${nextRevision}-approval`,
          revision: nextRevision,
          at: approvedAt,
          actor: "Human reviewer",
          action: `Approved award to ${evaluation.vendor.name}`,
        },
      ],
      frozen: true,
      lastAnnouncement: `${evaluation.vendor.name} approved by a human reviewer. The room is now frozen.`,
    };
  });
  return { ok: true, vendorId, approvedAt };
}

export function getRoomSnapshot() {
  const evaluation = evaluateCase();
  const activeScenario = runScenario("vendor-b", {
    totalCost: state.scenario.totalCost,
    operations: state.scenario.operations,
  });
  return {
    caseId: CASE_INFO.id,
    decisionRevision: state.caseRevision,
    decisionHash: state.decisionHash,
    viewRevision: state.viewRevision,
    viewHash: presentationHash(state.view),
    lens: state.view.lens,
    question: state.view.question,
    modules: state.view.modules,
    frozen: state.frozen,
    pins: {
      evidenceIds: state.pinnedEvidenceIds,
      requirementIds: state.pinnedRequirementIds,
    },
    omittedEntityCount: state.omittedEntityCount,
    viewStale: state.viewStale,
    recommendation: evaluation.recommendation,
    approval: state.approval,
    disputes: state.disputedEvidenceIds,
    scenario: state.scenario.open ? activeScenario : null,
  };
}

export function resetRoomForTesting() {
  compositionToken += 1;
  state = createInitialState();
  emit();
}
