# SituationRoom WebMCP gateway

SituationRoom treats WebMCP as a progressive, state-aware control surface over trusted application commands. WebMCP does not own the decision graph, document parser, renderer, formulas, permissions, human pins, or approval state.

## Integration contract

The application bootstrap creates adapters over the real kernel, import coordinator, presentation store, and output handlers, then injects those ports explicitly:

```js
import {
  IndexedDbInvocationStore,
  IndexedDbReceiptLedger,
  registerSituationRoomTools,
} from "../src/webmcp.js";
import { createWebMcpPorts } from "../src/workspace/webMcpAdapters.js";

const ports = createWebMcpPorts({
  runtime,
  importCoordinator,
  presentation,
  permissions,
  getWorkspaceContext,
  resolveStagedSource,
  reserveImportCaseId,
  outputHandlers,
});

const registration = await registerSituationRoomTools({
  ports,
  actor: { id: "browser-agent", type: "agent", label: "Browser agent" },
  onStatus: setWebMcpStatus,
  onReceipt: appendVisibleToolReceipt,
  onActivity: recordPrivacyBoundedAgentActivity,
  invocationStore: new IndexedDbInvocationStore(),
  receiptLedger: new IndexedDbReceiptLedger(),
});

// During application teardown:
ports.imports?.close?.();
await registration.gateway?.stop();
```

Calling `registerSituationRoomTools()` without ports is intentionally safe. It returns:

```js
{
  available: false,
  toolCount: 0,
  activeTools: [],
  reason: "ports-required",
  gateway: null
}
```

`src/main.jsx` performs this integration after the workspace initializes and mirrors status, receipts, review artifacts, and prepared outputs into visible manual surfaces. The gateway itself never imports a concrete store singleton.

### Required runtime port

```ts
interface RuntimePort {
  getWorkspaceState(): WorkspaceState | Promise<WorkspaceState>;
  getActiveContract(caseId: string): DecisionContract | null | Promise<DecisionContract | null>;
  queryGraph(query: GraphQuery): unknown | Promise<unknown>;
  evaluate(caseId: string, options: EvaluationOptions): unknown | Promise<unknown>;
  executeCommand(
    command: { type: string; caseId: string; payload: unknown },
    options: {
      expectedRevision: number;
      idempotencyKey: string;
      actor: Actor;
      signal?: AbortSignal;
    },
  ): CommandResult | Promise<CommandResult>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  getRecentChanges?(caseId: string, page: PageRequest): unknown | Promise<unknown>;
}
```

`getWorkspaceState()` must expose explicit permissions. Missing permissions are treated as no permission, not as implicit administrator access.

```js
{
  phase: "analysis",
  activeCaseId: "case-123",
  domainId: "health-plan",
  domainRisk: "regulated",
  role: "decision-owner",
  permissions: ["*"],
  decisionRevision: 8,
  decisionHash: "sr-...",
  frozen: false,
  pendingHumanCheckpoint: false,
  governanceVersion: 3,
  sharedAuthorityAvailable: true,
  governedAgentMutationsBlocked: false
}
```

Recognized capability phases are:

| Phase | Purpose |
|---|---|
| `empty` | No active case; staged-source import is available |
| `intake` | Import surface is intentionally open |
| `importing` | An asynchronous import pipeline is running |
| `import_review` | Mapping, source inspection, or human review is required |
| `contract_draft` | A draft decision contract and graph can be proposed |
| `analysis` | Deterministic analysis and compiled-room capabilities are available |
| `collaboration` | Agent-authored comments, branches, and review requests are available |
| `output` | Preview and local export preparation are available |
| `frozen` | Read-only analysis remains available; mutations disappear |

### Optional import port

The import port follows the coordinator API:

```ts
interface ImportPort {
  startImport(inputs, options): Promise<ImportJob>;
  listImports(caseId, page?): ImportJob[] | Promise<ImportJob[]>;
  getImport(jobId): ImportJob | Promise<ImportJob>;
  cancelImport(jobId, options?): Promise<ImportJob>;
  inspectDocument(documentId, options: { caseId: string; jobId?: string; includeRegions?: boolean; cursor?: string; limit?: number }): Promise<unknown>;
  searchFragments(query: { caseId: string; jobId?: string; query: string; documentIds?: string[]; cursor?: string; limit?: number }): Promise<unknown>;
  mapTableSchema(documentId, mapping, options?): Promise<unknown>;
  proposeSemanticMapping(jobId, suggestions, options?): Promise<unknown>;
  retryImport(jobId, options?): Promise<ImportJob>;
  readSourceSpans?(documentId, anchors, options: { caseId: string; jobId?: string }): Promise<unknown>;
  requestHumanReview?(request): Promise<unknown>;
  subscribe?(listener): () => void;
}
```

