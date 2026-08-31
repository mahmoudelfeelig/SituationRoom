# SituationRoom independent verification

## Verification scope

This record covers the generalized Decision OS, its four domain packs, native import and recovery pipeline, cross-document semantic intake, typed decision kernel, routed agent-constructed room views, receipt-backed agent activity and decision playback, model-evidence scoring, shared human-governance boundary, browser UI, real WebMCP gateway, and public production behavior.

The public production endpoint was verified. This document deliberately records no host, credential, private-network, or origin-routing detail. No challenge submission or external message was sent.

## Fresh release evidence

The complete release gate is available through the repository's aggregate command:

```text
npm run test:all
```

The named npm gates were executed directly and serially after the final relevant application corrections so every Vite and browser result remained attributable. Every component gate below passed; this record does not claim one aggregate-command exit code.

| Browser project | Configured coverage |
| --- | --- |
| Installed Google Chrome | Every black-box UI and real WebMCP specification |
| Installed Microsoft Edge | Every black-box UI and real WebMCP specification |

| Gate | Final post-correction result |
| --- | --- |
| Deterministic Node suite: kernel, import, semantic intake, persistence, routing, workspace, policy, exporter, presentation, activity/playback, model evidence, and WebMCP | Passed: 187/187 tests |
| OCR smoke test | Passed: local OCR recovered `SITUATION ROOM 2040` |
| Browser kernel smoke | Passed: local runtime, OCR, IndexedDB, invocation journal, receipts, and retry recovery |
| Sites worker, Hetzner hosting, and CI/CD contract | Passed: 12/12 tests |
| Presentation browser checks | Passed: 2/2 tests |
| Full UI suite in installed Chrome and Edge | Passed: 62/62 tests |
| Real WebMCP suite in installed Chrome and Edge | Passed: 14/14 tests using the browser feature flag and page-registered API |
| Production build and Sites artifacts | Passed; all three required artifacts verified on disk |

The successful direct runs establish the component coverage without representing an aggregate npm result.

## GitHub pre-release checkpoint

An early trusted `main` run passed actionlint, POSIX shell validation, OCR, browser-kernel, presentation, all 60 Chrome/Edge UI checks, and all 14 Chrome/Edge WebMCP checks.

The quality job failed closed because the clean Ubuntu runner executed the generated Sites-artifact assertion before running the production build. The release job was skipped, so the deployment workflow did not mutate production. CI was corrected to build before `test:sites`, and the workflow contract now asserts that ordering. This paragraph is a timestamped pre-release checkpoint; the current release state is established by the latest successful Actions run and the public `/release.json`, not by assuming a pending run succeeded.

