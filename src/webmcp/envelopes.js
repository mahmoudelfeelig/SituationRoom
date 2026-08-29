export const DEFAULT_OUTPUT_LIMIT = 1_400;

const KNOWN_ERROR_CODES = new Set([
  "VALIDATION_FAILED",
  "STALE_REVISION",
  "STALE_VIEW_REVISION",
  "POLICY_DENIED",
  "CAPABILITY_NOT_ACTIVE",
  "CAPABILITY_UNSUPPORTED",
  "ROOM_FROZEN",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_PENDING",
  "IDEMPOTENCY_OUTCOME_UNCERTAIN",
  "JOURNAL_UNAVAILABLE",
  "IMPORT_QUARANTINED",
  "IMPORT_NOT_CANCELABLE",
  "EXECUTION_CANCELED",
  "NOT_FOUND",
  "OUTPUT_TRUNCATED",
  "INTERNAL_ERROR",
]);

export class ToolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ToolError";
    this.code = KNOWN_ERROR_CODES.has(code) ? code : "INTERNAL_ERROR";
    this.retryable = Boolean(options.retryable);
    this.recovery = options.recovery ?? null;
    this.safeDetails = options.safeDetails ?? null;
  }
}

function jsonLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateText(value, maxLength) {
  if (typeof value !== "string" || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeData(data) {
  if (Array.isArray(data)) {
    return {
      truncated: true,
      kind: "array",
      total: data.length,
      sampleIds: data
        .slice(0, 5)
        .map((entry) => entry?.id ?? entry?.jobId ?? entry?.operationId)
        .filter(Boolean),
    };
  }
  if (data && typeof data === "object") {
    const summary = { truncated: true, availableFields: Object.keys(data).slice(0, 20) };
    for (const key of [
      "caseId",
      "jobId",
      "phase",
      "status",
      "decisionRevision",
      "viewRevision",
      "frozen",
      "pendingHumanCheckpoint",
      "governanceVersion",
      "sharedAuthorityAvailable",
      "governedAgentMutationsBlocked",
      "caseCount",
      "stagedSourceCount",
      "nextCursor",
      "total",
    ]) {
      if (data[key] !== undefined && ["string", "number", "boolean"].includes(typeof data[key])) {
        summary[key] = data[key];
      }
    }
    return summary;
  }
  return { truncated: true, valueType: typeof data };
}

function summarizeErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const summary = {};
  for (const key of [
    "stage",
    "currentDecisionRevision",
    "currentViewRevision",
    "currentImportVersion",
    "journalStatus",
    "outcomeUncertain",
  ]) {
    if (["string", "number", "boolean"].includes(typeof details[key])) summary[key] = details[key];
  }
  if (Array.isArray(details.issues)) {
    summary.issues = details.issues.slice(0, 2).map((issue) => ({
      ...(issue?.path ? { path: truncateText(String(issue.path), 80) } : {}),
      ...(issue?.code ? { code: truncateText(String(issue.code), 60) } : {}),
      ...(issue?.message ? { message: truncateText(String(issue.message), 140) } : {}),
    }));
  }
  return Object.keys(summary).length ? summary : undefined;
}

function fitEnvelope(envelope, limit) {
  if (jsonLength(envelope) <= limit) return envelope;
  if (envelope.ok === false) {
    const compactError = {
      ok: false,
      error: {
        code: envelope.error?.code ?? "INTERNAL_ERROR",
        message: truncateText(envelope.error?.message ?? "The operation failed.", 240),
        retryable: Boolean(envelope.error?.retryable),
        ...(envelope.error?.recovery ? { recovery: envelope.error.recovery } : {}),
        ...(summarizeErrorDetails(envelope.error?.details)
          ? { details: summarizeErrorDetails(envelope.error.details) }
          : {}),
      },
      ...(envelope.receipt
        ? {
            receipt: {
              operationId: envelope.receipt.operationId,
              tool: envelope.receipt.tool,
              status: envelope.receipt.status,
              errorCode: envelope.receipt.errorCode,
              caseId: envelope.receipt.caseId,
            },
          }
        : {}),
      ...(envelope.state
        ? {
            state: {
              phase: envelope.state.phase,
              decisionRevision: envelope.state.decisionRevision,
              viewRevision: envelope.state.viewRevision,
            },
          }
        : {}),
      meta: { ...(envelope.meta?.journal ? { journal: envelope.meta.journal } : {}), outputTruncated: true },
    };
    if (jsonLength(compactError) <= limit) return compactError;
    return {
      ok: false,
      error: {
        code: compactError.error.code,
        message: truncateText(compactError.error.message, 140),
        retryable: compactError.error.retryable,
        ...(compactError.error.details ? { details: compactError.error.details } : {}),
      },
      ...(compactError.receipt ? { receipt: compactError.receipt } : {}),
      meta: { ...(envelope.meta?.journal ? { journal: envelope.meta.journal } : {}), outputTruncated: true },
    };
  }
  const compact = {
    ...envelope,
    data: summarizeData(envelope.data),
    meta: { ...(envelope.meta ?? {}), outputTruncated: true },
  };
  if (compact.ui?.announcement) {
    compact.ui = { ...compact.ui, announcement: truncateText(compact.ui.announcement, 180) };
  }
  if (compact.receipt?.changedEntityIds?.length > 8) {
    compact.receipt = { ...compact.receipt, changedEntityIds: compact.receipt.changedEntityIds.slice(0, 8) };
  }
  if (jsonLength(compact) <= limit) return compact;

  const minimal = {
    ok: envelope.ok,
    data: summarizeData(envelope.data),
    receipt: envelope.receipt
      ? {
          operationId: envelope.receipt.operationId,
          tool: envelope.receipt.tool,
          status: envelope.receipt.status,
          caseId: envelope.receipt.caseId,
          revisionBefore: envelope.receipt.revisionBefore,
          revisionAfter: envelope.receipt.revisionAfter,
          viewRevisionBefore: envelope.receipt.viewRevisionBefore,
          viewRevisionAfter: envelope.receipt.viewRevisionAfter,
          replayed: envelope.receipt.replayed,
        }
      : undefined,
    ui: envelope.ui ? { settled: Boolean(envelope.ui.settled) } : undefined,
    state: envelope.state
      ? {
          phase: envelope.state.phase,
          decisionRevision: envelope.state.decisionRevision,
          viewRevision: envelope.state.viewRevision,
        }
      : undefined,
    meta: { ...(envelope.meta?.journal ? { journal: envelope.meta.journal } : {}), outputTruncated: true },
  };
  return minimal;
}

export function successEnvelope({ data = null, receipt, ui, state, meta, outputLimit } = {}) {
  return fitEnvelope(
    {
      ok: true,
      data,
      ...(receipt ? { receipt } : {}),
      ...(ui ? { ui } : {}),
      ...(state ? { state } : {}),
      ...(meta ? { meta } : {}),
    },
    outputLimit ?? DEFAULT_OUTPUT_LIMIT,
  );
}

function mapExternalCode(code) {
  const aliases = {
    VALIDATION_ERROR: "VALIDATION_FAILED",
    STALE_DECISION_REVISION: "STALE_REVISION",
    FROZEN: "ROOM_FROZEN",
    PERMISSION_DENIED: "POLICY_DENIED",
    ABORT_ERR: "EXECUTION_CANCELED",
  };
  const candidate = aliases[code] ?? code;
  return KNOWN_ERROR_CODES.has(candidate) ? candidate : "INTERNAL_ERROR";
}

export function normalizeToolError(error) {
  if (error instanceof ToolError) return error;
  if (error?.name === "AbortError") {
    return new ToolError("EXECUTION_CANCELED", "The tool execution was canceled.", { retryable: true });
  }
  const code = mapExternalCode(error?.code);
  if (code !== "INTERNAL_ERROR") {
    return new ToolError(code, truncateText(String(error?.message ?? "The operation failed."), 300), {
      retryable: Boolean(error?.retryable),
      recovery: error?.recovery,
      safeDetails: error?.safeDetails,
    });
  }
  return new ToolError("INTERNAL_ERROR", "The operation could not be completed safely.", {
    retryable: false,
  });
}

export function errorEnvelope(error, { state, receipt, meta, outputLimit } = {}) {
  const normalized = normalizeToolError(error);
  return fitEnvelope(
    {
      ok: false,
      error: {
        code: normalized.code,
        message: truncateText(normalized.message, 300),
        retryable: normalized.retryable,
        ...(normalized.recovery ? { recovery: normalized.recovery } : {}),
        ...(normalized.safeDetails ? { details: normalized.safeDetails } : {}),
      },
      ...(receipt ? { receipt } : {}),
      ...(state ? { state } : {}),
      ...(meta ? { meta } : {}),
    },
    outputLimit ?? DEFAULT_OUTPUT_LIMIT,
  );
}

export function isEnvelopeWithinBudget(envelope, outputLimit = DEFAULT_OUTPUT_LIMIT) {
  return jsonLength(envelope) <= outputLimit;
}
