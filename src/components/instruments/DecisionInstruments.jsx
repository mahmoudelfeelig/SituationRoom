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
      kicker="Required checks"
      title="Rules that cannot be bypassed"
      status={status}
      description="Neither a person nor an agent can hide or rewrite these checks from this view."
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
        <div><dt>Who decides</dt><dd>{authority?.mode || snapshot.contract?.authority || "Not specified"}</dd></div>
        <div><dt>Who can approve</dt><dd>{authority?.canApprove ? "An authorized person" : "People only"}</dd></div>
        <div><dt>Information that cannot be used</dt><dd>{prohibited.length ? prohibited.join(", ") : "None specified"}</dd></div>
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

export function ConstraintGateInstrument({ snapshot, instrument, onAction, title = "Required checks" }) {
  const referenced = referencedItems(snapshot, instrument, ["constraint", "requirement", "criterion"]);
  const fallback = itemsByKinds(snapshot, ["constraint", "requirement", "criterion"], getLimit(instrument)).map((item) => ({
    item,
    reference: { kind: item.kind, id: item.id },
  }));
  const constraints = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Requirements" title={title} status={constraints.some(({ item }) => normalizeStatus(matchingResult(snapshot, item, instrument)?.status ?? item.status) === "fail") ? "fail" : "neutral"}>
      {constraints.length ? (
        <ol className="constraint-gate-list">
          {constraints.map(({ item, reference }) => {
            const result = matchingResult(snapshot, item, instrument);
            return (
              <li key={`${reference.kind}:${reference.id}`}>
                <span className="gate-code">{item.attributes?.code || item.code || "Must have"}</span>
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
        <EmptyInstrumentState>No required checks have been added.</EmptyInstrumentState>
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
      ? "Run a scenario without changing the saved decision."
      : result?.reason || alternative?.summary || "The available evidence does not support a final outcome.";
  return (
    <InstrumentFrame
      instrument={instrument}
      kicker={hypothetical ? "Possible result · scenario only" : "Current result"}
      title={title}
      status={status}
      className="outcome-seal-instrument"
    >
      <div className={`outcome-seal tone-${normalizeStatus(status)}${scenario ? " is-scenario-branch" : ""}`}>
        {normalizeStatus(status) === "pass" ? <IconCheck size={30} aria-hidden="true" /> : normalizeStatus(status) === "fail" ? <IconCircleX size={30} aria-hidden="true" /> : <IconScale size={30} aria-hidden="true" />}
        <strong>{scenario?.outcomeLabel ?? (hypothetical ? "Choose a scenario to see the result" : String(status || "Unknown").replaceAll("-", " "))}</strong>
        <span>{summary}</span>
        {scenario ? (
          <dl className="scenario-branch-ledger">
            {scenarioChange ? (
              <>
                <div>
                  <dt>Current value</dt>
                  <dd><strong>{scenarioChange.baselineFormattedValue}</strong><em className={`status-${normalizeStatus(scenarioChange.baselineStatus)}`}>{scenarioChange.baselineStatus}</em></dd>
                </div>
                <div>
                <dt>With this change</dt>
                  <dd><strong>{scenarioChange.scenarioFormattedValue}</strong><em className={`status-${normalizeStatus(scenarioChange.scenarioStatus)}`}>{scenarioChange.scenarioStatus}</em></dd>
                </div>
              </>
            ) : null}
            {scenarioConstraint ? (
              <div className="scenario-branch-ledger__wide">
                <dt>{scenarioConstraint.label} · required check</dt>
                <dd>
                  <strong>{operatorSymbol(scenarioConstraint.operator)} {scenarioConstraint.expectedFormattedValue}</strong>
                  <em className={`status-${normalizeStatus(scenarioConstraint.scenarioStatus)}`}>{scenarioConstraint.scenarioStatus}</em>
                </dd>
              </div>
            ) : null}
            {additionalScenarioChanges.length > 0 ? (
              <div className="scenario-branch-ledger__wide scenario-branch-ledger__changes">
                <dt>Other changes included</dt>
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
                  {undisplayedScenarioChangeCount > 0 ? <span>+{undisplayedScenarioChangeCount} more changes included</span> : null}
                </dd>
              </div>
            ) : null}
            {scenario.recommendation ? (
              <div className="scenario-branch-ledger__wide">
                <dt>{scenario.recommendation.eligible ? "Best choice in this scenario" : "Highest score, but requirements are not met"}</dt>
                <dd><strong>{scenario.recommendation.label}</strong><span>Score {scenario.recommendation.score}</span></dd>
              </div>
            ) : null}
            <div>
              <dt>Blocking problems</dt>
              <dd><strong>{scenario.baseBlockerCount} → {scenario.blockerCount}</strong></dd>
            </div>
            <div>
              <dt>Saved decision</dt>
              <dd><strong>{scenario.originalDecisionUnchanged ? `Version ${snapshot.decisionRevision} unchanged` : "Review required"}</strong></dd>
            </div>
          </dl>
        ) : result?.value !== undefined && !hypothetical ? <output>{formatCanonicalValue(result.value, result.unit, snapshot.metadata?.locale)}</output> : null}
      </div>
      <p className="outcome-authority-note">
        <IconLock size={17} aria-hidden="true" />
        {hypothetical ? "The saved decision remains unchanged." : "A person must approve any consequential action."}
      </p>
    </InstrumentFrame>
  );
}

export function StakeholderMandateInstrument({ snapshot, instrument }) {
  const referenced = referencedItems(snapshot, instrument, ["stakeholder", "actor", "reviewer"]);
  const fallback = itemsByKinds(snapshot, ["stakeholder", "actor", "reviewer"], getLimit(instrument)).map((item) => ({ item }));
  const stakeholders = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="People involved" title="What each person needs">
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
  const fallbackResult = getPrimaryResult(snapshot, instrument.entityRefs);
  const recommendation = snapshot.protected?.recommendation ?? null;
  const recommendedAlternativeId = recommendation?.id ?? fallbackResult?.subjectId;
  const recommendationResults = (snapshot.results ?? []).filter(
    (result) => result.subjectId === recommendedAlternativeId,
  );
  const result = recommendationResults[0] ?? fallbackResult;
  const alternative = snapshot.entities?.find((entity) => entity.id === recommendedAlternativeId)
    ?? referencedItems(snapshot, instrument, ["alternative", "candidate", "plan", "vendor"])[0]?.item
    ?? null;
  const blockerCount = alternative?.attributes?.blockerCount ?? 0;
  const isEligible = alternative?.attributes?.eligible ?? normalizeStatus(recommendation?.status) === "pass";
  const recommendationSummary = recommendation
    ? isEligible && blockerCount === 0
      ? "Meets every must-have requirement and has the strongest overall score."
      : `This is the highest-scoring option, but ${blockerCount} must-have ${blockerCount === 1 ? "requirement needs" : "requirements need"} attention.`
    : result?.reason || alternative?.summary || "There is not enough information to make a recommendation yet.";
  const evidence = recommendationResults.flatMap((entry) => {
    const sourceId = entry.sourceRefs?.[0]?.fragmentId ?? entry.sourceRefs?.[0]?.id ?? entry.evidenceIds?.[0];
    const source = snapshot.sources?.find((item) => item.id === sourceId);
    const criterion = snapshot.entities?.find((item) => item.id === entry.criterionId);
    return source ? [{ source, criterion }] : [];
  });
  const score = recommendation?.score ?? alternative?.attributes?.score;
  return (
    <InstrumentFrame instrument={instrument} kicker="Recommended choice" title={alternative ? titleFor(alternative) : "Recommendation pending"} status={recommendation?.status ?? result?.status ?? alternative?.status} className="decision-brief-instrument">
      <div className="decision-brief-summary">
        <strong>{recommendationSummary}</strong>
        {score !== undefined && score !== null ? <span>Overall score {score}</span> : null}
      </div>
      {evidence.length ? (
        <ul className="brief-evidence-list">
          {evidence.slice(0, getLimit(instrument, 6)).map(({ source, criterion }) => (
            <li key={`${criterion?.id ?? "evidence"}:${source.id}`}>
              <span><strong>{criterion ? titleFor(criterion) : titleFor(source)}</strong><small>{summaryFor(source)}</small></span>
              <InstrumentAction type="focus" label="Trace" entityRef={{ kind: source.kind, id: source.id }} instrumentId={instrument.id} onAction={onAction} />
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
    <InstrumentFrame instrument={instrument} kicker="Fairness rules" title="Protected information and human control" status={prohibited.length ? "warning" : "neutral"}>
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
  return <ConstraintGateInstrument {...props} title="Must-have requirements" />;
}