The repository now exposes only a thin production caller. After a successful trusted `main` run, it invokes the public reusable [Hetzner Release Gateway](https://github.com/mahmoudelfeelig/HetznerReleaseGateway) at an immutable reviewed commit and passes application identity plus CI provenance. Deployment credentials, topology, activation policy, rollback implementation, and receipt signing are centralized outside this repository. Reviewers verify the result through the public release metadata, HTTPS behavior, browsers, and corresponding-source download described below.

## Actual Codex connection status

The automated WebMCP suite uses the real top-level browser API in installed Chrome and Edge, but it selects and executes tool names directly. The application now includes a fresh-arm, case-scoped Site-tools acceptance console and privacy-bounded evidence export, plus an offline scorer for the ten-case corpus. As of this checkpoint, no Codex model had independently discovered and selected SituationRoom Site tools from a natural-language request, and no **Recently used > Sources** capture had been recorded. The console therefore reports no model pass. That separate acceptance gate is defined in [`docs/CODEX_SITE_TOOLS_ACCEPTANCE.md`](docs/CODEX_SITE_TOOLS_ACCEPTANCE.md).

## Public production verification

The public results below describe the previously deployed release. The current semantic-intake, activity, playback, and evaluation-console expansion remains an uncommitted local working tree at this checkpoint and must not be represented as live until a separately authorized push and deployment complete successfully.

The production release is available at `https://situationroom.elfeel.me`. Verification is intentionally limited to the same public surfaces available to a reviewer; it does not require privileged host access, direct-origin requests, DNS overrides, or knowledge of the private deployment topology.

| Public property | Verified result |
| --- | --- |
| TLS | The public hostname completed normal HTTPS certificate validation |
| Release metadata | `/release.json` was reachable for comparison with repository history |
| Live UI | Passed: 48/48 checks against the public hostname in installed Chrome and Edge |
| Live WebMCP | Passed: 12/12 real browser checks against the public hostname in installed Chrome and Edge |
| Live OCR/browser kernel | Passed: OCR worker, WASM loader, versioned English model, extracted text, and durable IndexedDB mode |
| Public HTTP contract | Root and an HTML deep link returned 200; a missing asset returned 404 with `no-store`; API and unsupported-method requests returned errors; JavaScript, CSS, and OCR assets returned the correct MIME type and immutable caching |
| Corresponding source | `/source/SituationRoom-source.tar.gz` was downloadable with attachment disposition |

HTML uses `public, no-cache, must-revalidate, no-transform`. Existing fingerprinted assets are immutable; missing assets and missing source paths are explicitly `no-store`, preventing negative-cache poisoning.

An independent reviewer can repeat the public checks with a standard HTTPS client and installed Chrome or Edge: validate the root and a copied deep link, confirm the missing-resource and unsupported-method behavior, inspect `/release.json`, download the corresponding-source archive, exercise the primary UI workflow, and run WebMCP checks only when the browser exposes the required feature. No origin-bypass procedure is part of the acceptance evidence.

## What the browser evidence establishes

A passing local UI matrix establishes all four decision domains, canonical routes and browser history, isolated work surfaces, structural room recomposition, real-call activity display, decision-history comparison, semantic import review, scenario work, editing, approval restrictions, responsive layouts, accessibility, keyboard-only dialog behavior, shared freeze enforcement, session-only fallback, bounded output retention, and state continuity after reload.

The real WebMCP matrix invokes page-registered tools rather than test doubles. A passing final run establishes state-aware discovery, optimistic concurrency, durable idempotent replay, conflicting-key rejection, safe expired pre-execution reclamation, fail-closed outcome uncertainty after the execution boundary, exact case/job source scoping, import review, shared human-resolution staging, cross-tab freeze propagation, session-only mutation retirement, candidate-domain privacy projections, authoritative domain mismatch denial, protected-term search filtering without a presence oracle, bounded output retention, and reload-safe continuation.

Candidate source inspection fixtures cover protected headers, correlated row values, structured data, metadata, diagnostics, excerpts, spans, and search totals. Candidate evaluator and exporter fixtures require requirement-evidence-only output with no eligibility, score, rank, blockers, recommendation, or employment outcome. Health-plan policy validation traverses contract purpose, source-backed plan identity, positively typed criteria, alternatives, constraints, claims, and scenarios while rejecting diagnosis, treatment selection, clinical-outcome optimization, underwriting, personalized risk or pricing, denial, and adjudication purposes.

## Recovery and exactness checks

Import fixtures cover serialized mapping and acceptance races, stale-version rejection, low-confidence proposed evidence, discard cleanup recovery, retry lineage, interrupted commit resumption, post-command storage-failure reconciliation, deletion-only recovery after canonical acceptance, durable intake intent, and prompt-injection boundaries across filename, document text, spreadsheet cell, HTML, comment, and email surfaces. Workspace concurrency fixtures keep delayed model, approval, scenario, pin, and composition results bound to their captured case and revision across navigation and shared-freeze races. Minimum-change analysis refuses to call continuous numeric exclusions exact unless a trusted discrete step makes the search complete.

Reload fixtures cover the selected case, shared manual freeze, full human-resolution checkpoints, draft contracts, active path and focus, WebMCP invocation replay, the bounded receipt ledger, imports, canonical post-purge source reads, output artifacts, and review artifacts. Draft contracts remain visibly draft and cannot enter approval until explicitly activated.

## Build observations

Vite completed a production build after transforming 6,416 modules. The required outputs `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json` were then verified on disk. Vite emitted two non-blocking advisories: `fflate` is both statically and dynamically imported, so that dependency does not move into a separate dynamic chunk, and the PDF/OCR-capable client has minified chunks above the default 500 kB warning threshold. Neither warning prevented the build or the Sites artifact preparation step.

## Deliberate format boundaries

Legacy Office and OpenDocument files, Outlook MSG, HEIC, and Parquet are detected and routed to an explicit diagnostic or conversion-required state rather than being silently misparsed. Password-protected inputs require decryption, scanned PDFs follow the image/OCR route, English is the current OCR language, and spreadsheet formulas depend on cached values when the workbook does not provide a calculation engine.

These are surfaced limitations, not hidden success paths.

## Verdict

The routed local build passes every directly executed deterministic, OCR, browser-kernel, hosting-contract, presentation, Chrome/Edge UI, native WebMCP, audit, and production-build gate recorded above. The earlier GitHub run independently confirmed repository lint and the then-current Windows browser matrix, then correctly blocked release on the clean-checkout ordering defect described above; it is not CI evidence for the present uncommitted expansion. Actual Codex natural-language Site tools acceptance, an authorized commit/push/deployment, recording the challenge demonstration, and submitting the entry remain separate operational gates.
