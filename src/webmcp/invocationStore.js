function cloneJson(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function messageOf(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 240);
}

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

function boundedKey(key) {
  const value = String(key ?? "");
  if (!value || value.length > 700) throw new TypeError("Invocation journal keys must contain 1 to 700 characters.");
  return value;
}

function boundedFingerprint(fingerprint) {
  const value = String(fingerprint ?? "");
  if (!value || value.length > 100) throw new TypeError("Invocation fingerprints must contain 1 to 100 characters.");
  return value;
}

function boundedOwnerId(ownerId, fallback) {
  return String(ownerId ?? fallback).slice(0, 160);
}

function boundedLeaseMs(value, fallback) {
  const candidate = Number(value ?? fallback);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(1_000, Math.min(10 * 60_000, Math.trunc(candidate)));
}

function validDateMs(value) {
  const milliseconds = Date.parse(String(value ?? ""));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function leaseExpiresAt(at, leaseMs) {
  const start = validDateMs(at) ?? Date.now();
  return new Date(start + leaseMs).toISOString();
}

function leaseExpired(entry, at) {
  const deadline = validDateMs(entry?.leaseExpiresAt);
  const observedAt = validDateMs(at) ?? Date.now();
  return deadline === null || deadline <= observedAt;
}

function durability(value = {}) {
  return Object.freeze({
    durable: Boolean(value.durable),
    transactional: Boolean(value.transactional),
    sharedAcrossTabs: Boolean(value.sharedAcrossTabs),
    mode: String(value.mode ?? "memory"),
    scope: String(value.scope ?? "session"),
    ...(value.reason ? { reason: String(value.reason).slice(0, 240) } : {}),
  });
}

function classifyEntry(entry, fingerprint, { at = new Date().toISOString() } = {}) {
  if (!entry) return { status: "missing" };
  if (entry.fingerprint !== fingerprint) return { status: "conflict", entry };
  if (entry.status === "completed" && entry.response) return { status: "replay", entry };
  // Version-one journals used `pending` for both pre- and post-execution work.
  // Replaying one of those records could duplicate a completed mutation, so it
  // is permanently outcome-uncertain until a human reconciles the canonical state.
  if (entry.status === "pending") return { status: "uncertain", entry, legacy: true };
  if (entry.status === "claimed") {
    return leaseExpired(entry, at)
      ? { status: "reclaimable", entry }
      : { status: "pending", entry };
  }
  if (entry.status === "executing") {
    return leaseExpired(entry, at)
      ? { status: "uncertain", entry }
      : { status: "pending", entry };
  }
  return { status: "uncertain", entry };
}

async function pollForResult(
  read,
  key,
  fingerprint,
  { timeoutMs = 30_000, signal, intervalMs = 20, now = () => new Date().toISOString() } = {},
) {
  const deadline = Date.now() + Math.max(100, Math.min(60_000, timeoutMs));
  while (Date.now() <= deadline) {
    if (signal?.aborted) return { status: "canceled" };
    const classified = classifyEntry(await read(key), fingerprint, { at: now() });
    if (["replay", "conflict", "missing", "reclaimable", "uncertain"].includes(classified.status)) return classified;
    await new Promise((resolve) => setTimeout(resolve, Math.max(5, Math.min(100, intervalMs))));
  }
  const final = classifyEntry(await read(key), fingerprint, { at: now() });
  return final.status === "pending" ? { status: "timeout", entry: final.entry } : final;
}

export const WEBMCP_CLAIM_LEASE_MS = 30_000;
export const WEBMCP_EXECUTION_LEASE_MS = 30_000;

export const WEBMCP_INVOCATION_STORAGE_KEY = "situation-room:webmcp-invocations:v1";
export const WEBMCP_JOURNAL_DATABASE_NAME = "situation-room-webmcp-journal";
export const WEBMCP_JOURNAL_DATABASE_VERSION = 1;
export const WEBMCP_INVOCATION_STORE_NAME = "invocations";
export const WEBMCP_RECEIPT_STORE_NAME = "receipts";

export class InvocationJournalError extends Error {
  constructor(message, { stage, cause, uncertain = false } = {}) {
    super(message);
    this.name = "InvocationJournalError";
    this.code = "JOURNAL_UNAVAILABLE";
    this.stage = stage ?? "unknown";
    this.uncertain = Boolean(uncertain);
    this.cause = cause;
  }
}

export function createMemoryInvocationState() {
  return { entries: new Map(), locks: new Map() };
}

export async function openWebMcpJournalDatabase({
  indexedDB = globalThis.indexedDB,
  dbName = WEBMCP_JOURNAL_DATABASE_NAME,
  version = WEBMCP_JOURNAL_DATABASE_VERSION,
} = {}) {
  if (!indexedDB?.open) throw new Error("IndexedDB is unavailable.");
  const request = indexedDB.open(dbName, version);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(WEBMCP_INVOCATION_STORE_NAME)) {
      database.createObjectStore(WEBMCP_INVOCATION_STORE_NAME, { keyPath: "key" });
    }
    if (!database.objectStoreNames.contains(WEBMCP_RECEIPT_STORE_NAME)) {
      const receipts = database.createObjectStore(WEBMCP_RECEIPT_STORE_NAME, { keyPath: "operationId" });
      receipts.createIndex("at", "at", { unique: false });
    }
  };
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the WebMCP journal."));
    request.onblocked = () => reject(new Error("The WebMCP journal upgrade is blocked by another tab."));
  });
}

