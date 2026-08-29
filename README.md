# SituationRoom Decision OS

SituationRoom is a local-first, evidence-heavy decision workspace. A person can ask a decision question in ordinary language and the interface recompiles itself into the most useful causal trace, comparison matrix, scenario fork, or stakeholder brief while the canonical decision record remains unchanged.

The visual concept is a Living Caseboard: an asymmetric editorial evidence desk with a fixed authority spine, an always-reachable Decision Firewall, source-linked instruments, and a red causal thread connecting evidence to outcomes. It is not a chat wrapper or a generic dashboard.

## What the release includes

- One typed decision kernel shared by procurement, candidate review, consumer health-plan comparison, and general choice domains.
- Domain-permitted deterministic analysis: scoring, eligibility, and constraint gates where allowed; requirement-evidence analysis for candidate review; and source-backed claims, causal paths, uncertainty, conflicts, scenarios, revisions, idempotency, and audit receipts.
- Four genuinely structural view grammars and 34 allowlisted decision instruments. Agents select semantic instruments and canonical IDs; they cannot inject HTML, CSS, code, formulas, colors, facts, or authority.
- A complete manual lifecycle: import, inspect, review every inferred alternative, criterion, score range, gate, evidence value and status, anchor, and authority; edit the full typed model; activate; analyze; collaborate; prepare outputs; preview approval where the domain permits it; and human-only freeze.
- Four seeded synthetic rooms, no API keys or account requirement, and an explicit local reset that erases browser data before cleanly reseeding the demonstration.
- Local IndexedDB persistence for cases, source material, import recovery, prepared outputs, audited commands, per-case presentation/review ledgers, shared case governance, and the transactional WebMCP journal. Active-case selection remains browser-local; presentation and review state carries no decision authority even when it is durably mirrored. A clearly labeled session-only fallback keeps the manual workspace usable but retires governed agent mutations because shared authority cannot be guaranteed.
- Responsive desktop, tablet, and mobile compositions with keyboard navigation, an accessible outline, high-contrast-compatible controls, and reduced-motion support.

## Routed case file

The Living Caseboard is distributed across focused, deep-linkable workspaces instead of rendering the whole operating system at once:

- `/cases` opens the decision archive and `/new` opens intake or import recovery.
- `/cases/:caseId/model` contains the decision contract and typed model.
- `/cases/:caseId/analyze/:lens` contains exactly one of Investigate, Compare, Simulate, or Brief.
- `/cases/:caseId/review` contains human checkpoints and attributed collaboration.
- `/cases/:caseId/outputs` contains packet preview and preparation.

The URL is a projection of authoritative workspace state. Back, Forward, reload, and copied deep links restore the active case and surface; pending review, frozen authority, or import recovery may normalize a requested URL to the only permitted workspace. The desktop shell uses one document scroll and a compact case-file rail. Narrow screens replace that rail with a focus-managed room-map drawer rather than stacking every navigation and governance surface above the decision.

## Import and export coverage

The native intake pipeline parses text, Markdown, JSON, CSV, TSV, HTML, XML, YAML, PDF, DOCX, XLSX, PPTX, RTF, EML, PNG, JPEG, TIFF, WebP, and bounded ZIP bundles. It detects file signatures rather than trusting extensions, quarantines blocking failures, preserves native locators, marks all extracted text as untrusted, and surfaces diagnostics instead of silently inventing or discarding content.

New-case imports enter as reviewed drafts, never active contracts. Values below the confidence threshold remain proposed evidence and are ignored by scoring and gates until a person verifies or rejects them. Confirmation is bound to the exact durable import version inside a serialized commit transition. After a canonical commit, sanitized documents and anchors remain in the case while transient parsed documents and retained source bytes are deleted. If deletion fails, the committed case is not replayed: the import exposes a cleanup-pending recovery action that retries deletion only. Discard uses the same verified, recoverable cleanup boundary.

Legacy Office files, OpenDocument files, MSG, HEIC, and Parquet are recognized but deliberately return a visible unsupported-format diagnostic because no safe native parser is bundled. Password-protected sources must be explicitly decrypted before import. Image OCR uses the bundled English language data.

Decision packets can be prepared locally as JSON, JSON-LD, CSV, HTML, XLSX, DOCX, or print-ready HTML for browser PDF printing. The latest 20 artifacts per case are retained; evicted blobs are deleted and any retention-cleanup failure becomes a visible session-only warning that requires a workspace reset. Candidate-review packets are requirement-evidence-only: they contain no eligibility, score, rank, blocker, recommendation, or employment outcome. WebMCP can prepare an artifact, but a person must still download, print, publish, or send it.

## Governed WebMCP

When the browser exposes the experimental `document.modelContext` API, SituationRoom registers a compact capability set appropriate to the current lifecycle phase, lens, role, permissions, domain policy, revision, and freeze state. The wider catalog covers:

- workspace and decision-contract orientation;
- opaque human-staged file intake for new cases, plus bounded inline text only for an existing authoritative case;
- import inspection, source search, span reading, table mapping, retry, and review requests;
- draft decision modeling and validation;
- graph queries, deterministic evaluation, saved or inline scenarios, sensitivity, exact or explicitly diagnostic minimum-change analysis, challenges, and missing-evidence analysis;
- semantic room composition, evidence focus, view save and restore, and revision replay;
- attributed comments, human-resolution requests, and hypothetical branches;
- cited previews, local exports, information-request drafts, and external-action drafts.