`start_import` has no URL field and performs no agent-initiated network retrieval. It accepts opaque staged-source IDs that a person created through drag-and-drop or the file chooser, plus bounded inline text only when an existing case already supplies authoritative policy. A WebMCP JSON tool cannot select local files, transfer a browser `File`, or accept arbitrary filesystem paths.

For a new case, every input must be a staged source, all staged sources must carry the same human-confirmed policy-domain reservation, and `domainHint` must match that reservation exactly. For an existing case, every staged source reservation must match the canonical case domain; conflicting hints are denied before source bytes enter the import pipeline.

`inspect_document`, `search_sources`, and `read_source_spans` always require `caseId`. During `import_review`, they also require the owning `jobId`; cross-case and cross-job references return `NOT_FOUND`. In `contract_draft` and eligible `analysis` contexts, `jobId` is rejected and reads come only from canonical sanitized case documents. After verified cleanup, accepted-import source bytes and transient parsed documents are purged while canonical sanitized copies and anchors remain readable; a deletion failure stays visibly cleanup-pending and retries deletion only.

Candidate-review and health-plan projections apply after scope enforcement and before `inspect_document`, `search_sources`, and `read_source_spans` return. Candidate projection redacts protected tabular columns, correlated row values, structured metadata, unsafe diagnostics, and unblinded narrative material. Search totals and pagination are recomputed after projection so protected-value queries do not become a presence oracle. Health-plan projection removes personal, demographic, and clinical fields and withholds unstructured personal clinical material until a person supplies a plan-term-only extract.

`propose_semantic_mapping` is available only for the owning review-required job. Each bounded suggestion must cite exact supporting document and fragment IDs already authorized for that job and carry the current import version plus an idempotency key. The coordinator stores the suggestions and their hash as a new import revision. The deterministic semantic proposal revalidates them into a separate agent-proposal collection; they cannot override evidence mappings, resolve conflicts, accept the import, or remain active while an approval or shared human-resolution authority checkpoint is open.

### Optional presentation port

```ts
interface PresentationPort {
  getPresentationSnapshot(): PresentationSnapshot | Promise<PresentationSnapshot>;
  applyPresentationRecipe(recipe: RecipeV1, actor: Actor): Promise<ApplyRecipeResult>;
  focusEntity(entityRef: EntityRef, pathId?: string): Promise<unknown>;
  saveView(options?): Promise<unknown>;
  restoreViewRevision(revision: number): Promise<unknown>;
  requestHumanCheckpoint?(request): Promise<unknown>;
  waitForSettled?(options: { signal?: AbortSignal }): Promise<void>;
  subscribe?(listener): () => void;
}
```

The presentation snapshot should expose the trusted registry used to construct the live composition schema:

```js
{
  lens: "investigate",
  viewRevision: 4,
  viewHash: "view-...",
  capabilities: {
    instrumentTypes: ["causal-trace", "evidence-excerpt", "protected-invariants"],
    layoutIds: ["trace", "matrix", "fork", "council"],
    regions: ["primary", "secondary", "supporting"]
  }
}
```

`applyPresentationRecipe` remains the final semantic validator. The browser schema is helpful to an agent, but it is not an authorization or integrity boundary.

`request_human_resolution` is a cited request, not approval. Its full checkpoint is committed to versioned shared governance before the visible Review artifact is announced. While any resolution is awaiting human action or under review, every mutating WebMCP tool is retired. Only the manual interface can resolve, reject, or defer the request: resolve and reject require a 4-to-1,000-character rationale, while defer keeps the checkpoint open and mutations retired.

### Optional output port

```ts
interface OutputPort {
  previewDecisionPacket(input, context): Promise<unknown>;
  exportCase(input, context): Promise<unknown>;
  draftRequest(input, context): Promise<unknown>;
  prepareExternalAction(input, context): Promise<unknown>;
}
```