export async function clearWebMcpJournalDatabase({
  indexedDB = globalThis.indexedDB,
  dbName = WEBMCP_JOURNAL_DATABASE_NAME,
  version = WEBMCP_JOURNAL_DATABASE_VERSION,
} = {}) {
  const database = await openWebMcpJournalDatabase({ indexedDB, dbName, version });
  try {
    const transaction = database.transaction(
      [WEBMCP_INVOCATION_STORE_NAME, WEBMCP_RECEIPT_STORE_NAME],
      "readwrite",
    );
    transaction.objectStore(WEBMCP_INVOCATION_STORE_NAME).clear();
    transaction.objectStore(WEBMCP_RECEIPT_STORE_NAME).clear();
    await transactionDone(transaction);
    return true;
  } finally {
    database.close();
  }
}

export class MemoryInvocationStore {
  constructor({ sharedState = createMemoryInvocationState(), journalDurability } = {}) {
    this.state = sharedState;
    this.journalDurability = durability(journalDurability ?? {
      durable: false,
      transactional: true,
      sharedAcrossTabs: false,
      mode: "memory",
      scope: "session",
    });
  }

  async initialize() {
    return this;
  }

  getDurability() {
    return cloneJson(this.journalDurability);
  }

  async #locked(key, operation) {
    const previous = this.state.locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.state.locks.set(key, gate);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.state.locks.get(key) === gate) this.state.locks.delete(key);
    }
  }

  async get(key) {
    return cloneJson(this.state.entries.get(key) ?? null);
  }

  async claim(
    key,
    fingerprint,
    { ownerId, at = new Date().toISOString(), leaseMs = WEBMCP_CLAIM_LEASE_MS } = {},
  ) {
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    const safeOwnerId = boundedOwnerId(ownerId, "session-owner");
    const safeLeaseMs = boundedLeaseMs(leaseMs, WEBMCP_CLAIM_LEASE_MS);
    return this.#locked(safeKey, async () => {
      const existing = this.state.entries.get(safeKey);
      const classified = classifyEntry(existing, safeFingerprint, { at });
      if (!["missing", "reclaimable"].includes(classified.status)) {
        return { ...cloneJson(classified), durability: this.getDurability() };
      }
      const entry = {
        key: safeKey,
        fingerprint: safeFingerprint,
        status: "claimed",
        ownerId: safeOwnerId,
        claimedAt: at,
        updatedAt: at,
        leaseExpiresAt: leaseExpiresAt(at, safeLeaseMs),
        attempt: Math.max(1, Number(existing?.attempt ?? 0) + 1),
        ...(classified.status === "reclaimable" ? { reclaimedFromOwnerId: existing.ownerId ?? null } : {}),
        response: null,
      };
      this.state.entries.set(safeKey, cloneJson(entry));
      return {
        status: "claimed",
        entry: cloneJson(entry),
        reclaimed: classified.status === "reclaimable",
        durability: this.getDurability(),
      };
    });
  }

  async markExecuting(
    key,
    fingerprint,
    ownerId,
    { at = new Date().toISOString(), leaseMs = WEBMCP_EXECUTION_LEASE_MS } = {},
  ) {
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    const safeOwnerId = boundedOwnerId(ownerId, "session-owner");
    const safeLeaseMs = boundedLeaseMs(leaseMs, WEBMCP_EXECUTION_LEASE_MS);
    return this.#locked(safeKey, async () => {
      const existing = this.state.entries.get(safeKey);
      const classified = classifyEntry(existing, safeFingerprint, { at });
      if (["conflict", "replay", "uncertain", "missing"].includes(classified.status)) {
        return { ...cloneJson(classified), durability: this.getDurability() };
      }
      if (existing.status === "executing" && existing.ownerId === safeOwnerId) {
        return { status: "executing", entry: cloneJson(existing), durability: this.getDurability() };
      }
      if (existing.status !== "claimed" || existing.ownerId !== safeOwnerId || classified.status === "reclaimable") {
        return { status: "pending", entry: cloneJson(existing), durability: this.getDurability() };
      }
      const executing = {
        ...existing,
        status: "executing",
        executionStartedAt: at,
        updatedAt: at,
        leaseExpiresAt: leaseExpiresAt(at, safeLeaseMs),
      };
      this.state.entries.set(safeKey, cloneJson(executing));
      return { status: "executing", entry: cloneJson(executing), durability: this.getDurability() };
    });
  }

  async complete(key, fingerprint, ownerId, response, { at = new Date().toISOString() } = {}) {
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    return this.#locked(safeKey, async () => {
      const existing = this.state.entries.get(safeKey);
      const classified = classifyEntry(existing, safeFingerprint, { at });
      if (classified.status === "conflict") return { ...cloneJson(classified), durability: this.getDurability() };
      if (classified.status === "replay") return { ...cloneJson(classified), durability: this.getDurability() };
      if (
        !existing ||
        existing.ownerId !== ownerId ||
        !["claimed", "executing"].includes(existing.status)
      ) {
        return { status: "pending", entry: cloneJson(existing ?? null), durability: this.getDurability() };
      }
      const completed = {
        ...existing,
        status: "completed",
        response: cloneJson(response),
        updatedAt: at,
        completedAt: at,
        leaseExpiresAt: null,
      };
      this.state.entries.set(safeKey, cloneJson(completed));
      return { status: "completed", entry: cloneJson(completed), durability: this.getDurability() };
    });
  }

  async waitForResult(key, fingerprint, options = {}) {
    const result = await pollForResult((candidate) => this.get(candidate), key, fingerprint, options);
    return { ...result, durability: this.getDurability() };
  }

  async set(key, value) {
    const safeKey = boundedKey(key);
    this.state.entries.set(safeKey, cloneJson({
      key: safeKey,
      fingerprint: boundedFingerprint(value?.fingerprint),
      status: "completed",
      ownerId: null,
      response: value?.response,
      claimedAt: value?.at ?? new Date().toISOString(),
      updatedAt: value?.at ?? new Date().toISOString(),
    }));
    return true;
  }

  async delete(key) {
    return this.state.entries.delete(key);
  }

  async clear() {
    this.state.entries.clear();
    return true;
  }
}

