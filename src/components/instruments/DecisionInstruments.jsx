import {
  IconAlertTriangle,
  IconCheck,
  IconCircleX,
  IconLock,
  IconScale,
  IconShieldLock,
  IconUsers,
} from "@tabler/icons-react";
import {
  formatCanonicalValue,
  getPrimaryResult,
  normalizeStatus,
} from "../../presentation/presentationSelectors.js";
import { EmptyInstrumentState, InstrumentAction, InstrumentFrame, StatusMark } from "./InstrumentFrame.jsx";
import {
  firstNonEmpty,
  getLimit,
  itemsByKinds,
  referencedItems,
  summaryFor,
  titleFor,
} from "./shared.js";

function matchingResult(snapshot, item, instrument) {
  const referencedIds = new Set(instrument?.entityRefs?.map((reference) => reference.id) ?? []);
  return (
    snapshot.results?.find(
      (result) =>
        referencedIds.has(result.id) &&
        (result.criterionId === item.id || result.subjectId === item.id),
    ) ??
    snapshot.results?.find(
      (result) => result.criterionId === item.id || result.subjectId === item.id || result.id === item.id,
    ) ?? null
  );
}

function operatorSymbol(operator) {
  return ({ eq: "=", neq: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥", in: "∈", contains: "contains" })[operator] ?? operator ?? "threshold";
}

export function ProtectedInvariantsInstrument({ snapshot, instrument, onAction }) {
  const constraints = referencedItems(snapshot, instrument);
  const blockerIds = new Set(instrument.blockerResultIds ?? snapshot.protected?.blockerResultIds ?? []);
  const blockers = (snapshot.results ?? []).filter((result) => blockerIds.has(result.id));
  const unresolved = instrument.unresolvedEntityRefs ?? [];
  const authority = snapshot.protected?.authority;
  const prohibited = snapshot.protected?.prohibitedEntityKinds ?? [];
  const status = blockers.length || unresolved.length ? "fail" : "pass";

  return (
    <InstrumentFrame
      instrument={instrument}
      kicker="Decision Firewall"
      title="Protected invariants"
      status={status}
      description="The composition compiler cannot remove or rewrite these constraints."
    >
      <ul className="protected-invariant-list">
        {constraints.map(({ item, reference }) => {
          const result = matchingResult(snapshot, item, instrument);
          return (
            <li key={`${reference.kind}:${reference.id}`}>
              <StatusMark status={result?.status ?? item.status} />
              <span><strong>{titleFor(item)}</strong><small>{result?.reason || summaryFor(item)}</small></span>
              <InstrumentAction type="focus" label="Trace" entityRef={reference} instrumentId={instrument.id} onAction={onAction} />
            </li>
          );
        })}
        {blockers
          .filter((blocker) => !constraints.some(({ item }) => item.id === blocker.criterionId))
          .map((blocker) => (
            <li key={blocker.id}>
              <StatusMark status={blocker.status} />
              <span><strong>{blocker.label || "Mandatory blocker"}</strong><small>{blocker.reason || "This result blocks the current outcome."}</small></span>
            </li>
          ))}
      </ul>
      <dl className="authority-ledger">
        <div><dt>Authority</dt><dd>{authority?.mode || snapshot.contract?.authority || "Not declared"}</dd></div>
        <div><dt>Approval tool</dt><dd>{authority?.canApprove ? "Available to an authorized human" : "Not available to agents"}</dd></div>
        <div><dt>Prohibited entity kinds</dt><dd>{prohibited.length ? prohibited.join(", ") : "None declared"}</dd></div>
      </dl>
      {unresolved.length ? (
        <div className="unresolved-reference-warning" role="alert">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <span>{unresolved.length} protected reference could not be resolved. Human review is required.</span>
        </div>
      ) : null}
    </InstrumentFrame>
  );
}

export function ConstraintGateInstrument({ snapshot, instrument, onAction, title = "Constraint gates" }) {
  const referenced = referencedItems(snapshot, instrument, ["constraint", "requirement", "criterion"]);
  const fallback = itemsByKinds(snapshot, ["constraint", "requirement", "criterion"], getLimit(instrument)).map((item) => ({
    item,
    reference: { kind: item.kind, id: item.id },
  }));
  const constraints = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Declared policy" title={title} status={constraints.some(({ item }) => normalizeStatus(matchingResult(snapshot, item, instrument)?.status ?? item.status) === "fail") ? "fail" : "neutral"}>
      {constraints.length ? (
        <ol className="constraint-gate-list">
          {constraints.map(({ item, reference }) => {
            const result = matchingResult(snapshot, item, instrument);
            return (
              <li key={`${reference.kind}:${reference.id}`}>
                <span className="gate-code">{item.attributes?.code || item.code || "Gate"}</span>
                <div>
                  <strong>{titleFor(item)}</strong>
                  <p>{result?.reason || summaryFor(item)}</p>
                  <StatusMark status={result?.status ?? item.status} />
                </div>
                <InstrumentAction type="pin" label="Pin" entityRef={reference} instrumentId={instrument.id} onAction={onAction} />
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyInstrumentState>No declared constraints are available for evaluation.</EmptyInstrumentState>
      )}
    </InstrumentFrame>
  );
}

export function OutcomeSealInstrument({ snapshot, instrument }) {
  const result = getPrimaryResult(snapshot, instrument.entityRefs);
  const alternativeId = result?.subjectId;
  const alternative = snapshot.entities?.find((entity) => entity.id === alternativeId)
    ?? referencedItems(snapshot, instrument, ["alternative", "candidate", "plan", "vendor"])[0]?.item
    ?? null;
  const hypothetical = instrument.variant === "hypothetical";
  const scenario = hypothetical ? snapshot.domainData?.scenarioEvaluation : null;
  const status = scenario
    ? scenario.eligibleAlternativeCount > 0 ? "pass" : "fail"
    : hypothetical ? "hypothetical" : result?.status ?? alternative?.status ?? "unknown";
  const scenarioChange = scenario?.changes?.[0] ?? null;
  const additionalScenarioChanges = scenario?.changes?.slice(1, 4) ?? [];
  const undisplayedScenarioChangeCount = Math.max(0, (scenario?.changes?.length ?? 0) - 4);
  const scenarioConstraintChange = scenario?.changes?.find((change) => change.constraint) ?? null;
  const scenarioConstraint = scenarioConstraintChange?.constraint ?? null;
  const title = hypothetical
    ? scenario?.scenarioLabel ?? "Scenario result"
    : alternative ? titleFor(alternative) : "Outcome unresolved";
  const summary = scenarioChange
    ? `${scenarioChange.alternativeLabel} · ${scenarioChange.criterionLabel}: ${scenarioChange.baselineFormattedValue} to ${scenarioChange.scenarioFormattedValue}.${scenario.changes.length > 1 ? ` ${scenario.changes.length - 1} additional scenario ${scenario.changes.length === 2 ? "input is" : "inputs are"} included in this branch.` : ""}`
    : hypothetical
      ? "Run a scenario to calculate this branch without changing the canonical decision."
      : result?.reason || alternative?.summary || "The available evidence does not support a final outcome.";
  return (
    <InstrumentFrame
      instrument={instrument}
      kicker={hypothetical ? "Projected outcome · scenario only" : "Canonical outcome"}
      title={title}
      status={status}
      className="outcome-seal-instrument"
    >
      <div className={`outcome-seal tone-${normalizeStatus(status)}${scenario ? " is-scenario-branch" : ""}`}>
        {normalizeStatus(status) === "pass" ? <IconCheck size={30} aria-hidden="true" /> : normalizeStatus(status) === "fail" ? <IconCircleX size={30} aria-hidden="true" /> : <IconScale size={30} aria-hidden="true" />}
        <strong>{scenario?.outcomeLabel ?? (hypothetical ? "Awaiting scenario" : String(status || "Unknown").replaceAll("-", " "))}</strong>
        <span>{summary}</span>
        {scenario ? (
          <dl className="scenario-branch-ledger">
            {scenarioChange ? (
              <>
                <div>
                  <dt>Canonical</dt>
                  <dd><strong>{scenarioChange.baselineFormattedValue}</strong><em className={`status-${normalizeStatus(scenarioChange.baselineStatus)}`}>{scenarioChange.baselineStatus}</em></dd>
                </div>
                <div>
                  <dt>Hypothetical</dt>
                  <dd><strong>{scenarioChange.scenarioFormattedValue}</strong><em className={`status-${normalizeStatus(scenarioChange.scenarioStatus)}`}>{scenarioChange.scenarioStatus}</em></dd>
                </div>
              </>
            ) : null}
            {scenarioConstraint ? (
              <div className="scenario-branch-ledger__wide">
                <dt>{scenarioConstraint.label} · mandatory gate</dt>
                <dd>
                  <strong>{operatorSymbol(scenarioConstraint.operator)} {scenarioConstraint.expectedFormattedValue}</strong>
                  <em className={`status-${normalizeStatus(scenarioConstraint.scenarioStatus)}`}>{scenarioConstraint.scenarioStatus}</em>
                </dd>
              </div>
            ) : null}
            {additionalScenarioChanges.length > 0 ? (
              <div className="scenario-branch-ledger__wide scenario-branch-ledger__changes">
                <dt>Additional scenario inputs</dt>
                <dd>
                  <ul>
                    {additionalScenarioChanges.map((change) => (
                      <li key={change.claimId}>
                        <strong>{change.alternativeLabel} · {change.criterionLabel}</strong>
                        <span>{change.baselineFormattedValue} → {change.scenarioFormattedValue}</span>
                        <em className={`status-${normalizeStatus(change.scenarioStatus)}`}>{change.scenarioStatus}</em>
                      </li>
                    ))}
                  </ul>
                  {undisplayedScenarioChangeCount > 0 ? <span>+{undisplayedScenarioChangeCount} more overrides included in this branch</span> : null}
                </dd>
              </div>
            ) : null}
            {scenario.recommendation ? (
              <div className="scenario-branch-ledger__wide">
                <dt>{scenario.recommendation.eligible ? "Top eligible alternative" : "Top-ranked but blocked"}</dt>
                <dd><strong>{scenario.recommendation.label}</strong><span>Score {scenario.recommendation.score}</span></dd>
              </div>
            ) : null}
            <div>
              <dt>Mandatory blockers</dt>
              <dd><strong>{scenario.baseBlockerCount} → {scenario.blockerCount}</strong></dd>
            </div>
            <div>
              <dt>Canonical record</dt>
              <dd><strong>{scenario.originalDecisionUnchanged ? `Revision ${snapshot.decisionRevision} unchanged` : "Review required"}</strong></dd>
            </div>
          </dl>
        ) : result?.value !== undefined && !hypothetical ? <output>{formatCanonicalValue(result.value, result.unit, snapshot.metadata?.locale)}</output> : null}
      </div>
      <p className="outcome-authority-note">
        <IconLock size={17} aria-hidden="true" />
        {hypothetical ? "The canonical decision remains unchanged." : "Human authority remains required for consequential action."}
      </p>
    </InstrumentFrame>
  );
}

export function StakeholderMandateInstrument({ snapshot, instrument }) {
  const referenced = referencedItems(snapshot, instrument, ["stakeholder", "actor", "reviewer"]);
  const fallback = itemsByKinds(snapshot, ["stakeholder", "actor", "reviewer"], getLimit(instrument)).map((item) => ({ item }));
  const stakeholders = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Affected and accountable people" title="Stakeholder mandates">
      {stakeholders.length ? (
        <ol className="stakeholder-mandate-list">
          {stakeholders.map(({ item }, index) => (
            <li key={item.id}>
              <span className="mandate-number">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <span className="instrument-kicker">{titleFor(item)}</span>
                <strong>{item.attributes?.question || item.question || summaryFor(item)}</strong>
                <p>{item.attributes?.mandate || item.mandate || item.summary}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyInstrumentState>No affected or accountable stakeholder has been declared.</EmptyInstrumentState>
      )}
    </InstrumentFrame>
  );
}

export function DecisionBriefInstrument({ snapshot, instrument, onAction }) {
  const result = getPrimaryResult(snapshot, instrument.entityRefs);
  const alternative = snapshot.entities?.find((entity) => entity.id === result?.subjectId)
    ?? referencedItems(snapshot, instrument, ["alternative", "candidate", "plan", "vendor"])[0]?.item
    ?? null;
  const evidenceIds = new Set(result?.evidenceIds ?? []);
  const evidence = (snapshot.entities ?? []).filter((entity) => evidenceIds.has(entity.id));
  return (
    <InstrumentFrame instrument={instrument} kicker="Decision brief" title={alternative ? titleFor(alternative) : "Recommendation pending"} status={result?.status ?? alternative?.status} className="decision-brief-instrument">
      <div className="decision-brief-summary">
        <strong>{result?.reason || alternative?.summary || "The current graph does not contain a recommendation."}</strong>
        {result?.value !== undefined ? <span>{formatCanonicalValue(result.value, result.unit, snapshot.metadata?.locale)}</span> : null}
      </div>
      {evidence.length ? (
        <ul className="brief-evidence-list">
          {evidence.slice(0, getLimit(instrument, 6)).map((item) => (
            <li key={item.id}>
              <span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small></span>
              <InstrumentAction type="focus" label="Trace" entityRef={{ kind: item.kind, id: item.id }} instrumentId={instrument.id} onAction={onAction} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="human-authority-stamp"><IconShieldLock size={19} aria-hidden="true" /> Human review required</div>
    </InstrumentFrame>
  );
}

export function BiasShieldInstrument({ snapshot, instrument }) {
  const prohibited = snapshot.protected?.prohibitedEntityKinds ?? [];
  return (
    <InstrumentFrame instrument={instrument} kicker="Governance boundary" title="Bias and authority shield" status={prohibited.length ? "warning" : "neutral"}>
      <div className="bias-shield-copy">
        <IconShieldLock size={26} aria-hidden="true" />
        <div>
          <strong>Protected inputs cannot influence evaluation</strong>
          <p>{prohibited.length ? prohibited.join(", ") : "No prohibited entity kinds were supplied by the active domain policy."}</p>
        </div>
      </div>
      <div className="human-authority-stamp"><IconUsers size={19} aria-hidden="true" /> Consequential decisions remain human-only</div>
    </InstrumentFrame>
  );
}

export function ComplianceGateWallInstrument(props) {
  return <ConstraintGateInstrument {...props} title="Compliance gate wall" />;
}
