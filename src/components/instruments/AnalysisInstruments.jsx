import { IconArrowRight, IconChartBar, IconClock } from "@tabler/icons-react";
import {
  formatCanonicalValue,
  getResultFor,
  normalizeStatus,
} from "../../presentation/presentationSelectors.js";
import { BoundedInstrumentRegion, EmptyInstrumentState, InstrumentFrame, StatusMark } from "./InstrumentFrame.jsx";
import {
  firstNonEmpty,
  getLimit,
  itemsByKinds,
  referencedItems,
  sortCanonical,
  summaryFor,
  titleFor,
} from "./shared.js";

function alternativesFor(snapshot, instrument) {
  const kinds = ["alternative", "candidate", "plan", "vendor"];
  const referenced = referencedItems(snapshot, instrument, kinds).map(({ item }) => item);
  return firstNonEmpty(referenced, itemsByKinds(snapshot, kinds));
}

function criteriaFor(snapshot, instrument) {
  const kinds = ["criterion", "constraint", "requirement"];
  const referenced = referencedItems(snapshot, instrument, kinds).map(({ item }) => item);
  return firstNonEmpty(referenced, itemsByKinds(snapshot, kinds));
}

function maximaByUnit(results) {
  const maxima = new Map();
  for (const result of results) {
    if (typeof result.value !== "number" || !Number.isFinite(result.value)) continue;
    const unit = result.unit ?? "unitless";
    maxima.set(unit, Math.max(maxima.get(unit) ?? 1, Math.abs(result.value)));
  }
  return maxima;
}

export function ComparisonMatrixInstrument({ snapshot, instrument, title = "Aligned alternative comparison" }) {
  const limit = getLimit(instrument, 12);
  const alternatives = sortCanonical(alternativesFor(snapshot, instrument), instrument.options?.sort).slice(0, limit);
  const criteria = criteriaFor(snapshot, instrument).slice(0, limit);
  const transposed = instrument.options?.transpose === true;
  const descriptionId = `${instrument.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-scroll-description`;

  if (!alternatives.length || !criteria.length) {
    return (
      <InstrumentFrame instrument={instrument} kicker="Shared criteria" title={title}>
        <EmptyInstrumentState>A comparison requires at least one alternative and one declared criterion.</EmptyInstrumentState>
      </InstrumentFrame>
    );
  }

  const renderCell = (alternative, criterion) => {
    const result = getResultFor(snapshot, alternative.id, criterion.id);
    return (
      <td key={`${alternative.id}:${criterion.id}`} className={`tone-${normalizeStatus(result?.status)}`}>
        <StatusMark status={result?.status ?? "unknown"} />
        <span>{result ? (result.reason || "Canonical value recorded.") : "No canonical result is available."}</span>
        {result?.value !== undefined ? (
          <strong>{formatCanonicalValue(result.value, result.unit, snapshot.metadata?.locale)}</strong>
        ) : null}
      </td>
    );
  };

  return (
    <InstrumentFrame instrument={instrument} kicker="Shared criteria" title={title}>
      <p className="sr-only" id={descriptionId}>This comparison may scroll horizontally. Every cell includes a text status and reason.</p>
      <div className="comparison-table-scroll" tabIndex="0" role="region" aria-label={title} aria-describedby={descriptionId}>
        <table className={`compiled-comparison-table ${transposed ? "is-transposed" : ""}`}>
          <caption className="sr-only">{title}</caption>
          {!transposed ? (
            <>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  {alternatives.map((alternative) => <th scope="col" key={alternative.id}>{titleFor(alternative)}</th>)}
                </tr>
              </thead>
              <tbody>
                {criteria.map((criterion) => (
                  <tr key={criterion.id}>
                    <th scope="row"><strong>{titleFor(criterion)}</strong><span>{summaryFor(criterion)}</span></th>
                    {alternatives.map((alternative) => renderCell(alternative, criterion))}
                  </tr>
                ))}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr><th scope="col">Alternative</th>{criteria.map((criterion) => <th scope="col" key={criterion.id}>{titleFor(criterion)}</th>)}</tr>
              </thead>
              <tbody>
                {alternatives.map((alternative) => (
                  <tr key={alternative.id}>
                    <th scope="row">{titleFor(alternative)}</th>
                    {criteria.map((criterion) => renderCell(alternative, criterion))}
                  </tr>
                ))}
              </tbody>
            </>
          )}
        </table>
      </div>
      {(alternativesFor(snapshot, instrument).length > limit || criteriaFor(snapshot, instrument).length > limit) ? (
        <p className="instrument-overflow-note">Additional alternatives or criteria remain available in full context.</p>
      ) : null}
    </InstrumentFrame>
  );
}

