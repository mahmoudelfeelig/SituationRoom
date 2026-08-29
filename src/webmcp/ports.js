import { ToolError } from "./envelopes.js";

const REQUIRED_RUNTIME_METHODS = [
  "getWorkspaceState",
  "getActiveContract",
  "queryGraph",
  "evaluate",
  "executeCommand",
  "subscribe",
];

const OPTIONAL_PORT_REQUIREMENTS = {
  imports: [
    "startImport",
    "listImports",
    "getImport",
    "cancelImport",
    "inspectDocument",
    "searchFragments",
    "mapTableSchema",
    "retryImport",
  ],
  presentation: [
    "getPresentationSnapshot",
    "applyPresentationRecipe",
    "focusEntity",
    "saveView",
    "restoreViewRevision",
  ],
};

function missingMethods(target, names) {
  return names.filter((name) => typeof target?.[name] !== "function");
}

export function validatePorts(ports) {
  if (!ports || typeof ports !== "object") {
    return { ok: false, error: "WebMCP ports are required." };
  }
  const missingRuntime = missingMethods(ports.runtime, REQUIRED_RUNTIME_METHODS);
  if (missingRuntime.length) {
    return {
      ok: false,
      error: `Runtime port is missing: ${missingRuntime.join(", ")}.`,
      missing: missingRuntime.map((method) => `runtime.${method}`),
    };
  }
  for (const [portName, methods] of Object.entries(OPTIONAL_PORT_REQUIREMENTS)) {
    if (!ports[portName]) continue;
    const missing = missingMethods(ports[portName], methods);
    if (missing.length) {
      return {
        ok: false,
        error: `${portName} port is missing: ${missing.join(", ")}.`,
        missing: missing.map((method) => `${portName}.${method}`),
      };
    }
  }
  return { ok: true };
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string"))];
}

function getActiveCaseId(workspace) {
  return workspace?.activeCaseId ?? workspace?.activeCase?.id ?? workspace?.caseId ?? null;
}

function getImportPhase(entry) {
  return entry?.phase ?? entry?.status ?? "unknown";
}

function inferPhase({ workspace, contract, imports, frozen }) {
  if (frozen) return "frozen";
  const phases = imports.map(getImportPhase);
  if (phases.some((phase) => ["review_required", "failed", "quarantined"].includes(phase))) {
    return "import_review";
  }
  if (phases.some((phase) => ["queued", "validating", "fingerprinting", "parsing", "normalizing", "scanning", "committing"].includes(phase))) {
    return "importing";
  }
  const explicit = workspace?.capabilityPhase ?? workspace?.workspacePhase ?? workspace?.phase;
  if (explicit && explicit !== "ready") return explicit;
  if (!getActiveCaseId(workspace)) return "empty";
  if (!contract || ["draft", "proposed", "review_required"].includes(contract.status)) return "contract_draft";
  return "analysis";
}

async function settle(value) {
  return await value;
}

export async function readCapabilityContext(ports) {
  const workspace = (await settle(ports.runtime.getWorkspaceState())) ?? {};
  const activeCaseId = getActiveCaseId(workspace);
  const [contract, presentation, imports] = await Promise.all([
    activeCaseId ? settle(ports.runtime.getActiveContract(activeCaseId)) : null,
    ports.presentation ? settle(ports.presentation.getPresentationSnapshot()) : null,
    ports.imports ? settle(ports.imports.listImports(activeCaseId)) : [],
  ]);
  const importEntries = Array.isArray(imports) ? imports : imports?.entries ?? imports?.imports ?? [];
  const frozen = Boolean(workspace.frozen ?? workspace.activeCase?.frozen ?? presentation?.frozen);
  const permissions = normalizePermissions(workspace.permissions ?? workspace.security?.permissions);
  const pendingHumanCheckpoint = Boolean(
    workspace.pendingHumanCheckpoint ??
      contract?.pendingHumanCheckpoint ??
      presentation?.pendingHumanCheckpoint,
  );
  const decisionRevision =
    workspace.decisionRevision ?? workspace.activeCase?.decisionRevision ?? contract?.revision ?? 0;
  const viewRevision = presentation?.viewRevision ?? workspace.viewRevision ?? 0;

  return {
    phase: inferPhase({ workspace, contract, imports: importEntries, frozen }),
    workspace,
    activeCaseId,
    contract,
    imports: importEntries,
    importPhases: [...new Set(importEntries.map(getImportPhase))],
    presentation,
    presentationCapabilities: presentation?.capabilities ?? workspace.presentationCapabilities ?? {},
    domainId: workspace.domainId ?? contract?.domainId ?? workspace.activeCase?.domainId ?? "general",
    domainRisk: workspace.domainRisk ?? contract?.domainRisk ?? "ordinary",
    role: workspace.role ?? workspace.security?.role ?? "unassigned",
    permissions,
    frozen,
    pendingHumanCheckpoint,
    decisionRevision,
    decisionHash: workspace.decisionHash ?? contract?.decisionHash ?? null,
    viewRevision,
    viewHash: presentation?.viewHash ?? workspace.viewHash ?? null,
  };
}

export function subscribeToPorts(ports, listener) {
  const unsubscribers = [];
  for (const port of [ports.runtime, ports.imports, ports.presentation, ports.outputs]) {
    if (typeof port?.subscribe !== "function") continue;
    const unsubscribe = port.subscribe(listener);
    if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
  }
  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Teardown must continue even if one collaborator has already been disposed.
      }
    }
  };
}

export function supportsPortMethod(ports, requirement) {
  if (!requirement) return true;
  if (typeof requirement === "function") return Boolean(requirement(ports));
  const [portName, method] = requirement.split(".");
  return typeof ports?.[portName]?.[method] === "function";
}

export function requirePortMethod(ports, requirement) {
  const [portName, method] = requirement.split(".");
  const callable = ports?.[portName]?.[method];
  if (typeof callable !== "function") {
    throw new ToolError(
      "CAPABILITY_UNSUPPORTED",
      `The ${requirement} capability is not available in this workspace.`,
      { recovery: { tool: "get_available_capabilities" } },
    );
  }
  return callable.bind(ports[portName]);
}

function waitForAnimationFrame(signal) {
  if (typeof globalThis.requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolError("EXECUTION_CANCELED", "The tool execution was canceled.", { retryable: true }));
      return;
    }
    let frameId;
    const onAbort = () => {
      globalThis.cancelAnimationFrame?.(frameId);
      reject(new ToolError("EXECUTION_CANCELED", "The tool execution was canceled.", { retryable: true }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    frameId = globalThis.requestAnimationFrame(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

export async function waitForVisibleSettle(ports, signal) {
  if (signal?.aborted) {
    throw new ToolError("EXECUTION_CANCELED", "The tool execution was canceled.", { retryable: true });
  }
  if (typeof ports.presentation?.waitForSettled === "function") {
    await ports.presentation.waitForSettled({ signal });
    return;
  }
  await Promise.resolve();
  await waitForAnimationFrame(signal);
}

export function publicContext(context) {
  return {
    phase: context.phase,
    caseId: context.activeCaseId,
    domainId: context.domainId,
    domainRisk: context.domainRisk,
    role: context.role,
    frozen: context.frozen,
    pendingHumanCheckpoint: context.pendingHumanCheckpoint,
    decisionRevision: context.decisionRevision,
    decisionHash: context.decisionHash,
    viewRevision: context.viewRevision,
    viewHash: context.viewHash,
    importPhases: context.importPhases,
  };
}
