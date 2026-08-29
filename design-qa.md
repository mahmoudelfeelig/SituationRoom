# SituationRoom design QA

## Current routed case-file review

The current redesign was judged against the immediately preceding live interface, using the same seeded procurement case, Investigate lens, Chrome binary, and viewport in one combined comparison image.

- Desktop comparison: `C:\Users\mahmo\.codex\visualizations\2026\08\28\01a047d2-aaeb-7de3-8fbb-393bd89ea440\situationroom-ui-audit\comparison-before-after.png`
- Mobile comparison: `C:\Users\mahmo\.codex\visualizations\2026\08\28\01a047d2-aaeb-7de3-8fbb-393bd89ea440\situationroom-ui-audit\comparison-mobile-before-after.png`
- Final desktop capture: `C:\Users\mahmo\.codex\visualizations\2026\08\28\01a047d2-aaeb-7de3-8fbb-393bd89ea440\situationroom-ui-audit\after-investigate-desktop.png`
- Final mobile capture: `C:\Users\mahmo\.codex\visualizations\2026\08\28\01a047d2-aaeb-7de3-8fbb-393bd89ea440\situationroom-ui-audit\after-investigate-mobile.png`

The structural problem was confirmed rather than treated as a spacing defect: the previous page exposed cases, workflow phases, all four lenses, the command rail, the analytical stage, the full Decision Firewall, history, and utilities simultaneously. On mobile, navigation and governance stacked ahead of the task.

The final shell distributes content across `/cases`, `/new`, Model, four analysis-lens routes, Review, and Outputs. Only one primary work surface mounts at a time. The desktop keeps a 210px case-file rail and one document scroll. Mobile navigation is a focus-managed drawer; governance, prompt ideas, and presentation history are compact disclosures.

Measured final state:

- All eight representative destinations have zero document-level horizontal overflow at 1440px and 390px.
- Route headings begin at 150-162px on desktop and 106-123px on mobile.
- Visible routed-shell, instrument, and workflow text has a 12px minimum; body and form copy uses at least 14px.
- The closed mobile drawer is hidden from rendering, pointer interaction, and keyboard focus.
- The final Chrome/Edge UI matrix passes 60/60, and the presentation browser checks pass 2/2.

The combined comparison shows a materially calmer entry hierarchy, an immediately visible route heading and outcome summary, a wider causal stage, and no stacked mobile navigation or full firewall below the decision. The remaining page length is decision content, not duplicated application chrome; long canonical ledgers retain labelled bounded scrolling.

Current result: passed. No actionable P0, P1, or P2 visual issue remains.

## Superseded single-screen baseline

The historical notes below describe the original fixed-rail implementation and are retained only as provenance. They are not the current layout or current verification count.

### Comparison target

- Source visual truth: `C:\Users\mahmo\.codex\generated_images\01a047d2-aaeb-7de3-8fbb-393bd89ea440\exec-4aa3cf20-6466-4176-86c4-7a3f9b56e1c4.png`
- Browser-rendered implementation: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\desktop-1440x1024-investigate.png`
- URL tested: `http://127.0.0.1:4173/`
- State: canonical revision 17, view revision 1, Investigate lens, no WebMCP host available
- CSS viewport: 1440 x 1024
- Device scale factor: 1
- Source pixels: 1487 x 1058
- Implementation pixels: 1440 x 1024
- Normalization: source bicubic-scaled to 1440 x 1024; implementation captured at native CSS size and density

## Visual evidence

- Full-view combined comparison: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\combined-source-vs-implementation-1440x1024.png`
- Focused main-stage comparison: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\focused-main-stage-comparison.png`
- Focused firewall comparison: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\focused-firewall-comparison.png`
- Full implementation page: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\desktop-fullpage-investigate.png`
- Tablet viewport: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\tablet-1024x900-investigate.png`
- Mobile viewport: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\mobile-390x844-investigate.png`
- Mobile full page: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\mobile-390x844-fullpage-investigate.png`
- Re-composed Investigate: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\desktop-investigate-recomposed.png`
- Compare lens: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\desktop-compare.png`
- Simulate lens: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\desktop-simulate.png`
- Brief lens: `D:\Stuff\Projects\Sites\SituationRoom\test-artifacts\desktop-brief.png`

The source and implementation were placed in one normalized comparison image before judgment. Focused regions were required because typography, evidence controls, paper treatment, and Decision Firewall details are too small to assess reliably in the full view.

## Findings

No actionable P0, P1, or P2 mismatch remains after three visual comparison iterations.