No registered tool can approve or reject a decision, impersonate a human pin, hire or reject a candidate, infer protected characteristics, underwrite insurance, adjudicate a claim, choose treatment, select an arbitrary local path, fetch a URL, or execute an external action. Candidate evaluation and exports remain requirement-evidence-only, and candidate source projections redact protected columns, correlated values, structured metadata, and unsafe diagnostics before inspect, search, or span reads. Health-plan mode is identified by `health-plan`; it requires explicit plan-comparison purpose, source-backed insurance-plan identity, and allowlisted plan aspects, while rejecting diagnosis, treatment selection, clinical-outcome optimization, underwriting, personalized pricing, and coverage or claim adjudication.

Every state-changing call is idempotent and policy checked again at execution time; mutations of existing versioned state also require the applicable optimistic revision. Successful changes settle visibly and emit a receipt before the tool resolves. Manual freeze and complete cited human-resolution checkpoints use a separate versioned governance record shared across tabs. While a resolution is open, every mutating WebMCP tool is retired; resolve and reject require a human rationale, while defer deliberately keeps the checkpoint open. In durable mode, browser operation replay/conflict records and the bounded receipt ledger survive reload; canonical commands and import starts also retain their own durable idempotency records. The journal can reclaim an expired pre-execution claim, but once its durable execution boundary is crossed, a missing result is reported as outcome-uncertain and never repeated automatically. The complete workflow remains usable when WebMCP is unavailable.

## Run locally

```bash
npm install
npm run dev
```

The production build writes the static client to `dist/client`, the hosting worker to `dist/server/index.js`, and hosting metadata to `dist/.openai/hosting.json`.

## Verification

```bash
npm run test:unit
npm run test:ocr
npm run test:kernel:browser
npm run test:sites
npm run test:presentation
npm run test:ui
npm run test:webmcp
npm run build
```

`npm run test:ui` runs every black-box interface specification in installed Google Chrome and Microsoft Edge. `npm run test:webmcp` launches both browsers with WebMCP enabled and exercises tool discovery and execution through `getTools()` and `executeTool()`. `npm run test:all` executes the entire release gate. Exact results from the final post-correction aggregate run belong in [`independent-verification.md`](independent-verification.md), not in evergreen product copy.

The native-browser matrix does not substitute for a Codex model choosing Site tools from natural language. The separate built-in-browser acceptance run and its evidence requirements are documented in [`docs/CODEX_SITE_TOOLS_ACCEPTANCE.md`](docs/CODEX_SITE_TOOLS_ACCEPTANCE.md).

## Continuous delivery

`SituationRoom CI` runs deterministic, hosting, OCR, browser-kernel, presentation, routed UI, and real WebMCP checks. It builds one static payload, embeds the exact commit and corresponding-source archive, smoke-tests the resulting Caddy image, and publishes a checksummed short-lived release artifact.

After a successful trusted `main` push, `Deploy SituationRoom Production` downloads that exact artifact, revalidates the current branch SHA, transfers it with strict SSH host verification, and activates it on Hetzner through the versioned `/opt/situationroom` release layout. Internal and public route, release, and missing-asset checks must pass or the previous Compose release is restored. Routine application deploys do not mutate Cloudflare or the shared Caddy route.

Ten model-facing task definitions, including prompt injection, stale revisions, frozen state, regulated candidate and health-plan policies, scenario analysis, and draft-only external actions, live in [`tests/fixtures/webmcp/evals.json`](tests/fixtures/webmcp/evals.json). They are kept separate from deterministic tests so model-selection results are never presented as measured unless a model runner actually executes them.

The detailed product invariants and acceptance gates are in [`docs/DECISION_OS_ACCEPTANCE.md`](docs/DECISION_OS_ACCEPTANCE.md). System boundaries and manual parity are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), with the capability catalog and browser contract in [`docs/WEBMCP.md`](docs/WEBMCP.md). The judge-facing evidence map and recording sequence are in [`docs/JUDGING_MAP.md`](docs/JUDGING_MAP.md) and [`docs/DEMO_RUNBOOK.md`](docs/DEMO_RUNBOOK.md).

## Project map

```text
src/kernel/                 canonical decision graph and deterministic runtime
src/domain-packs/           procurement, candidate, health-plan, and generic policies
src/import/                 secure multi-format extraction and review pipeline
src/persistence/            IndexedDB and memory repositories
src/presentation/           semantic recipes, compiler, policies, and instrument registry
src/components/             four layout grammars, instruments, and workspace surfaces
src/workspace/              application store, adapters, import mapping, and exporters
src/webmcp/                 capability policy, schemas, gateway, receipts, and tool catalog
tests/                      unit, renderer, browser, WebMCP, packaging, and smoke tests
deploy/hetzner/             immutable image activation and rollback contract
.github/workflows/          trusted CI artifact and automatic production deployment
```

## Licensing

No AI-generated image is shipped. The paper texture is a public-domain scan by Paolo Neo from Wikimedia Commons. Tabler Icons are MIT licensed; Libre Baskerville and IBM Plex use the SIL Open Font License 1.1. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

SituationRoom's original source code is licensed under GNU Affero General Public License v3.0 or later. See [`LICENSE`](LICENSE).
