import { evaluateCapability, selectCapabilities } from "./capabilityPolicy.js";
import {
  DEFAULT_OUTPUT_LIMIT,
  ToolError,
  errorEnvelope,
  normalizeToolError,
  successEnvelope,
} from "./envelopes.js";
import {
  publicContext,
  readCapabilityContext,
  subscribeToPorts,
  validatePorts,
  waitForVisibleSettle,
} from "./ports.js";
import { ReceiptLedger } from "./receiptLedger.js";
import { stableStringify, summarizeValidationIssues, validateInput } from "./runtimeValidation.js";
import { createToolCatalog } from "./toolCatalog.js";
import { canonicalHash } from "../kernel/canonicalize.js";
import { MemoryInvocationStore } from "./invocationStore.js";

function cloneJson(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function actorLabel(actor) {
  if (typeof actor === "string") return actor;
  return actor?.id ?? actor?.label ?? "webmcp-agent";
}

function compactData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  if (Object.prototype.hasOwnProperty.call(raw, "data")) return raw.data;
  const { ok, receipt, ui, announcement, message, ...data } = raw;
  return Object.keys(data).length ? data : { status: ok === false ? "rejected" : "completed" };
}

function upstreamReceipt(raw) {
  if (!raw || typeof raw !== "object") return {};
  return raw.receipt ?? raw.commandReceipt ?? {};
}

function compactJournalDurability(value) {
  if (!value) return null;
  const durable = Boolean(value.durable);
  return {
    durable,
    ...(!durable && value.mode ? { mode: value.mode } : {}),
    ...(!durable && value.status ? { status: value.status } : {}),
    ...(value.resultPersisted !== undefined ? { resultPersisted: Boolean(value.resultPersisted) } : {}),
    ...(value.reason ? { reason: String(value.reason).slice(0, 120) } : {}),
  };
}

function responseReceipt(spec, receipt) {
  const receiptJournal = compactJournalDurability(receipt.journalDurability);
  return {
    operationId: receipt.operationId,
    tool: receipt.tool,
    status: receipt.status,
    caseId: receipt.caseId,
    revisionBefore: receipt.revisionBefore,
    revisionAfter: receipt.revisionAfter,
    viewRevisionBefore: receipt.viewRevisionBefore,
    viewRevisionAfter: receipt.viewRevisionAfter,
    decisionHashBefore: receipt.decisionHashBefore,
    decisionHashAfter: receipt.decisionHashAfter,
    replayed: receipt.replayed,
    ...(receiptJournal && !receiptJournal.durable ? { journalDurability: receiptJournal } : {}),
  };
}

function responseState(spec, context) {
  const state = publicContext(context);
  return {
    phase: state.phase,
    caseId: state.caseId,
    decisionRevision: state.decisionRevision,
    viewRevision: state.viewRevision,
  };
}

function safeAnnouncement(raw, toolName) {
  if (typeof raw?.ui?.announcement === "string") return raw.ui.announcement;
  if (typeof raw?.announcement === "string") return raw.announcement;
  if (typeof raw?.message === "string") return raw.message;
  return `${toolName} completed.`;
}

function specSignature(spec) {
  return stableStringify({
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
  });
}

function defaultActor() {
  return { id: "webmcp-agent", type: "agent", label: "WebMCP agent" };
}

