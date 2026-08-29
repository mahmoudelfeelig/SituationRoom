import { canonicalHash } from "./canonicalize.js";
import { applyDecisionCommand, assertCommandAuthorized } from "./commands.js";
import { ERROR_CODES, SituationRoomError } from "./errors.js";
import { evaluateScenario, evaluateWithDomainPack } from "./evaluate.js";
import { createDecisionCase, getDecisionHash, withCaseRevision } from "./model.js";
import { queryDecisionGraph } from "./query.js";
import { assertValidDecisionCase } from "./validation.js";
import { createDefaultDomainRegistry } from "../domain-packs/index.js";
import { MemoryRepository } from "../persistence/memoryRepository.js";
import { COMMIT_STATUSES, assertRepository } from "../persistence/repository.js";

function defaultId() {
  return globalThis.crypto?.randomUUID?.() ?? `sr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function requireIdempotencyKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      "A non-empty idempotency key of at most 200 characters is required.",
    );
  }
  return value;
}

function diagnosticsFromPack(pack, decisionCase) {
  return pack.validateCase?.(decisionCase) ?? [];
}

function assertPackValid(pack, decisionCase) {
  const diagnostics = diagnosticsFromPack(pack, decisionCase);
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      `Domain policy validation failed with ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
      { diagnostics },
    );
  }
  return diagnostics;
}

export class DecisionRuntime {
  #repository;
  #registry;
  #listeners = new Set();
  #activeCaseId = null;
  #now;
  #id;
  #initialized = false;
  #broadcast = null;

  constructor(options = {}) {
    this.#repository = assertRepository(options.repository ?? new MemoryRepository());
    this.#registry = options.domainRegistry ?? createDefaultDomainRegistry();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.idGenerator ?? defaultId;
    if (options.broadcastChannelName && typeof BroadcastChannel === "function") {
      this.#broadcast = new BroadcastChannel(options.broadcastChannelName);
      this.#broadcast.onmessage = (event) => this.#emit({ ...event.data, remote: true }, false);
    }
  }

