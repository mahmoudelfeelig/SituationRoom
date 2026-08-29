# SituationRoom independent verification

## Verification scope

This record covers the generalized Decision OS, its four domain packs, native import and recovery pipeline, typed decision kernel, routed agent-constructed room views, shared human-governance boundary, browser UI, real WebMCP gateway, and the pre-automation Hetzner/Cloudflare baseline.

Production deployment and the scoped Cloudflare DNS change were performed. No challenge submission or external message was sent.

## Fresh release evidence

The complete release gate is available through the repository's aggregate command:

```text
& "C:\Program Files\nodejs\npm.cmd" run test:all
```

The named npm gates were executed directly and serially after the final relevant application corrections so every Vite and browser result remained attributable. Every component gate below passed; this record does not claim one aggregate-command exit code.

| Browser project | Installed binary at audit | Configured coverage |
| --- | --- | --- |
| Google Chrome `151.0.7922.175` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Every black-box UI and real WebMCP specification |
| Microsoft Edge `152.0.4191.53` | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Every black-box UI and real WebMCP specification |

| Gate | Final post-correction result |
| --- | --- |
| Deterministic Node suite: kernel, import, persistence, routing, workspace, policy, exporter, presentation, and WebMCP | Passed: 152/152 tests |
| OCR smoke test | Passed: local OCR recovered `SITUATION ROOM 2040` |
| Browser kernel smoke | Passed: local runtime, OCR, IndexedDB, invocation journal, receipts, and retry recovery |
| Sites worker, Hetzner hosting, and CI/CD contract | Passed: 11/11 tests |
| Presentation browser checks | Passed: 2/2 tests |
| Full UI suite in installed Chrome and Edge | Passed: 60/60 tests |
| Real WebMCP suite in installed Chrome and Edge | Passed: 14/14 tests using the browser feature flag and page-registered API |
| Production build and Sites artifacts | Passed; all three required artifacts verified on disk |

The successful direct runs establish the component coverage without representing an aggregate npm result.

## GitHub pre-release checkpoint

The first `main` push created `SituationRoom CI` run `33259196449` for commit `3291d0101488ed39a974f4358005eec668fc3f83`. The repository job passed actionlint and POSIX shell validation. The Windows browser job passed OCR, browser-kernel, presentation, all 60 Chrome/Edge UI checks, and all 14 Chrome/Edge WebMCP checks.

The quality job failed closed because the clean Ubuntu runner executed the generated Sites-artifact assertion before running the production build. The release job was skipped, so the deployment workflow did not mutate production. CI was corrected to build before `test:sites`, and the workflow contract now asserts that ordering. This paragraph is a timestamped pre-release checkpoint; the current release state is established by the latest successful Actions run and the public `/release.json`, not by assuming a pending run succeeded.

## Actual Codex connection status

The automated WebMCP suite uses the real top-level browser API in installed Chrome and Edge, but it selects and executes tool names directly. As of this checkpoint, no Codex model had independently discovered and selected SituationRoom Site tools from a natural-language request, and no **Recently used > Sources** capture had been recorded. That separate acceptance gate is defined in [`docs/CODEX_SITE_TOOLS_ACCEPTANCE.md`](docs/CODEX_SITE_TOOLS_ACCEPTANCE.md).

## Pre-automation production baseline

The production facts below capture the release that existed before GitHub-driven deployment was enabled. They are historical baseline evidence rather than a claim about the current release pointer.

The production release is available at `https://situationroom.elfeel.me`.

| Production property | Verified result |
| --- | --- |
| Release archive | SHA-256 `afe6aa4f5f30d1df30a7b09a9a6537a96bec5cce7135f236bd444814648cdc17` |
| Hetzner workload | Image `situationroom-web:afe6aa4f5f30d1df`; healthy; user `10001:10001`; read-only root; all Linux capabilities dropped; no host port bindings |
| Network path | Private `web` Docker network to the shared Caddy reverse proxy |
| Cloudflare | Proxied A record for `situationroom.elfeel.me` targeting `65.21.109.224` |
| TLS | Public HTTPS validated through Cloudflare; Caddy obtained a production Let's Encrypt origin certificate |
| Live UI | Passed: 48/48 checks against the public hostname in installed Chrome and Edge |
| Live WebMCP | Passed: 12/12 real browser checks against the public hostname in installed Chrome and Edge |
| Live OCR/browser kernel | Passed: OCR worker, WASM loader, versioned English model, extracted text, and durable IndexedDB mode |
| Public HTTP contract | Root and HTML deep link 200; missing asset 404 `no-store`; API and POST requests 404; JavaScript/CSS and OCR assets 200 with correct MIME and immutable caching |
| Corresponding source | Downloadable `/source/SituationRoom-source.tar.gz` with attachment disposition |
| Neighbor regression | `https://systemforge.elfeel.me/` remained 200 after the shared route update |

HTML uses `public, no-cache, must-revalidate, no-transform`, preventing Cloudflare Web Analytics from rewriting the application payload. The Tesseract model is emitted at the versioned path `/assets/ocr/4.0.0_best_int/eng.traineddata.gz`. Existing assets are immutable; missing assets and missing source paths are explicitly `no-store`, preventing negative-cache poisoning.

The shared-Caddy bind-mount maintenance was completed on 2026-08-29 after explicit approval. Only the Caddy service was recreated; its persistent certificate/config volumes and external web network were preserved. The replacement container (`96cab396d6030767ac02ca839d079e973a5389484ca0ffbb56569bfa69336b36`) is running, the host and in-container Caddyfiles both hash to `95169476ab2c5a3dfe1194b3b19ea12012cc9d2a6d6091289587197336d3f8c1`, and the mounted configuration validates from inside the container. Caddy loaded all ten configured domains. Post-recreation public probes returned 200 for SituationRoom, SystemForge, and the other site roots; the API-only hostname remained reachable and returned its application-level 404 at `/` rather than a proxy or TLS failure.

## What the browser evidence establishes

A passing UI matrix establishes all four decision domains, canonical routes and browser history, isolated work surfaces, structural room recomposition, scenario work, editing, import review, approval restrictions, responsive layouts, accessibility, keyboard-only dialog behavior, shared freeze enforcement, session-only fallback, bounded output retention, and state continuity after reload.

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

The routed local build passes every directly executed deterministic, OCR, browser-kernel, hosting-contract, presentation, Chrome/Edge UI, native WebMCP, audit, and production-build gate. The first GitHub run independently confirmed repository lint and the full Windows browser matrix, then correctly blocked release on the clean-checkout ordering defect described above. Actual Codex natural-language Site tools acceptance, recording the challenge demonstration, and submitting the entry remain separate operational gates.
