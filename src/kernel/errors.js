export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  STALE_REVISION: "STALE_REVISION",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  POLICY_DENIED: "POLICY_DENIED",
  CASE_FROZEN: "CASE_FROZEN",
  QUARANTINED: "QUARANTINED",
  STORAGE_FAILURE: "STORAGE_FAILURE",
  UNSUPPORTED_FORMAT: "UNSUPPORTED_FORMAT",
  IMPORT_CANCELED: "IMPORT_CANCELED",
});

export class SituationRoomError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SituationRoomError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function asErrorResult(error) {
  if (error instanceof SituationRoomError) {
    return { ok: false, error: error.toJSON() };
  }
  return {
    ok: false,
    error: {
      code: ERROR_CODES.STORAGE_FAILURE,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
