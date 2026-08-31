# Decision OS implementation contract

SituationRoom is a local-first, evidence-heavy decision runtime. It may structure, compare, simulate, explain, and recommend discrete alternatives against explicit evidence, constraints, scenarios, and human authority. It must not present itself as an unrestricted autonomous decision-maker.

## Product invariants

- All domains compile into the same typed decision and evidence graph.
- Every material claim retains an exact source anchor and import fingerprint.
- Authoritative calculations and eligibility checks use deterministic rules, never language-model arithmetic.
- Missing, disputed, low-confidence, and not-applicable values remain distinct.
- Decision, presentation, import-job, scenario, interaction, and shared-governance versions remain separate.
- Agent presentation requests select validated semantic instruments; they cannot provide runtime markup, styles, formulas, status, evidence, approval, or arbitrary code.
- Browser-agent activity is derived only from real gateway execution callbacks, excludes raw inputs, remains truthful under overlapping calls, and distinguishes canonical from presentation-only change using settled receipts.
- Human pins, mandatory blockers, the Authority Rail, the Decision Firewall, sources, audit receipts, and domain-appropriate human-authority state remain reachable in every composition. An in-product approval control appears only where domain policy permits it.
- Every WebMCP state change revalidates lifecycle, permission, policy, and idempotency at execution time; mutations of existing versioned state also revalidate the applicable optimistic revision.
- Imported content is untrusted data and cannot change policy, tool definitions, permissions, or approval state.
- Pending model edits, approvals, scenarios, pin actions, and compositions remain bound to their captured case and revision; switching rooms cannot redirect a late result.
- The complete workflow remains usable without WebMCP.

## Demonstration domains

The release includes four domain packs backed by the same runtime:

- Procurement: vendor eligibility, mandatory gates, normalized cost, scenarios, and recommendation.
- Candidate review: blinded, allowlisted job-related evidence, per-requirement coverage and verification gaps, with every employment outcome outside SituationRoom.
- Consumer health-plan comparison (`health-plan`): verified plan identity, premiums, deductible, out-of-pocket maximum, provider and formulary evidence, exclusions, enrollment terms, and utilization-cost scenarios.
- Generic choice: typed alternatives, criteria, constraints, weights, uncertainty, and comparisons imported from tabular or structured data.

Candidate-review alternatives must use opaque identifiers, criteria must match the job-related allowlist, and claim values must use bounded evidence types rather than free-text narratives. Candidate evaluation and every prepared export must remove eligibility, scores, rankings, blockers, recommendations, and employment outcomes. SituationRoom does not provide a human control for recording that outcome. Protected purpose language is rejected in the contract and model, and source inspection/search/span projections must redact protected columns, correlated row values, structured metadata, diagnostics, and unblinded narratives before returning data or search totals.

Health-plan tools must require explicit insurance-plan comparison purpose, positively typed `planAspect` criteria, and source-backed alternative identity: `insurance-plan` entity type, issuer, plan ID, recognized plan type, matching label, and exact quoted-source hash. They must reject diagnosis, treatment selection, clinical-outcome optimization, underwriting, personalized premiums, denial, and coverage or claim adjudication across the contract, alternatives, criteria, constraints, claims, and scenarios. Personal, demographic, and clinical source fields are removed before evidence becomes canonical; unstructured personal clinical material remains withheld until a person provides a plan-term-only extract.

## Import contract

The native adapter registry covers PDF, DOCX, XLSX, CSV, TSV, PPTX, JSON, YAML, XML, HTML, Markdown, plain text, RTF, EML, PNG, JPEG, TIFF, WebP, and ZIP bundles. Each adapter must either produce anchored normalized blocks or a typed, visible diagnostic. Legacy Office/OpenDocument, MSG, HEIC, and Parquet are diagnostic-only in this release. The pipeline must never silently discard or invent content.

The pipeline handles duplicate fingerprints, empty files, extension and MIME mismatches, encrypted or password-protected content, macros, malformed encodings, hidden spreadsheet content, formulas versus cached displayed values, merged-cell review diagnostics, archive traversal and expansion limits, nested archives, partial parsing, OCR uncertainty, cancellation races, quarantine, storage failure, and changed-source diagnostics.

New-case import confirmation exposes the complete inferred draft: alternatives, typed criteria, weights, score direction/range, gates, evidence values and statuses, exact anchors, authority, diagnostics, and draft status. Values below confidence `0.8` remain `proposed` and are ignored by evaluation until a person verifies or rejects them. Acceptance is bound to the reviewed durable import version inside a serialized coordinator operation.

The same confirmation exposes a conservative cross-document semantic proposal. Exact normalized identities may resolve; legal-suffix aliases, unknown fields, duplicate records, unstructured narratives, low-confidence values, and values without exact locators remain proposals or unresolved items. Contradictory values remain side by side with their source anchors. Agent suggestions require exact supporting document/fragment references, strict size and count limits, and the current import version; they stay visibly separate from deterministic mappings and cannot override, auto-resolve, or commit anything.

After a successful canonical commit, sanitized documents and anchors remain readable in the case while transient parsed documents and retained source bytes are deleted. A deletion failure leaves the job complete with an explicit cleanup-pending recovery action; recovery retries deletion only and must not replay the committed case mutation. Discard similarly retains recovery handles until source deletion is verified. Failed and quarantined jobs surface an explicit recovery checkpoint, while interrupted canonical commits persist replayable intent and reconcile through the original idempotency key without creating a second revision.

## Adaptive interface contract

At least four structural layout grammars are supported: causal trace, aligned comparison, scenario fork, and stakeholder brief. The current trusted registry contains 34 semantic instrument types, including evidence excerpts, source previews, claim interpretations, constraint gates, causal traces, outcome seals, comparison matrices, metric waterfalls, timelines, contradiction and missing-evidence dockets, scenario controls, sensitivity plots, risk frontiers, stakeholder mandates, and decision briefs.

