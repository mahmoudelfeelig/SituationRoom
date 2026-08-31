import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/libre-baskerville/latin-400.css";
import "@fontsource/libre-baskerville/latin-700.css";
import "@fontsource/ibm-plex-sans-condensed/latin-400.css";
import "@fontsource/ibm-plex-sans-condensed/latin-500.css";
import "@fontsource/ibm-plex-sans-condensed/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import { App } from "./App.jsx";
import {
  IndexedDbInvocationStore,
  IndexedDbReceiptLedger,
  registerSituationRoomTools,
} from "./webmcp.js";
import { createWebMcpPorts } from "./workspace/webMcpAdapters.js";
import { createDecisionPacket } from "./workspace/exporter.js";
import { parseWorkspacePath } from "./workspace/workspaceRouter.js";
import {
  addExternalReceipt,
  addExternalReviewArtifact,
  getImportCoordinator,
  getPresentationPort,
  getRuntime,
  getWorkspaceAuthorityContext,
  getWorkspaceStoreState,
  hasPendingHumanCheckpoint,
  initializeWorkspace,
  prepareCaseExport,
  recordAgentActivity,
  reserveAgentImportCaseId,
  resolveStagedSource,
  setWebMcpStatus,
  stageReviewArtifact,
  subscribeWorkspaceEvents,
} from "./workspace/workspaceStore.js";
import "./styles.css";
import "./styles/composition.css";
import "./styles/workspace.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

function outputHandlers() {
  return {
    async previewDecisionPacket(input) {
      const room = getWorkspaceStoreState();
      if (room.activeCase?.id !== input.caseId || room.activeCase.revision !== input.expectedDecisionRevision) {
        throw new Error("The requested case revision is no longer active.");
      }
      const packet = createDecisionPacket(room.activeCase, room.evaluation, {
        includeAppendix: input.includeAppendix,
      });
      return {
        ok: true,
        status: "preview",
        executable: false,
        caseId: packet.case.id,
        title: packet.case.title,
        decisionRevision: packet.case.revision,
        decisionHash: packet.case.decisionHash,
        analysisMode: packet.analysis.mode,
        ...(packet.analysis.mode === "requirement-evidence-only"
          ? { authority: packet.analysis.authority }
          : {
              recommendation: packet.analysis.recommendation,
              blockerCount: packet.analysis.blockerCount,
            }),
        unresolvedCount: packet.analysis.unresolvedCount,
        claimCount: packet.claims.length,
        sourceCount: packet.appendix?.sourceAnchors.length ?? 0,
      };
    },
    async exportCase(input) {
      const room = getWorkspaceStoreState();
      if (room.activeCase?.id !== input.caseId || room.activeCase.revision !== input.expectedDecisionRevision) {
        throw new Error("The requested case revision is no longer active.");
      }
      const prepared = await prepareCaseExport(input.format, {
        source: "agent",
        expectedCaseId: input.caseId,
        expectedDecisionRevision: input.expectedDecisionRevision,
      });
      return {
        ok: true,
        status: "prepared",
        awaitingHuman: true,
        executable: false,
        artifact: {
          id: prepared.artifact.id,
          fileName: prepared.artifact.fileName,
          format: prepared.artifact.format,
          decisionRevision: prepared.artifact.decisionRevision,
          decisionHash: prepared.artifact.decisionHash,
          byteLength: prepared.artifact.bytes.byteLength,
          printRequired: Boolean(prepared.artifact.printRequired),
        },
        receipt: prepared.receipt,
      };
    },
    async draftRequest(input) {
      return stageReviewArtifact({
        kind: "information_request",
        body: `To: ${input.recipientRole}\n\nPurpose: ${input.purpose}\n\nDraft only. This request has not been sent.`,
        entityRefs: input.entityRefs,
        source: "agent",
      });
    },
    async prepareExternalAction(input) {
      return stageReviewArtifact({
        kind: `external_action_${input.actionType}`,
        body: `${input.summary}\n\nPrepared only. No external action has been executed.`,
        entityRefs: input.entityRefs,
        source: "agent",
      });
    },
    subscribe: subscribeWorkspaceEvents,
  };
}

async function bootstrapSituationRoom() {
  await initializeWorkspace({ initialRoute: parseWorkspacePath(window.location.pathname) });
  const ports = createWebMcpPorts({
    runtime: getRuntime(),
    importCoordinator: getImportCoordinator(),
    presentation: getPresentationPort(),
    permissions: ["*"],
    resolveStagedSource,
    reserveImportCaseId: reserveAgentImportCaseId,
    outputHandlers: outputHandlers(),
    getWorkspaceContext: async () => {
      const room = getWorkspaceStoreState();
      const authority = await getWorkspaceAuthorityContext();
      const caseSurface = room.navigationSurface === "case";
      return {
        phase: room.activeImportReview
          ? "import_review"
          : room.intakeOpen
            ? "intake"
            : caseSurface ? room.capabilityPhase : "empty",
        role: "decision-owner",
        frozen: caseSurface && (authority.frozen || !authority.sharedAuthorityAvailable),
        sharedAuthorityAvailable: authority.sharedAuthorityAvailable,
        governedAgentMutationsBlocked: !authority.sharedAuthorityAvailable,
        pendingHumanCheckpoint: authority.pendingHumanCheckpoint || hasPendingHumanCheckpoint(),
        pendingHumanAuthorityCheckpoint: authority.pendingHumanAuthorityCheckpoint,
        governanceVersion: authority.governanceVersion,
        stagedSourceCount: room.stagedSourceCount,
        viewRevision: room.viewRevision,
        viewHash: room.plan?.viewHash ?? null,
      };
    },
  });
  const unsubscribeReviewArtifacts = ports.reviewArtifacts.subscribe(addExternalReviewArtifact);
  const registration = await registerSituationRoomTools({
    ports,
    modelContext: document.modelContext,
    actor: { id: "browser-agent", type: "agent", label: "Browser agent" },
    onStatus: setWebMcpStatus,
    onReceipt: addExternalReceipt,
    onActivity: recordAgentActivity,
    invocationStore: new IndexedDbInvocationStore(),
    receiptLedger: new IndexedDbReceiptLedger(),
  });
  window.__situationRoom = Object.freeze({
    getState: getWorkspaceStoreState,
    ports,
    gateway: registration.gateway,
    registration: () => ({
      available: registration.available,
      toolCount: registration.toolCount,
      activeTools: [...(registration.activeTools ?? [])],
      reason: registration.reason ?? null,
    }),
  });
  window.addEventListener("pagehide", () => {
    unsubscribeReviewArtifacts();
    ports.imports?.close?.();
    registration.gateway?.stop?.();
  }, { once: true });
  return registration;
}

bootstrapSituationRoom().catch((error) => {
  setWebMcpStatus({ available: false, toolCount: 0, activeTools: [], reason: error.message });
  console.warn("SituationRoom site tools could not be registered.", error);
});
