import test from "node:test";
import assert from "node:assert/strict";

import { DecisionRuntime, ERROR_CODES } from "../../src/kernel/index.js";
import { createGenericFixture } from "../../src/domain-packs/index.js";
import { IndexedDbRepository, MemoryRepository } from "../../src/persistence/index.js";

test("memory repository isolates stored state from caller mutation", async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  const fixture = createGenericFixture();
  await repository.putCase(fixture, { createOnly: true });
  const first = await repository.getCase(fixture.id);
  first.title = "Mutated outside storage";
  assert.equal((await repository.getCase(fixture.id)).title, fixture.title);
});

test("atomic repository commit lets only one concurrent revision writer win", async () => {
  const repository = new MemoryRepository();
  const first = new DecisionRuntime({ repository });
  const second = new DecisionRuntime({ repository });
  await first.initialize({ seedCases: [createGenericFixture()] });
  await second.initialize();
  const current = await first.getCase("generic-demo");
  const actor = { type: "agent", id: "parallel-test" };
  const results = await Promise.allSettled([
    first.executeCommand(
      { type: "create_scenario", payload: { scenario: { id: "scenario:first", label: "First" } } },
      { caseId: current.id, expectedRevision: current.revision, idempotencyKey: "parallel-first", actor },
    ),
    second.executeCommand(
      { type: "create_scenario", payload: { scenario: { id: "scenario:second", label: "Second" } } },
      { caseId: current.id, expectedRevision: current.revision, idempotencyKey: "parallel-second", actor },
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, ERROR_CODES.STALE_REVISION);
  assert.equal((await repository.getCase(current.id)).revision, current.revision + 1);
});

test("shared governance compare-and-swap serializes freeze and human checkpoints", async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  const caseId = "governance-case";
  const first = {
    id: caseId,
    version: 1,
    manualFrozen: true,
    humanCheckpoints: [],
  };
  const second = {
    id: caseId,
    version: 1,
    manualFrozen: false,
    humanCheckpoints: [{ id: "checkpoint:1", status: "awaiting-human", body: "Resolve cited evidence." }],
  };
  const results = await Promise.all([
    repository.commitGovernanceMutation({ caseId, expectedVersion: 0, nextGovernance: first }),
    repository.commitGovernanceMutation({ caseId, expectedVersion: 0, nextGovernance: second }),
  ]);
  assert.equal(results.filter((entry) => entry.status === "committed").length, 1);
  assert.equal(results.filter((entry) => entry.status === "stale").length, 1);
  const current = await repository.getGovernance(caseId);
  assert.equal(current.version, 1);
  assert.equal(current.manualFrozen || current.humanCheckpoints.length === 1, true);
});

test("IndexedDB adapter fails with a typed recoverable error when the browser API is absent", async () => {
  const repository = new IndexedDbRepository({ indexedDB: {} });
  await assert.rejects(repository.initialize(), (error) => {
    assert.equal(error.code, ERROR_CODES.STORAGE_FAILURE);
    assert.equal(error.details.recoverable, true);
    return true;
  });
});
