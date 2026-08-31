const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_CHANGED_ENTITIES = 40;

function boundedText(value, fallback = "") {
  return String(value ?? fallback).trim().slice(0, 240);
}

function humanize(value) {
  return boundedText(value, "workspace event")
    .replaceAll(/[._-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function finiteRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function timestampValue(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function uniqueStrings(values, limit = MAX_CHANGED_ENTITIES) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = boundedText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function receiptIdentity(receipt, index) {
  const supplied = boundedText(receipt?.id);
  if (supplied) return supplied;
  const type = boundedText(receipt?.tool ?? receipt?.type ?? receipt?.commandType, "event");
  const at = boundedText(receipt?.at ?? receipt?.createdAt ?? receipt?.timestamp, "undated");
  return `derived:${type}:${at}:${index}`;
}

function classifyScope(receipt, decisionChanged, viewChanged) {
  const type = String(receipt?.type ?? receipt?.commandType ?? "").toLowerCase();
  if (decisionChanged) return "canonical";
  if (viewChanged || type.startsWith("presentation.") || /(^|[._-])view([._-]|$)/.test(type)) return "presentation";
  if (type.startsWith("import.") || type.includes("import")) return "import";
  if (type.includes("approval") || type.includes("freeze") || type.includes("governance") || type.includes("resolution")) {
    return "governance";
  }
  if (receipt?.tool || String(receipt?.source ?? receipt?.actor ?? "").toLowerCase().includes("agent")) return "agent";
  return "workspace";
}

function eventSummary(receipt, scope, status, decisionChanged, viewChanged, changedEntityIds) {
  if (status === "rejected") {
    const code = humanize(receipt?.errorCode ?? receipt?.code ?? "operation rejected").toUpperCase();
    return `${code}. No authoritative state change was recorded.`;
  }
  if (decisionChanged) {
    return `Canonical decision changed${changedEntityIds.length ? ` across ${changedEntityIds.length} cited entit${changedEntityIds.length === 1 ? "y" : "ies"}` : ""}.`;
  }
  if (viewChanged || scope === "presentation") return "Presentation changed while the canonical decision remained unchanged.";
  if (scope === "import") return "Import evidence or its human-review state changed.";
  if (scope === "governance") return "Human authority or a governed checkpoint changed.";
  if (scope === "agent") return "The browser agent completed a workspace operation without changing the canonical decision.";
  return "Workspace state was recorded without a canonical decision change.";
}

function projectReceipt(receipt, index) {
  const boundDecisionRevision = finiteRevision(receipt.decisionRevision);
  const boundViewRevision = finiteRevision(receipt.viewRevision);
  const revisionBefore = finiteRevision(receipt.revisionBefore) ?? boundDecisionRevision;
  const revisionAfter = finiteRevision(receipt.revisionAfter) ?? boundDecisionRevision;
  const viewRevisionBefore = finiteRevision(receipt.viewRevisionBefore) ?? boundViewRevision;
  const viewRevisionAfter = finiteRevision(receipt.viewRevisionAfter) ?? boundViewRevision;
  const boundDecisionHash = boundedText(receipt.decisionHash);
  const hashBefore = boundedText(receipt.decisionHashBefore) || boundDecisionHash;
  const hashAfter = boundedText(receipt.decisionHashAfter) || boundDecisionHash;
  const decisionChanged = (
    revisionBefore !== null && revisionAfter !== null && revisionBefore !== revisionAfter
  ) || Boolean(hashBefore && hashAfter && hashBefore !== hashAfter);
  const viewChanged = viewRevisionBefore !== null && viewRevisionAfter !== null && viewRevisionBefore !== viewRevisionAfter;
  const changedEntityIds = uniqueStrings(receipt.changedEntityIds);
  const status = boundedText(receipt.status, "committed").toLowerCase();
  const scope = classifyScope(receipt, decisionChanged, viewChanged);
  const tool = boundedText(receipt.tool);
  const type = boundedText(receipt.type ?? receipt.commandType ?? tool, "workspace.event");
  const id = receiptIdentity(receipt, index);
  const at = boundedText(receipt.at ?? receipt.createdAt ?? receipt.timestamp);

  return Object.freeze({
    id,
    caseId: boundedText(receipt.caseId),
    at: at || null,
    timestamp: timestampValue(at),
    type,
    tool: tool || null,
    label: humanize(tool || type),
    source: boundedText(receipt.source ?? receipt.actor, "workspace"),
    status,
    scope,
    errorCode: boundedText(receipt.errorCode ?? receipt.code) || null,
    decision: Object.freeze({
      before: revisionBefore,
      after: revisionAfter,
      hashBefore: hashBefore || null,
      hashAfter: hashAfter || null,
      changed: decisionChanged,
    }),
    view: Object.freeze({ before: viewRevisionBefore, after: viewRevisionAfter, changed: viewChanged }),
    changedEntityIds: Object.freeze(changedEntityIds),
    causalPath: Object.freeze(changedEntityIds.map((entityId, pathIndex) => Object.freeze({
      entityId,
      order: pathIndex + 1,
    }))),
    summary: eventSummary(receipt, scope, status, decisionChanged, viewChanged, changedEntityIds),
  });
}

export function buildDecisionPlayback(receipts, options = {}) {
  const activeCaseId = boundedText(options.activeCaseId);
  const requestedLimit = Number.isInteger(options.limit) ? options.limit : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, requestedLimit));
  const seen = new Set();
  const projected = [];

  (Array.isArray(receipts) ? receipts : []).forEach((receipt, index) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return;
    if (activeCaseId && receipt.caseId && receipt.caseId !== activeCaseId) return;
    const id = receiptIdentity(receipt, index);
    if (seen.has(id)) return;
    seen.add(id);
    projected.push(projectReceipt({ ...receipt, id }, index));
  });

  projected.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  const events = Object.freeze(projected.slice(-limit));
  const scopes = Object.fromEntries(
    ["canonical", "presentation", "import", "governance", "agent", "workspace"]
      .map((scope) => [scope, events.filter((event) => event.scope === scope).length]),
  );

  return Object.freeze({
    events,
    summary: Object.freeze({
      total: events.length,
      canonicalChanges: scopes.canonical,
      presentationChanges: scopes.presentation,
      rejected: events.filter((event) => event.status === "rejected").length,
      scopes: Object.freeze(scopes),
      firstAt: events[0]?.at ?? null,
      lastAt: events.at(-1)?.at ?? null,
    }),
  });
}

function postRevision(event, axis) {
  return event?.[axis]?.after ?? event?.[axis]?.before ?? null;
}

function laterEvent(left, right) {
  return left.timestamp <= right.timestamp ? right : left;
}

function changedEntitiesBetween(left, right, events) {
  if (!Array.isArray(events) || !events.length) return laterEvent(left, right).changedEntityIds ?? [];
  const leftIndex = events.findIndex((event) => event.id === left.id);
  const rightIndex = events.findIndex((event) => event.id === right.id);
  if (leftIndex < 0 || rightIndex < 0) return laterEvent(left, right).changedEntityIds ?? [];
  const start = Math.min(leftIndex, rightIndex);
  const end = Math.max(leftIndex, rightIndex);
  return events
    .slice(start + 1, end + 1)
    .filter((event) => event.decision?.changed)
    .flatMap((event) => event.changedEntityIds ?? []);
}

export function comparePlaybackEvents(left, right, events = []) {
  if (!left || !right) return null;
  const leftDecisionRevision = postRevision(left, "decision");
  const rightDecisionRevision = postRevision(right, "decision");
  const leftDecisionHash = left.decision?.hashAfter ?? left.decision?.hashBefore ?? null;
  const rightDecisionHash = right.decision?.hashAfter ?? right.decision?.hashBefore ?? null;
  const decisionChanged = Boolean(
    (
      leftDecisionRevision !== null &&
      rightDecisionRevision !== null &&
      leftDecisionRevision !== rightDecisionRevision
    ) ||
    (
      leftDecisionHash &&
      rightDecisionHash &&
      leftDecisionHash !== rightDecisionHash
    )
  );
  const leftViewRevision = postRevision(left, "view");
  const rightViewRevision = postRevision(right, "view");
  const viewChanged = Boolean(
    leftViewRevision !== null &&
    rightViewRevision !== null &&
    leftViewRevision !== rightViewRevision
  );
  const changedEntityIds = decisionChanged
    ? uniqueStrings(changedEntitiesBetween(left, right, events))
    : [];
  const summary = decisionChanged
    ? `The canonical decision changed between ${left.label} and ${right.label}.`
    : viewChanged
      ? "Only presentation state changed; the canonical decision remained stable."
      : "These receipts record no authoritative state difference.";

  return Object.freeze({
    leftId: left.id,
    rightId: right.id,
    decisionChanged,
    viewChanged,
    changedEntityIds: Object.freeze(changedEntityIds),
    summary,
  });
}
