# Decision OS architecture and invariants

## System shape

SituationRoom separates source intake, canonical decisions, deterministic analysis, semantic presentation, and browser-agent capabilities. Every domain compiles into the same graph instead of supplying a custom dashboard.

```text
untrusted files or text
  -> bounded native extraction and diagnostics
  -> conservative cross-document semantic proposal
  -> human import review
  -> typed decision contract and evidence graph
  -> deterministic domain policy and evaluation
  -> source-backed paths, blockers, uncertainty, and domain-permitted analysis
  -> trusted semantic presentation compiler
  -> human-governed UI and contextual WebMCP capabilities
```

The application is local-first. IndexedDB persists cases, documents, import jobs, raw import inputs, audited commands, prepared output blobs, per-case presentation/review ledgers, versioned case-governance records, and a shared transactional WebMCP invocation/receipt journal. A governance record owns manual freeze and complete human-resolution checkpoints; compare-and-swap commits plus `BroadcastChannel` updates make that authority visible across tabs. Active-case selection remains browser-local. Focus, pins, view history, review artifacts, receipts, and prepared-output references are per-case presentation/session state mirrored to local storage and, when available, durable IndexedDB; none carries decision authority. If durable storage is unavailable, the typed memory repository and in-memory journal keep the manual interface usable in a visibly session-only mode, but governed WebMCP mutations are disabled.

## Ownership boundaries

| Layer | Owns | Authorized writers |
| --- | --- | --- |
| Imported evidence | bytes, fingerprint, blocks, native locators, confidence, diagnostics | import pipeline after explicit source staging |
| Decision state | contract, alternatives, criteria, constraints, claims, relations, rules, conflicts, audit, and policy-permitted approval | validated kernel commands and, where the domain permits it, the visible human approval checkpoint |
| Deterministic analysis | domain-permitted eligibility, blockers, normalized metrics, rankings, requirement evidence, paths, and scenario results | pure domain-pack evaluators |
| Presentation | lens, semantic recipe, trusted instruments, focus, pins, view revision and history | manual controls or validated presentation commands |
| Interaction | open dialogs, keyboard focus, local composition phase, staged files | local interface |
| Agent activity | transient tool lifecycle, privacy-bounded argument keys, receipt deltas | actual WebMCP gateway callbacks only |
| Shared governance | governance version, manual freeze, and complete cited human-resolution checkpoints | guarded request creation; human-only resolution and freeze controls |
| Capability context | phase, role, permissions, policy, revisions, shared-authority availability, checkpoint state, and freeze state | derived by the WebMCP gateway; never supplied by imported content |

Decision, presentation, import-job, scenario, interaction, and governance versions are deliberately independent. A presentation, scenario, or governance mutation cannot change the canonical decision hash.

## Domain packs

The procurement, candidate-review, consumer health-plan, and generic packs supply labels, policy restrictions, fixtures, normalization rules, and deterministic evaluators over the shared schema.

Candidate review accepts only opaque candidate identifiers, allowlisted job-related criteria, and bounded evidence states. Its evaluator and prepared packets remove eligibility, scores, rankings, blockers, recommendations, and employment outcomes; SituationRoom does not record the employment outcome even through its human UI. The agent source projection redacts protected tabular columns, correlated row values, structured metadata, and unsafe diagnostic details before inspect, search, or span reads, so protected-value searches do not become a presence oracle.

Health-plan comparison uses the canonical pack ID `health-plan`. It requires explicit plan-comparison language in the question and objective, positively typed `planAspect` criteria, and source-backed alternative identity: `insurance-plan` entity type, issuer, plan ID, recognized plan type, matching display label, and exact quoted source hash. The full model rejects diagnosis, treatment selection, clinical-outcome optimization, underwriting, personalized premiums, denial, and coverage or claim adjudication. Procurement, health-plan, and generic cases may proceed to a digest-bound in-product human approval checkpoint before freeze; candidate review keeps every employment outcome outside SituationRoom.

## Import boundary