These commands can preview, draft, or prepare a visible local artifact. The latest 20 prepared artifacts per case are retained as local blobs; eviction deletes older blobs, and any retention-cleanup failure becomes a visible session-only warning that requires workspace reset. Candidate-review packets contain requirement evidence only, with no eligibility, score, rank, blockers, recommendation, or employment outcome. Output commands cannot publish, message, approve, purchase, reject a person, set an insurance premium, adjudicate a claim, or execute an external action.

## Lifecycle and current Chromium compatibility

The gateway listens to runtime, import, presentation, and output events. It recomputes the capability context and registers only the tools useful in that state.

Durable shared governance is a precondition for governed agent mutation. If IndexedDB is unavailable, the manual workspace remains usable in an explicitly session-only mode, but capability context sets `sharedAuthorityAvailable: false` and `governedAgentMutationsBlocked: true`, causing the gateway to expose read-only/fallback state rather than unsafe mutation tools.

Every registration owns an `AbortController`. Aborting that controller unregisters the tool. Chromium implementations before version 153 can cancel an in-flight execution when its registration is aborted, so the gateway uses retirement rather than immediate removal:

```text
state changes
    -> mark obsolete tool as retiring
    -> reject new calls as CAPABILITY_NOT_ACTIVE
    -> allow existing call to settle and return its receipt
    -> unregister when in-flight count reaches zero
```

Schema or trusted-registry changes use the same safe replacement path. Tool additions occur before idle removals so state transitions do not create avoidable discovery gaps.

`gateway.flush()` waits for scheduled reconciliation and is useful in integration tests. Production code normally relies on subscriptions.

## Revisions, idempotency, and receipts

The gateway enforces three independent concurrency axes:

| Mutation | Required concurrency input |
|---|---|
| Canonical decision | `expectedDecisionRevision` |
| Presentation | `expectedDecisionRevision` and `expectedViewRevision` |
| Existing import job | `expectedImportVersion` |

Shared authority uses a separate internal `governanceVersion` compare-and-swap record. An agent does not supply that version to override authority; guarded request creation and human-only checkpoint/freeze controls commit it inside the workspace boundary.

Every mutation also requires an `idempotencyKey`. An identical completed retry returns the original operation receipt with `replayed: true`. Reusing the key with different input returns `IDEMPOTENCY_CONFLICT` without calling a port. The browser integration stores only a canonical input hash and the bounded response envelope, never the original tool input; replay/conflict behavior therefore survives reload without retaining inline source text. Canonical kernel commands and import starts maintain their own durable idempotency records as a second boundary.

The default browser journal is a shared IndexedDB database. Claiming an idempotency key and fingerprint is a single read/write transaction, so two tabs cannot both win the same mutation. A caller that observes the same live claim waits for its stored result and replays it; a different fingerprint conflicts immediately.

The journal uses two leased states. `claimed` means the durable execution boundary has not been crossed, so an expired claim may be reclaimed safely by a new owner. Immediately before the mutation port runs, that owner must transactionally commit `executing`. An expired or interrupted executing record with no durable result returns non-retryable `IDEMPOTENCY_OUTCOME_UNCERTAIN`, is never executed again automatically, and directs a human to inspect canonical state and recent receipts before choosing a new key. Ambiguous version-one `pending` records fail closed through the same recovery path.

The gateway initializes the invocation journal before exposing tools. If either the durable claim or the durable `executing` boundary cannot be written, it returns `JOURNAL_UNAVAILABLE` before calling the mutation port. If a mutation runs but its result or receipt cannot be persisted, the response remains honest about that uncertainty through `meta.journal`:

```js
{
  durable: false,
  status: "session-only",
  invocation: { resultPersisted: false },
  receipt: { durable: false, reason: "..." }
}
```

Unsupported browsers may use the in-memory fallback for the current page session. Local-storage adapters remain exported for compatibility, but they identify themselves as non-transactional and are not the production default. Callers and UI surfaces can inspect `gateway.snapshot().journalDurability`, `response.meta.journal`, and each receipt's `journalDurability` instead of assuming durable audit state.

Destructive local-workspace reset flows must also call `await clearWebMcpJournalDatabase()`. The helper clears invocation claims/results and receipts together in one transaction without requiring live tabs to close their database connections. `WEBMCP_JOURNAL_DATABASE_NAME` is exported for diagnostics and browser-storage tooling.

Receipts are bounded to the latest 100 entries, retained in an IndexedDB ledger, persisted by the browser integration, and passed to `onReceipt` before the tool returns. Each append merges and prunes inside one read/write transaction, preventing concurrent tabs from replacing one another's entries. A successful receipt records:

