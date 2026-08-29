export const ANALYSIS_LENSES = Object.freeze([
  "investigate",
  "compare",
  "simulate",
  "brief",
]);

const ANALYSIS_LENS_SET = new Set(ANALYSIS_LENSES);
const CASE_WORKSPACES = new Set(["model", "analyze", "review", "outputs"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function notFoundRoute() {
  return { kind: "not-found" };
}

function normalizeTrailingSlashes(pathname) {
  const normalized = pathname.replace(/\/+$/u, "");
  return normalized || "/";
}

function isValidCaseId(caseId) {
  if (typeof caseId !== "string" || !caseId.length || caseId.trim() !== caseId) return false;
  if (caseId === "." || caseId === "..") return false;
  if (caseId.includes("/") || caseId.includes("\\") || CONTROL_CHARACTERS.test(caseId)) return false;
  try {
    encodeURIComponent(caseId);
    return true;
  } catch {
    return false;
  }
}

function decodeCaseId(segment) {
  try {
    const caseId = decodeURIComponent(segment);
    return isValidCaseId(caseId) ? caseId : null;
  } catch {
    return null;
  }
}

export function parseWorkspacePath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return notFoundRoute();
  const normalized = normalizeTrailingSlashes(pathname);
  if (normalized === "/") return { kind: "root" };
  if (normalized === "/new") return { kind: "new" };
  if (normalized === "/cases") return { kind: "archive" };

  const segments = normalized.slice(1).split("/");
  if (segments[0] !== "cases" || ![3, 4].includes(segments.length)) return notFoundRoute();
  const caseId = decodeCaseId(segments[1]);
  if (!caseId) return notFoundRoute();

  const workspace = segments[2];
  if (!CASE_WORKSPACES.has(workspace)) return notFoundRoute();
  if (workspace === "analyze") {
    if (segments.length !== 4 || !ANALYSIS_LENS_SET.has(segments[3])) return notFoundRoute();
    return { kind: "case", caseId, workspace, lens: segments[3] };
  }
  if (segments.length !== 3) return notFoundRoute();
  return { kind: "case", caseId, workspace };
}

export function workspacePathFor(routeLike) {
  if (!routeLike || typeof routeLike !== "object" || Array.isArray(routeLike)) return null;
  if (routeLike.kind === "root") return "/";
  if (routeLike.kind === "new") return "/new";
  if (routeLike.kind === "archive") return "/cases";
  if (routeLike.kind !== "case" || !isValidCaseId(routeLike.caseId)) return null;
  if (!CASE_WORKSPACES.has(routeLike.workspace)) return null;

  let encodedCaseId;
  try {
    encodedCaseId = encodeURIComponent(routeLike.caseId);
  } catch {
    return null;
  }
  const base = `/cases/${encodedCaseId}`;
  if (routeLike.workspace === "analyze") {
    return ANALYSIS_LENS_SET.has(routeLike.lens) ? `${base}/analyze/${routeLike.lens}` : null;
  }
  if (routeLike.lens !== undefined) return null;
  return `${base}/${routeLike.workspace}`;
}

export function phaseForWorkspaceRoute(route) {
  if (workspacePathFor(route) === null) return null;
  if (route.kind === "new") return "intake";
  if (route.kind !== "case") return null;
  if (route.workspace === "model") return "contract_draft";
  if (route.workspace === "analyze") return "analysis";
  if (route.workspace === "review") return "collaboration";
  if (route.workspace === "outputs") return "output";
  return null;
}

export function routeFromWorkspaceState(room) {
  if (!room || typeof room !== "object" || Array.isArray(room)) return { kind: "root" };
  if (room.intakeOpen === true) return { kind: "new" };

  const caseId = room.activeCase?.id;
  if (!isValidCaseId(caseId)) return { kind: "root" };
  if (room.capabilityPhase === "contract_draft") return { kind: "case", caseId, workspace: "model" };
  if (room.capabilityPhase === "collaboration") return { kind: "case", caseId, workspace: "review" };
  if (room.capabilityPhase === "output") return { kind: "case", caseId, workspace: "outputs" };

  return {
    kind: "case",
    caseId,
    workspace: "analyze",
    lens: ANALYSIS_LENS_SET.has(room.lens) ? room.lens : "investigate",
  };
}