export class LocalStorageInvocationStore {
  constructor({
    storage = globalThis.localStorage,
    storageKey = WEBMCP_INVOCATION_STORAGE_KEY,
    limit = 200,
    maxRecordBytes = 24_000,
  } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.limit = Math.max(20, Math.min(500, limit));
    this.maxRecordBytes = Math.max(2_000, Math.min(100_000, maxRecordBytes));
  }

  async initialize() {
    return this;
  }

  getDurability() {
    return durability({
      durable: false,
      transactional: false,
      sharedAcrossTabs: false,
      mode: "local-storage",
      scope: "browser-profile-session-fallback",
      reason: "LocalStorage cannot provide an atomic cross-tab invocation claim.",
    });
  }

  #read() {
    try {
      const parsed = JSON.parse(this.storage?.getItem?.(this.storageKey) || "{}");
      if (![2, 3].includes(parsed?.version) || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter((entry) =>
        entry &&
        typeof entry.key === "string" &&
        typeof entry.fingerprint === "string" &&
        ["pending", "claimed", "executing", "completed"].includes(entry.status),
      );
    } catch {
      return [];
    }
  }

  #write(entries) {
    try {
      this.storage?.setItem?.(this.storageKey, JSON.stringify({ version: 3, entries }));
      return true;
    } catch {
      return false;
    }
  }

  async get(key) {
    const entry = this.#read().find((candidate) => candidate.key === key);
    return entry ? cloneJson(entry) : null;
  }

  async claim(
    key,
    fingerprint,
    { ownerId, at = new Date().toISOString(), leaseMs = WEBMCP_CLAIM_LEASE_MS } = {},
  ) {
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    const safeOwnerId = boundedOwnerId(ownerId, "local-owner");
    const safeLeaseMs = boundedLeaseMs(leaseMs, WEBMCP_CLAIM_LEASE_MS);
    const existing = await this.get(safeKey);
    const classified = classifyEntry(existing, safeFingerprint, { at });
    if (!["missing", "reclaimable"].includes(classified.status)) {
      return { ...classified, durability: this.getDurability() };
    }
    const entry = {
      key: safeKey,
      fingerprint: safeFingerprint,
      status: "claimed",
      ownerId: safeOwnerId,
      claimedAt: at,
      updatedAt: at,
      leaseExpiresAt: leaseExpiresAt(at, safeLeaseMs),
      attempt: Math.max(1, Number(existing?.attempt ?? 0) + 1),
      ...(classified.status === "reclaimable" ? { reclaimedFromOwnerId: existing.ownerId ?? null } : {}),
      response: null,
    };
    const entries = this.#read().filter((candidate) => candidate.key !== safeKey);
    if (!this.#write([...entries, entry].slice(-this.limit))) {
      throw new InvocationJournalError("The LocalStorage invocation claim could not be saved.", { stage: "claim" });
    }
    return {
      status: "claimed",
      entry: cloneJson(entry),
      reclaimed: classified.status === "reclaimable",
      durability: this.getDurability(),
    };
  }

  async markExecuting(
    key,
    fingerprint,
    ownerId,
    { at = new Date().toISOString(), leaseMs = WEBMCP_EXECUTION_LEASE_MS } = {},
  ) {
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    const safeOwnerId = boundedOwnerId(ownerId, "local-owner");
    const existing = await this.get(safeKey);
    const classified = classifyEntry(existing, safeFingerprint, { at });
    if (["conflict", "replay", "uncertain", "missing"].includes(classified.status)) {
      return { ...classified, durability: this.getDurability() };
    }
    if (existing.status === "executing" && existing.ownerId === safeOwnerId) {
      return { status: "executing", entry: cloneJson(existing), durability: this.getDurability() };
    }
    if (existing.status !== "claimed" || existing.ownerId !== safeOwnerId || classified.status === "reclaimable") {
      return { status: "pending", entry: cloneJson(existing), durability: this.getDurability() };
    }
    const executing = {
      ...existing,
      status: "executing",
      executionStartedAt: at,
      updatedAt: at,
      leaseExpiresAt: leaseExpiresAt(at, boundedLeaseMs(leaseMs, WEBMCP_EXECUTION_LEASE_MS)),
    };
    const entries = this.#read().filter((candidate) => candidate.key !== safeKey);
    if (!this.#write([...entries, executing].slice(-this.limit))) {
      throw new InvocationJournalError("The LocalStorage execution boundary could not be saved.", {
        stage: "mark-executing",
        uncertain: true,
      });
    }
    return { status: "executing", entry: cloneJson(executing), durability: this.getDurability() };
  }

  async complete(key, fingerprint, ownerId, response, { at = new Date().toISOString() } = {}) {
    const safeKey = boundedKey(key);
    const existing = await this.get(safeKey);
    const classified = classifyEntry(existing, boundedFingerprint(fingerprint), { at });
    if (["conflict", "replay"].includes(classified.status)) return { ...classified, durability: this.getDurability() };
    if (!existing || existing.ownerId !== ownerId || !["claimed", "executing"].includes(existing.status)) {
      return { status: "pending", entry: existing, durability: this.getDurability() };
    }
    const completed = {
      ...existing,
      status: "completed",
      response: cloneJson(response),
      updatedAt: at,
      completedAt: at,
      leaseExpiresAt: null,
    };
    let serialized;
    try {
      serialized = JSON.stringify(completed);
    } catch {
      throw new InvocationJournalError("The invocation response could not be serialized.", { stage: "complete" });
    }
    if (serialized.length > this.maxRecordBytes) {
      throw new InvocationJournalError("The invocation response exceeds the fallback journal quota.", { stage: "complete" });
    }
    const entries = this.#read().filter((candidate) => candidate.key !== safeKey);
    if (!this.#write([...entries, completed].slice(-this.limit))) {
      throw new InvocationJournalError("The LocalStorage invocation result could not be saved.", { stage: "complete" });
    }
    return { status: "completed", entry: cloneJson(completed), durability: this.getDurability() };
  }

  async waitForResult(key, fingerprint, options = {}) {
    const result = await pollForResult((candidate) => this.get(candidate), key, fingerprint, options);
    return { ...result, durability: this.getDurability() };
  }

  async set(key, value) {
    const claimed = await this.claim(key, value?.fingerprint, { ownerId: "compatibility-set", at: value?.at });
    if (claimed.status === "conflict") return false;
    if (claimed.status === "replay") return true;
    const completed = await this.complete(key, value?.fingerprint, "compatibility-set", value?.response, { at: value?.at });
    return completed.status === "completed";
  }

  async delete(key) {
    const entries = this.#read();
    const next = entries.filter((entry) => entry.key !== key);
    if (next.length === entries.length) return false;
    return this.#write(next);
  }

  async clear() {
    try {
      this.storage?.removeItem?.(this.storageKey);
      return true;
    } catch {
      return false;
    }
  }
}

