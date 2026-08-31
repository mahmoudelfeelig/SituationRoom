const MAX_STEPS = 24;
const SESSION_GAP_MS = 12_000;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

function safeText(value, limit = 160) {
  return String(value ?? "").trim().replaceAll(/\s+/g, " ").slice(0, limit);
}

function safeIdentifier(value, fallback) {
  const normalized = safeText(value, 160);
  return SAFE_ID.test(normalized) ? normalized : fallback;
}

function eventTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function uniqueIdentifiers(values, limit = 20) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = safeIdentifier(value, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function safeArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const projected = {};
  for (const [key, entry] of Object.entries(value).slice(0, 12)) {
    const safeKey = safeIdentifier(key, "");
    if (!safeKey) continue;
    if (typeof entry === "string") projected[safeKey] = safeText(entry, 120);
    else if (Number.isInteger(entry) && entry >= 0) projected[safeKey] = entry;
  }
  return Object.freeze(projected);
}

function receiptDiff(receipt = {}) {
  const revisionBefore = Number.isInteger(receipt.revisionBefore) ? receipt.revisionBefore : null;
  const revisionAfter = Number.isInteger(receipt.revisionAfter) ? receipt.revisionAfter : null;
  const viewRevisionBefore = Number.isInteger(receipt.viewRevisionBefore) ? receipt.viewRevisionBefore : null;
  const viewRevisionAfter = Number.isInteger(receipt.viewRevisionAfter) ? receipt.viewRevisionAfter : null;
  const decisionHashBefore = safeText(receipt.decisionHashBefore, 128) || null;
  const decisionHashAfter = safeText(receipt.decisionHashAfter, 128) || null;
  const decisionChanged = (
    revisionBefore !== null && revisionAfter !== null && revisionBefore !== revisionAfter
  ) || Boolean(decisionHashBefore && decisionHashAfter && decisionHashBefore !== decisionHashAfter);
  const viewChanged = viewRevisionBefore !== null && viewRevisionAfter !== null && viewRevisionBefore !== viewRevisionAfter;
  return Object.freeze({
    decisionChanged,
    viewChanged,
    revisionBefore,
    revisionAfter,
    viewRevisionBefore,
    viewRevisionAfter,
    decisionHashBefore,
    decisionHashAfter,
    changedEntityIds: Object.freeze(uniqueIdentifiers(receipt.changedEntityIds)),
  });
}

export function createAgentActivityState() {
  return {
    status: "idle",
    sessionId: null,
    startedAt: null,
    updatedAt: null,
    currentTool: null,
    steps: [],
    lastDiff: receiptDiff(),
  };
}

function latestByTimestamp(items, field) {
  return items.reduce((latest, item) => {
    const itemTime = Date.parse(item?.[field]);
    const latestTime = Date.parse(latest?.[field]);
    if (!latest || (Number.isFinite(itemTime) && (!Number.isFinite(latestTime) || itemTime > latestTime))) return item;
    return latest;
  }, null);
}

export function selectAgentActivityForCase(current, caseId) {
  const state = current && typeof current === "object" ? current : createAgentActivityState();
  const normalizedCaseId = safeIdentifier(caseId, "");
  const steps = normalizedCaseId
    ? (state.steps ?? []).filter((step) => step.caseId === normalizedCaseId)
    : [];
  const runningSteps = steps.filter((step) => step.status === "started");
  const latestRunning = latestByTimestamp(runningSteps, "startedAt");
  const latestTerminal = latestByTimestamp(steps.filter((step) => step.status !== "started"), "completedAt");
  return {
    status: runningSteps.length
      ? "running"
      : latestTerminal?.status === "rejected"
        ? "rejected"
        : latestTerminal ? "settled" : "idle",
    sessionId: state.sessionId,
    startedAt: steps.reduce((earliest, step) => !earliest || Date.parse(step.startedAt) < Date.parse(earliest) ? step.startedAt : earliest, null),
    updatedAt: latestTerminal?.completedAt ?? latestRunning?.startedAt ?? null,
    currentTool: latestRunning?.tool ?? null,
    steps,
    lastDiff: latestTerminal?.diff ?? receiptDiff(),
  };
}

function createSessionId(event, timestamp) {
  const caseId = safeIdentifier(event.caseId, "workspace");
  return `agent-session:${caseId}:${timestamp}`;
}

