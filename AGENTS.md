# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## SituationRoom product decisions

- The selected visual target is the first image from the latest ideation set: the warm archival "Living Caseboard" with a dominant causal stage, left file index, fixed Decision Firewall, and bottom view-history rail.
- The generated image is design reference only and must never ship as a runtime asset.
- Runtime imagery must be freely licensed and documented. Icons come from an open-source icon library; the paper texture is a public-domain source asset.
- The agent composes validated presentation recipes from trusted primitives. It never generates runtime HTML, CSS, formulas, evidence, decision status, or approval state.
- Decision state, presentation state, and transient interaction state remain separate. View changes must not change the canonical decision revision or hash.
- Preserve four structural views: Investigate, Compare, Simulate, and Brief. The complete manual workflow must remain available without WebMCP.
- Do not expose the case index, workflow phases, all room grammars, the full Decision Firewall, view history, and utility controls simultaneously. The selected case should use route-level Model, Analyze, Review, and Outputs workspaces, with Analyze split into Investigate, Compare, Simulate, and Brief routes; only the current task surface should dominate the page.
- Preserve the Living Caseboard identity through the warm archival palette, functional red route thread, docket typography, and governed evidence instruments. The calmer shell must not become a generic SaaS sidebar dashboard.
- On narrow screens, navigation belongs in a focus-managed drawer and protected governance belongs in a compact expandable summary. Do not stack every desktop rail into one extremely long mobile page.
- Keep the Decision Firewall, mandatory blockers, omitted-context count, decision revision, human pins, and access to the full room visible or reachable in every composition.
- The red thread is functional navigation and causality, not decoration. Motion communicates selection, movement, and downstream impact and must respect reduced-motion preferences.
- Do not use generic dashboard cards, gradients, glassmorphism, decorative blobs, stock startup imagery, emoji, or arbitrary animation.
- SituationRoom is now a general evidence-heavy Decision OS, not a procurement-only product. Procurement remains one domain pack beside candidate review, consumer health-plan comparison, and a generic typed-choice pack.
- The honest product boundary is decision support over explicit alternatives, evidence, constraints, scenarios, and human authority. Do not claim unrestricted autonomous decision-making.
- Imported material compiles into a canonical document and evidence graph with exact page, paragraph, cell, region, or equivalent anchors. Unparsed or uncertain content must remain visibly unresolved rather than being guessed.
- The shared kernel owns alternatives, criteria, constraints, claims, evidence links, deterministic rules, scenarios, revisions, receipts, and approvals. Domain packs may add vocabulary, mappings, policy, pure rules, and instrument hints without generating arbitrary code.
- The central caseboard is compiled from a strict semantic instrument grammar. The fixed governance shell, Decision Firewall, Authority Rail, red causal thread, sources, blockers, pins, and human-only approval remain outside agent control.
- Candidate-review mode must exclude protected attributes from evaluation and never autonomously reject or hire. Consumer health-plan mode may compare coverage and user scenarios but must never underwrite, set premiums, deny claims or benefits, diagnose, or select treatment.
- WebMCP capability discovery is lifecycle-, permission-, and policy-dependent. Expose only a compact non-overlapping set for the current state, validate again at execution time, emit visible receipts, and never expose human approval as a tool.
- Decision, presentation, import-job, and interaction revisions are separate. Mutations use optimistic revisions and idempotency keys; presentation changes never alter the canonical decision digest.
- Preserve a complete manual workflow and accessible outline when WebMCP is absent. Chrome and Edge WebMCP tests must use the real API behind the browser feature flag when available, in addition to deterministic gateway tests.
- Treat an actual Codex Site tools run as a separate release gate: natural-language tool selection, built-in-browser safety review, Recently used source evidence, and visible receipts are not proven by direct `getTools()` or `executeTool()` tests.
- Production deploys must consume the exact checksummed image and release files produced by a successful unsuperseded `main` CI run. Keep strict SSH host verification, immutable releases, serialized deployment, public smoke checks, and automatic rollback; routine application deploys must not mutate Cloudflare or the shared Caddy route.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