  async initialize(options = {}) {
    if (this.#initialized) return this;
    await this.#repository.initialize();
    for (const seed of options.seedCases ?? []) {
      const decisionCase = createDecisionCase(seed);
      assertValidDecisionCase(decisionCase);
      const pack = this.#registry.get(decisionCase.domain.packId);
      assertPackValid(pack, decisionCase);
      await this.#repository.putCase(decisionCase, { createOnly: true });
    }
    const cases = await this.#repository.listCases();
    this.#activeCaseId = options.activeCaseId ?? cases[0]?.id ?? null;
    this.#initialized = true;
    return this;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event, broadcast = true) {
    this.#listeners.forEach((listener) => listener(event));
    if (broadcast) this.#broadcast?.postMessage(event);
  }

  async getWorkspaceState() {
    const cases = await this.#repository.listCases();
    const imports = await this.#repository.listImports();
    return {
      activeCaseId: this.#activeCaseId,
      cases: cases.map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.subtitle,
        domainPackId: entry.domain.packId,
        revision: entry.revision,
        status: entry.status,
        updatedAt: entry.updatedAt,
        decisionHash: getDecisionHash(entry),
      })),
      imports: imports.map((entry) => ({
        id: entry.id,
        caseId: entry.caseId,
        phase: entry.phase,
        progress: entry.progress,
      })),
      domainPacks: this.#registry.list(),
    };
  }

  async setActiveCase(caseId) {
    const decisionCase = await this.#repository.getCase(caseId);
    if (!decisionCase) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Case '${caseId}' was not found.`);
    this.#activeCaseId = caseId;
    this.#emit({ type: "workspace.changed", activeCaseId: caseId });
    this.#emit({ type: "capability-context.changed", caseId, domainPackId: decisionCase.domain.packId });
    return decisionCase;
  }

  async getCase(caseId = this.#activeCaseId) {
    if (!caseId) return null;
    return this.#repository.getCase(caseId);
  }

  async #requireCase(caseId = this.#activeCaseId) {
    const decisionCase = await this.getCase(caseId);
    if (!decisionCase) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Case '${caseId ?? ""}' was not found.`);
    return decisionCase;
  }

  async getActiveContract(caseId = this.#activeCaseId) {
    return (await this.#requireCase(caseId)).contract;
  }

  async evaluate(caseId = this.#activeCaseId) {
    const decisionCase = await this.#requireCase(caseId);
    const pack = this.#registry.get(decisionCase.domain.packId);
    return evaluateWithDomainPack(decisionCase, pack);
  }

  async evaluateScenario(caseId, scenarioId) {
    const decisionCase = await this.#requireCase(caseId);
    const pack = this.#registry.get(decisionCase.domain.packId);
    const result = evaluateScenario(decisionCase, scenarioId, pack);
    if (!result) throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Scenario '${scenarioId}' was not found.`);
    return result;
  }

  async queryGraph(query = {}) {
    const decisionCase = await this.#requireCase(query.caseId ?? this.#activeCaseId);
    const pack = this.#registry.get(decisionCase.domain.packId);
    return queryDecisionGraph(decisionCase, evaluateWithDomainPack(decisionCase, pack), query);
  }

  async createCase(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(options.idempotencyKey);
    const actor = options.actor ?? { type: "human", id: "local-user" };
    if (!actor || !["human", "agent", "system"].includes(actor.type) || typeof actor.id !== "string") {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "A typed command actor is required.");
    }
    const commandFingerprint = canonicalHash({ type: "create_case", input, actor });
    const baseCase = createDecisionCase(input);
    const at = this.#now();
    const event = {
      id: this.#id(),
      caseId: baseCase.id,
      revision: baseCase.revision,
      at,
      actor,
      action: "Created decision case",
      commandType: "create_case",
    };
    const decisionCase = createDecisionCase({ ...baseCase, audit: [...baseCase.audit, event] });
    assertValidDecisionCase(decisionCase);
    const pack = this.#registry.get(decisionCase.domain.packId);
    assertPackValid(pack, decisionCase);
    const decisionHashAfter = getDecisionHash(decisionCase);
    const receipt = {
      id: this.#id(),
      commandId: this.#id(),
      commandType: "create_case",
      caseId: decisionCase.id,
      actor,
      at,
      revisionBefore: null,
      revisionAfter: decisionCase.revision,
      decisionHashBefore: null,
      decisionHashAfter,
      changedEntityIds: [decisionCase.id],
      auditEventId: event.id,
    };
    const result = await this.#repository.commitCreateCase({
      decisionCase,
      idempotencyKey,
      commandFingerprint,
      receipt,
      event,
    });
    if (result.status === COMMIT_STATUSES.REPLAYED) return { ok: true, replayed: true, receipt: result.receipt };
    if (result.status === COMMIT_STATUSES.CONFLICT) {
      throw new SituationRoomError(ERROR_CODES.IDEMPOTENCY_CONFLICT, "Idempotency key was reused for a different command.");
    }
    if (result.status === COMMIT_STATUSES.ALREADY_EXISTS) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, `Case '${decisionCase.id}' already exists.`);
    }
    this.#activeCaseId ??= decisionCase.id;
    this.#emit({ type: "case.changed", caseId: decisionCase.id, revision: decisionCase.revision, receipt });
    return { ok: true, replayed: false, receipt };
  }

  async executeCommand(command, options = {}) {
    const caseId = options.caseId ?? this.#activeCaseId;
    const expectedRevision = options.expectedRevision;
    const idempotencyKey = requireIdempotencyKey(options.idempotencyKey);
    const actor = options.actor ?? { type: "agent", id: "site-agent" };
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "expectedRevision must be a positive integer.");
    }
    const commandFingerprint = canonicalHash({ caseId, command });
    const priorReceipt = await this.#repository.getCommandReceipt(caseId, idempotencyKey);
    if (priorReceipt) {
      if (priorReceipt.commandFingerprint !== commandFingerprint) {
        throw new SituationRoomError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "Idempotency key was reused for a different command.",
        );
      }
      return { ok: true, replayed: true, receipt: priorReceipt };
    }
    const current = await this.#requireCase(caseId);
    if (current.revision !== expectedRevision) {
      throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The decision changed before this command could commit.", {
        expectedRevision,
        currentRevision: current.revision,
      });
    }
    const pack = this.#registry.get(current.domain.packId);
    assertCommandAuthorized(current, command, actor, pack);
    const at = this.#now();
    const decisionHashBefore = getDecisionHash(current);
    const { next: draft, changedEntityIds } = applyDecisionCommand(current, command, {
      actor,
      at,
      decisionHashBefore,
      domainPack: pack,
    });
    const event = {
      id: this.#id(),
      caseId,
      revision: current.revision + 1,
      at,
      actor,
      action: command.type.replaceAll("_", " "),
      commandType: command.type,
      changedEntityIds,
    };
    const nextCase = withCaseRevision(current, draft, event);
    assertValidDecisionCase(nextCase);
    assertPackValid(pack, nextCase);
    const decisionHashAfter = getDecisionHash(nextCase);
    const receipt = {
      id: this.#id(),
      commandId: this.#id(),
      commandType: command.type,
      caseId,
      actor,
      at,
      revisionBefore: current.revision,
      revisionAfter: nextCase.revision,
      decisionHashBefore,
      decisionHashAfter,
      changedEntityIds,
      auditEventId: event.id,
    };
    const result = await this.#repository.commitCaseCommand({
      caseId,
      expectedRevision,
      idempotencyKey,
      commandFingerprint,
      nextCase,
      receipt,
      event,
    });
    if (result.status === COMMIT_STATUSES.REPLAYED) return { ok: true, replayed: true, receipt: result.receipt };
    if (result.status === COMMIT_STATUSES.CONFLICT) {
      throw new SituationRoomError(ERROR_CODES.IDEMPOTENCY_CONFLICT, "Idempotency key was reused for a different command.");
    }
    if (result.status === COMMIT_STATUSES.STALE) {
      throw new SituationRoomError(ERROR_CODES.STALE_REVISION, "The decision changed before this command could commit.", {
        expectedRevision,
        currentRevision: result.currentRevision,
      });
    }
    if (result.status === COMMIT_STATUSES.NOT_FOUND) {
      throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Case '${caseId}' was not found.`);
    }
    const changeEvent = { type: "decision.changed", caseId, revision: nextCase.revision, receipt };
    this.#emit(changeEvent);
    this.#emit({ type: "case.changed", caseId, revision: nextCase.revision, receipt });
    this.#emit({ type: "capability-context.changed", caseId, domainPackId: nextCase.domain.packId });
    return { ok: true, replayed: false, receipt };
  }

  async listEvents(caseId = this.#activeCaseId) {
    return this.#repository.listEvents(caseId);
  }

  close() {
    this.#broadcast?.close();
    this.#broadcast = null;
  }
}