function projectStep(event, prior = null) {
  const timestamp = eventTimestamp(event.at);
  const status = ["started", "settled", "rejected", "replayed"].includes(event.phase)
    ? event.phase
    : "settled";
  return Object.freeze({
    id: safeIdentifier(event.id, `agent-call:${timestamp}`),
    tool: safeIdentifier(event.tool, "unknown_tool"),
    family: safeIdentifier(event.family, "workspace"),
    caseId: safeIdentifier(event.caseId, prior?.caseId ?? "workspace"),
    mutating: Boolean(event.mutating ?? prior?.mutating),
    status,
    startedAt: prior?.startedAt ?? (safeText(event.at, 40) || new Date(timestamp).toISOString()),
    completedAt: status === "started" ? null : (safeText(event.at, 40) || new Date(timestamp).toISOString()),
    receiptId: safeIdentifier(event.receipt?.id ?? event.receipt?.operationId, prior?.receiptId ?? "") || null,
    errorCode: safeIdentifier(event.errorCode ?? event.receipt?.errorCode, prior?.errorCode ?? "") || null,
    argumentKeys: Object.freeze(uniqueIdentifiers(event.argumentKeys ?? prior?.argumentKeys, 40)),
    safeArguments: Object.keys(event.safeArguments ?? {}).length ? safeArguments(event.safeArguments) : prior?.safeArguments ?? Object.freeze({}),
    diff: status === "started" ? prior?.diff ?? receiptDiff() : receiptDiff(event.receipt),
  });
}

export function reduceAgentActivity(current, event) {
  const state = current && typeof current === "object" ? current : createAgentActivityState();
  if (!event || typeof event !== "object" || !event.tool) return state;
  const timestamp = eventTimestamp(event.at);
  const lastTimestamp = eventTimestamp(state.updatedAt);
  const startNewSession = !state.sessionId || (
    event.phase === "started" &&
    state.status !== "running" &&
    timestamp - lastTimestamp > SESSION_GAP_MS
  );
  const sessionId = startNewSession ? createSessionId(event, timestamp) : state.sessionId;
  const existingIndex = state.steps.findIndex((step) => step.id === safeText(event.id, 160));
  const existing = existingIndex >= 0 ? state.steps[existingIndex] : null;
  const step = projectStep(event, existing);
  const steps = [...state.steps];
  if (existingIndex >= 0) steps[existingIndex] = step;
  else steps.push(step);
  const bounded = steps.slice(-MAX_STEPS);
  const runningSteps = bounded.filter((candidate) => candidate.status === "started");
  const status = runningSteps.length
    ? "running"
    : event.phase === "rejected"
      ? "rejected"
      : "settled";
  return {
    status,
    sessionId,
    startedAt: startNewSession ? step.startedAt : state.startedAt ?? step.startedAt,
    updatedAt: safeText(event.at, 40) || new Date(timestamp).toISOString(),
    currentTool: runningSteps.at(-1)?.tool ?? null,
    steps: bounded,
    lastDiff: event.phase === "started" ? state.lastDiff ?? receiptDiff() : step.diff,
  };
}

function instrumentMap(plan) {
  return new Map(
    (Array.isArray(plan?.instruments) ? plan.instruments : [])
      .filter((instrument) => instrument && typeof instrument.type === "string")
      .map((instrument) => [instrument.type, safeText(instrument.region, 32) || "secondary"]),
  );
}

export function diffPresentationPlans(previousPlan, nextPlan) {
  const previous = instrumentMap(previousPlan);
  const next = instrumentMap(nextPlan);
  const added = [...next.keys()].filter((type) => !previous.has(type));
  const removed = [...previous.keys()].filter((type) => !next.has(type));
  const retained = [...next.keys()].filter((type) => previous.has(type));
  const moved = retained.filter((type) => previous.get(type) !== next.get(type));
  return Object.freeze({
    lensBefore: safeText(previousPlan?.lens, 32) || null,
    lensAfter: safeText(nextPlan?.lens, 32) || null,
    lensChanged: Boolean(previousPlan?.lens && nextPlan?.lens && previousPlan.lens !== nextPlan.lens),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    retained: Object.freeze(retained),
    moved: Object.freeze(moved),
  });
}
