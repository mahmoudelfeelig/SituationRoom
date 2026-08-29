import { cloneValue } from "../kernel/canonicalize.js";
import { ERROR_CODES, SituationRoomError } from "../kernel/errors.js";
import {
  COMMIT_STATUSES,
  REPOSITORY_SCHEMA_VERSION,
  eventKey,
  receiptKey,
} from "./repository.js";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function createStores(database) {
  if (!database.objectStoreNames.contains("cases")) database.createObjectStore("cases", { keyPath: "id" });
  if (!database.objectStoreNames.contains("receipts")) {
    database.createObjectStore("receipts", { keyPath: "receiptKey" });
  }
  if (!database.objectStoreNames.contains("events")) {
    const store = database.createObjectStore("events", { keyPath: "eventKey" });
    store.createIndex("caseId", "caseId", { unique: false });
  }
  if (!database.objectStoreNames.contains("imports")) {
    const store = database.createObjectStore("imports", { keyPath: "id" });
    store.createIndex("caseId", "caseId", { unique: false });
  }
  if (!database.objectStoreNames.contains("documents")) {
    const store = database.createObjectStore("documents", { keyPath: "id" });
    store.createIndex("caseId", "caseId", { unique: false });
  }
  if (!database.objectStoreNames.contains("blobs")) database.createObjectStore("blobs", { keyPath: "id" });
  if (!database.objectStoreNames.contains("governance")) database.createObjectStore("governance", { keyPath: "id" });
}

export class IndexedDbRepository {
  #indexedDB;
  #database = null;
  #dbName;
  #version;

  constructor(options = {}) {
    this.#indexedDB = options.indexedDB ?? globalThis.indexedDB;
    this.#dbName = options.dbName ?? "situation-room-os";
    this.#version = options.version ?? REPOSITORY_SCHEMA_VERSION;
  }

  async initialize() {
    if (this.#database) return this;
    if (!this.#indexedDB?.open) {
      throw new SituationRoomError(
        ERROR_CODES.STORAGE_FAILURE,
        "IndexedDB is unavailable in this environment.",
        { recoverable: true },
      );
    }
    const request = this.#indexedDB.open(this.#dbName, this.#version);
    request.onupgradeneeded = () => createStores(request.result);
    try {
      this.#database = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
        request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another open tab."));
      });
    } catch (error) {
      throw new SituationRoomError(ERROR_CODES.STORAGE_FAILURE, "Unable to open the decision database.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    this.#database.onversionchange = () => {
      this.#database?.close();
      this.#database = null;
    };
    return this;
  }

  #transaction(storeNames, mode = "readonly") {
    if (!this.#database) throw new Error("Repository must be initialized before use.");
    return this.#database.transaction(storeNames, mode);
  }

