# Semantic presentation compiler

The presentation compiler is the trust boundary between a canonical decision case and the adaptive Living Caseboard UI. Domain adapters provide normalized data. Agents provide bounded semantic recipes. The compiler resolves both into immutable plans built only from trusted layout and instrument primitives.

The compiler never accepts HTML, CSS, JavaScript, formulas, graph edges, evidence text, status colors, approval state, or external actions from a recipe.

## Integration

```jsx
import { CompiledRoomView } from "../components/composer/CompiledRoomView.jsx";
import {
  compilePresentation,
  createDefaultPresentationRecipe,
} from "./index.js";
import "../styles/composition.css";

const recipe = createDefaultPresentationRecipe(snapshot, {
  lens: "investigate",
  question: "Explain the decisive evidence.",
});
const result = compilePresentation(snapshot, recipe, {
  maxInstrumentCount: 10,
});

if (result.ok) {
  // Commit result.plan atomically in presentation state.
  return (
    <CompiledRoomView
      snapshot={snapshot}
      plan={result.plan}
      onAction={handleGovernedPresentationAction}
    />
  );
}
```

`compilePresentation(snapshot, recipe, environment?)` returns:

```js
{ ok: true, plan, warnings }
```

or:

```js
{ ok: false, error, errors }
```

The caller preserves the existing plan when compilation fails. The only trusted environment option is `maxInstrumentCount`, an integer from 2 through 24.

`CompiledRoomView` accepts `snapshot`, `plan`, optional `onAction`, and optional `className`. Governed actions contain `type`, `instrumentId`, `planId`, `viewHash`, and an optional canonical `entityRef` or primitive `value`. The application adapter decides whether and how to execute them.

## Snapshot contract

```js
{
  schemaVersion: "1.0",
  caseId,
  decisionRevision,
  decisionHash,
  viewRevision,
  frozen,
  domain: { id, kind, label, riskLevel? },
  contract: { title, question, status?, authority? },
  entities: [],
  results: [],
  relations: [],
  paths: [],
  sources: [],
  pins: [],
  protected: {
    entityRefs: [],
    blockerResultIds: [],
    omittedEntityCount,
    prohibitedEntityKinds: [],
    authority: { mode, canApprove }
  },
  policy: {
    allowedInstrumentTypes: null,
    blockedInstrumentTypes: [],
    maxInstrumentCount
  },
  permissions: { canCompose, canSimulate, canApprove },
  metadata: {},
  domainData: {}
}
```

Canonical entities use:

```js
{ id, kind, label, summary?, status?, attributes? }
```

Results use:

```js
{
  id,
  kind: "evaluation",
  label?,
  subjectId?,
  criterionId?,
  status,
  value?,
  unit?,
  reason?,
  evidenceIds?
}
```

Relations use `{ id, type, from: {kind,id}, to: {kind,id} }`. Paths use `{ id, label?, entityRefs, resultIds?, status? }`. Sources use `{ id, kind: "source", label, format, status, version?, locations? }`. A location uses `{ label, locator }`.

Pins are allowed to become temporarily unresolved after a reimport. They remain in the plan as visible warnings. Broken relations, paths, result subjects, result criteria, evidence IDs, and blocker IDs invalidate the snapshot.

## Instrument data conventions

| Instrument family | Canonical data consumed |
| --- | --- |
| Evidence excerpt | `evidence` entity; `summary`; `status`; `attributes.citation`, `sourceId`, `confidence`, or `location` |
| Source preview | source `label`, `format`, `status`, `version`, and `locations` |
| Claim interpretation | `claim` or `interpretation` entity; `summary`; `status`; `attributes.confidence` |
| Constraint gate | `constraint`, `requirement`, or `criterion` entities plus results whose `criterionId` matches |
| Outcome and decision brief | alternatives plus results whose `subjectId` matches; result `status`, `reason`, `value`, `unit`, and `evidenceIds` |
| Causal trace | a canonical path with ordered `entityRefs` and optional `resultIds` |
| Contradiction docket | relations with type `contradicts`, `disputes`, or `opposes` |
| Comparison matrix | alternatives, criteria, and results keyed by `subjectId` and `criterionId` |
| Metric and score instruments | finite numeric result `value` and optional `unit` |
| Scenario controls | `control` entities with `attributes.control`, `value`, and optional `baseline`; range controls use `min`, `max`, and `step`; selects use primitive `options` |
| Timeline | entities with `attributes.date` or `attributes.start` and optional `end` |
| Risk frontier | alternatives with canonical `attributes.risk` and `benefit`, or numeric results explicitly labeled as risk/cost and benefit/score |
| Stakeholder mandate | `stakeholder`, `actor`, or `reviewer` entity; `attributes.question`, `mandate`, or `authority` |
| Health-plan instruments | the same generic fields, with optional `provider`, `network`, `facility`, `drug`, `medication`, or `formulary-entry` kinds |
| Candidate instruments | the same generic fields, with protected kinds listed in `protected.prohibitedEntityKinds` |

`domainData` may carry non-authoritative adapter extensions. Components must not use it to override canonical results, authority, status, formulas, or citations.

## Layout grammar

The four immutable layout mappings are:

```text
investigate -> trace
compare     -> matrix
simulate    -> fork
brief       -> council
```

Every instrument is placed in `primary`, `secondary`, or `supporting`. The compiler injects `protected-invariants`, `pinned-context`, and the candidate-domain `bias-shield` outside recipe control.

## Safe lifecycle

The caller reads a canonical snapshot, constructs or receives a recipe, compiles against expected decision and view revisions, and commits the complete plan atomically. A stale, frozen, unauthorized, malformed, unsupported, or policy-blocked recipe fails without a partial plan. The plan includes the unchanged decision hash, the next view revision, visible entity references, omitted context, preserved pins, unresolved protected references, warnings, and a deterministic view hash.

