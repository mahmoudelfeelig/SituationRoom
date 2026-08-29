import { cloneValue } from "../kernel/canonicalize.js";
import { COMMIT_STATUSES, eventKey, receiptKey } from "./repository.js";

function clone(value) {
  return value === undefined ? undefined : cloneValue(value);
}

export class MemoryRepository {
  #cases = new Map();
  #receipts = new Map();
  #events = new Map();
  #governance = new Map();
  #imports = new Map();
  #documents = new Map();
  #blobs = new Map();
  #locks = new Map();

  async initialize() {
    return this;
  }

  async #locked(key, operation) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this.#locks.set(key, gate);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === gate) this.#locks.delete(key);
    }
  }

  async listCases() {
    return [...this.#cases.values()]
      .map(clone)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async getCase(caseId) {
    return clone(this.#cases.get(caseId) ?? null);
  }

  async putCase(decisionCase, options = {}) {
    return this.#locked(decisionCase.id, async () => {
      const current = this.#cases.get(decisionCase.id);
      if (options.createOnly && current) {
        return { status: COMMIT_STATUSES.ALREADY_EXISTS, current: clone(current) };
      }
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== null &&
        current?.revision !== options.expectedRevision
      ) {
        return {
          status: COMMIT_STATUSES.STALE,
          currentRevision: current?.revision ?? null,
          current: clone(current ?? null),
        };
      }
      this.#cases.set(decisionCase.id, clone(decisionCase));
      return { status: COMMIT_STATUSES.COMMITTED, case: clone(decisionCase) };
    });
  }

  async commitCreateCase({ decisionCase, idempotencyKey, commandFingerprint, receipt, event }) {
    return this.#locked(decisionCase.id, async () => {
      const key = receiptKey(decisionCase.id, idempotencyKey);
      const existingReceipt = this.#receipts.get(key);
      if (existingReceipt) {
        return existingReceipt.commandFingerprint === commandFingerprint
          ? { status: COMMIT_STATUSES.REPLAYED, receipt: clone(existingReceipt) }
          : { status: COMMIT_STATUSES.CONFLICT, receipt: clone(existingReceipt) };
      }
      if (this.#cases.has(decisionCase.id)) {
        return { status: COMMIT_STATUSES.ALREADY_EXISTS, current: clone(this.#cases.get(decisionCase.id)) };
      }
      this.#cases.set(decisionCase.id, clone(decisionCase));
      this.#receipts.set(key, clone({ ...receipt, commandFingerprint, receiptKey: key }));
      if (event) this.#events.set(eventKey(event), clone({ ...event, eventKey: eventKey(event) }));
      return { status: COMMIT_STATUSES.COMMITTED, receipt: clone(receipt), case: clone(decisionCase) };
    });
  }

  async commitCaseCommand({
    caseId,
    expectedRevision,
    idempotencyKey,
    commandFingerprint,
    nextCase,
    receipt,
    event,
  }) {
    return this.#locked(caseId, async () => {
      const key = receiptKey(caseId, idempotencyKey);
      const existingReceipt = this.#receipts.get(key);
      if (existingReceipt) {
        return existingReceipt.commandFingerprint === commandFingerprint
          ? { status: COMMIT_STATUSES.REPLAYED, receipt: clone(existingReceipt) }
          : { status: COMMIT_STATUSES.CONFLICT, receipt: clone(existingReceipt) };
      }
      const current = this.#cases.get(caseId);
      if (!current) return { status: COMMIT_STATUSES.NOT_FOUND };
      if (current.revision !== expectedRevision) {
        return { status: COMMIT_STATUSES.STALE, currentRevision: current.revision, current: clone(current) };
      }
      if (nextCase.revision !== expectedRevision + 1) {
        throw new TypeError("A committed case must advance exactly one revision.");
      }
      this.#cases.set(caseId, clone(nextCase));
      this.#receipts.set(key, clone({ ...receipt, commandFingerprint, receiptKey: key }));
      if (event) this.#events.set(eventKey(event), clone({ ...event, eventKey: eventKey(event) }));
      return { status: COMMIT_STATUSES.COMMITTED, receipt: clone(receipt), case: clone(nextCase) };
    });
  }

  async getCommandReceipt(caseId, idempotencyKey) {
    return clone(this.#receipts.get(receiptKey(caseId, idempotencyKey)) ?? null);
  }

  async listEvents(caseId) {
    return [...this.#events.values()]
      .filter((event) => event.caseId === caseId)
      .sort((left, right) => left.revision - right.revision || left.at.localeCompare(right.at))
      .map(clone);
  }

  async getGovernance(caseId) {
    return clone(this.#governance.get(caseId) ?? null);
  }

  async commitGovernanceMutation({ caseId, expectedVersion, nextGovernance }) {
    return this.#locked(`governance:${caseId}`, async () => {
      const current = this.#governance.get(caseId);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        return { status: COMMIT_STATUSES.STALE, current: clone(current ?? null), currentVersion };
      }
      if (nextGovernance?.id !== caseId || nextGovernance.version !== expectedVersion + 1) {
        throw new TypeError("A governance mutation must preserve the case ID and advance exactly one version.");
      }
      this.#governance.set(caseId, clone(nextGovernance));
      return { status: COMMIT_STATUSES.COMMITTED, governance: clone(nextGovernance) };
    });
  }

  async putImport(job) {
    return this.#locked(`import:${job.id}`, async () => {
      this.#imports.set(job.id, clone(job));
      return clone(job);
    });
  }

  async createImport(job) {
    const request = job.startRequest;
    const lockKey = request?.idempotencyKey ? `import-start:${request.idempotencyKey}` : `import:${job.id}`;
    return this.#locked(lockKey, async () => {
      if (request?.idempotencyKey) {
        const existing = [...this.#imports.values()].find(
          (candidate) => candidate.startRequest?.idempotencyKey === request.idempotencyKey,
        );
        if (existing) {
          return existing.startRequest.fingerprint === request.fingerprint
            ? { status: COMMIT_STATUSES.REPLAYED, job: clone(existing) }
            : { status: COMMIT_STATUSES.CONFLICT, job: clone(existing) };
        }
      }
      if (this.#imports.has(job.id)) {
        return { status: COMMIT_STATUSES.ALREADY_EXISTS, job: clone(this.#imports.get(job.id)) };
      }
      this.#imports.set(job.id, clone(job));
      return { status: COMMIT_STATUSES.COMMITTED, job: clone(job) };
    });
  }

  async commitImportMutation({ jobId, expectedVersion, expectedPhase, nextJob, documents = [], blobs = [] }) {
    return this.#locked(`import:${jobId}`, async () => {
      const current = this.#imports.get(jobId);
      if (!current) return { status: COMMIT_STATUSES.NOT_FOUND };
      const currentVersion = current.version ?? 0;
      if (
        currentVersion !== expectedVersion ||
        (expectedPhase !== undefined && current.phase !== expectedPhase)
      ) {
        return { status: COMMIT_STATUSES.STALE, current: clone(current), currentVersion };
      }
      if (nextJob?.id !== jobId || nextJob.version !== currentVersion + 1) {
        throw new TypeError("An import mutation must preserve the job ID and advance exactly one version.");
      }
      for (const document of documents) {
        if (document?.importId !== jobId || !nextJob.documentIds?.includes(document.id)) {
          throw new TypeError("Atomic import document updates must belong to the current import job.");
        }
      }
      for (const blob of blobs) {
        if (!blob?.id?.startsWith(`${jobId}:raw-input:`) || !nextJob.rawInputBlobIds?.includes(blob.id)) {
          throw new TypeError("Atomic import blobs must belong to the current import job.");
        }
      }
      for (const document of documents) this.#documents.set(document.id, clone(document));
      for (const blob of blobs) this.#blobs.set(blob.id, clone(blob.value));
      this.#imports.set(jobId, clone(nextJob));
      return { status: COMMIT_STATUSES.COMMITTED, job: clone(nextJob) };
    });
  }

  async getImport(jobId) {
    return clone(this.#imports.get(jobId) ?? null);
  }

  async listImports(caseId = undefined) {
    return [...this.#imports.values()]
      .filter((job) => caseId === undefined || job.caseId === caseId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(clone);
  }

  async putDocument(document) {
    return this.#locked(`import:${document.importId}`, async () => {
      this.#documents.set(document.id, clone(document));
      return clone(document);
    });
  }

  async getDocument(documentId) {
    return clone(this.#documents.get(documentId) ?? null);
  }

  async listDocuments(caseId = undefined) {
    return [...this.#documents.values()]
      .filter((document) => caseId === undefined || document.caseId === caseId)
      .map(clone);
  }

  async deleteDocument(documentId) {
    return this.#documents.delete(documentId);
  }

  async putBlob(blobId, value) {
    this.#blobs.set(blobId, clone(value));
  }

  async getBlob(blobId) {
    return clone(this.#blobs.get(blobId) ?? null);
  }

  async deleteBlob(blobId) {
    return this.#blobs.delete(blobId);
  }
}