export function ScoreBreakdownInstrument({ snapshot, instrument }) {
  const referencedIds = new Set(instrument.entityRefs.map((reference) => reference.id));
  const results = sortCanonical(
    (snapshot.results ?? []).filter((result) => !referencedIds.size || referencedIds.has(result.id) || referencedIds.has(result.subjectId)),
    instrument.options?.sort,
  ).slice(0, getLimit(instrument));
  const numeric = results.filter((result) => typeof result.value === "number" && Number.isFinite(result.value));
  const maximumByUnit = maximaByUnit(numeric);
  return (
    <InstrumentFrame instrument={instrument} kicker="Canonical evaluation" title="Score and result breakdown">
      {results.length ? (
        <BoundedInstrumentRegion itemCount={results.length} label="Score and result breakdown">
          <ul className="score-breakdown-list">
            {results.map((result) => {
              const value = typeof result.value === "number" ? Math.abs(result.value) : null;
              const maximum = maximumByUnit.get(result.unit ?? "unitless") ?? 1;
              return (
                <li key={result.id}>
                  <div><strong>{result.label || result.reason || result.id}</strong><StatusMark status={result.status} /></div>
                  {value !== null ? <meter min="0" max={maximum} value={value} data-scale-unit={result.unit ?? "unitless"}>{value}</meter> : null}
                  <span>{result.value !== undefined ? formatCanonicalValue(result.value, result.unit, snapshot.metadata?.locale) : result.reason}</span>
                </li>
              );
            })}
          </ul>
        </BoundedInstrumentRegion>
      ) : <EmptyInstrumentState>No canonical evaluation results are available.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

export function MetricWaterfallInstrument({ snapshot, instrument, title = "Metric waterfall" }) {
  const referencedIds = new Set(instrument.entityRefs.map((reference) => reference.id));
  const results = (snapshot.results ?? []).filter(
    (result) => typeof result.value === "number" && (!referencedIds.size || referencedIds.has(result.id) || referencedIds.has(result.subjectId) || referencedIds.has(result.criterionId)),
  );
  const sorted = sortCanonical(results, instrument.options?.sort).slice(0, getLimit(instrument));
  const maximumByUnit = new Map();
  sorted.forEach((result) => {
    const unit = result.unit ?? "unitless";
    maximumByUnit.set(unit, Math.max(maximumByUnit.get(unit) ?? 1, Math.abs(result.value)));
  });
  return (
    <InstrumentFrame instrument={instrument} kicker="Canonical metrics" title={title}>
      {sorted.length ? (
        <div className="metric-waterfall">
          <BoundedInstrumentRegion itemCount={sorted.length} label={title}>
            <ol>
              {sorted.map((result, index) => {
                const maximum = maximumByUnit.get(result.unit ?? "unitless") ?? 1;
                const ratio = Math.max(0.02, Math.min(1, Math.abs(result.value) / maximum));
                return (
                  <li key={result.id} style={{ "--instrument-ratio": ratio }}>
                    <span className="waterfall-index">{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{result.label || result.reason || result.id}</strong><span className="waterfall-bar" /></div>
                    <output>{formatCanonicalValue(result.value, result.unit, snapshot.metadata?.locale)}</output>
                  </li>
                );
              })}
            </ol>
          </BoundedInstrumentRegion>
          <div className="waterfall-total waterfall-total--disclosure">
            <span>Canonical values retain their own units and subjects.</span>
            <strong>No cross-metric total</strong>
          </div>
        </div>
      ) : <EmptyInstrumentState>No numeric canonical metrics are linked to this view.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

export function TimelineInstrument({ snapshot, instrument, title = "Evidence timeline" }) {
  const referenced = referencedItems(snapshot, instrument).map(({ item }) => item);
  const fallback = (snapshot.entities ?? []).filter((item) => item.attributes?.date || item.attributes?.start || item.date || item.start);
  const items = firstNonEmpty(referenced, fallback)
    .filter((item) => item.attributes?.date || item.attributes?.start || item.date || item.start)
    .sort((left, right) => String(left.attributes?.date || left.attributes?.start || left.date || left.start).localeCompare(String(right.attributes?.date || right.attributes?.start || right.date || right.start)))
    .slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Chronology" title={title}>
      {items.length ? (
        <BoundedInstrumentRegion itemCount={items.length} label={title}>
          <ol className="instrument-timeline">
            {items.map((item) => (
              <li key={item.id}>
                <IconClock size={18} aria-hidden="true" />
                <time dateTime={item.attributes?.date || item.attributes?.start || item.date || item.start}>{item.attributes?.date || item.attributes?.start || item.date || item.start}</time>
                <div><strong>{titleFor(item)}</strong><span>{summaryFor(item)}</span></div>
              </li>
            ))}
          </ol>
        </BoundedInstrumentRegion>
      ) : <EmptyInstrumentState>No dated canonical events are available.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

function riskBenefit(item, snapshot) {
  const attributes = item.attributes ?? {};
  if (Number.isFinite(attributes.risk) || Number.isFinite(attributes.benefit)) {
    return { risk: Number(attributes.risk) || 0, benefit: Number(attributes.benefit) || 0 };
  }
  const subjectResults = (snapshot.results ?? []).filter((result) => result.subjectId === item.id && typeof result.value === "number");
  return {
    risk: Math.abs(subjectResults.find((result) => /risk|cost|harm/i.test(result.label || result.id))?.value ?? 0),
    benefit: Math.abs(subjectResults.find((result) => /benefit|score|coverage|value/i.test(result.label || result.id))?.value ?? 0),
  };
}

export function RiskFrontierInstrument({ snapshot, instrument, title = "Risk and benefit frontier" }) {
  const items = alternativesFor(snapshot, instrument).slice(0, getLimit(instrument));
  const values = items.map((item) => ({ item, ...riskBenefit(item, snapshot) }));
  const riskMax = Math.max(1, ...values.map((entry) => entry.risk));
  const benefitMax = Math.max(1, ...values.map((entry) => entry.benefit));
  return (
    <InstrumentFrame instrument={instrument} kicker="Canonical trade-offs" title={title}>
      {values.length ? (
        <div className="risk-frontier-table" role="table" aria-label={title}>
          <div role="row" className="risk-frontier-header"><span role="columnheader">Alternative</span><span role="columnheader">Risk</span><span role="columnheader">Benefit</span></div>
          {values.map(({ item, risk, benefit }) => (
            <div role="row" key={item.id}>
              <strong role="rowheader">{titleFor(item)}</strong>
              <span role="cell"><meter min="0" max={riskMax} value={risk}>{risk}</meter><small>{risk}</small></span>
              <span role="cell"><meter min="0" max={benefitMax} value={benefit}>{benefit}</meter><small>{benefit}</small></span>
            </div>
          ))}
        </div>
      ) : <EmptyInstrumentState>No alternatives are available for trade-off analysis.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

export function SensitivityPlotInstrument({ snapshot, instrument }) {
  const numericResults = (snapshot.results ?? []).filter((result) => typeof result.value === "number").slice(0, getLimit(instrument));
  const maximumByUnit = maximaByUnit(numericResults);
  return (
    <InstrumentFrame instrument={instrument} kicker="Hypothetical analysis" title="Sensitivity to canonical inputs">
      {numericResults.length ? (
        <BoundedInstrumentRegion itemCount={numericResults.length} label="Sensitivity to canonical inputs">
          <ol className="sensitivity-ledger">
            {numericResults.map((result) => {
              const maximum = maximumByUnit.get(result.unit ?? "unitless") ?? 1;
              return (
                <li key={result.id}>
                  <IconChartBar size={18} aria-hidden="true" />
                  <span><strong>{result.label || result.id}</strong><small>{result.reason}</small></span>
                  <meter min="0" max={maximum} value={Math.abs(result.value)} data-scale-unit={result.unit ?? "unitless"}>{result.value}</meter>
                  <output>{formatCanonicalValue(result.value, result.unit, snapshot.metadata?.locale)}</output>
                </li>
              );
            })}
          </ol>
        </BoundedInstrumentRegion>
      ) : <EmptyInstrumentState>No canonical sensitivity samples are available.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

export function WeightedCriteriaInstrument({ snapshot, instrument }) {
  const criteria = criteriaFor(snapshot, instrument).slice(0, getLimit(instrument));
  const weights = criteria.map((item) => Number(item.attributes?.weight ?? item.weight ?? 0));
  const max = Math.max(1, ...weights.map(Math.abs));
  return (
    <InstrumentFrame instrument={instrument} kicker="Declared priorities" title="Weighted criteria">
      {criteria.length ? (
        <ol className="weighted-criteria-list">
          {criteria.map((item, index) => (
            <li key={item.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small><meter min="0" max={max} value={Math.abs(weights[index])}>{weights[index]}</meter></div>
              <output>{weights[index] || "Unweighted"}</output>
            </li>
          ))}
        </ol>
      ) : <EmptyInstrumentState>No declared criteria are available.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

export function CausalTraceInstrument({ snapshot, instrument, onAction }) {
  const path = snapshot.paths?.find((item) => item.id === instrument.pathId) ?? snapshot.paths?.[0];
  const items = path
    ? path.entityRefs.map((reference) => ({ reference, item: snapshot.entities?.find((entity) => entity.id === reference.id && entity.kind === reference.kind) || snapshot.sources?.find((source) => source.id === reference.id) })).filter(({ item }) => item)
    : referencedItems(snapshot, instrument);
  return (
    <InstrumentFrame instrument={instrument} kicker="Red thread" title={path?.label || "Causal trace"} status={path?.status}>
      {items.length ? (
        <ol className="compact-causal-trace">
          {items.map(({ item, reference }, index) => (
            <li key={`${reference.kind}:${reference.id}`}>
              <button type="button" onClick={() => onAction?.({ type: "focus", instrumentId: instrument.id, entityRef: reference })}>
                <span className="instrument-kicker">{reference.kind}</span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small>
              </button>
              {index < items.length - 1 ? <IconArrowRight size={20} aria-hidden="true" /> : null}
            </li>
          ))}
        </ol>
      ) : <EmptyInstrumentState>No complete canonical path is available.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}