- [P3] The source's folder tabs have more physical depth, edge wear, and hardware detail than the runtime file index.
  - Location: left file index.
  - Evidence: the target uses sculpted folder-tab silhouettes and a metal clip; the implementation uses flatter paper-index rows with restrained active-state movement.
  - Impact: the implementation is slightly less tactile, but the archive navigation, hierarchy, selected state, and recurring paper motif remain clear.
  - Classification: acceptable follow-up polish. Reproducing the source's decorative hardware with fake CSS/SVG art would conflict with the runtime-asset constraint; any future enhancement should use an appropriately licensed real asset or remain component-native.

## Required fidelity surfaces

- Fonts and typography: Libre Baskerville plus IBM Plex Sans Condensed/Mono form a coherent serif, condensed-label, and provenance hierarchy. The families and weight contrast fit the source. Small evidence metadata is dense but remains legible at desktop; no actionable typography defect remains.
- Spacing and layout rhythm: the final desktop frame keeps the complete question, dominant causal stage, full secondary evidence/gate/fork row, verified rail, fixed firewall, history rail, and accessibility strip inside 1440 x 1024. Tablet and mobile preserve the hierarchy without horizontal overflow.
- Colors and visual tokens: warm cream, oxblood, pine, amber, and ink map well to the source and semantic states. Focus indicators use a distinct blue. Dense reading surfaces are now solid enough to preserve contrast.
- Image quality and asset fidelity: no generated mock or AI-created runtime image is shipped. The documented public-domain paper source is used only as a grayscale 2.4% micro-grain wash; it no longer produces large decorative forms on cards. The route favicon and interface icons use the MIT-licensed Tabler family.
- Copy and content: case-specific copy is coherent, source-backed, and usable without the design prompt. Differences from the mock's erroneous EU-residency status are intentional corrections to the canonical case, not visual drift.
- Icons: Tabler icons are consistently stroked and optically aligned. No emoji, text-glyph substitution, handcrafted illustration, or fake inline SVG imagery was observed.
- Interaction states: trace, source expansion, challenge, dispute, mapping lock, pin, freeze, history, scenario, approval, Outline, and reduced motion were exercised in the browser. Functional evidence is recorded in `independent-verification.md`.
- Responsiveness: no horizontal document overflow was observed at 1024 x 900 or 390 x 844. Tablet presents the firewall as an immediate compact 2x2 mandatory-gate summary before the working stage. Mobile presents a sticky firewall outcome immediately below the two sticky top rails; the full receipt remains reachable through Why this view.
- Accessibility: the skip link reaches the decision stage, Outline preserves causal reading order, focus indicators are visible, and reduced motion disables transitions. The tested mobile controls remain reachable.

## Comparison history

### Iteration 1

- Earlier evidence: initial implementation capture at 1440 x 1024 plus tablet and mobile captures.
- Earlier findings: desktop history rail outside the frame; responsive firewall not continuously visible; texture scale too coarse.
- Fixes made: converted the desktop app to a 100vh five-row frame; made stage and firewall independently scrollable; surfaced a compact tablet firewall above the stage; moved a sticky mobile firewall ahead of the content; removed texture from reading surfaces and reduced the remaining page wash to grayscale 2.4% micro-grain.
- Post-fix evidence: second desktop, tablet, and mobile browser captures plus refreshed combined comparison.

### Iteration 2

- Earlier finding: the fixed desktop frame exposed the complete history rail but still clipped the commercial evidence, R4 gate, fork, and verified rail at the stage/history boundary.
- Fixes made: compressed desktop-only primary trace, instrument heights, secondary row spacing, compact evidence/gate treatment, fork height, and verified rail while retaining internal scrolling for smaller heights.
- Post-fix evidence: `desktop-1440x1024-investigate.png` and `combined-source-vs-implementation-1440x1024.png` show the full primary and secondary causal content above the complete history rail.

### Iteration 3

- Earlier P0/P1/P2 findings rechecked: history visibility, responsive firewall persistence, texture fidelity, desktop secondary-row clipping.
- Result: resolved. No new P0/P1/P2 issue appeared in Investigate, Compare, Simulate, Brief, tablet, or mobile captures.
- Behavioral corroboration: the final black-box matrix passed 30/30 across installed Chrome and Edge, including active-case/freeze continuity, draft approval blocking, sequential keyboard typing, and modal focus containment.

## Primary interactions and runtime checks

- Natural-language composition into Investigate, Compare, Simulate, and Brief
- Evidence open, trace, challenge, dispute, and human lock
- Evidence pin preservation across composition
- Freeze rejection, undo, forward, and restore default
- Scenario threshold controls, security lock, and hypothetical save
- Human-only approval checkpoint
- Outline, skip link, reduced motion, and responsive reachability
- Console and page errors checked in every isolated browser context; final behavioral run had no errors

## Follow-up polish

- If a suitably licensed physical folder-edge or archival hardware asset is sourced later, consider adding restrained depth to the file index without changing its current responsive anatomy.

superseded baseline result: passed at the time of that audit
