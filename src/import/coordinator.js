import { canonicalHash, cloneValue } from "../kernel/canonicalize.js";
import { ERROR_CODES, SituationRoomError } from "../kernel/errors.js";
import { COMMIT_STATUSES } from "../persistence/repository.js";
import { createDefaultDomainRegistry } from "../domain-packs/index.js";
import { ImportStore, InMemoryImportStore } from "./importStore.js";
import { parseImportInputs } from "./pipeline.js";

const TERMINAL_PHASES = new Set(["complete", "failed", "canceled", "quarantined"]);
const DURABLE_IDLE_PHASES = new Set([...TERMINAL_PHASES, "review_required"]);
const TABLE_SEMANTIC_TYPES = new Set([
  "identifier",
  "label",
  "number",
  "currency",
  "date",
  "boolean",
  "category",
  "text",
  "source_ref",
]);

function rawInputBlobId(jobId, index) {
  return `${jobId}:raw-input:${index + 1}`;
}

function sourceIdentity(document) {
  const archivePath = document.metadata?.archivePath;
  const archiveName = document.metadata?.archiveName;
  return archivePath
    ? `archive:${String(archiveName ?? "").toLocaleLowerCase()}:${String(archivePath).replaceAll("\\", "/").toLocaleLowerCase()}`
    : `file:${String(document.name ?? "").toLocaleLowerCase()}`;
}

function withPriorImportDiagnostic(document, priorDocuments) {
  const identity = sourceIdentity(document);
  const candidates = priorDocuments
    .filter((candidate) => candidate.importId !== document.importId && sourceIdentity(candidate) === identity)
    .sort((left, right) =>
      String(right.importedAt ?? "").localeCompare(String(left.importedAt ?? "")) || String(right.id).localeCompare(String(left.id)),
    );
  const prior = candidates.find((candidate) => candidate.byteHash === document.byteHash) ?? candidates[0];
  if (!prior) return document;
  const unchanged = prior.byteHash === document.byteHash;
  return {
    ...document,
    diagnostics: [
      ...document.diagnostics,
      {
        code: unchanged ? "CROSS_IMPORT_DUPLICATE" : "SOURCE_REVISION_CHANGED",
        severity: unchanged ? "info" : "warning",
        message: unchanged
          ? "This source is byte-identical to a prior import for the same case."
          : "This source differs from the latest prior import for the same case; dependent claims require review.",
        details: {
          priorDocumentId: prior.id,
          priorImportId: prior.importId,
          priorByteHash: prior.byteHash,
          currentByteHash: document.byteHash,
          sourceIdentity: identity,
          claimsInvalidatedAutomatically: false,
        },
      },
    ],
  };
}

function defaultId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function inputSummary(input, index) {
  if (typeof input === "string") return { name: `pasted-text-${index + 1}.txt`, size: new TextEncoder().encode(input).byteLength };
  if (input instanceof Uint8Array) return { name: `unnamed-${index + 1}.bin`, size: input.byteLength };
  return {
    name: String(input?.name ?? `unnamed-${index + 1}.bin`),
    size: Number(input?.size ?? input?.bytes?.byteLength ?? 0),
    mimeType: String(input?.mimeType ?? input?.type ?? "application/octet-stream"),
  };
}

function boundedIntakeContext(value) {
  if (!value || typeof value !== "object") return null;
  const source = value.source === "human" ? "human" : "agent";
  const title = String(value.title ?? "").trim().slice(0, 160);
  const objective = String(value.objective ?? "").trim().slice(0, 600);
  return { source, ...(title ? { title } : {}), ...(objective ? { objective } : {}) };
}

function normalizeTableMapping(mapping) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Table mapping must be an object.");
  }
  if (!mapping.columns) {
    const entries = Object.entries(mapping);
    if (!entries.length || entries.length > 100 || entries.some(([, value]) => typeof value !== "string" || value.length > 200)) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Legacy table mappings need 1 to 100 short string targets.");
    }
    return cloneValue(mapping);
  }
  const entries = Object.entries(mapping.columns);
  if (!entries.length || entries.length > 100) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Table mappings need 1 to 100 column definitions.");
  }
  const columns = {};
  for (const [sourceColumn, definition] of entries) {
    if (!sourceColumn || sourceColumn.length > 120 || !definition || typeof definition !== "object") {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Each mapped source column needs a valid definition.");
    }
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(definition.targetField ?? "")) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Mapped target fields must be safe identifiers.");
    }
    if (!TABLE_SEMANTIC_TYPES.has(definition.semanticType)) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, `Unsupported table semantic type '${String(definition.semanticType)}'.`);
    }
    columns[sourceColumn] = {
      targetField: definition.targetField,
      semanticType: definition.semanticType,
    };
  }
  const headerRow = mapping.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 1_000_000) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Table headerRow must be a positive spreadsheet row number.");
  }
  return {
    sheetName: mapping.sheetName ? String(mapping.sheetName).slice(0, 120) : null,
    headerRow,
    columns,
  };
}

export class ImportCoordinator {
  #store;
  #registry;
  #listeners = new Set();
  #controllers = new Map();
  #promises = new Map();
  #rawInputs = new Map();
  #jobOperations = new Map();
  #id;
  #now;
  #options;

  constructor(options = {}) {
    this.#store = options.store ??
      (options.repository ? new ImportStore(options.repository) : new InMemoryImportStore());
    this.#registry = options.domainRegistry ?? createDefaultDomainRegistry();
    this.#id = options.idGenerator ?? defaultId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#options = { limits: options.limits, ocr: options.ocr };
  }

