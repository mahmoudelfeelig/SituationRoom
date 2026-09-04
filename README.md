# SituationRoom Decision OS

SituationRoom is a local-first, evidence-heavy decision workspace. A person can ask a decision question in ordinary language and the interface recompiles itself into the most useful causal trace, comparison matrix, scenario fork, or stakeholder brief while the canonical decision record remains unchanged.

The visual concept is a Living Caseboard: an asymmetric editorial evidence desk with a fixed authority spine, an always-reachable Decision Firewall, source-linked instruments, and a red causal thread connecting evidence to outcomes. It is not a chat wrapper or a generic dashboard.

## Quick start for judges

- **Live app:** [https://situationroom.elfeel.me](https://situationroom.elfeel.me) (no account, no keys; all data is synthetic and stays in your browser). Use **More → Reset demo** to reseed the four example decisions.
- **Enable WebMCP:** Use ChatGPT's in-app browser, or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` set to Enabled before relaunching.
- **What you should see:** The header reports the number of site tools currently registered, the **Agent activity** thread lists each real call the page received, and **Activity history** shows a receipt with decision and view revisions before and after.
- **Run locally:** Use Node 24, then run `npm install` and `npm run dev`. The browser suites (`npm run test:ui` and `npm run test:webmcp`) expect installed Chrome and Edge at the Windows paths in `playwright.webmcp.config.mjs`.

## What the release includes

- One shared typed decision model for procurement, candidate review, consumer health-plan comparison, and general choice domains.
- Domain-permitted deterministic analysis: scoring, eligibility, and constraint gates where allowed; requirement-evidence analysis for candidate review; and source-backed claims, causal paths, uncertainty, conflicts, scenarios, revisions, idempotency, and audit receipts.
- Four genuinely structural view grammars and 34 allowlisted decision instruments. Agents select semantic instruments and canonical IDs; they cannot inject HTML, CSS, code, formulas, colors, facts, or authority.
- A truthful browser-agent channel that shows only tool calls the page actually receives, remains accurate during overlapping executions, and separates canonical changes from presentation-only recomposition through receipt-backed deltas.
- A decision time machine that orders canonical, presentation, import, governance, workspace, and agent receipts; compares any two events; and traces the canonical entity IDs affected.
- A complete manual lifecycle: import, inspect, review every inferred alternative, criterion, score range, gate, evidence value and status, anchor, and authority; edit the full typed model; activate; analyze; collaborate; prepare outputs; preview approval where the domain permits it; and human-only freeze.
- A cross-document semantic intake review that resolves exact identities, proposes near aliases without merging them, preserves contradictory values as conflicts, shows confidence gates and exact anchors, and quarantines agent mapping suggestions in a separate human-review layer.
- A privacy-bounded ten-case Site-tools evaluation corpus and offline scorer that cannot turn missing, rejected, or incomplete model work into a pass.
- Four seeded synthetic rooms, no API keys or account requirement, and an explicit local reset that erases browser data before cleanly reseeding the demonstration.
- Local IndexedDB persistence for cases, source material, import recovery, prepared outputs, audited commands, per-case presentation/review ledgers, shared case governance, and the transactional WebMCP journal. Active-case selection remains browser-local; presentation and review state carries no decision authority even when it is durably mirrored. A clearly labeled session-only fallback keeps the manual workspace usable but retires governed agent mutations because shared authority cannot be guaranteed.
- Responsive desktop, tablet, and mobile compositions with keyboard navigation, an accessible outline, high-contrast-compatible controls, and reduced-motion support.

## Routed case file

The Living Caseboard is distributed across focused, deep-linkable workspaces instead of rendering the whole operating system at once:

- `/cases` opens the decision archive and `/new` opens intake or import recovery.
- `/cases/:caseId/model` contains the decision contract and typed model.
- `/cases/:caseId/analyze/:lens` contains exactly one of Investigate, Compare, Simulate, or Brief.
- `/cases/:caseId/review` contains human checkpoints and attributed collaboration.
- `/cases/:caseId/outputs` contains report preview and preparation.

The URL is a projection of authoritative workspace state. Back, Forward, reload, and copied deep links restore the active case and surface; pending review, frozen authority, or import recovery may normalize a requested URL to the only permitted workspace. The desktop shell uses one document scroll and a compact case-file rail. Narrow screens replace that rail with a focus-managed room-map drawer rather than stacking every navigation and governance surface above the decision.

## Import and export coverage

The native intake pipeline parses text, Markdown, JSON, CSV, TSV, HTML, XML, YAML, PDF, DOCX, XLSX, PPTX, RTF, EML, PNG, JPEG, TIFF, WebP, and bounded ZIP bundles. It detects file signatures rather than trusting extensions, quarantines blocking failures, preserves native locators, marks all extracted text as untrusted, and surfaces diagnostics instead of silently inventing or discarding content.

New-case imports enter as reviewed drafts, never active contracts. Values below the confidence threshold remain proposed evidence and are ignored by scoring and gates until a person verifies or rejects them. Confirmation is bound to the exact durable import version inside a serialized commit transition. After a canonical commit, sanitized documents and anchors remain in the case while transient parsed documents and retained source bytes are deleted. If deletion fails, the committed case is not replayed: the import exposes a cleanup-pending recovery action that retries deletion only. Discard uses the same verified, recoverable cleanup boundary.

Normalized table cells, structured fields, workbook ranges, and conservative key-value text pass through the same semantic intake proposal. Exact normalized identities may merge across sources; near aliases, unknown fields, low-confidence values, unlocated facts, duplicates, and contradictions remain explicit review items. `propose_semantic_mapping` lets a browser agent stage bounded, source-cited suggestions against the exact import version, but those suggestions cannot overwrite deterministic evidence, resolve a conflict, or commit the case.

Legacy Office files, OpenDocument files, MSG, HEIC, and Parquet are recognized but deliberately return a visible unsupported-format diagnostic because no safe native parser is bundled. Password-protected sources must be explicitly decrypted before import. Image OCR uses the bundled English language data.

Decision reports can be prepared locally as JSON, JSON-LD, CSV, HTML, XLSX, DOCX, or print-ready HTML for browser PDF printing. The latest 20 artifacts per case are retained; evicted blobs are deleted and any retention-cleanup failure becomes a visible session-only warning that requires a workspace reset. Candidate-review reports are requirement-evidence-only: they contain no eligibility, score, rank, blocker, recommendation, or employment outcome. WebMCP can prepare an artifact, but a person must still download, print, publish, or send it.

## Governed WebMCP

Tools are registered with the WebMCP imperative API. Each active capability becomes one call of this shape; see `src/webmcp/gateway.js` for registration and `src/main.jsx` for the `document.modelContext` injection:

```js
document.modelContext.registerTool(
  {
    name: "compose_decision_room",
    description: "Apply a validated semantic room recipe while preserving canonical facts and human pins.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { /* ... */ },
      required: [ /* ... */ ],
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute: async (input, { signal }) =>
      gateway.execute("compose_decision_room", input, { signal }),
  },
  { signal: controller.signal },
);
```

The registered set is recomputed from lifecycle phase, lens, permissions, domain policy, revision, and freeze state. Every condition is evaluated again inside `execute`.

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

The live agent channel stores tool name, argument-key names, a tiny allowlist of non-sensitive routing values, status, and bounded receipt deltas. It never stores raw tool input. The acceptance scorer treats rejected expected calls as failures and forbidden attempts as failures even when the gateway safely blocks them.

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

After a real Codex run, score an exported ten-case trace corpus with:

```bash
npm run test:webmcp:score -- model-traces.json report.json
```

`npm run test:ui` runs every black-box interface specification in installed Google Chrome and Microsoft Edge. `npm run test:webmcp` launches both browsers with WebMCP enabled and exercises tool discovery and execution through `getTools()` and `executeTool()`. `npm run test:all` executes the entire release gate. Exact results from the final post-correction aggregate run belong in [`independent-verification.md`](independent-verification.md), not in evergreen product copy.

The native-browser matrix does not substitute for a Codex model choosing Site tools from natural language. The separate built-in-browser acceptance run and its evidence requirements are documented in [`docs/CODEX_SITE_TOOLS_ACCEPTANCE.md`](docs/CODEX_SITE_TOOLS_ACCEPTANCE.md).

## Continuous delivery

`SituationRoom CI` runs deterministic, hosting, OCR, browser-kernel, presentation, routed UI, and real WebMCP checks. It builds one static payload, embeds the corresponding-source archive and public release metadata, smoke-tests the exact image, and publishes a checksummed short-lived release artifact.

After a successful trusted `main` push, the repository's thin deployment caller invokes the public reusable [Hetzner Release Gateway](https://github.com/mahmoudelfeelig/HetznerReleaseGateway) at an immutable reviewed commit. The caller supplies only the application identifier and trusted CI provenance; credentials, host topology, activation policy, rollback, and receipt signing remain outside this public repository. A release is accepted only when the gateway and private deployment controller validate the same unsuperseded commit and CI run.

Production verification uses only public surfaces: HTTPS and certificate validation, root and deep-link responses, missing-asset and unsupported-method behavior, browser checks in Chrome and Edge, WebMCP discovery where the feature is available, `/release.json`, and the downloadable corresponding-source archive. See [`deploy/hetzner/README.md`](deploy/hetzner/README.md) for the public verification contract.

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
src/webmcp/                 capability policy, schemas, gateway, receipts, tool catalog, and model-evidence scoring
tests/                      unit, renderer, browser, WebMCP, packaging, and smoke tests
deploy/hetzner/             immutable image activation and rollback contract
.github/workflows/          trusted CI artifact and automatic production deployment
```

## Licensing

No AI-generated image is shipped. The paper texture is a public-domain scan by Paolo Neo from Wikimedia Commons. Tabler Icons are MIT licensed; Libre Baskerville and IBM Plex use the SIL Open Font License 1.1. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

SituationRoom's original source code is licensed under GNU Affero General Public License v3.0 or later. See [`LICENSE`](LICENSE).