export class IndexedDbInvocationStore {
  constructor({
    indexedDB = globalThis.indexedDB,
    dbName = WEBMCP_JOURNAL_DATABASE_NAME,
    version = WEBMCP_JOURNAL_DATABASE_VERSION,
    maxRecordBytes = 24_000,
    fallbackStore = new MemoryInvocationStore(),
  } = {}) {
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.version = version;
    this.maxRecordBytes = Math.max(2_000, Math.min(100_000, maxRecordBytes));
    this.fallbackStore = fallbackStore;
    this.database = null;
    this.fallbackReason = null;
  }

  async initialize() {
    if (this.database || this.fallbackReason) return this;
    try {
      this.database = await openWebMcpJournalDatabase({
        indexedDB: this.indexedDB,
        dbName: this.dbName,
        version: this.version,
      });
      this.database.onversionchange = () => {
        this.database?.close();
        this.database = null;
      };
    } catch (error) {
      this.fallbackReason = `IndexedDB initialization failed: ${messageOf(error)}`;
      await this.fallbackStore.initialize?.();
    }
    return this;
  }

  getDurability() {
    if (this.fallbackReason) {
      return {
        ...this.fallbackStore.getDurability(),
        requestedMode: "indexeddb",
        reason: this.fallbackReason,
      };
    }
    return durability({
      durable: true,
      transactional: true,
      sharedAcrossTabs: true,
      mode: "indexeddb",
      scope: "browser-profile",
    });
  }