  async initialize() {
    await this.#store.initialize();
    const jobs = await this.#store.listJobs();
    for (const job of jobs) {
      if (
        job.phase === "complete" &&
        (job.rawInputBlobIds?.length || job.documentIds?.length || job.rawInputCleanup?.status === "pending")
      ) {
        try {
          await this.#serializeJob(job.id, () => this.#cleanupRawInputsUnlocked(job.id));
        } catch (error) {
          this.#emit({
            type: "import.raw_cleanup_failed",
            jobId: job.id,
            caseId: job.caseId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      if (DURABLE_IDLE_PHASES.has(job.phase)) continue;
      const interruptedCommit = job.phase === "committing" && job.commitIntent;
      await this.#update(job.id, {
        phase: "failed",
        progress: 1,
        error: {
          code: ERROR_CODES.STORAGE_FAILURE,
          message: `Import was interrupted during '${job.phase}' and was moved to a recoverable state.`,
          details: {
            recoverable: true,
            previousPhase: job.phase,
            action: interruptedCommit
              ? "resume_commit"
              : job.phase === "canceling"
                ? "retry_discard"
                : job.rawInputBlobIds?.length
                  ? "retry_import"
                  : "reselect_inputs",
          },
        },
      });
    }
    return this;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    this.#listeners.forEach((listener) => listener(event));
  }