  async listCases() {
    const transaction = this.#transaction(["cases"]);
    const values = await requestResult(transaction.objectStore("cases").getAll());
    await transactionDone(transaction);
    return values.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async getCase(caseId) {
    const transaction = this.#transaction(["cases"]);
    const value = await requestResult(transaction.objectStore("cases").get(caseId));
    await transactionDone(transaction);
    return value ?? null;
  }

  async putCase(decisionCase, options = {}) {
    const transaction = this.#transaction(["cases"], "readwrite");
    const store = transaction.objectStore("cases");
    const current = await requestResult(store.get(decisionCase.id));
    if (options.createOnly && current) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.ALREADY_EXISTS, current };
    }
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== null &&
      current?.revision !== options.expectedRevision
    ) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.STALE, currentRevision: current?.revision ?? null, current: current ?? null };
    }
    store.put(cloneValue(decisionCase));
    await transactionDone(transaction);
    return { status: COMMIT_STATUSES.COMMITTED, case: cloneValue(decisionCase) };
  }

  async commitCreateCase({ decisionCase, idempotencyKey, commandFingerprint, receipt, event }) {
    const transaction = this.#transaction(["cases", "receipts", "events"], "readwrite");
    const cases = transaction.objectStore("cases");
    const receipts = transaction.objectStore("receipts");
    const events = transaction.objectStore("events");
    const key = receiptKey(decisionCase.id, idempotencyKey);
    const existingReceipt = await requestResult(receipts.get(key));
    if (existingReceipt) {
      await transactionDone(transaction);
      return existingReceipt.commandFingerprint === commandFingerprint
        ? { status: COMMIT_STATUSES.REPLAYED, receipt: existingReceipt }
        : { status: COMMIT_STATUSES.CONFLICT, receipt: existingReceipt };
    }
    const current = await requestResult(cases.get(decisionCase.id));
    if (current) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.ALREADY_EXISTS, current };
    }
    cases.put(cloneValue(decisionCase));
    receipts.put({ ...cloneValue(receipt), commandFingerprint, receiptKey: key });
    if (event) events.put({ ...cloneValue(event), eventKey: eventKey(event) });
    await transactionDone(transaction);
    return { status: COMMIT_STATUSES.COMMITTED, receipt: cloneValue(receipt), case: cloneValue(decisionCase) };
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
    const transaction = this.#transaction(["cases", "receipts", "events"], "readwrite");
    const cases = transaction.objectStore("cases");
    const receipts = transaction.objectStore("receipts");
    const events = transaction.objectStore("events");
    const key = receiptKey(caseId, idempotencyKey);
    const existingReceipt = await requestResult(receipts.get(key));
    if (existingReceipt) {
      await transactionDone(transaction);
      return existingReceipt.commandFingerprint === commandFingerprint
        ? { status: COMMIT_STATUSES.REPLAYED, receipt: existingReceipt }
        : { status: COMMIT_STATUSES.CONFLICT, receipt: existingReceipt };
    }
    const current = await requestResult(cases.get(caseId));
    if (!current) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.NOT_FOUND };
    }
    if (current.revision !== expectedRevision) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.STALE, currentRevision: current.revision, current };
    }
    if (nextCase.revision !== expectedRevision + 1) {
      transaction.abort();
      throw new TypeError("A committed case must advance exactly one revision.");
    }
    cases.put(cloneValue(nextCase));
    receipts.put({ ...cloneValue(receipt), commandFingerprint, receiptKey: key });
    if (event) events.put({ ...cloneValue(event), eventKey: eventKey(event) });
    await transactionDone(transaction);
    return { status: COMMIT_STATUSES.COMMITTED, receipt: cloneValue(receipt), case: cloneValue(nextCase) };
  }

  async getCommandReceipt(caseId, idempotencyKey) {
    const transaction = this.#transaction(["receipts"]);
    const value = await requestResult(transaction.objectStore("receipts").get(receiptKey(caseId, idempotencyKey)));
    await transactionDone(transaction);
    return value ?? null;
  }

  async listEvents(caseId) {
    const transaction = this.#transaction(["events"]);
    const values = await requestResult(transaction.objectStore("events").getAll());
    await transactionDone(transaction);
    return values
      .filter((event) => event.caseId === caseId)
      .sort((left, right) => left.revision - right.revision || left.at.localeCompare(right.at));
  }

  async getGovernance(caseId) {
    const transaction = this.#transaction(["governance"]);
    const value = await requestResult(transaction.objectStore("governance").get(caseId));
    await transactionDone(transaction);
    return value ?? null;
  }

  async commitGovernanceMutation({ caseId, expectedVersion, nextGovernance }) {
    if (nextGovernance?.id !== caseId || nextGovernance.version !== expectedVersion + 1) {
      throw new TypeError("A governance mutation must preserve the case ID and advance exactly one version.");
    }
    const transaction = this.#transaction(["governance"], "readwrite");
    const store = transaction.objectStore("governance");
    const current = await requestResult(store.get(caseId));
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.STALE, current: current ?? null, currentVersion };
    }
    store.put(cloneValue(nextGovernance));
    await transactionDone(transaction);
    return { status: COMMIT_STATUSES.COMMITTED, governance: cloneValue(nextGovernance) };
  }

  async putImport(job) {
    const transaction = this.#transaction(["imports"], "readwrite");
    transaction.objectStore("imports").put(cloneValue(job));
    await transactionDone(transaction);
    return cloneValue(job);
  }

  async createImport(job) {
    const transaction = this.#transaction(["imports"], "readwrite");
    const store = transaction.objectStore("imports");
    if (job.startRequest?.idempotencyKey) {
      const imports = await requestResult(store.getAll());
      const existing = imports.find(
        (candidate) => candidate.startRequest?.idempotencyKey === job.startRequest.idempotencyKey,
      );
      if (existing) {
        await transactionDone(transaction);
        return existing.startRequest.fingerprint === job.startRequest.fingerprint
          ? { status: COMMIT_STATUSES.REPLAYED, job: existing }
          : { status: COMMIT_STATUSES.CONFLICT, job: existing };
      }
    }
    const existingId = await requestResult(store.get(job.id));
    if (existingId) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.ALREADY_EXISTS, job: existingId };
    }
    store.add(cloneValue(job));
    await transactionDone(transaction);
    return { status: COMMIT_STATUSES.COMMITTED, job: cloneValue(job) };
  }

  async commitImportMutation({ jobId, expectedVersion, expectedPhase, nextJob, documents = [], blobs = [] }) {
    if (nextJob?.id !== jobId || nextJob.version !== expectedVersion + 1) {
      throw new TypeError("An import mutation must preserve the job ID and advance exactly one version.");
    }
    for (const blob of blobs) {
      if (!blob?.id?.startsWith(`${jobId}:raw-input:`) || !nextJob.rawInputBlobIds?.includes(blob.id)) {
        throw new TypeError("Atomic import blobs must belong to the current import job.");
      }
    }
    const transaction = this.#transaction(["imports", "documents", "blobs"], "readwrite");
    const imports = transaction.objectStore("imports");
    const documentStore = transaction.objectStore("documents");
    const blobStore = transaction.objectStore("blobs");
    const current = await requestResult(imports.get(jobId));
    if (!current) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.NOT_FOUND };
    }
    if (
      (current.version ?? 0) !== expectedVersion ||
      (expectedPhase !== undefined && current.phase !== expectedPhase)
    ) {
      await transactionDone(transaction);
      return { status: COMMIT_STATUSES.STALE, current, currentVersion: current.version ?? 0 };
    }
    for (const document of documents) {
      if (document?.importId !== jobId || !nextJob.documentIds?.includes(document.id)) {
        transaction.abort();
        throw new TypeError("Atomic import document updates must belong to the current import job.");
      }
      documentStore.put(cloneValue(document));
    }
    for (const blob of blobs) blobStore.put({ id: blob.id, value: cloneValue(blob.value) });
    imports.put(cloneValue(nextJob));
    await transactionDone(transaction);
    return { status: COMMIT_STATUSES.COMMITTED, job: cloneValue(nextJob) };
  }

  async getImport(jobId) {
    const transaction = this.#transaction(["imports"]);
    const value = await requestResult(transaction.objectStore("imports").get(jobId));
    await transactionDone(transaction);
    return value ?? null;
  }

  async listImports(caseId = undefined) {
    const transaction = this.#transaction(["imports"]);
    const values = await requestResult(transaction.objectStore("imports").getAll());
    await transactionDone(transaction);
    return values
      .filter((job) => caseId === undefined || job.caseId === caseId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async putDocument(document) {
    const transaction = this.#transaction(["documents"], "readwrite");
    transaction.objectStore("documents").put(cloneValue(document));
    await transactionDone(transaction);
    return cloneValue(document);
  }

  async getDocument(documentId) {
    const transaction = this.#transaction(["documents"]);
    const value = await requestResult(transaction.objectStore("documents").get(documentId));
    await transactionDone(transaction);
    return value ?? null;
  }

  async listDocuments(caseId = undefined) {
    const transaction = this.#transaction(["documents"]);
    const values = await requestResult(transaction.objectStore("documents").getAll());
    await transactionDone(transaction);
    return values.filter((document) => caseId === undefined || document.caseId === caseId);
  }

  async deleteDocument(documentId) {
    const transaction = this.#transaction(["documents"], "readwrite");
    transaction.objectStore("documents").delete(documentId);
    await transactionDone(transaction);
    return true;
  }

  async putBlob(blobId, value) {
    const transaction = this.#transaction(["blobs"], "readwrite");
    transaction.objectStore("blobs").put({ id: blobId, value: cloneValue(value) });
    await transactionDone(transaction);
  }

  async getBlob(blobId) {
    const transaction = this.#transaction(["blobs"]);
    const record = await requestResult(transaction.objectStore("blobs").get(blobId));
    await transactionDone(transaction);
    return record?.value ?? null;
  }

  async deleteBlob(blobId) {
    const transaction = this.#transaction(["blobs"], "readwrite");
    transaction.objectStore("blobs").delete(blobId);
    await transactionDone(transaction);
    return true;
  }

  close() {
    this.#database?.close();
    this.#database = null;
  }
}