Local files enter only after a person uses the file chooser or drop zone. WebMCP receives opaque staged-source IDs only after the person confirms their exact policy domain. A new-case agent import may contain only staged sources, every source must reserve the same domain, and `domainHint` must match that reservation exactly. An existing-case staged source must match the authoritative case domain. Bounded inline text is permitted only for an existing authoritative case. The WebMCP schema has no URL field and the agent cannot select arbitrary filesystem paths, transfer a browser `File`, or initiate network retrieval. Extensions and MIME declarations are hints, while binary signatures and parser diagnostics determine trust.

Parsers emit normalized blocks with native page, paragraph, sheet/range, slide, line, or archive locators. Extracted instructions are untrusted evidence text. Macros, embedded scripts, external relationships, archive traversal, expansion bombs, malformed structures, OCR uncertainty, and unsupported formats become visible diagnostics or quarantine states.

Review, table mapping, acceptance, retry, and discard are serialized per import job. A confirmation carries the exact durable import version into the coordinator transition, preventing remap/accept time-of-check races. New cases commit as drafts. Extracted values below confidence `0.8` remain `proposed`, do not enter scoring or gates, and require human verification or rejection in the model editor.

Successful acceptance copies sanitized documents, fragments, claims, and anchors into the canonical case, then deletes transient parsed documents and retained source bytes. If that deletion fails, the completed job exposes `cleanup_pending_after_acceptance` and `retry_raw_cleanup`; recovery retries deletion only and never replays the canonical commit. Discard likewise retains a visible recovery handle until deletion is verified. A durable commit intent distinguishes an interrupted pre-commit from a post-commit receipt-storage failure and reconciles through the original idempotency key without creating a second decision revision.

Every WebMCP source read requires `caseId`. During `import_review`, the owning `jobId` is also required and cross-case or cross-job references fail closed. In `contract_draft` and eligible `analysis` contexts, source reads reject `jobId` and use only the case's canonical sanitized documents. Candidate and health-plan projections apply after this scope check.

Normalized import documents also feed a deterministic semantic proposal. It resolves only exact normalized identities, keeps near aliases as proposals, groups evidence by normalized field, preserves contradictory values, and refuses to infer from missing locators or unstructured prose. Browser-agent suggestions are separately validated against the exact supporting import fragments, count and byte limits, and the current import version. They never mutate deterministic entities, facts, mappings, conflicts, or confidence.

## Composition boundary

The agent stages the room; it never rewrites the application. A versioned semantic recipe may choose a supported lens, layout grammar, density, allowlisted instrument types, canonical entity references, source-backed paths, and bounded question text.

The compiler owns component definitions, hierarchy, typography, color, responsive behavior, accessible reading order, motion, formulas, protected context, and omission reporting. It injects mandatory blockers and human pins even when a recipe omits them. The four layout grammars are causal trace, aligned matrix, scenario fork, and stakeholder council; the trusted registry currently contains 34 semantic instrument types.

## Routed interaction shell

The browser URL is a navigable projection of workspace state, not a second source of authority. A dependency-free parser maps the archive, intake, Model, four analysis lenses, Review, and Outputs to fixed route shapes. Initial route settlement happens before WebMCP registration. Human navigation pushes history; automatic lifecycle normalization replaces it; `popstate` uses the same guarded case, phase, and lens transitions as visible controls.

Only the selected route's main work surface is mounted. The case-file rail, compact governance seal, and route heading remain stable; full authority gates, prompt ideas, and view history expand on demand. Mobile navigation is removed from the focus order while closed and opens as a focus-managed drawer. Page-level surfaces use one document scroll, with labelled overflow reserved for data instruments that genuinely require it.

When Site tools are active, the analysis surface adds a compact live execution thread scoped to the active case. Its nodes come from actual gateway start, settle, reject, and replay events and hold no raw input. Stable semantic instrument identifiers opt into Chromium view transitions so a recompose shows location and hierarchy changes without animating canonical content arbitrarily; reduced-motion removes the transition. The audit overlay projects the append-only receipt ledger into an ordered, comparable decision time machine without becoming an authority source itself.