At least twelve representative requests across the four domains must produce at least eight materially different compiled compositions. Recomposition preserves decision hashes, human pins, blockers, source reachability, accessible reading order, and view history.

The routed analysis surface includes one receipt-backed browser-agent thread when Site tools are available. It shows real tool lifecycle state and resulting authority deltas, not simulated reasoning. The audit surface includes a decision time machine that orders and compares canonical, presentation, import, governance, workspace, and agent events while keeping raw append-only receipts inspectable.

The archive, intake, Model, four analysis lenses, Review, and Outputs must have canonical deep links. Browser history and reload restore case, workspace, and lens without bypassing frozen state, pending checkpoints, or import recovery. Only the active workspace's primary surface is mounted; governance remains summarized and reachable on every case route.

The routed shell must have one primary document scroll, no page-level horizontal overflow at 1440px or 390px, no more than twelve persistent controls above the mobile decision content, body text of at least 14px, and metadata/status text of at least 12px. The main route heading begins within 220px on a 390px viewport. Closed mobile navigation is not focusable; opening it moves focus inside, Escape or Close restores the trigger, and the skip link focuses the decision stage. Motion communicates transition or state and respects reduced-motion preference.

## WebMCP contract

Capabilities are lifecycle-, role-, permission-, domain-policy-, and revision-dependent. A compact set is discoverable at any moment while the overall catalog covers intake, contract construction, evidence queries, deterministic analysis, semantic composition, collaboration, review, revision replay, and cited exports.

Agent intake may use only opaque human-staged sources. New-case sources must share one exact human-confirmed domain reservation that matches `domainHint`; existing-case sources must match the canonical domain. Bounded inline text is allowed only for an existing authoritative case. There is no URL field or agent network-fetch path. Every source read requires `caseId`; import-review reads additionally require the owning `jobId`, while contract-draft and eligible analysis reads reject `jobId` and use canonical sanitized case evidence only.

No WebMCP tool may approve a decision, impersonate a human pin, reject a candidate, underwrite insurance, adjudicate a claim, bypass a file chooser, accept arbitrary local paths, fetch a URL, or perform an irreversible external action.

Manual freeze and complete cited human-resolution checkpoints are stored in a versioned governance record shared across tabs. A resolution request must commit there before its visible artifact appears. Every mutating WebMCP tool remains retired while the checkpoint is open; only the manual interface may resolve or reject it with a 4-to-1,000-character rationale, or defer it while keeping the checkpoint open. This is separate from domain-permitted human approval, which is never exposed as a tool. If durable shared authority is unavailable, the manual workflow remains usable in a visible session-only mode and governed WebMCP mutations are disabled.

Every successful mutation emits an on-screen receipt before its tool call resolves. Stale writes, conflicting idempotency reuse, capability loss, cancellation, and durable claim or execution-boundary failure reject before mutation. Equal live calls wait and replay; an expired pre-execution claim may be reclaimed, but an interrupted executing record without a durable result must return non-retryable outcome uncertainty, never repeat automatically, and require human reconciliation. Post-execution result or receipt persistence failures are labeled session-only rather than claimed as durable. In durable mode, browser invocation records and the latest 100 operation receipts survive reload; kernel commands and import starts retain independent durable idempotency records. Workspace reset clears both invocation records and receipts.

Import-review semantic assistance is the sole mutating capability allowed while the import itself is awaiting human review. It must still retire whenever a distinct approval or shared human-resolution authority checkpoint is open. It can stage proposals only and cannot cross the canonical commit boundary.

Model-facing acceptance must use a fresh, explicitly armed capture. A run passes only when all required tool names, argument keys, safe argument constraints, successful execution statuses, and forbidden-authority checks pass. Missing work is `incomplete`; rejected expected work or forbidden attempts are `failed`. Prior receipts and simulated calls cannot be counted.

## Output contract

Prepared artifacts remain local and digest-bound. At most the latest 20 artifacts per case are retained as blobs; older blobs are deleted, and a retention-cleanup failure produces a visible session-only warning that requires workspace reset. Candidate-review packets are requirement-evidence-only. An agent may prepare a packet or draft, but only a person may download, print, publish, send, or execute it.

## Verification gates

- Unit tests cover rules, canonicalization, validation, revisions, idempotency, import security, composition schemas, hashes, and policy boundaries.
- Integration tests cover import review to canonical commit, review-version races, discard cleanup, interrupted-commit reconciliation, persistence and reload, changed-source diagnostics, domain-pack parity, gateway lifecycle, and receipt settlement.
- Chrome and Edge tests cover all four domains, all layout grammars, manual parity, imports, source tracing, revisions, responsive layouts, keyboard operation and focus containment, reduced motion, and failure diagnostics.
- Real Chrome and Edge WebMCP tests run with the browser feature enabled when supported and use `getTools()` plus `executeTool()` rather than directly invoking mock callbacks.
- Prompt-injection fixtures in filenames, document text, spreadsheet cells, HTML, comments, and email content produce no unauthorized state or capability change.
- Semantic-intake fixtures cover exact cross-source identity, aliases, duplicates, contradictions, nested JSON pointers, workbook ranges, missing locators, low confidence, supporting source-scoped agent suggestions, payload limits, and stale import versions.
- Model-evidence fixtures prove pass, fail, incomplete, rejected-call, forbidden-authority, privacy-bounded export, and ten-case corpus scoring behavior.
- Production build, Sites packaging, and worker fallback tests pass.

Exact results belong in `independent-verification.md` after the final post-correction aggregate run.
