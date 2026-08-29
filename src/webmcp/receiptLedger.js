import {
  WEBMCP_JOURNAL_DATABASE_NAME,
  WEBMCP_JOURNAL_DATABASE_VERSION,
  WEBMCP_RECEIPT_STORE_NAME,
  openWebMcpJournalDatabase,
} from "./invocationStore.js";

function cloneJson(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function createId() {
  if (globalThis.crypto?.randomUUID) return `op_${globalThis.crypto.randomUUID()}`;
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  const match = /^r:(\d+)$/.exec(cursor);
  return match ? Number(match[1]) : 0;
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

function durability(value = {}) {
  return {
    durable: Boolean(value.durable),
    transactional: Boolean(value.transactional),
    sharedAcrossTabs: Boolean(value.sharedAcrossTabs),
    mode: String(value.mode ?? "memory"),
    scope: String(value.scope ?? "session"),
    ...(value.reason ? { reason: String(value.reason).slice(0, 240) } : {}),
  };
}

function sorted(entries) {
  return [...entries].sort(
    (left, right) => String(left.at).localeCompare(String(right.at)) || String(left.operationId).localeCompare(String(right.operationId)),
  );
}

export function createMemoryReceiptState(initialEntries = []) {
  return {
    entries: Array.isArray(initialEntries) ? initialEntries.map(cloneJson) : [],
    listeners: new Set(),
  };
}

export class ReceiptLedger {
  constructor({
    limit = 100,
    clock = () => new Date().toISOString(),
    initialEntries = [],
    persist,
    sharedState,
    journalDurability,
  } = {}) {
    this.limit = Math.max(10, Math.min(500, limit));
    this.clock = clock;
    this.persist = typeof persist === "function" ? persist : null;
    this.state = sharedState ?? createMemoryReceiptState(initialEntries);
    this.state.entries = this.state.entries
      .filter((entry) => entry?.operationId && entry?.tool && entry?.status)
      .slice(-this.limit)
      .map(cloneJson);
    this.state.listeners ??= new Set();
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

  create(fields = {}) {
    return {
      operationId: fields.operationId ?? createId(),
      at: fields.at ?? this.clock(),
      tool: fields.tool,
      status: fields.status ?? "completed",
      errorCode: fields.errorCode ?? null,
      actor: fields.actor,
      caseId: fields.caseId ?? null,
      revisionBefore: fields.revisionBefore ?? null,
      revisionAfter: fields.revisionAfter ?? fields.revisionBefore ?? null,
      viewRevisionBefore: fields.viewRevisionBefore ?? null,
      viewRevisionAfter: fields.viewRevisionAfter ?? fields.viewRevisionBefore ?? null,
      decisionHashBefore: fields.decisionHashBefore ?? null,
      decisionHashAfter: fields.decisionHashAfter ?? fields.decisionHashBefore ?? null,
      changedEntityIds: [...new Set(fields.changedEntityIds ?? [])].slice(0, 30),
      auditEventId: fields.auditEventId ?? null,
      idempotencyKey: fields.idempotencyKey ?? null,
      replayed: Boolean(fields.replayed),
      ...(fields.journalDurability ? { journalDurability: cloneJson(fields.journalDurability) } : {}),
    };
  }

  append(receipt) {
    const entry = cloneJson({
      ...receipt,
      journalDurability: receipt.journalDurability ?? this.getDurability(),
    });
    const existingIndex = this.state.entries.findIndex((candidate) => candidate.operationId === entry.operationId);
    if (existingIndex >= 0) this.state.entries.splice(existingIndex, 1);
    this.state.entries.push(entry);
    if (this.state.entries.length > this.limit) {
      this.state.entries.splice(0, this.state.entries.length - this.limit);
    }
    this.state.listeners.forEach((listener) => listener(cloneJson(entry)));
    try {
      this.persist?.(this.state.entries.map(cloneJson));
    } catch {
      entry.journalDurability = {
        ...this.getDurability(),
        durable: false,
        reason: "Receipt persistence failed; this entry is available only in the current session.",
      };
    }
    return cloneJson(entry);
  }

  get(operationId) {
    const entry = this.state.entries.find((candidate) => candidate.operationId === operationId);
    return entry ? cloneJson(entry) : null;
  }

  list({ cursor, limit = 10 } = {}) {
    const offset = decodeCursor(cursor);
    const boundedLimit = Math.max(1, Math.min(20, limit));
    const newestFirst = [...this.state.entries].reverse();
    const entries = newestFirst.slice(offset, offset + boundedLimit).map(cloneJson);
    const nextOffset = offset + entries.length;
    return {
      entries,
      nextCursor: nextOffset < newestFirst.length ? `r:${nextOffset}` : null,
      total: newestFirst.length,
      journalDurability: this.getDurability(),
    };
  }

  async listAsync(options = {}) {
    return this.list(options);
  }

  subscribe(listener) {
    this.state.listeners.add(listener);
    return () => this.state.listeners.delete(listener);
  }

  clear() {
    this.state.entries.splice(0);
    try {
      this.persist?.([]);
    } catch {
      // The session ledger is still empty.
    }
    return true;
  }
}

export const WEBMCP_RECEIPT_STORAGE_KEY = "situation-room:webmcp-receipts:v1";

export class LocalStorageReceiptLedger extends ReceiptLedger {
  constructor({
    storage = globalThis.localStorage,
    storageKey = WEBMCP_RECEIPT_STORAGE_KEY,
    limit = 100,
    clock,
  } = {}) {
    let initialEntries = [];
    try {
      const parsed = JSON.parse(storage?.getItem?.(storageKey) || "{}");
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) initialEntries = parsed.entries;
    } catch {
      initialEntries = [];
    }
    super({
      limit,
      clock,
      initialEntries,
      journalDurability: {
        durable: false,
        transactional: false,
        sharedAcrossTabs: false,
        mode: "local-storage",
        scope: "browser-profile-session-fallback",
        reason: "LocalStorage receipt appends are not transactionally merged across tabs.",
      },
      persist: (entries) => {
        storage?.setItem?.(storageKey, JSON.stringify({ version: 1, entries }));
      },
    });
    this.storage = storage;
    this.storageKey = storageKey;
  }

  clear() {
    super.clear();
    try {
      this.storage?.removeItem?.(this.storageKey);
    } catch {
      // The session ledger is still empty.
    }
    return true;
  }
}

export class IndexedDbReceiptLedger extends ReceiptLedger {
  constructor({
    indexedDB = globalThis.indexedDB,
    dbName = WEBMCP_JOURNAL_DATABASE_NAME,
    version = WEBMCP_JOURNAL_DATABASE_VERSION,
    limit = 100,
    clock,
    fallbackLedger = new ReceiptLedger({ limit, clock }),
  } = {}) {
    super({
      limit,
      clock,
      journalDurability: {
        durable: true,
        transactional: true,
        sharedAcrossTabs: true,
        mode: "indexeddb",
        scope: "browser-profile",
      },
    });
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.version = version;
    this.fallbackLedger = fallbackLedger;
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
      await this.refresh();
    } catch (error) {
      this.fallbackReason = `IndexedDB receipt journal initialization failed: ${String(error?.message ?? error).slice(0, 180)}`;
      await this.fallbackLedger.initialize?.();
    }
    return this;
  }

  getDurability() {
    if (this.fallbackReason) {
      return {
        ...this.fallbackLedger.getDurability(),
        requestedMode: "indexeddb",
        reason: this.fallbackReason,
      };
    }
    return super.getDurability();
  }

  #transaction(mode = "readonly") {
    if (!this.database) throw new Error("The receipt journal is not open.");
    return this.database.transaction([WEBMCP_RECEIPT_STORE_NAME], mode);
  }

  #replaceEntries(entries) {
    this.state.entries.splice(0, this.state.entries.length, ...sorted(entries).slice(-this.limit).map(cloneJson));
  }

  async refresh() {
    if (this.fallbackReason) return this;
    if (!this.database) await this.initialize();
    if (this.fallbackReason) return this;
    const transaction = this.#transaction();
    const entries = await requestResult(transaction.objectStore(WEBMCP_RECEIPT_STORE_NAME).getAll());
    await transactionDone(transaction);
    this.#replaceEntries(entries);
    return this;
  }

  async append(receipt) {
    await this.initialize();
    if (this.fallbackReason) {
      const entry = await this.fallbackLedger.append({
        ...receipt,
        journalDurability: this.getDurability(),
      });
      this.#replaceEntries([...this.state.entries, entry]);
      return entry;
    }
    const durableEntry = cloneJson({ ...receipt, journalDurability: this.getDurability() });
    try {
      const transaction = this.#transaction("readwrite");
      const store = transaction.objectStore(WEBMCP_RECEIPT_STORE_NAME);
      const entries = await requestResult(store.getAll());
      const merged = sorted([
        ...entries.filter((entry) => entry.operationId !== durableEntry.operationId),
        durableEntry,
      ]);
      const retained = merged.slice(-this.limit);
      const retainedIds = new Set(retained.map((entry) => entry.operationId));
      for (const entry of entries) {
        if (!retainedIds.has(entry.operationId)) store.delete(entry.operationId);
      }
      store.put(durableEntry);
      await transactionDone(transaction);
      this.#replaceEntries(retained);
      this.state.listeners.forEach((listener) => listener(cloneJson(durableEntry)));
      return cloneJson(durableEntry);
    } catch (error) {
      this.fallbackReason = `Receipt append failed and is session-only: ${String(error?.message ?? error).slice(0, 180)}`;
      const entry = await this.fallbackLedger.append({
        ...receipt,
        journalDurability: this.getDurability(),
      });
      this.#replaceEntries([...this.state.entries, entry]);
      this.state.listeners.forEach((listener) => listener(cloneJson(entry)));
      return entry;
    }
  }

  async listAsync(options = {}) {
    await this.initialize();
    if (this.fallbackReason) return this.list(options);
    await this.refresh();
    return this.list(options);
  }

  async clear() {
    await this.initialize();
    if (this.fallbackReason) {
      this.fallbackLedger.clear();
      return super.clear();
    }
    const transaction = this.#transaction("readwrite");
    transaction.objectStore(WEBMCP_RECEIPT_STORE_NAME).clear();
    await transactionDone(transaction);
    return super.clear();
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