Archive, unknown-route, and cross-case transition surfaces set a separate navigation-surface context. Outside a settled case route, WebMCP exposes only the empty/intake orientation contract rather than retaining mutation tools for a persisted background case. Pending import review owns `/new`, pending human resolution owns Review, and frozen cases normalize to read-only analysis.

## Governed capability lifecycle

The WebMCP gateway projects a compact tool set from the current phase, lens, domain policy, role, permissions, revision, and freeze state. Discovery helps an agent plan but is not the security boundary; the same conditions are revalidated immediately before execution.

```text
empty or intake -> importing -> import review -> contract draft
contract draft -> analysis -> collaboration -> output -> frozen
```

State-changing calls require idempotency keys, and mutations of existing versioned state require the applicable optimistic revision. Tool retirement preserves in-flight execution, every successful mutation settles the visible UI and emits a bounded receipt, and capability loss prevents new calls. A cited human-resolution request is committed to shared governance before its visible artifact is announced. While any resolution remains open, every mutating WebMCP tool is retired. Human resolve and reject actions require a 4-to-1,000-character rationale; defer deliberately leaves the checkpoint open. This checkpoint is distinct from the digest-bound approval flow, and approval is never a WebMCP tool.

The IndexedDB invocation journal claims each scoped key and request hash transactionally across tabs: equal concurrent requests wait and replay, while unequal hashes conflict without execution. Its two durable stages distinguish a leased pre-execution `claimed` record from `executing`. An expired pre-execution claim may be reclaimed safely because no mutation crossed the boundary. Immediately before the port call, the owner must commit `executing`; an interrupted or expired executing record without a result becomes non-retryable `IDEMPOTENCY_OUTCOME_UNCERTAIN`, is never repeated automatically, and requires a human to inspect canonical state and receipts. Legacy ambiguous `pending` records fail closed the same way.

Claim or execution-boundary persistence failures stop before mutation. Post-execution result or receipt persistence failures are labeled session-only rather than presented as durable success, and later callers fail closed rather than risking a duplicate. The receipt ledger retains the latest 100 entries and merges concurrent appends. Canonical runtime commands and import starts also enforce their own durable idempotency. Workspace reset clears both invocation records and receipts. Approval, rejection, external submission, and irreversible execution are absent from the catalog.

## Protected invariants

- Mandatory failures, unresolved material evidence, human pins, sources, authority, decision revision, and approval state remain reachable in every composition.
- Imported content cannot modify policies, schemas, permissions, capabilities, layouts, styles, formulas, or authority.
- Scenario evaluation is hypothetical and reports that the original decision is unchanged.
- Stale decision, view, or import revisions reject atomically.
- Asynchronous model edits, approvals, scenarios, pin actions, and compositions stay bound to their captured case and revision; navigation cannot redirect a late result into the newly active room.
- Reusing an idempotency key with different arguments rejects without mutation.
- Frozen cases retain read-only analysis and lose mutation tools.
- Open human-resolution checkpoints retire every mutating WebMCP tool until a person closes them.
- Loss of durable shared authority leaves the manual UI usable but disables governed WebMCP mutations.
- Accessible Outline exposes the same causal content as the spatial room.
- Manual controls cover the complete workflow when WebMCP is unavailable.

## Asset and output policy

Generated visual references are not runtime assets. Interface icons use Tabler, fonts are self-hosted, and the only raster treatment is the documented public-domain paper texture.

Exports are generated locally and remain bound to the case revision and decision digest. Candidate-review packets are requirement-evidence-only and contain no eligibility, score, rank, blocker, recommendation, or employment outcome. The latest 20 prepared artifacts per case are retained as blobs; evicted blobs are deleted, and a cleanup failure produces a visible session-only warning that requires workspace reset. Agent tools can prepare packets and drafts, but only a person can download, print, publish, send, or execute an external action.