  async #ready() {
    await this.initialize();
    return !this.fallbackReason;
  }

  #transaction(mode = "readonly") {
    if (!this.database) throw new Error("The invocation journal is not open.");
    return this.database.transaction([WEBMCP_INVOCATION_STORE_NAME], mode);
  }

  async get(key) {
    if (!(await this.#ready())) return this.fallbackStore.get(key);
    try {
      const transaction = this.#transaction();
      const entry = await requestResult(transaction.objectStore(WEBMCP_INVOCATION_STORE_NAME).get(key));
      await transactionDone(transaction);
      return entry ?? null;
    } catch (error) {
      throw new InvocationJournalError("The durable invocation journal could not be read.", {
        stage: "read",
        cause: error,
        uncertain: true,
      });
    }
  }

  async claim(
    key,
    fingerprint,
    { ownerId, at = new Date().toISOString(), leaseMs = WEBMCP_CLAIM_LEASE_MS } = {},
  ) {
    if (!(await this.#ready())) return this.fallbackStore.claim(key, fingerprint, { ownerId, at, leaseMs });
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    const safeOwnerId = boundedOwnerId(ownerId, "indexeddb-owner");
    const safeLeaseMs = boundedLeaseMs(leaseMs, WEBMCP_CLAIM_LEASE_MS);
    try {
      const transaction = this.#transaction("readwrite");
      const store = transaction.objectStore(WEBMCP_INVOCATION_STORE_NAME);
      const existing = await requestResult(store.get(safeKey));
      const classified = classifyEntry(existing, safeFingerprint, { at });
      if (!["missing", "reclaimable"].includes(classified.status)) {
        await transactionDone(transaction);
        return { ...classified, durability: this.getDurability() };
      }
      const entry = {
        key: safeKey,
        fingerprint: safeFingerprint,
        status: "claimed",
        ownerId: safeOwnerId,
        claimedAt: at,
        updatedAt: at,
        leaseExpiresAt: leaseExpiresAt(at, safeLeaseMs),
        attempt: Math.max(1, Number(existing?.attempt ?? 0) + 1),
        ...(classified.status === "reclaimable" ? { reclaimedFromOwnerId: existing.ownerId ?? null } : {}),
        response: null,
      };
      if (existing) store.put(entry);
      else store.add(entry);
      await transactionDone(transaction);
      return {
        status: "claimed",
        entry,
        reclaimed: classified.status === "reclaimable",
        durability: this.getDurability(),
      };
    } catch (error) {
      throw new InvocationJournalError("The durable invocation claim could not be committed; the mutation was not executed.", {
        stage: "claim",
        cause: error,
        uncertain: true,
      });
    }
  }

  async markExecuting(
    key,
    fingerprint,
    ownerId,
    { at = new Date().toISOString(), leaseMs = WEBMCP_EXECUTION_LEASE_MS } = {},
  ) {
    if (!(await this.#ready())) {
      return this.fallbackStore.markExecuting(key, fingerprint, ownerId, { at, leaseMs });
    }
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    const safeOwnerId = boundedOwnerId(ownerId, "indexeddb-owner");
    const safeLeaseMs = boundedLeaseMs(leaseMs, WEBMCP_EXECUTION_LEASE_MS);
    try {
      const transaction = this.#transaction("readwrite");
      const store = transaction.objectStore(WEBMCP_INVOCATION_STORE_NAME);
      const existing = await requestResult(store.get(safeKey));
      const classified = classifyEntry(existing, safeFingerprint, { at });
      if (["conflict", "replay", "uncertain", "missing"].includes(classified.status)) {
        await transactionDone(transaction);
        return { ...classified, durability: this.getDurability() };
      }
      if (existing.status === "executing" && existing.ownerId === safeOwnerId) {
        await transactionDone(transaction);
        return { status: "executing", entry: existing, durability: this.getDurability() };
      }
      if (existing.status !== "claimed" || existing.ownerId !== safeOwnerId || classified.status === "reclaimable") {
        await transactionDone(transaction);
        return { status: "pending", entry: existing, durability: this.getDurability() };
      }
      const executing = {
        ...existing,
        status: "executing",
        executionStartedAt: at,
        updatedAt: at,
        leaseExpiresAt: leaseExpiresAt(at, safeLeaseMs),
      };
      store.put(executing);
      await transactionDone(transaction);
      return { status: "executing", entry: executing, durability: this.getDurability() };
    } catch (error) {
      throw new InvocationJournalError(
        "The durable execution boundary could not be committed; the mutation was not executed.",
        { stage: "mark-executing", cause: error, uncertain: true },
      );
    }
  }

  async complete(key, fingerprint, ownerId, response, { at = new Date().toISOString() } = {}) {
    if (!(await this.#ready())) return this.fallbackStore.complete(key, fingerprint, ownerId, response, { at });
    let serialized;
    try {
      serialized = JSON.stringify(response);
    } catch (error) {
      throw new InvocationJournalError("The invocation result could not be serialized for durable replay.", {
        stage: "complete",
        cause: error,
      });
    }
    if (serialized.length > this.maxRecordBytes) {
      throw new InvocationJournalError("The invocation result exceeds the durable journal record limit.", { stage: "complete" });
    }
    const safeKey = boundedKey(key);
    const safeFingerprint = boundedFingerprint(fingerprint);
    try {
      const transaction = this.#transaction("readwrite");
      const store = transaction.objectStore(WEBMCP_INVOCATION_STORE_NAME);
      const existing = await requestResult(store.get(safeKey));
      const classified = classifyEntry(existing, safeFingerprint, { at });
      if (["conflict", "replay"].includes(classified.status)) {
        await transactionDone(transaction);
        return { ...classified, durability: this.getDurability() };
      }
      if (!existing || existing.ownerId !== ownerId || !["claimed", "executing"].includes(existing.status)) {
        await transactionDone(transaction);
        return { status: "pending", entry: existing ?? null, durability: this.getDurability() };
      }
      const completed = {
        ...existing,
        status: "completed",
        response: cloneJson(response),
        updatedAt: at,
        completedAt: at,
        leaseExpiresAt: null,
      };
      store.put(completed);
      await transactionDone(transaction);
      return { status: "completed", entry: completed, durability: this.getDurability() };
    } catch (error) {
      throw new InvocationJournalError("The mutation completed, but its durable replay result could not be saved.", {
        stage: "complete",
        cause: error,
        uncertain: true,
      });
    }
  }

  async waitForResult(key, fingerprint, options = {}) {
    if (!(await this.#ready())) return this.fallbackStore.waitForResult(key, fingerprint, options);
    try {
      const result = await pollForResult((candidate) => this.get(candidate), key, fingerprint, options);
      return { ...result, durability: this.getDurability() };
    } catch (error) {
      if (error instanceof InvocationJournalError) throw error;
      throw new InvocationJournalError("The pending invocation could not be observed safely.", {
        stage: "wait",
        cause: error,
        uncertain: true,
      });
    }
  }

  async set(key, value) {
    const claim = await this.claim(key, value?.fingerprint, { ownerId: "compatibility-set", at: value?.at });
    if (claim.status === "conflict") return false;
    if (claim.status === "replay") return true;
    const result = await this.complete(key, value?.fingerprint, "compatibility-set", value?.response, { at: value?.at });
    return result.status === "completed";
  }

  async delete(key) {
    if (!(await this.#ready())) return this.fallbackStore.delete(key);
    const transaction = this.#transaction("readwrite");
    transaction.objectStore(WEBMCP_INVOCATION_STORE_NAME).delete(key);
    await transactionDone(transaction);
    return true;
  }

  async clear() {
    if (!(await this.#ready())) return this.fallbackStore.clear();
    const transaction = this.#transaction("readwrite");
    transaction.objectStore(WEBMCP_INVOCATION_STORE_NAME).clear();
    await transactionDone(transaction);
    return true;
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