  async #serializeJob(jobId, operation) {
    const previous = this.#jobOperations.get(jobId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.#jobOperations.set(jobId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#jobOperations.get(jobId) === queued) this.#jobOperations.delete(jobId);
    }
  }

  async #update(jobId, patch) {
    const current = await this.#store.getJob(jobId);
    if (!current) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
    return this.#commitJobPatch(current, patch);
  }

  async #commitJobPatch(current, patch, options = {}) {
    const nextJob = {
      ...current,
      ...cloneValue(patch),
      version: (current.version ?? 0) + 1,
      updatedAt: this.#now(),
    };
    const result = await this.#store.commitJobMutation({
      jobId: current.id,
      expectedVersion: current.version ?? 0,
      expectedPhase: options.expectedPhase ?? current.phase,
      nextJob,
      documents: options.documents ?? [],
      blobs: options.blobs ?? [],
    });
    if (result.status === COMMIT_STATUSES.NOT_FOUND) {
      throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${current.id}' was not found.`);
    }
    if (result.status !== COMMIT_STATUSES.COMMITTED) {
      throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The import changed before the operation could commit.", {
        expectedImportVersion: current.version ?? 0,
        currentImportVersion: result.currentVersion ?? result.current?.version ?? null,
        currentPhase: result.current?.phase ?? null,
      });
    }
    const job = result.job;
    this.#emit({ type: "import.progress", jobId: job.id, caseId: job.caseId, phase: job.phase, progress: job.progress });
    this.#emit({ type: "capability-context.changed", caseId: job.caseId, importId: job.id, phase: job.phase });
    return job;
  }

  async #discardRawInputs(job) {
    return this.#cleanupRawInputsUnlocked(job.id);
  }

  async #cleanupRawInputsUnlocked(jobId) {
    this.#rawInputs.delete(jobId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await this.#store.getJob(jobId);
      if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
      if (job.phase !== "complete") {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Raw input cleanup is only available after canonical acceptance.");
      }
      const blobIds = [...new Set([
        ...(job.rawInputBlobIds ?? []),
        ...(job.rawInputCleanup?.pendingBlobIds ?? []),
      ])];
      const documentIds = [...new Set([
        ...(job.documentIds ?? []),
        ...(job.rawInputCleanup?.pendingDocumentIds ?? []),
      ])];
      const cleanupAttempts = (job.rawInputCleanup?.attempts ?? 0) + 1;
      const cleanupDiagnostics = (job.diagnostics ?? []).filter(
        (entry) => !["RAW_INPUT_CLEANUP_FAILED", "RAW_INPUT_CLEANUP_PENDING"].includes(entry.code),
      );
      const failures = [];
      for (const blobId of blobIds) {
        try {
          await this.#store.deleteRawInput(blobId);
          const retained = await this.#store.getRawInput(blobId);
          if (retained !== null && retained !== undefined) {
            failures.push({ kind: "blob", id: blobId, message: "Deletion could not be verified." });
          }
        } catch (error) {
          failures.push({ kind: "blob", id: blobId, message: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const documentId of documentIds) {
        try {
          await this.#store.deleteDocument(documentId);
          const retained = await this.#store.getDocument(documentId);
          if (retained !== null && retained !== undefined) {
            failures.push({ kind: "document", id: documentId, message: "Deletion could not be verified." });
          }
        } catch (error) {
          failures.push({ kind: "document", id: documentId, message: error instanceof Error ? error.message : String(error) });
        }
      }
      const pendingBlobIds = failures.filter((failure) => failure.kind === "blob").map((failure) => failure.id);
      const pendingDocumentIds = failures.filter((failure) => failure.kind === "document").map((failure) => failure.id);
      const completed = pendingBlobIds.length === 0 && pendingDocumentIds.length === 0;
      const patch = completed
        ? {
            rawInputBlobIds: [],
            documentIds: [],
            rawInputsPersisted: false,
            rawInputRetention: "discarded_after_acceptance",
            rawInputCleanup: {
              status: "complete",
              attempts: cleanupAttempts,
              completedAt: this.#now(),
              pendingBlobIds: [],
              pendingDocumentIds: [],
            },
            diagnostics: cleanupDiagnostics,
          }
        : {
            rawInputBlobIds: pendingBlobIds,
            documentIds: pendingDocumentIds,
            rawInputsPersisted: true,
            rawInputRetention: "cleanup_pending_after_acceptance",
            rawInputCleanup: {
              status: "pending",
              action: "retry_raw_cleanup",
              attempts: cleanupAttempts,
              attemptedAt: this.#now(),
              pendingBlobIds,
              pendingDocumentIds,
              failures: failures.slice(0, 20),
            },
            diagnostics: [
              ...cleanupDiagnostics,
              {
                code: "RAW_INPUT_CLEANUP_PENDING",
                severity: "warning",
                message: "Canonical acceptance is committed, but retained source cleanup still requires recovery.",
                details: {
                  recoverable: true,
                  action: "retry_raw_cleanup",
                  count: pendingBlobIds.length + pendingDocumentIds.length,
                },
              },
            ],
          };
      try {
        const updated = await this.#commitJobPatch(job, patch, { expectedPhase: "complete" });
        if (!completed) {
          this.#emit({
            type: "import.raw_cleanup_failed",
            jobId,
            caseId: job.caseId,
            pendingBlobIds,
            pendingDocumentIds,
          });
        }
        return updated;
      } catch (error) {
        if (error?.code !== ERROR_CODES.STALE_REVISION || attempt === 2) throw error;
        const latest = await this.#store.getJob(jobId);
        if (
          latest?.rawInputCleanup?.status === "complete" &&
          !(latest.rawInputBlobIds?.length) &&
          !(latest.documentIds?.length)
        ) return latest;
      }
    }
    throw new SituationRoomError(ERROR_CODES.STORAGE_FAILURE, "Raw input cleanup could not stabilize after concurrent recovery.");
  }

  async startImport(inputs, options = {}) {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "At least one import input is required.");
    }
    if (options.startRequest?.idempotencyKey && !String(options.startRequest.fingerprint ?? "").trim()) {
      throw new SituationRoomError(
        ERROR_CODES.VALIDATION_FAILED,
        "Durable import idempotency requires a canonical input fingerprint.",
      );
    }
    const id = `import:${this.#id()}`;
    const at = this.#now();
    const job = {
      id,
      caseId: options.caseId ?? null,
      domainHint: options.domainHint ?? "generic",
      phase: "queued",
      progress: 0,
      createdAt: at,
      updatedAt: at,
      version: 0,
      inputSummaries: inputs.map(inputSummary),
      documentIds: [],
      diagnostics: [],
      error: null,
      receipt: null,
      rawInputBlobIds: [],
      rawInputsPersisted: false,
      intakeContext: boundedIntakeContext(options.intakeContext),
      ...(options.retryParentId ? { retryParentId: String(options.retryParentId).slice(0, 200) } : {}),
      ...(options.startRequest?.idempotencyKey
        ? {
            startRequest: {
              idempotencyKey: String(options.startRequest.idempotencyKey).slice(0, 200),
              fingerprint: String(options.startRequest.fingerprint ?? "").slice(0, 200),
            },
          }
        : {}),
    };
    const creation = await this.#store.createJob(job);
    if (creation.status === COMMIT_STATUSES.REPLAYED) return cloneValue(creation.job);
    if (creation.status === COMMIT_STATUSES.CONFLICT) {
      throw new SituationRoomError(
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        "This import idempotency key was reused with different sources.",
        { existingImportId: creation.job?.id ?? null },
      );
    }
    if (creation.status !== COMMIT_STATUSES.COMMITTED) {
      throw new SituationRoomError(ERROR_CODES.STORAGE_FAILURE, "The import job ID is already in use.");
    }
    this.#rawInputs.set(id, inputs);
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    const promise = Promise.resolve().then(() => this.#run(job, inputs, controller, options));
    this.#promises.set(id, promise);
    promise.finally(() => {
      this.#controllers.delete(id);
      this.#promises.delete(id);
    });
    this.#emit({ type: "import.progress", jobId: id, caseId: job.caseId, phase: "queued", progress: 0 });
    return cloneValue(job);
  }

  async #run(job, inputs, controller, options) {
    let activeJob = job;
    try {
      activeJob = await this.#commitJobPatch(activeJob, { phase: "validating", progress: 0.03 }, { expectedPhase: "queued" });
      activeJob = await this.#commitJobPatch(activeJob, { phase: "fingerprinting", progress: 0.08 }, { expectedPhase: "validating" });
      activeJob = await this.#commitJobPatch(activeJob, { phase: "parsing", progress: 0.1 }, { expectedPhase: "fingerprinting" });
      const parsed = await parseImportInputs(inputs, {
        importId: job.id,
        caseId: job.caseId,
        signal: controller.signal,
        limits: options.limits ?? this.#options.limits,
        passwords: options.passwords,
        ocr: options.ocr ?? this.#options.ocr,
        importedAt: job.createdAt,
        onNormalizedInputs: async (normalizedInputs) => {
          if (!this.#store.supportsRawInputPersistence()) return;
          const blobs = normalizedInputs.map((normalizedInput, index) => ({
            id: rawInputBlobId(job.id, index),
            value: normalizedInput,
          }));
          activeJob = await this.#commitJobPatch(
            activeJob,
            {
              rawInputBlobIds: blobs.map((blob) => blob.id),
              rawInputsPersisted: blobs.length === normalizedInputs.length,
            },
            { expectedPhase: "parsing", blobs },
          );
          this.#rawInputs.set(job.id, normalizedInputs);
        },
        onProgress: (fraction) => {
          this.#emit({
            type: "import.progress",
            jobId: job.id,
            caseId: job.caseId,
            phase: "parsing",
            progress: 0.1 + Math.max(0, Math.min(1, fraction)) * 0.65,
          });
        },
      });
      if (controller.signal.aborted) throw new SituationRoomError(ERROR_CODES.IMPORT_CANCELED, "Import was canceled.");
      activeJob = await this.#commitJobPatch(activeJob, { phase: "normalizing", progress: 0.8 }, { expectedPhase: "parsing" });
      const priorDocuments = await this.#store.listDocuments(job.caseId);
      parsed.documents = parsed.documents.map((document) => withPriorImportDiagnostic(document, priorDocuments));
      activeJob = await this.#commitJobPatch(
        activeJob,
        {
          phase: "scanning",
          progress: 0.93,
          documentIds: parsed.documents.map((document) => document.id),
        },
        { expectedPhase: "normalizing", documents: parsed.documents },
      );
      const diagnostics = parsed.documents.flatMap((document) =>
        document.diagnostics.map((entry) => ({ ...entry, documentId: document.id })),
      );
      const quarantinedDocumentIds = parsed.documents
        .filter((document) => document.securityStatus === "quarantined")
        .map((document) => document.id);
      const phase = quarantinedDocumentIds.length ? "quarantined" : "review_required";
      if (quarantinedDocumentIds.length) {
        diagnostics.push({
          code: "IMPORT_BATCH_QUARANTINED",
          severity: "error",
          message: "The batch contains quarantined content and cannot be partially accepted.",
          details: {
            quarantinedDocumentIds,
            recoverable: true,
            action: "reselect_safe_sources",
          },
        });
      }
      const completed = await this.#commitJobPatch(activeJob, {
        phase,
        progress: 1,
        diagnostics,
        error: quarantinedDocumentIds.length
          ? {
              code: ERROR_CODES.QUARANTINED,
              message: "Import batch contains one or more quarantined documents.",
              details: { recoverable: true, action: "reselect_safe_sources", quarantinedDocumentIds },
            }
          : null,
      }, { expectedPhase: "scanning" });
      this.#emit({
        type: phase === "quarantined" ? "import.failed" : "import.review_required",
        jobId: job.id,
        caseId: job.caseId,
        phase,
      });
      return completed;
    } catch (error) {
      const latest = await this.#store.getJob(job.id);
      if (!latest) throw error;
      if (["canceling", "canceled"].includes(latest.phase)) return latest;
      if (error?.code === ERROR_CODES.STALE_REVISION) return latest;
      const canceled = controller.signal.aborted || error?.code === ERROR_CODES.IMPORT_CANCELED;
      const phase = canceled ? "canceled" : error?.code === ERROR_CODES.QUARANTINED ? "quarantined" : "failed";
      let failed;
      try {
        failed = await this.#commitJobPatch(
          latest,
          {
            phase,
            progress: 1,
            error: {
              code: error?.code ?? ERROR_CODES.VALIDATION_FAILED,
              message: error instanceof Error ? error.message : String(error),
              details: error?.details,
            },
          },
          { expectedPhase: latest.phase },
        );
      } catch (commitError) {
        if (commitError?.code === ERROR_CODES.STALE_REVISION) return this.#store.getJob(job.id);
        throw commitError;
      }
      this.#emit({ type: "import.failed", jobId: job.id, caseId: job.caseId, phase, error: failed.error });
      return failed;
    }
  }

  async waitForImport(jobId) {
    const promise = this.#promises.get(jobId);
    if (promise) return promise;
    const job = await this.#store.getJob(jobId);
    if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
    return job;
  }

  async getImport(jobId) {
    return this.#store.getJob(jobId);
  }

  async listImports(caseId = undefined) {
    return this.#store.listJobs(caseId);
  }

  async #cancelImportUnlocked(jobId, terminalPatch = {}) {
    let job = await this.#store.getJob(jobId);
    if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
    if (["resume_commit", "reconcile_committed_receipt"].includes(job.error?.details?.action) && (job.commitIntent || job.receipt)) {
      return { ok: false, phase: "commit_recovery_required" };
    }
    if (["complete", "committing", "canceling"].includes(job.phase)) return { ok: false, phase: job.phase };
    if (job.phase === "canceled") return { ok: true, job };
    job = await this.#commitJobPatch(
      job,
      { phase: "canceling", error: null },
      { expectedPhase: job.phase },
    );
    this.#controllers.get(jobId)?.abort();
    const running = this.#promises.get(jobId);
    if (running) await running;
    job = await this.#store.getJob(jobId) ?? job;
    this.#rawInputs.delete(jobId);
    const failures = [];
    for (const blobId of job.rawInputBlobIds ?? []) {
      try {
        await this.#store.deleteRawInput(blobId);
        const retained = await this.#store.getRawInput(blobId);
        if (retained !== null && retained !== undefined) throw new Error("Deletion could not be verified.");
      } catch (error) {
        failures.push(`raw input ${blobId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const documentId of job.documentIds ?? []) {
      try {
        await this.#store.deleteDocument(documentId);
        const retained = await this.#store.getDocument(documentId);
        if (retained !== null && retained !== undefined) throw new Error("Deletion could not be verified.");
      } catch (error) {
        failures.push(`document ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) {
      const cleanupError = new SituationRoomError(
        ERROR_CODES.STORAGE_FAILURE,
        "The import was canceled, but retained source data could not be completely removed.",
        { recoverable: true, action: "retry_discard", failures },
      );
      await this.#commitJobPatch(job, {
        phase: "failed",
        progress: 1,
        error: cleanupError.toJSON(),
        diagnostics: [
          ...(job.diagnostics ?? []),
          { code: "IMPORT_DISCARD_FAILED", severity: "error", message: cleanupError.message, details: cleanupError.details },
        ],
      }, { expectedPhase: "canceling" });
      throw cleanupError;
    }
    const canceled = await this.#commitJobPatch(job, {
      phase: "canceled",
      progress: 1,
      inputCount: job.inputCount ?? job.inputSummaries?.length ?? 0,
      inputSummaries: [],
      documentIds: [],
      rawInputBlobIds: [],
      rawInputsPersisted: false,
      rawInputRetention: "discarded_after_cancel",
      error: null,
      commitIntent: null,
      ...terminalPatch,
    }, { expectedPhase: "canceling" });
    this.#emit({ type: "import.canceled", jobId, caseId: canceled.caseId, phase: canceled.phase });
    return { ok: true, job: canceled };
  }

  async cancelImport(jobId) {
    return this.#serializeJob(jobId, () => this.#cancelImportUnlocked(jobId));
  }

  async inspectDocument(documentId) {
    const document = await this.#store.getDocument(documentId);
    if (!document) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Document '${documentId}' was not found.`);
    return document;
  }

  async assignImportCaseId(jobId, caseId) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(caseId ?? "")) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import case IDs must be safe identifiers.");
    }
    const job = await this.#store.getJob(jobId);
    if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
    if (job.caseId && job.caseId !== caseId) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "An import already assigned to a case cannot be reassigned.");
    }
    if (job.caseId === caseId) return job;
    if (job.phase !== "review_required") {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Only a review-required unassigned import can reserve a case ID.");
    }
    const documents = await Promise.all((job.documentIds ?? []).map((documentId) => this.#store.getDocument(documentId)));
    if (documents.some((document) => !document)) {
      throw new SituationRoomError(ERROR_CODES.STORAGE_FAILURE, "One or more imported documents are unavailable.", {
        recoverable: true,
        action: "retry_case_assignment",
      });
    }
    return this.#commitJobPatch(
      job,
      { caseId },
      {
        expectedPhase: "review_required",
        documents: documents.map((document) => ({ ...document, caseId })),
      },
    );
  }

  async searchFragments(query = {}) {
    const needle = String(query.text ?? "").trim().toLocaleLowerCase();
    if (!needle) throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Search text is required.");
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Search limit must be between 1 and 200.");
    }
    const documents = await this.#store.listDocuments(query.caseId);
    const results = [];
    for (const document of documents) {
      for (const block of document.blocks) {
        const index = block.text.toLocaleLowerCase().indexOf(needle);
        if (index < 0) continue;
        results.push({
          documentId: document.id,
          documentName: document.name,
          fragmentId: block.id,
          kind: block.kind,
          locator: block.locator,
          excerpt: block.text.slice(Math.max(0, index - 80), Math.min(block.text.length, index + needle.length + 80)),
          confidence: block.confidence,
        });
        if (results.length >= limit) return { results, truncated: true };
      }
    }
    return { results, truncated: false };
  }

  async mapTableSchema(documentId, mapping, options = {}) {
    const normalizedMapping = normalizeTableMapping(mapping);
    const initialDocument = await this.inspectDocument(documentId);
    if (options.expectedImportId && initialDocument.importId !== options.expectedImportId) {
      throw new SituationRoomError(ERROR_CODES.NOT_FOUND, "The selected document is not owned by the requested import job.");
    }
    return this.#serializeJob(initialDocument.importId, async () => {
      const job = await this.#store.getJob(initialDocument.importId);
      if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${initialDocument.importId}' was not found.`);
      if (options.expectedImportVersion !== undefined && job.version !== options.expectedImportVersion) {
        throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The import changed before the table mapping could commit.", {
          expectedImportVersion: options.expectedImportVersion,
          currentImportVersion: job.version,
        });
      }
      if (job.phase !== "review_required") {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Table mappings can only change a review-required import.");
      }
      const document = await this.inspectDocument(documentId);
      if (options.expectedImportId && document.importId !== options.expectedImportId) {
        throw new SituationRoomError(ERROR_CODES.NOT_FOUND, "The selected document is not owned by the requested import job.");
      }
      if (document.securityStatus === "quarantined") {
        throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Quarantined documents cannot be mapped.");
      }
      if (!document.blocks.some((block) => block.kind === "cell")) {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "The selected document has no tabular cells.");
      }
      const updated = {
        ...document,
        metadata: {
          ...document.metadata,
          tableMapping: normalizedMapping,
          tableMappingHash: canonicalHash(normalizedMapping),
        },
      };
      await this.#commitJobPatch(
        job,
        {
          lastMappingDocumentId: documentId,
          lastMappingHash: updated.metadata.tableMappingHash,
        },
        { expectedPhase: "review_required", documents: [updated] },
      );
      this.#emit({
        type: "import.mapping_changed",
        jobId: document.importId,
        caseId: document.caseId,
        documentId,
        mapping: normalizedMapping,
      });
      return updated.metadata.tableMapping;
    });
  }

  async stageSemanticSuggestions(jobId, suggestions, options = {}) {
    if (!Array.isArray(suggestions) || suggestions.length > 128) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Semantic intake suggestions must be a bounded array of at most 128 entries.");
    }
    let encoded;
    try {
      encoded = JSON.stringify(suggestions);
    } catch {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Semantic intake suggestions must be JSON-serializable.");
    }
    if (new TextEncoder().encode(encoded).byteLength > 64 * 1024) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Semantic intake suggestions exceed the 64 KB review limit.");
    }
    return this.#serializeJob(jobId, async () => {
      const job = await this.#store.getJob(jobId);
      if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
      if (options.expectedImportVersion !== undefined && job.version !== options.expectedImportVersion) {
        throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The import changed before semantic suggestions could be staged.", {
          expectedImportVersion: options.expectedImportVersion,
          currentImportVersion: job.version,
        });
      }
      if (job.phase !== "review_required") {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Semantic suggestions can only be staged for an import awaiting human review.");
      }
      const updated = await this.#commitJobPatch(
        job,
        {
          semanticAgentSuggestions: cloneValue(suggestions),
          semanticSuggestionHash: canonicalHash(suggestions),
        },
        { expectedPhase: "review_required" },
      );
      this.#emit({
        type: "import.semantic_suggestions_changed",
        jobId,
        caseId: job.caseId,
        importVersion: updated.version,
        suggestionCount: suggestions.length,
      });
      return updated;
    });
  }

  async acceptImportAsNewCase(jobId, options) {
    return this.#serializeJob(jobId, async () => {
    const job = await this.#store.getJob(jobId);
    if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
    if (options?.expectedImportVersion !== undefined && job.version !== options.expectedImportVersion) {
      throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The reviewed import changed before case creation could commit.", {
        expectedImportVersion: options.expectedImportVersion,
        currentImportVersion: job.version,
      });
    }
    if (job.phase !== "review_required") {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import is not ready for atomic case creation.");
    }
    const runtime = options?.runtime;
    if (!runtime?.createCase) throw new TypeError("acceptImportAsNewCase requires a DecisionRuntime instance.");
    const caseInput = cloneValue(options.caseInput);
    if (!caseInput?.id || caseInput.id !== job.caseId) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "The proposed case ID must match the import target case ID.");
    }
    if (["documents", "fragments", "claims"].some((field) => (caseInput[field]?.length ?? 0) > 0)) {
      throw new SituationRoomError(
        ERROR_CODES.VALIDATION_FAILED,
        "New-case import proposals must leave documents, fragments, and claims to the atomic import commit.",
      );
    }
    let committedReceipt = null;
    let claimedJob = null;
    try {
      const documents = await Promise.all(job.documentIds.map((documentId) => this.#store.getDocument(documentId)));
      if (documents.some((document) => !document || document.securityStatus === "quarantined")) {
        throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Quarantined documents cannot create a case.");
      }
      const pack = this.#registry.get(caseInput.domain?.packId ?? job.domainHint);
      const mapped = await pack.mapImportedDocuments(documents, options.mappingHints ?? {});
      if (mapped.diagnostics?.some((entry) => entry.severity === "error")) {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Domain mapping requires corrections.", {
          diagnostics: mapped.diagnostics,
        });
      }
      const atomicCaseInput = {
        ...caseInput,
        documents: mapped.documents,
        fragments: mapped.fragments,
        claims: [...(mapped.claims ?? []), ...(options.claims ?? [])],
      };
      const actor = options.actor ?? { type: "human", id: "local-user" };
      const commitIntent = {
        mode: "new-case",
        caseInput,
        claims: cloneValue(options.claims ?? []),
        mappingHints: cloneValue(options.mappingHints ?? {}),
        idempotencyKey: options.idempotencyKey,
        actor,
      };
      claimedJob = await this.#commitJobPatch(
        job,
        { phase: "committing", progress: 0.98, error: null, commitIntent },
        { expectedPhase: "review_required" },
      );
      const result = await runtime.createCase(atomicCaseInput, {
        idempotencyKey: options.idempotencyKey,
        actor,
      });
      committedReceipt = result.receipt;
      const pendingBlobIds = [...(claimedJob.rawInputBlobIds ?? [])];
      const pendingDocumentIds = [...(claimedJob.documentIds ?? [])];
      const cleanupPending = pendingBlobIds.length > 0 || pendingDocumentIds.length > 0;
      let completed = await this.#commitJobPatch(claimedJob, {
        phase: "complete",
        progress: 1,
        inputCount: claimedJob.inputCount ?? claimedJob.inputSummaries?.length ?? 0,
        inputSummaries: [],
        receipt: result.receipt,
        error: null,
        commitIntent: null,
        rawInputRetention: cleanupPending ? "cleanup_pending_after_acceptance" : "discarded_after_acceptance",
        rawInputCleanup: cleanupPending
          ? { status: "pending", action: "retry_raw_cleanup", attempts: 0, pendingBlobIds, pendingDocumentIds }
          : { status: "complete", attempts: 0, completedAt: this.#now(), pendingBlobIds: [], pendingDocumentIds: [] },
      }, { expectedPhase: "committing" });
      try {
        completed = await this.#discardRawInputs(completed);
      } catch (cleanupError) {
        this.#emit({
          type: "import.raw_cleanup_failed",
          jobId,
          caseId: job.caseId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      this.#emit({ type: "import.completed", jobId, caseId: job.caseId, receipt: result.receipt });
      return {
        ok: true,
        job: completed,
        receipt: result.receipt,
        diagnostics: mapped.diagnostics ?? [],
        cleanupPending: completed.rawInputCleanup?.status === "pending",
        recoveryAction: completed.rawInputCleanup?.action ?? null,
      };
    } catch (error) {
      if (!claimedJob && !committedReceipt && error?.code === ERROR_CODES.STALE_REVISION) throw error;
      if (committedReceipt) {
        const reconciliationError = new SituationRoomError(
          ERROR_CODES.STORAGE_FAILURE,
          "The new case committed, but the import job could not persist completion. Reconcile using the attached receipt before retrying.",
          { recoverable: true, action: "reconcile_committed_receipt", receipt: committedReceipt },
        );
        try {
          await this.#update(jobId, {
            phase: "failed",
            progress: 1,
            receipt: committedReceipt,
            error: reconciliationError.toJSON(),
          });
        } catch {
          // The receipt remains attached to the thrown error if durable job storage is unavailable.
        }
        throw reconciliationError;
      }
      await this.#update(jobId, {
        phase: error?.code === ERROR_CODES.QUARANTINED ? "quarantined" : "review_required",
        progress: 1,
        error: {
          code: error?.code ?? ERROR_CODES.VALIDATION_FAILED,
          message: error instanceof Error ? error.message : String(error),
          details: { ...(error?.details ?? {}), recoverable: true, action: "review_and_retry_acceptance" },
        },
        commitIntent: null,
      });
      throw error;
    }
    });
  }

  async acceptImport(jobId, options) {
    return this.#serializeJob(jobId, async () => {
    const job = await this.#store.getJob(jobId);
    if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
    if (options?.expectedImportVersion !== undefined && job.version !== options.expectedImportVersion) {
      throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The reviewed import changed before acceptance could commit.", {
        expectedImportVersion: options.expectedImportVersion,
        currentImportVersion: job.version,
      });
    }
    if (job.phase === "quarantined") {
      throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Quarantined imports cannot enter a decision case.");
    }
    if (job.phase !== "review_required") {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Import is not ready for acceptance.");
    }
    const runtime = options?.runtime;
    if (!runtime?.executeCommand) throw new TypeError("acceptImport requires a DecisionRuntime instance.");
    let committedReceipt = null;
    let claimedJob = null;
    try {
      const decisionCase = await runtime.getCase(job.caseId);
      if (!decisionCase) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Case '${job.caseId}' was not found.`);
      const documents = await Promise.all(job.documentIds.map((documentId) => this.#store.getDocument(documentId)));
      if (documents.some((document) => !document || document.securityStatus === "quarantined")) {
        throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Remove quarantined documents before accepting this import.");
      }
      const pack = this.#registry.get(decisionCase.domain.packId);
      const mapped = await pack.mapImportedDocuments(documents, options.mappingHints ?? {});
      if (mapped.diagnostics?.some((entry) => entry.severity === "error")) {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Domain mapping requires corrections.", {
          diagnostics: mapped.diagnostics,
        });
      }
      const actor = options.actor ?? { type: "human", id: "local-user" };
      const commitIntent = {
        mode: "existing-case",
        expectedRevision: options.expectedRevision,
        mappingHints: cloneValue(options.mappingHints ?? {}),
        idempotencyKey: options.idempotencyKey,
        actor,
      };
      claimedJob = await this.#commitJobPatch(
        job,
        { phase: "committing", progress: 0.98, error: null, commitIntent },
        { expectedPhase: "review_required" },
      );
      const result = await runtime.executeCommand(
        {
          type: "accept_import",
          payload: { documents: mapped.documents, fragments: mapped.fragments, claims: mapped.claims },
        },
        {
          caseId: job.caseId,
          expectedRevision: options.expectedRevision,
          idempotencyKey: options.idempotencyKey,
          actor,
        },
      );
      committedReceipt = result.receipt;
      const pendingBlobIds = [...(claimedJob.rawInputBlobIds ?? [])];
      const pendingDocumentIds = [...(claimedJob.documentIds ?? [])];
      const cleanupPending = pendingBlobIds.length > 0 || pendingDocumentIds.length > 0;
      let completed = await this.#commitJobPatch(claimedJob, {
        phase: "complete",
        progress: 1,
        inputCount: claimedJob.inputCount ?? claimedJob.inputSummaries?.length ?? 0,
        inputSummaries: [],
        receipt: result.receipt,
        error: null,
        commitIntent: null,
        rawInputRetention: cleanupPending ? "cleanup_pending_after_acceptance" : "discarded_after_acceptance",
        rawInputCleanup: cleanupPending
          ? { status: "pending", action: "retry_raw_cleanup", attempts: 0, pendingBlobIds, pendingDocumentIds }
          : { status: "complete", attempts: 0, completedAt: this.#now(), pendingBlobIds: [], pendingDocumentIds: [] },
      }, { expectedPhase: "committing" });
      try {
        completed = await this.#discardRawInputs(completed);
      } catch (cleanupError) {
        this.#emit({
          type: "import.raw_cleanup_failed",
          jobId,
          caseId: job.caseId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      this.#emit({ type: "import.completed", jobId, caseId: job.caseId, receipt: result.receipt });
      return {
        ok: true,
        job: completed,
        receipt: result.receipt,
        diagnostics: mapped.diagnostics ?? [],
        cleanupPending: completed.rawInputCleanup?.status === "pending",
        recoveryAction: completed.rawInputCleanup?.action ?? null,
      };
    } catch (error) {
      if (!claimedJob && !committedReceipt && error?.code === ERROR_CODES.STALE_REVISION) throw error;
      if (committedReceipt) {
        const reconciliationError = new SituationRoomError(
          ERROR_CODES.STORAGE_FAILURE,
          "The case revision committed, but the import job could not persist completion. Reconcile using the attached receipt before retrying.",
          { recoverable: true, action: "reconcile_committed_receipt", receipt: committedReceipt },
        );
        try {
          await this.#update(jobId, {
            phase: "failed",
            progress: 1,
            receipt: committedReceipt,
            error: reconciliationError.toJSON(),
          });
        } catch {
          // The receipt remains attached to the thrown error when durable job storage is unavailable.
        }
        throw reconciliationError;
      }
      const recoverable = await this.#update(jobId, {
        phase: "review_required",
        progress: 1,
        error: {
          code: error?.code ?? ERROR_CODES.VALIDATION_FAILED,
          message: error instanceof Error ? error.message : String(error),
          details: { ...(error?.details ?? {}), recoverable: true, action: "review_and_retry_acceptance" },
        },
        commitIntent: null,
      });
      this.#emit({ type: "import.acceptance_failed", jobId, caseId: job.caseId, phase: recoverable.phase, error: recoverable.error });
      throw error;
    }
    });
  }

  async resumeImportCommit(jobId, options = {}) {
    const runtime = options.runtime;
    if (!runtime) throw new TypeError("resumeImportCommit requires a DecisionRuntime instance.");
    const recovered = await this.#serializeJob(jobId, async () => {
      const job = await this.#store.getJob(jobId);
      if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
      if (
        job.phase === "failed" &&
        job.error?.details?.action === "reconcile_committed_receipt" &&
        job.receipt
      ) {
        const pendingBlobIds = [...(job.rawInputBlobIds ?? [])];
        const pendingDocumentIds = [...(job.documentIds ?? [])];
        const cleanupPending = pendingBlobIds.length > 0 || pendingDocumentIds.length > 0;
        let completed = await this.#commitJobPatch(job, {
          phase: "complete",
          progress: 1,
          inputCount: job.inputCount ?? job.inputSummaries?.length ?? 0,
          inputSummaries: [],
          error: null,
          commitIntent: null,
          rawInputRetention: cleanupPending ? "cleanup_pending_after_acceptance" : "discarded_after_acceptance",
          rawInputCleanup: cleanupPending
            ? { status: "pending", action: "retry_raw_cleanup", attempts: 0, pendingBlobIds, pendingDocumentIds }
            : { status: "complete", attempts: 0, completedAt: this.#now(), pendingBlobIds: [], pendingDocumentIds: [] },
        }, { expectedPhase: "failed" });
        completed = await this.#discardRawInputs(completed);
        this.#emit({ type: "import.completed", jobId, caseId: job.caseId, receipt: job.receipt, reconciled: true });
        return { reconciled: true, job: completed, receipt: job.receipt };
      }
      if (job.phase !== "failed" || job.error?.details?.action !== "resume_commit" || !job.commitIntent) {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "This import has no interrupted commit to resume.");
      }
      return this.#update(jobId, { phase: "review_required", progress: 1, error: null });
    });
    if (recovered.reconciled) {
      return {
        ok: true,
        replayed: true,
        job: recovered.job,
        receipt: recovered.receipt,
        diagnostics: [],
        cleanupPending: recovered.job.rawInputCleanup?.status === "pending",
        recoveryAction: recovered.job.rawInputCleanup?.action ?? null,
      };
    }
    const intent = recovered.commitIntent;
    if (intent.mode === "new-case") {
      return this.acceptImportAsNewCase(jobId, {
        runtime,
        caseInput: intent.caseInput,
        claims: intent.claims,
        mappingHints: intent.mappingHints,
        idempotencyKey: intent.idempotencyKey,
        actor: intent.actor,
        expectedImportVersion: recovered.version,
      });
    }
    if (intent.mode === "existing-case") {
      return this.acceptImport(jobId, {
        runtime,
        expectedRevision: intent.expectedRevision,
        mappingHints: intent.mappingHints,
        idempotencyKey: intent.idempotencyKey,
        actor: intent.actor,
        expectedImportVersion: recovered.version,
      });
    }
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "The interrupted import commit has an unknown mode.");
  }

  async retryRawInputCleanup(jobId) {
    return this.#serializeJob(jobId, async () => {
      const job = await this.#cleanupRawInputsUnlocked(jobId);
      return { ok: job.rawInputCleanup?.status === "complete", job };
    });
  }

  async retrySourceCleanup(jobId) {
    return this.retryRawInputCleanup(jobId);
  }

  async retryImport(jobId, options = {}) {
    return this.#serializeJob(jobId, async () => {
      const job = await this.#store.getJob(jobId);
      if (!job) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Import '${jobId}' was not found.`);
      if (!["review_required", "failed", "quarantined"].includes(job.phase)) {
        throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Only reviewable, failed, or quarantined imports can be retried.");
      }
      let inputs = this.#rawInputs.get(jobId);
      if (!inputs && job.rawInputBlobIds?.length) {
        const persisted = await Promise.all(job.rawInputBlobIds.map((blobId) => this.#store.getRawInput(blobId)));
        if (persisted.every(Boolean)) {
          inputs = persisted;
          this.#rawInputs.set(jobId, persisted);
        }
      }
      if (!inputs) {
        throw new SituationRoomError(
          ERROR_CODES.STORAGE_FAILURE,
          "Raw inputs are no longer available; select the files again to retry.",
          { recoverable: true, action: "reselect_inputs" },
        );
      }
      const retried = await this.startImport(inputs, {
        caseId: job.caseId,
        domainHint: job.domainHint,
        intakeContext: job.intakeContext,
        retryParentId: job.id,
        ...options,
      });
      await this.#cancelImportUnlocked(jobId, {
        retryChildId: retried.id,
        retryDisposition: "superseded_by_explicit_retry",
      });
      return retried;
    });
  }
}
