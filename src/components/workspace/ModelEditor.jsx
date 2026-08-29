import { useEffect, useMemo, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconFileDescription,
  IconPlus,
  IconRotate,
  IconTrash,
} from "@tabler/icons-react";
import { decideModelProposal, replaceDecisionModel } from "../../workspace/workspaceStore.js";
import { HEALTH_PLAN_CRITERION_ASPECTS, HEALTH_PLAN_TYPES } from "../../domain-packs/healthPlan.js";
import { CANDIDATE_JOB_ASPECTS } from "../../domain-packs/candidateReview.js";
import { sha256Hex } from "../../kernel/index.js";

const CRITERION_KINDS = ["gate", "score", "informational"];
const VALUE_TYPES = ["boolean", "number", "currency", "string", "enum", "date"];
const CONSTRAINT_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "not_in"];
const CLAIM_STATUSES = ["proposed", "accepted", "disputed", "rejected"];

function editorId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:manual:${suffix}`.slice(0, 128);
}

function jsonText(value, fallback = "") {
  if (value === undefined) return fallback;
  return JSON.stringify(value);
}

function createDraft(decisionCase) {
  return {
    alternatives: decisionCase.alternatives.map((entry) => ({ ...entry })),
    criteria: decisionCase.criteria.map((entry) => ({
      ...entry,
      weightText: entry.weight === undefined ? "" : String(entry.weight),
      scoringText: jsonText(entry.scoring),
      allowedValuesText: jsonText(entry.allowedValues),
    })),
    constraints: decisionCase.constraints.map((entry) => ({
      ...entry,
      expectedText: jsonText(entry.expected, "null"),
    })),
    claims: decisionCase.claims.map((entry) => ({
      ...entry,
      valueText: jsonText(entry.value, "null"),
      confidenceText: entry.confidence === undefined ? "" : String(entry.confidence),
    })),
  };
}

function parseTypedValue(text, criterion, label) {
  const value = String(text ?? "").trim();
  if (criterion?.valueType === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${label} must be true or false.`);
  }
  if (["number", "currency"].includes(criterion?.valueType)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
    return parsed;
  }
  if (criterion?.valueType === "date") {
    if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO-compatible date.`);
    return value;
  }
  if (["string", "enum"].includes(criterion?.valueType)) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error();
      return parsed;
    } catch {
      return value;
    }
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseObject(text, label) {
  if (!String(text ?? "").trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function parseArray(text, label) {
  if (!String(text ?? "").trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed;
}

function move(items, index, offset) {
  const target = index + offset;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function RowActions({ label, index, count, onMove, onRemove, disableRemove = false }) {
  return (
    <div className="model-row-actions">
      <button type="button" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(-1)}><IconArrowUp size={15} /></button>
      <button type="button" aria-label={`Move ${label} down`} disabled={index === count - 1} onClick={() => onMove(1)}><IconArrowDown size={15} /></button>
      <button type="button" aria-label={`Remove ${label}`} disabled={disableRemove} onClick={onRemove}><IconTrash size={15} /></button>
    </div>
  );
}

function proposalValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ModelEditor({ room }) {
  const [draft, setDraft] = useState(() => createDraft(room.activeCase));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(createDraft(room.activeCase));
    setError("");
  }, [room.activeCase.id, room.activeCase.revision]);

  const criteriaById = useMemo(() => new Map(draft.criteria.map((entry) => [entry.id, entry])), [draft.criteria]);
  const isHealthPlan = room.activeCase.domain.packId === "health-plan";
  const isCandidateReview = room.activeCase.domain.packId === "candidate-review";
  const dirty = JSON.stringify(draft) !== JSON.stringify(createDraft(room.activeCase));

  function update(collection, index, patch) {
    setDraft((current) => ({
      ...current,
      [collection]: current[collection].map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry),
    }));
  }

  function updatePlanIdentity(index, patch) {
    setDraft((current) => ({
      ...current,
      alternatives: current.alternatives.map((entry, entryIndex) => entryIndex === index
        ? { ...entry, planIdentity: { ...(entry.planIdentity ?? {}), ...patch } }
        : entry),
    }));
  }

  function setPlanIdentitySource(index, fragmentId) {
    if (!fragmentId) {
      updatePlanIdentity(index, { sourceRefs: [] });
      return;
    }
    const fragment = room.activeCase.fragments.find((entry) => entry.id === fragmentId);
    if (!fragment) return;
    updatePlanIdentity(index, {
      sourceRefs: [{
        documentId: fragment.documentId,
        fragmentId: fragment.id,
        locator: fragment.locator,
        quoteHash: `sha256:${sha256Hex(fragment.text)}`,
      }],
    });
  }

  function removeAlternative(index) {
    const alternativeId = draft.alternatives[index].id;
    setDraft((current) => ({
      ...current,
      alternatives: current.alternatives.filter((_, entryIndex) => entryIndex !== index),
      claims: current.claims.filter((claim) => claim.subjectId !== alternativeId),
      constraints: current.constraints.map((constraint) => ({
        ...constraint,
        alternativeIds: constraint.alternativeIds?.filter((id) => id !== alternativeId),
      })),
    }));
  }

  function removeCriterion(index) {
    const criterionId = draft.criteria[index].id;
    setDraft((current) => ({
      ...current,
      criteria: current.criteria.filter((_, entryIndex) => entryIndex !== index),
      constraints: current.constraints.filter((constraint) => constraint.criterionId !== criterionId),
      claims: current.claims.filter((claim) => claim.criterionId !== criterionId),
    }));
  }

  function buildModel() {
    const criteria = draft.criteria.map(({ weightText, scoringText, allowedValuesText, ...criterion }) => {
      const next = { ...criterion };
      if (next.kind === "score") {
        const weight = Number(weightText);
        if (!Number.isFinite(weight) || weight < 0) throw new Error(`${next.label || next.id} needs a non-negative score weight.`);
        next.weight = weight;
        next.scoring = parseObject(scoringText, `${next.label || next.id} scoring`);
        if (!next.scoring) throw new Error(`${next.label || next.id} needs an explicit scoring object.`);
      } else {
        delete next.weight;
        delete next.scoring;
      }
      const allowedValues = parseArray(allowedValuesText, `${next.label || next.id} allowed values`);
      if (allowedValues) next.allowedValues = allowedValues;
      else delete next.allowedValues;
      if (!String(next.unit ?? "").trim()) delete next.unit;
      return next;
    });
    const builtCriteria = new Map(criteria.map((entry) => [entry.id, entry]));
    const constraints = draft.constraints.map(({ expectedText, ...constraint }) => ({
      ...constraint,
      expected: parseTypedValue(expectedText, builtCriteria.get(constraint.criterionId), `${constraint.id} expected value`),
    }));
    const claims = draft.claims.map(({ valueText, confidenceText, ...claim }) => {
      const confidence = confidenceText === "" ? undefined : Number(confidenceText);
      if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
        throw new Error(`${claim.id} confidence must be between zero and one.`);
      }
      return {
        ...claim,
        value: parseTypedValue(valueText, builtCriteria.get(claim.criterionId), `${claim.id} value`),
        ...(confidence === undefined ? {} : { confidence }),
      };
    });
    return {
      alternatives: draft.alternatives.map((entry) => ({ ...entry })),
      criteria,
      constraints,
      claims,
    };
  }

  async function apply() {
    setBusy(true);
    setError("");
    try {
      await replaceDecisionModel(buildModel());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="typed-model-editor" aria-labelledby="typed-model-editor-title">
      <header>
        <div>
          <span className="os-eyebrow">Atomic typed revision</span>
          <h3 id="typed-model-editor-title">Decision model editor</h3>
          <p>Correct inferred structure before activation. Every apply revalidates domain policy, source links, claim types, and protected fields as one revision.</p>
        </div>
        <div className="typed-model-editor__counts" aria-label="Model counts">
          <span><strong>{draft.alternatives.length}</strong> alternatives</span>
          <span><strong>{draft.criteria.length}</strong> criteria</span>
          <span><strong>{draft.constraints.length}</strong> constraints</span>
          <span><strong>{draft.claims.length}</strong> claims</span>
        </div>
      </header>

      {room.pendingModelProposal ? (
        <aside className="model-proposal-brief" aria-labelledby="model-proposal-title">
          <IconFileDescription size={19} aria-hidden="true" />
          <div>
            <span className="os-eyebrow">Agent draft · canonical model unchanged</span>
            <h4 id="model-proposal-title">{room.pendingModelProposal.kind.replaceAll("_", " ")}</h4>
            <p>{room.pendingModelProposal.body}</p>
            <dl>
              {Object.entries(room.pendingModelProposal.proposal ?? {}).filter(([key]) => !["caseId", "expectedDecisionRevision", "idempotencyKey"].includes(key)).slice(0, 12).map(([key, value]) => (
                <div key={key}><dt>{key.replaceAll(/([A-Z])/g, " $1")}</dt><dd>{proposalValue(value).slice(0, 500)}</dd></div>
              ))}
            </dl>
          </div>
          <button type="button" onClick={() => decideModelProposal(room.pendingModelProposal.id, "defer")}>Return to review</button>
        </aside>
      ) : null}

      <details open className="model-editor-section">
        <summary>Alternatives <span>editable and ordered</span></summary>
        <ol className="model-editor-ledger">
          {draft.alternatives.map((alternative, index) => (
            <li key={alternative.id} className="model-editor-row model-editor-row--alternative">
              <code>{alternative.id}</code>
              <label>Name<input value={alternative.label ?? ""} maxLength={200} onChange={(event) => update("alternatives", index, { label: event.target.value })} /></label>
              <label>Description<input value={alternative.description ?? ""} maxLength={500} onChange={(event) => update("alternatives", index, { description: event.target.value })} /></label>
              {isHealthPlan ? <label>Semantic type<select value={alternative.entityType ?? "unclassified"} onChange={(event) => update("alternatives", index, { entityType: event.target.value })}><option value="unclassified">unclassified</option><option value="insurance-plan">insurance-plan</option></select></label> : null}
              {isHealthPlan ? <>
                <label>Issuer<input value={alternative.planIdentity?.issuer ?? ""} maxLength={120} onChange={(event) => updatePlanIdentity(index, { issuer: event.target.value })} /></label>
                <label>Plan or policy ID<input value={alternative.planIdentity?.planId ?? ""} maxLength={80} onChange={(event) => updatePlanIdentity(index, { planId: event.target.value })} /></label>
                <label>Plan type<select value={alternative.planIdentity?.planType ?? ""} onChange={(event) => updatePlanIdentity(index, { planType: event.target.value })}><option value="">Choose type</option>{HEALTH_PLAN_TYPES.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
                <label>Identity source<select value={alternative.planIdentity?.sourceRefs?.[0]?.fragmentId ?? ""} onChange={(event) => setPlanIdentitySource(index, event.target.value)}><option value="">Choose exact source</option>{room.activeCase.fragments.map((fragment) => <option value={fragment.id} key={fragment.id}>{fragment.id}</option>)}</select></label>
              </> : null}
              <RowActions label={alternative.label || alternative.id} index={index} count={draft.alternatives.length} disableRemove={draft.alternatives.length <= 1} onMove={(offset) => setDraft((current) => ({ ...current, alternatives: move(current.alternatives, index, offset) }))} onRemove={() => removeAlternative(index)} />
            </li>
          ))}
        </ol>
        <button type="button" className="model-add-row" onClick={() => setDraft((current) => ({ ...current, alternatives: [...current.alternatives, { id: editorId("alternative"), label: isHealthPlan ? "New insurance plan" : isCandidateReview ? `Candidate ${current.alternatives.length + 1}` : "New alternative", description: isCandidateReview ? "Blinded application" : "", ...(isHealthPlan ? { entityType: "insurance-plan", planIdentity: { issuer: "", planId: "", planType: "", sourceRefs: [] } } : {}) }] }))}><IconPlus size={16} /> Add alternative</button>
      </details>

      <details className="model-editor-section">
        <summary>Criteria <span>types, weights, directions, and units</span></summary>
        <ol className="model-editor-ledger">
          {draft.criteria.map((criterion, index) => (
            <li key={criterion.id} className="model-editor-row model-editor-row--criterion">
              <code>{criterion.id}</code>
              <label>Label<input value={criterion.label ?? ""} maxLength={200} onChange={(event) => update("criteria", index, { label: event.target.value })} /></label>
              <label>Kind<select value={criterion.kind} onChange={(event) => update("criteria", index, { kind: event.target.value })}>{CRITERION_KINDS.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label>Value type<select value={criterion.valueType} onChange={(event) => update("criteria", index, { valueType: event.target.value })}>{VALUE_TYPES.map((value) => <option key={value}>{value}</option>)}</select></label>
              {isHealthPlan ? <label>Plan aspect<select value={criterion.planAspect ?? ""} onChange={(event) => update("criteria", index, { planAspect: event.target.value })}><option value="">Choose plan term</option>{HEALTH_PLAN_CRITERION_ASPECTS.map((value) => <option value={value} key={value}>{value}</option>)}</select></label> : null}
              {isCandidateReview ? <label>Job-related aspect<select value={criterion.candidateAspect ?? ""} onChange={(event) => update("criteria", index, { candidateAspect: event.target.value })}><option value="">Choose job evidence</option>{CANDIDATE_JOB_ASPECTS.map((value) => <option value={value} key={value}>{value}</option>)}</select></label> : null}
              <label>Unit<input value={criterion.unit ?? ""} maxLength={40} onChange={(event) => update("criteria", index, { unit: event.target.value })} /></label>
              <label>Weight<input type="number" min="0" step="1" disabled={criterion.kind !== "score"} value={criterion.weightText} onChange={(event) => update("criteria", index, { weightText: event.target.value })} /></label>
              <label className="model-json-field">Scoring JSON<textarea rows={2} disabled={criterion.kind !== "score"} value={criterion.scoringText} onChange={(event) => update("criteria", index, { scoringText: event.target.value })} /></label>
              <label className="model-json-field">Allowed values JSON<textarea rows={2} value={criterion.allowedValuesText} onChange={(event) => update("criteria", index, { allowedValuesText: event.target.value })} /></label>
              <RowActions label={criterion.label || criterion.id} index={index} count={draft.criteria.length} disableRemove={draft.criteria.length <= 1} onMove={(offset) => setDraft((current) => ({ ...current, criteria: move(current.criteria, index, offset) }))} onRemove={() => removeCriterion(index)} />
            </li>
          ))}
        </ol>
        <button type="button" className="model-add-row" onClick={() => setDraft((current) => ({ ...current, criteria: [...current.criteria, { id: editorId("criterion"), label: isHealthPlan ? "Monthly premium" : isCandidateReview ? "Verified technical experience" : "New criterion", kind: "informational", valueType: "string", unit: "", weightText: "", scoringText: "", allowedValuesText: "", ...(isHealthPlan ? { planAspect: "premium" } : {}), ...(isCandidateReview ? { candidateAspect: "technical-experience" } : {}) }] }))}><IconPlus size={16} /> Add criterion</button>
      </details>

      <details className="model-editor-section">
        <summary>Constraints <span>typed mandatory and advisory gates</span></summary>
        <ol className="model-editor-ledger">
          {draft.constraints.map((constraint, index) => (
            <li key={constraint.id} className="model-editor-row model-editor-row--constraint">
              <code>{constraint.id}</code>
              <label>Criterion<select value={constraint.criterionId} onChange={(event) => update("constraints", index, { criterionId: event.target.value })}>{draft.criteria.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>
              <label>Operator<select value={constraint.operator} onChange={(event) => update("constraints", index, { operator: event.target.value })}>{CONSTRAINT_OPERATORS.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label>Expected<input value={constraint.expectedText} onChange={(event) => update("constraints", index, { expectedText: event.target.value })} /></label>
              <label>Severity<select value={constraint.severity} onChange={(event) => update("constraints", index, { severity: event.target.value })}><option value="mandatory">mandatory</option><option value="advisory">advisory</option></select></label>
              <RowActions label={constraint.id} index={index} count={draft.constraints.length} onMove={(offset) => setDraft((current) => ({ ...current, constraints: move(current.constraints, index, offset) }))} onRemove={() => setDraft((current) => ({ ...current, constraints: current.constraints.filter((_, entryIndex) => entryIndex !== index) }))} />
            </li>
          ))}
        </ol>
        <button type="button" className="model-add-row" disabled={!draft.criteria.length} onClick={() => setDraft((current) => ({ ...current, constraints: [...current.constraints, { id: editorId("constraint"), criterionId: current.criteria[0].id, operator: "eq", expectedText: current.criteria[0].valueType === "boolean" ? "true" : "null", severity: "mandatory" }] }))}><IconPlus size={16} /> Add constraint</button>
      </details>

      <details className="model-editor-section">
        <summary>Claims and source anchors <span>normalized values stay tied to exact fragments</span></summary>
        <ol className="model-editor-ledger model-editor-ledger--claims">
          {draft.claims.map((claim, index) => (
            <li key={claim.id} className="model-editor-row model-editor-row--claim">
              <code>{claim.id}</code>
              <label>Alternative<select value={claim.subjectId} onChange={(event) => update("claims", index, { subjectId: event.target.value })}>{draft.alternatives.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>
              <label>Criterion<select value={claim.criterionId} onChange={(event) => update("claims", index, { criterionId: event.target.value })}>{draft.criteria.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>
              <label>Value<input value={claim.valueText} onChange={(event) => update("claims", index, { valueText: event.target.value })} /></label>
              <label>Status<select value={claim.status} onChange={(event) => update("claims", index, { status: event.target.value })}>{CLAIM_STATUSES.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label>Confidence<input type="number" min="0" max="1" step="0.05" value={claim.confidenceText} onChange={(event) => update("claims", index, { confidenceText: event.target.value })} /></label>
              <details className="claim-source-anchors"><summary>{claim.sourceRefs?.length ?? 0} exact source anchor{claim.sourceRefs?.length === 1 ? "" : "s"}</summary>{claim.sourceRefs?.length ? <ul>{claim.sourceRefs.map((reference) => <li key={`${reference.documentId}:${reference.fragmentId}`}><code>{reference.documentId}</code><span>{reference.fragmentId}</span></li>)}</ul> : <p>Proposed values without a source cannot be accepted while source evidence is required.</p>}</details>
              <RowActions label={claim.id} index={index} count={draft.claims.length} onMove={(offset) => setDraft((current) => ({ ...current, claims: move(current.claims, index, offset) }))} onRemove={() => setDraft((current) => ({ ...current, claims: current.claims.filter((_, entryIndex) => entryIndex !== index) }))} />
            </li>
          ))}
        </ol>
        <button type="button" className="model-add-row" disabled={!draft.alternatives.length || !draft.criteria.length} onClick={() => setDraft((current) => ({ ...current, claims: [...current.claims, { id: editorId("claim"), subjectId: current.alternatives[0].id, criterionId: current.criteria[0].id, valueText: current.criteria[0].valueType === "boolean" ? "false" : current.criteria[0].valueType === "number" || current.criteria[0].valueType === "currency" ? "0" : "\"\"", status: "proposed", confidenceText: "0.5", sourceRefs: [], origin: "human_proposal" }] }))}><IconPlus size={16} /> Add proposed claim</button>
      </details>

      <footer className="typed-model-editor__actions">
        <p>{dirty ? "Uncommitted model edits are local to this form." : "The form matches the current canonical revision."}</p>
        <button type="button" disabled={!dirty || busy} onClick={() => setDraft(createDraft(room.activeCase))}><IconRotate size={16} /> Discard edits</button>
        <button type="button" className="is-primary" disabled={!dirty || busy} onClick={apply}><IconCheck size={16} /> Apply typed model</button>
      </footer>
      {error ? <p className="workflow-desk-error" role="alert">{error}</p> : null}
    </section>
  );
}