function gatewayOwnerId() {
  return globalThis.crypto?.randomUUID?.() ?? `gateway-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function journalMeta(invocation, receipt, options = {}) {
  const invocationDurability = compactJournalDurability(invocation);
  const receiptDurability = compactJournalDurability(receipt);
  return {
    durable: Boolean((!invocationDurability || invocationDurability.durable) && (!receiptDurability || receiptDurability.durable)),
    status: options.status ?? "completed",
    ...(invocationDurability ? { invocation: invocationDurability } : {}),
    ...(receiptDurability && !receiptDurability.durable ? { receipt: receiptDurability } : {}),
    ...(options.reason ? { reason: String(options.reason).slice(0, 240) } : {}),
  };
}

function withJournalMeta(response, journal) {
  return {
    ...cloneJson(response),
    meta: {
      ...(response?.meta ?? {}),
      journal,
    },
  };
}

function replayResponse(response) {
  const replay = cloneJson(response);
  if (replay?.receipt) replay.receipt.replayed = true;
  if (replay?.meta?.journal) replay.meta.journal.replayed = true;
  return replay;
}

function outcomeUncertainError(entry) {
  return new ToolError(
    "IDEMPOTENCY_OUTCOME_UNCERTAIN",
    "The journal shows that this mutation may have started, but no durable result was recorded. It was not repeated.",
    {
      retryable: false,
      recovery: {
        action: "Inspect the canonical case and recent receipts, then have a human reconcile the outcome before using a new idempotency key.",
      },
      safeDetails: {
        outcomeUncertain: true,
        journalStatus: entry?.status ?? "unknown",
        ...(entry?.executionStartedAt ? { executionStartedAt: entry.executionStartedAt } : {}),
        ...(entry?.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      },
    },
  );
}

export class WebMcpGateway {
  #started = false;

  #stopped = false;

  #unsubscribe = () => {};

  #registrations = new Map();

  #catalog = [];

  #catalogByName = new Map();

  #desiredNames = new Set();

  #context = null;

  #reconcileRequested = false;

  #reconcileScheduled = false;

  #reconcileChain = Promise.resolve();

  #idempotency = new Map();

  #registrationErrors = [];

  #ownerId = gatewayOwnerId();

  constructor({
    modelContext,
    ports,
    actor = defaultActor(),
    onStatus,
    onReceipt,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    receiptLedger,
    invocationStore,
  }) {
    this.modelContext = modelContext;
    this.ports = ports;
    this.actor = actor;
    this.onStatus = onStatus;
    this.onReceipt = onReceipt;
    this.outputLimit = Math.max(700, Math.min(4_000, outputLimit));
    this.receipts = receiptLedger ?? new ReceiptLedger();
    this.invocations = invocationStore ?? new MemoryInvocationStore();
  }

  get available() {
    return typeof this.modelContext?.registerTool === "function";
  }

  get activeTools() {
    return [...this.#desiredNames]
      .filter((name) => this.#registrations.has(name))
      .sort();
  }

  get context() {
    return this.#context ? publicContext(this.#context) : null;
  }

  async start() {
    if (this.#started && !this.#stopped) return this.snapshot();
    if (!this.available) {
      await this.#emitStatus({ available: false, toolCount: 0, activeTools: [], reason: "webmcp-unavailable" });
      return { available: false, toolCount: 0, activeTools: [], reason: "webmcp-unavailable", gateway: this };
    }
    const portValidation = validatePorts(this.ports);
    if (!portValidation.ok) {
      await this.#emitStatus({ available: false, toolCount: 0, activeTools: [], reason: "ports-invalid", error: portValidation.error });
      return {
        available: false,
        toolCount: 0,
        activeTools: [],
        reason: "ports-invalid",
        error: portValidation.error,
        missing: portValidation.missing,
        gateway: this,
      };
    }

    await this.invocations.initialize?.();
    await this.receipts.initialize?.();

    this.#started = true;
    this.#stopped = false;
    this.#unsubscribe = subscribeToPorts(this.ports, () => this.scheduleReconcile());
    await this.flush();
    return this.snapshot();
  }

  snapshot() {
    return {
      available: this.available && this.#started && !this.#stopped,
      toolCount: this.activeTools.length,
      activeTools: this.activeTools,
      phase: this.#context?.phase ?? null,
      registrationErrors: cloneJson(this.#registrationErrors),
      journalDurability: {
        invocation: this.invocations.getDurability?.() ?? null,
        receipt: this.receipts.getDurability?.() ?? null,
      },
      gateway: this,
    };
  }

  scheduleReconcile() {
    if (this.#stopped) return this.#reconcileChain;
    this.#reconcileRequested = true;
    if (this.#reconcileScheduled) return this.#reconcileChain;
    this.#reconcileScheduled = true;
    this.#reconcileChain = this.#reconcileChain
      .then(async () => {
        while (this.#reconcileRequested && !this.#stopped) {
          this.#reconcileRequested = false;
          await this.#reconcile();
        }
      })
      .finally(() => {
        this.#reconcileScheduled = false;
        if (this.#reconcileRequested && !this.#stopped) this.scheduleReconcile();
      });
    return this.#reconcileChain;
  }

  async flush() {
    await this.scheduleReconcile();
    if (this.#reconcileScheduled) await this.#reconcileChain;
    const deliveryReleases = [...this.#registrations.values()]
      .flatMap((record) => [...(record.deliveryReleases ?? [])]);
    if (deliveryReleases.length) {
      await Promise.allSettled(deliveryReleases);
      await this.scheduleReconcile();
      if (this.#reconcileScheduled) await this.#reconcileChain;
    }
    return this.snapshot();
  }

  async stop() {
    if (this.#stopped) return { stopped: true, pendingExecutions: 0 };
    this.#stopped = true;
    this.#unsubscribe();
    this.#unsubscribe = () => {};
    this.#desiredNames.clear();
    let pendingExecutions = 0;
    for (const record of this.#registrations.values()) {
      record.retiring = true;
      if (record.inFlight === 0) this.#retireRecord(record);
      else pendingExecutions += record.inFlight;
    }
    await this.#emitStatus({ available: false, toolCount: 0, activeTools: [], reason: "stopped" });
    return { stopped: true, pendingExecutions };
  }

  async #reconcile() {
    const context = await readCapabilityContext(this.ports);
    this.#context = context;
    this.#catalog = createToolCatalog({
      ports: this.ports,
      receipts: this.receipts,
      actor: this.actor,
      capabilities: context.presentationCapabilities,
      getCapabilitySummary: () => this.#capabilitySummary(),
    });
    this.#catalogByName = new Map(this.#catalog.map((spec) => [spec.name, spec]));
    const desiredSpecs = selectCapabilities(this.#catalog, context, this.ports);
    const desiredByName = new Map(desiredSpecs.map((spec) => [spec.name, spec]));
    this.#desiredNames = new Set(desiredByName.keys());

    for (const record of [...this.#registrations.values()]) {
      const desired = desiredByName.get(record.name);
      if (!desired) {
        record.retiring = true;
        record.replacement = null;
        if (record.inFlight === 0) this.#retireRecord(record);
        continue;
      }
      const nextSignature = specSignature(desired);
      if (record.signature !== nextSignature) {
        record.retiring = true;
        record.replacement = desired;
        if (record.inFlight === 0) {
          this.#retireRecord(record);
          await this.#register(desired);
        }
      } else {
        record.spec = desired;
        record.retiring = false;
        record.replacement = null;
      }
      desiredByName.delete(record.name);
    }

    for (const spec of desiredByName.values()) await this.#register(spec);

    await this.#emitStatus({
      available: true,
      toolCount: this.activeTools.length,
      activeTools: this.activeTools,
      phase: context.phase,
      registrationErrors: cloneJson(this.#registrationErrors),
      journalDurability: {
        invocation: this.invocations.getDurability?.() ?? null,
        receipt: this.receipts.getDurability?.() ?? null,
      },
    });
  }

  async #register(spec) {
    if (this.#stopped || this.#registrations.has(spec.name)) return;
    const controller = new AbortController();
    const record = {
      name: spec.name,
      spec,
      signature: specSignature(spec),
      controller,
      inFlight: 0,
      deliveryReleases: new Set(),
      retiring: false,
      replacement: null,
    };
    const definition = {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
      execute: async (input = {}, options = {}) => this.#executeRegistered(record, input ?? {}, options),
    };
    try {
      await this.modelContext.registerTool(definition, { signal: controller.signal });
      if (controller.signal.aborted || this.#stopped) {
        controller.abort();
        return;
      }
      this.#registrations.set(spec.name, record);
    } catch (error) {
      controller.abort();
      this.#registrationErrors.push({
        name: spec.name,
        code: error?.code ?? "REGISTRATION_FAILED",
        message: String(error?.message ?? "Tool registration failed.").slice(0, 240),
      });
      this.#registrationErrors = this.#registrationErrors.slice(-20);
    }
  }

  #retireRecord(record) {
    if (record.inFlight > 0) return false;
    record.controller.abort();
    this.#registrations.delete(record.name);
    return true;
  }

  async #executeRegistered(record, input, options) {
    record.inFlight += 1;
    let invocation = null;
    let executionSpec = record.spec;
    try {
      if (record.retiring || !this.#desiredNames.has(record.name)) {
        throw new ToolError(
          "CAPABILITY_NOT_ACTIVE",
          "This capability is no longer active in the current room state.",
          { recovery: { tool: "get_available_capabilities" } },
        );
      }
      const context = await readCapabilityContext(this.ports);
      const currentSpec = this.#catalogByName.get(record.name) ?? record.spec;
      executionSpec = currentSpec;
      const decision = evaluateCapability(currentSpec, context, this.ports);
      if (!decision.allowed) {
        const code = decision.reason === "room_frozen" ? "ROOM_FROZEN" : "CAPABILITY_NOT_ACTIVE";
        throw new ToolError(code, `This capability is unavailable because: ${decision.reason}.`, {
          recovery: { tool: "get_available_capabilities" },
        });
      }

      const validation = validateInput(currentSpec.inputSchema, input);
      if (!validation.ok) {
        throw new ToolError("VALIDATION_FAILED", summarizeValidationIssues(validation.issues), {
          safeDetails: { issues: validation.issues.slice(0, 3) },
        });
      }

      invocation = currentSpec.mutating
        ? await this.#claimIdempotentInvocation(currentSpec, input, options)
        : null;
      if (invocation?.replay) return invocation.response;

      await this.#enforceRevisions(input, context);
      if (currentSpec.mutating) await this.#markInvocationExecuting(invocation);
      const result = await this.#perform(currentSpec, input, options, context, invocation?.durability ?? null);
      if (!currentSpec.mutating) return result;
      return await this.#completeInvocation(invocation, result);
    } catch (error) {
      const failure = await this.#recordFailure(executionSpec, input, error, invocation?.durability ?? null);
      if (invocation?.claimed) return this.#completeInvocation(invocation, failure);
      return failure;
    } finally {
      // Chrome/Edge may still be serializing the fulfilled callback result when
      // this async function's finally block runs. Aborting a self-retiring tool
      // here makes the native bridge reject an already-completed mutation with
      // a generic UnknownError. Keep the registration alive through the next
      // task, then release/retire it. flush() explicitly awaits these releases.
      let release;
      release = new Promise((resolve) => {
        setTimeout(() => {
          record.inFlight -= 1;
          record.deliveryReleases.delete(release);
          if (record.retiring && record.inFlight === 0) {
            const replacement = record.replacement;
            this.#retireRecord(record);
            if (replacement && this.#desiredNames.has(replacement.name) && !this.#stopped) {
              void this.#register(replacement);
            }
          }
          if (!this.#stopped) this.scheduleReconcile();
          resolve();
        }, 0);
      });
      record.deliveryReleases.add(release);
    }
  }

  async #claimIdempotentInvocation(spec, input, options = {}) {
    const scope = input.caseId ?? input.jobId ?? this.#context?.activeCaseId ?? "workspace";
    const key = `${spec.name}:${scope}:${input.idempotencyKey}`;
    const fingerprint = canonicalHash(input);
    const local = this.#idempotency.get(key);
    if (local && local.fingerprint !== fingerprint) {
      throw new ToolError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used with different input.",
        { recovery: { action: "Use a new idempotency key for a different mutation." } },
      );
    }
    if (local) {
      return { key, fingerprint, replay: true, response: replayResponse(await local.promise) };
    }

    let claim;
    try {
      claim = await this.invocations.claim(key, fingerprint, {
        ownerId: this.#ownerId,
        at: new Date().toISOString(),
      });
    } catch (error) {
      throw new ToolError(
        "JOURNAL_UNAVAILABLE",
        "The mutation was not executed because its idempotency claim could not be persisted safely.",
        {
          retryable: true,
          recovery: { action: "Restore browser storage, then retry with the same idempotency key." },
          safeDetails: { stage: error?.stage ?? "claim" },
        },
      );
    }
    if (claim.status === "conflict") {
      throw new ToolError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used with different input.",
        { recovery: { action: "Use a new idempotency key for a different mutation." } },
      );
    }
    if (claim.status === "replay") {
      const response = replayResponse(claim.entry.response);
      this.#idempotency.set(key, { fingerprint, promise: Promise.resolve(cloneJson(claim.entry.response)) });
      this.#pruneIdempotency();
      return { key, fingerprint, replay: true, response };
    }
    if (claim.status === "uncertain") throw outcomeUncertainError(claim.entry);
    if (claim.status === "pending") {
      let waited;
      try {
        waited = await this.invocations.waitForResult(key, fingerprint, {
          signal: options?.signal,
          timeoutMs: 30_000,
        });
      } catch (error) {
        throw new ToolError("JOURNAL_UNAVAILABLE", "The pending mutation result could not be read safely.", {
          retryable: true,
          recovery: { action: "Retry with the same idempotency key after browser storage recovers." },
          safeDetails: { stage: error?.stage ?? "wait" },
        });
      }
      if (waited.status === "conflict") {
        throw new ToolError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different input.");
      }
      if (waited.status === "replay") {
        const response = replayResponse(waited.entry.response);
        this.#idempotency.set(key, { fingerprint, promise: Promise.resolve(cloneJson(waited.entry.response)) });
        this.#pruneIdempotency();
        return { key, fingerprint, replay: true, response };
      }
      if (waited.status === "uncertain") throw outcomeUncertainError(waited.entry);
      if (["missing", "reclaimable"].includes(waited.status)) {
        return this.#claimIdempotentInvocation(spec, input, options);
      }
      if (waited.status === "canceled") {
        throw new ToolError("EXECUTION_CANCELED", "Waiting for the in-flight idempotent mutation was canceled.", { retryable: true });
      }
      throw new ToolError(
        "IDEMPOTENCY_PENDING",
        "A mutation with this idempotency key is still in progress or has an unresolved durable outcome.",
        {
          retryable: true,
          recovery: { action: "Retry the same input and key later; do not use a new key." },
        },
      );
    }
    if (claim.status !== "claimed") {
      throw new ToolError("JOURNAL_UNAVAILABLE", "The invocation journal returned an unsafe claim state.");
    }
    let resolveLocal;
    const promise = new Promise((resolve) => { resolveLocal = resolve; });
    this.#idempotency.set(key, { fingerprint, promise });
    this.#pruneIdempotency();
    return {
      key,
      fingerprint,
      claimed: true,
      durability: claim.durability ?? this.invocations.getDurability?.() ?? null,
      resolveLocal,
    };
  }

  async #markInvocationExecuting(invocation) {
    if (!invocation?.claimed) return;
    let marked;
    try {
      marked = await this.invocations.markExecuting(
        invocation.key,
        invocation.fingerprint,
        this.#ownerId,
        { at: new Date().toISOString() },
      );
    } catch (error) {
      throw new ToolError(
        "JOURNAL_UNAVAILABLE",
        "The mutation was not executed because its durable execution boundary could not be recorded safely.",
        {
          retryable: true,
          recovery: { action: "Restore browser storage, then retry with the same idempotency key." },
          safeDetails: { stage: error?.stage ?? "mark-executing" },
        },
      );
    }
    if (marked.status === "executing") {
      invocation.durability = marked.durability ?? invocation.durability;
      return;
    }
    if (marked.status === "conflict") {
      throw new ToolError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency key was already used with different input.",
        { recovery: { action: "Use a new idempotency key for a different mutation." } },
      );
    }
    if (marked.status === "uncertain") throw outcomeUncertainError(marked.entry);
    throw new ToolError(
      "IDEMPOTENCY_PENDING",
      "The pre-execution claim is no longer owned by this invocation, so the mutation was not executed.",
      {
        retryable: true,
        recovery: { action: "Retry the same input and idempotency key after the current owner settles." },
        safeDetails: { journalStatus: marked.status },
      },
    );
  }

  async #completeInvocation(invocation, response) {
    const receiptDurability =
      response?.meta?.journal?.receipt ??
      response?.receipt?.journalDurability ??
      this.receipts.getDurability?.() ??
      null;
    const optimisticInvocation = {
      ...(invocation.durability ?? {}),
      resultPersisted: Boolean(invocation.durability?.durable),
      status: invocation.durability?.durable ? "durable" : "session-only",
    };
    let finalResponse = withJournalMeta(
      response,
      journalMeta(optimisticInvocation, receiptDurability, {
        status: optimisticInvocation.status,
      }),
    );
    try {
      const completed = await this.invocations.complete(
        invocation.key,
        invocation.fingerprint,
        this.#ownerId,
        finalResponse,
        { at: new Date().toISOString() },
      );
      if (!["completed", "replay"].includes(completed.status)) {
        throw new Error("The invocation result was not accepted by the journal owner claim.");
      }
      if (completed.status === "replay" && completed.entry?.response) {
        finalResponse = replayResponse(completed.entry.response);
      }
    } catch (error) {
      const sessionInvocation = {
        ...(invocation.durability ?? {}),
        durable: false,
        resultPersisted: false,
        status: "session-only",
        reason: "The mutation ran, but its replay result could not be durably persisted.",
      };
      finalResponse = withJournalMeta(
        response,
        journalMeta(sessionInvocation, receiptDurability, {
          status: "session-only",
          reason: String(error?.message ?? error),
        }),
      );
    }
    invocation.resolveLocal?.(cloneJson(finalResponse));
    return finalResponse;
  }

  #pruneIdempotency() {
    while (this.#idempotency.size > 200) {
      const firstKey = this.#idempotency.keys().next().value;
      this.#idempotency.delete(firstKey);
    }
  }

  async #enforceRevisions(input, context) {
    let scopedImport = null;
    const mismatchedActiveCase = Boolean(
      input.caseId &&
      context.activeCaseId &&
      input.caseId !== context.activeCaseId &&
      context.phase !== "empty" &&
      context.phase !== "intake"
    );
    if (mismatchedActiveCase && context.phase === "import_review" && input.jobId && this.ports.imports) {
      scopedImport = await this.ports.imports.getImport(input.jobId);
    }
    if (
      mismatchedActiveCase &&
      (!scopedImport || scopedImport.caseId !== input.caseId)
    ) {
      throw new ToolError("NOT_FOUND", "The requested case is not the active case.", {
        recovery: { tool: "get_workspace_state" },
      });
    }
    if (
      input.expectedDecisionRevision !== undefined &&
      input.expectedDecisionRevision !== context.decisionRevision
    ) {
      throw new ToolError("STALE_REVISION", "The canonical decision changed before this tool could run.", {
        retryable: true,
        recovery: { tool: "get_workspace_state" },
        safeDetails: { currentDecisionRevision: context.decisionRevision },
      });
    }
    if (input.expectedViewRevision !== undefined && input.expectedViewRevision !== context.viewRevision) {
      throw new ToolError("STALE_VIEW_REVISION", "The presentation changed before this tool could run.", {
        retryable: true,
        recovery: { tool: "explain_view" },
        safeDetails: { currentViewRevision: context.viewRevision },
      });
    }
    if (input.expectedImportVersion !== undefined && input.jobId && this.ports.imports) {
      const job = scopedImport ?? await this.ports.imports.getImport(input.jobId);
      const version = job?.version ?? job?.importVersion ?? job?.data?.version;
      if (version !== input.expectedImportVersion) {
        throw new ToolError("STALE_REVISION", "The import job changed before this tool could run.", {
          retryable: true,
          recovery: { tool: "get_import_status" },
          safeDetails: { currentImportVersion: version },
        });
      }
    }
  }

  async #perform(spec, input, options, contextBefore, invocationDurability = null) {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new ToolError("EXECUTION_CANCELED", "The tool execution was canceled.", { retryable: true });
    }
    const raw = await spec.execute(input, {
      actor: this.actor,
      signal,
      context: contextBefore,
    });
    if (raw?.ok === false) {
      const error = raw.error;
      throw new ToolError(
        error?.code ?? raw.code ?? "VALIDATION_FAILED",
        error?.message ?? raw.message ?? "The operation was rejected.",
        { retryable: Boolean(error?.retryable ?? raw.retryable), recovery: error?.recovery ?? raw.recovery },
      );
    }
    if (spec.mutating) await waitForVisibleSettle(this.ports, signal);
    const contextAfter = await readCapabilityContext(this.ports);
    const sourceReceipt = upstreamReceipt(raw);
    const receipt = await this.#appendReceipt(this.receipts.create({
      status: "completed",
      tool: spec.name,
      actor: actorLabel(this.actor),
      caseId: input.caseId ?? contextAfter.activeCaseId,
      revisionBefore: sourceReceipt.revisionBefore ?? contextBefore.decisionRevision,
      revisionAfter: sourceReceipt.revisionAfter ?? contextAfter.decisionRevision,
      viewRevisionBefore: sourceReceipt.viewRevisionBefore ?? contextBefore.viewRevision,
      viewRevisionAfter: sourceReceipt.viewRevisionAfter ?? contextAfter.viewRevision,
      decisionHashBefore: sourceReceipt.decisionHashBefore ?? contextBefore.decisionHash,
      decisionHashAfter: sourceReceipt.decisionHashAfter ?? contextAfter.decisionHash,
      changedEntityIds: sourceReceipt.changedEntityIds ?? raw?.changedEntityIds,
      auditEventId: sourceReceipt.auditEventId,
      idempotencyKey: input.idempotencyKey,
    }));
    await this.#emitReceipt(receipt);
    if (spec.mutating) await waitForVisibleSettle(this.ports, signal);
    return successEnvelope({
      data: compactData(raw),
      receipt: responseReceipt(spec, receipt),
      ...(spec.mutating || raw?.ui?.announcement || raw?.announcement || raw?.message
        ? {
            ui: {
              settled: true,
              announcement: safeAnnouncement(raw, spec.name),
            },
          }
        : {}),
      state: responseState(spec, contextAfter),
      meta: {
        journal: journalMeta(
          invocationDurability
            ? {
                ...invocationDurability,
                resultPersisted: Boolean(invocationDurability.durable),
                status: invocationDurability.durable ? "durable" : "session-only",
              }
            : null,
          receipt.journalDurability ?? this.receipts.getDurability?.() ?? null,
          { status: invocationDurability?.durable === false ? "session-only" : "completed" },
        ),
      },
      outputLimit: this.outputLimit,
    });
  }

  async #recordFailure(spec, input, error, invocationDurability = null) {
    const normalized = normalizeToolError(error);
    let context;
    try {
      context = await readCapabilityContext(this.ports);
    } catch {
      context = this.#context;
    }
    const receipt = await this.#appendReceipt(this.receipts.create({
      status: "rejected",
      errorCode: normalized.code,
      tool: spec.name,
      actor: actorLabel(this.actor),
      caseId: input?.caseId ?? context?.activeCaseId,
      revisionBefore: context?.decisionRevision,
      revisionAfter: context?.decisionRevision,
      viewRevisionBefore: context?.viewRevision,
      viewRevisionAfter: context?.viewRevision,
      decisionHashBefore: context?.decisionHash,
      decisionHashAfter: context?.decisionHash,
      idempotencyKey: input?.idempotencyKey,
    }));
    await this.#emitReceipt(receipt);
    return errorEnvelope(normalized, {
      state: context ? publicContext(context) : undefined,
      receipt,
      meta: {
        journal: journalMeta(
          invocationDurability
            ? {
                ...invocationDurability,
                resultPersisted: Boolean(invocationDurability.durable),
                status: invocationDurability.durable ? "durable" : "session-only",
              }
            : null,
          receipt.journalDurability ?? this.receipts.getDurability?.() ?? null,
          { status: invocationDurability?.durable === false ? "session-only" : "completed" },
        ),
      },
      outputLimit: this.outputLimit,
    });
  }

  async #appendReceipt(receipt) {
    try {
      return await this.receipts.append(receipt);
    } catch (error) {
      return {
        ...receipt,
        journalDurability: {
          ...(this.receipts.getDurability?.() ?? {}),
          durable: false,
          status: "session-only",
          reason: `Receipt persistence failed: ${String(error?.message ?? error).slice(0, 180)}`,
        },
      };
    }
  }

  #capabilitySummary() {
    const activeTools = this.activeTools;
    const context = this.#context;
    if (!context) return { activeTools, phase: null };
    const byLens = {};
    if (["analysis", "frozen"].includes(context.phase)) {
      for (const lens of ["investigate", "compare", "simulate", "brief"]) {
        const lensContext = {
          ...context,
          presentation: { ...(context.presentation ?? {}), lens },
        };
        byLens[lens] = selectCapabilities(this.#catalog, lensContext, this.ports)
          .filter((spec) => !["kernel"].includes(spec.family))
          .map((spec) => spec.name)
          .slice(0, 10);
      }
    }
    return {
      phase: context.phase,
      lens: context.presentation?.lens ?? null,
      activeTools,
      toolCount: activeTools.length,
      byLens,
      otherWorkflowFamilies: ["intake", "model", "collaboration", "output"],
      manualParity: true,
      humanOnly: ["approve decision", "reject candidate", "underwrite policy", "adjudicate claim", "submit external action"],
    };
  }

  async #emitStatus(status) {
    if (typeof this.onStatus !== "function") return;
    try {
      await this.onStatus(status);
    } catch {
      // A status renderer must never break registration or execution.
    }
  }

  async #emitReceipt(receipt) {
    if (typeof this.onReceipt !== "function") return;
    try {
      await this.onReceipt(cloneJson(receipt));
    } catch {
      // The internal ledger remains authoritative if a transient renderer fails.
    }
  }
}

export function createWebMcpGateway(options) {
  return new WebMcpGateway(options);
}
