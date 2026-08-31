import assert from "node:assert/strict";
import test from "node:test";

import { createGenericFixture } from "../src/domain-packs/index.js";
import { ImportCoordinator } from "../src/import/index.js";
import { MemoryRepository } from "../src/persistence/index.js";
import { createImportWebMcpAdapter } from "../src/workspace/webMcpAdapters.js";

test("WebMCP semantic suggestions stay version-bound, source-scoped, and durable through review", async () => {
  const repository = new MemoryRepository();
  const coordinator = new ImportCoordinator({ repository });
  await coordinator.initialize();
  const started = await coordinator.startImport([{
    name: "options.csv",
    type: "text/csv",
    text: "Vendor,Cost\nNorthwind,900",
  }], { caseId: "generic-demo", domainHint: "generic" });
  const reviewed = await coordinator.waitForImport(started.id);
  assert.equal(reviewed.phase, "review_required");
  const document = await coordinator.inspectDocument(reviewed.documentIds[0]);
  const costCell = document.blocks.find((block) => block.locator?.range === "B2");

  const adapter = createImportWebMcpAdapter({
    importCoordinator: coordinator,
    getCase: async (caseId) => caseId === "generic-demo" ? createGenericFixture() : null,
  });
  const suggestion = {
    id: "semantic-cost-1",
    kind: "field-mapping",
    sourceField: "Cost",
    targetCriterion: "Operating cost",
    confidence: 0.93,
    sourceRefs: [{ documentId: document.id, fragmentId: costCell.id }],
  };
  const staged = await adapter.proposeSemanticMapping(reviewed.id, [suggestion], {
    expectedImportVersion: reviewed.version,
  });
  assert.equal(staged.awaitingHuman, true);
  assert.equal(staged.importVersion, reviewed.version + 1);
  const persisted = await coordinator.getImport(reviewed.id);
  assert.deepEqual(persisted.semanticAgentSuggestions, [suggestion]);
  assert.match(persisted.semanticSuggestionHash, /^sha256:[a-f0-9]{64}$/);

  await assert.rejects(
    adapter.proposeSemanticMapping(reviewed.id, [suggestion], { expectedImportVersion: reviewed.version }),
    (error) => error.code === "STALE_REVISION",
  );
  await assert.rejects(
    adapter.proposeSemanticMapping(reviewed.id, [{
      ...suggestion,
      id: "semantic-out-of-scope",
      sourceRefs: [{ documentId: document.id, fragmentId: "fragment-outside-job" }],
    }], { expectedImportVersion: persisted.version }),
    (error) => error.code === "NOT_FOUND",
  );
  adapter.close();
});