- Operation ID, tool, actor, case, timestamp, and status
- Decision revision and hash before and after
- Presentation revision before and after
- Changed canonical entity IDs
- Audit event ID when supplied by the runtime
- Idempotency key and replay status

The UI should render these receipts as agent-authored actions, visually distinct from human approvals and pins.

The optional `onActivity` callback is transient presentation feedback around the real registered-tool callback. It receives a random call ID, tool family, status, case scope, argument-key names, a small allowlist of non-sensitive routing values, and a bounded receipt projection. Raw arguments, source text, prompts, personal data, and arbitrary string values are never included. Callback failure cannot alter authoritative execution.

The in-product acceptance console arms a timestamped, case-scoped capture and scores only subsequent `onActivity` steps. Required calls must settle or replay successfully; a rejected expected call fails. Forbidden tool attempts fail even when policy correctly rejects them. Exported evidence is synthetic-case metadata plus privacy-bounded call records. The ten-case corpus can be scored offline with `npm run test:webmcp:score -- <model-traces.json> [report.json]`; an absent run remains incomplete rather than becoming a claimed zero or simulated pass.

## Validation and content safety

Every handler validates again in JavaScript. The validator rejects:

- Unknown properties
- Wrong primitive or collection types
- Missing required fields
- Values outside length, count, range, enum, and format bounds
- Excessive nesting or node counts
- Prototype-pollution keys
- Non-JSON-serializable values

Imported text, user-authored labels, contracts, graph paths, document spans, and generated packets use `untrustedContentHint: true`. Tool output is capped at 1,400 serialized characters by default. Oversized data is replaced with a bounded truncation summary while preserving the operation receipt and current revisions.

Tool discovery is not an authorization boundary. Permission, phase, freeze, case identity, human-checkpoint, and revision conditions are re-evaluated immediately before every execution.

The catalog intentionally contains no tool capable of:

- Approving or committing a decision
- Rejecting a candidate
- Ranking people using protected traits
- Underwriting insurance or setting premiums
- Adjudicating a claim
- Deleting a case
- Submitting an external action

## Deterministic tests

Run the gateway contract suite without a browser:

```powershell
node --test tests/webmcp-gateway.test.mjs
```

It verifies lifecycle registration, strict runtime validation, stale revisions, two-gateway atomic claim/wait/replay/conflict behavior, safe expired pre-execution reclamation, fail-closed executing/legacy outcome uncertainty, concurrent receipt retention, fail-before-execution claim and execution-boundary errors, visibly session-only quota failures, bounded output, prohibited-action absence, no-WebMCP fallback, and current-browser-safe in-flight retirement.

## Real Chrome and Edge tests

Chrome and Edge require the WebMCP feature during local development. The dedicated Playwright projects launch both installed browsers with `--enable-features=WebMCP`.

Run:

```powershell
node node_modules/@playwright/test/cli.js test --config=playwright.webmcp.config.mjs
```

The Playwright configuration starts a dedicated Vite server on port 4192 when `SITUATION_ROOM_BASE_URL` is not supplied. Set that environment variable to reuse an already-running server.

The test uses the genuine browser API rather than calling definition functions directly:

```js
const tools = await document.modelContext.getTools();
const resultText = await document.modelContext.executeTool(tool, JSON.stringify(input));
const result = JSON.parse(resultText);
```

The configured matrix runs every WebMCP browser specification in both installed Chrome and Microsoft Edge. It verifies real schema serialization, discovery, invocation, `toolchange`, visible UI settlement, lens-driven capability replacement, shared freeze and human-resolution propagation, session-only fallback, bounded output retention, candidate source privacy across inspect/search/span tools, reload continuity, and prohibited-action absence. Exact results from the final aggregate run are recorded in [`../independent-verification.md`](../independent-verification.md).

Codex's natural-language discovery and selection layer is verified separately in the ChatGPT desktop built-in browser. The required prompts, Site tools evidence, and refusal checks are in [`CODEX_SITE_TOOLS_ACCEPTANCE.md`](CODEX_SITE_TOOLS_ACCEPTANCE.md). Do not describe direct `getTools()` or `executeTool()` coverage as an actual Codex-agent connection.

The evaluation corpus at `tests/fixtures/webmcp/evals.json` is intentionally separate from deterministic tests. It describes probabilistic tool-choice and multi-step journey checks for a model runner.
