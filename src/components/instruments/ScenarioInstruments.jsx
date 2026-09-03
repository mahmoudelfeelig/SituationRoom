import { IconLock } from "@tabler/icons-react";
import { formatCanonicalValue } from "../../presentation/presentationSelectors.js";
import { EmptyInstrumentState, InstrumentFrame } from "./InstrumentFrame.jsx";
import { firstNonEmpty, getLimit, itemsByKinds, referencedItems, summaryFor, titleFor } from "./shared.js";

function Control({ item, instrument, snapshot, onAction }) {
  const attributes = item.attributes ?? {};
  const control = attributes.control || "boolean";
  const disabled = snapshot.permissions?.canSimulate === false;
  const controlId = `${instrument.id}-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const descriptionId = `${controlId}-description`;
  const emit = (value) => onAction?.({
    type: "change-scenario",
    instrumentId: instrument.id,
    entityRef: { kind: item.kind, id: item.id },
    value,
  });

  return (
    <div className="scenario-control" data-control-type={control}>
      <div className="scenario-control__heading">
        <label htmlFor={controlId}>{titleFor(item)}</label>
        {control === "range" ? (
          <output htmlFor={controlId}>{formatCanonicalValue(attributes.value, attributes.unit, snapshot.metadata?.locale)}</output>
        ) : null}
      </div>
      <p id={descriptionId}>{summaryFor(item)}</p>
      {control === "range" ? (
        <input
          id={controlId}
          type="range"
          min={attributes.min}
          max={attributes.max}
          step={attributes.step ?? 1}
          value={attributes.value ?? attributes.min ?? 0}
          aria-describedby={descriptionId}
          disabled={disabled}
          onChange={(event) => emit(Number(event.target.value))}
        />
      ) : control === "select" ? (
        <select
          id={controlId}
          value={attributes.value ?? ""}
          aria-describedby={descriptionId}
          disabled={disabled}
          onChange={(event) => emit(event.target.value)}
        >
          {(attributes.options ?? []).map((option) => {
            const value = typeof option === "object" ? option.value : option;
            const label = typeof option === "object" ? option.label : option;
            return <option key={String(value)} value={value}>{label}</option>;
          })}
        </select>
      ) : control === "scenario" ? (
        <button
          type="button"
          className="scenario-run-button"
          aria-describedby={descriptionId}
          aria-pressed={Boolean(attributes.active)}
          disabled={disabled}
          onClick={() => emit(true)}
        >
          {attributes.active ? "Current scenario" : "Run scenario"}
        </button>
      ) : (
        <label className="scenario-checkbox" htmlFor={controlId}>
          <input
            id={controlId}
            type="checkbox"
            checked={Boolean(attributes.value)}
            aria-describedby={descriptionId}
            disabled={disabled}
            onChange={(event) => emit(event.target.checked)}
          />
          <span>{attributes.value ? "Committed" : "Not committed"}</span>
        </label>
      )}
      {attributes.baseline !== undefined ? (
        <small className="scenario-baseline">Current value: {formatCanonicalValue(attributes.baseline, attributes.unit, snapshot.metadata?.locale)}</small>
      ) : null}
    </div>
  );
}

export function ScenarioControlsInstrument({ snapshot, instrument, onAction, title = "Scenario controls" }) {
  const referenced = referencedItems(snapshot, instrument, ["control", "scenario-control"]).map(({ item }) => item);
  const fallback = itemsByKinds(snapshot, ["control", "scenario-control"], getLimit(instrument));
  const declaredScenarios = Array.isArray(snapshot.domainData?.scenarios)
    ? snapshot.domainData.scenarios
        .filter((scenario) => scenario && typeof scenario.id === "string" && typeof scenario.label === "string")
        .map((scenario) => ({
          id: scenario.id,
          kind: "scenario",
          label: scenario.label,
          summary: scenario.description || "Run this trusted hypothetical scenario.",
          attributes: {
            control: "scenario",
            active: snapshot.domainData?.activeScenarioId === scenario.id,
          },
        }))
    : [];
  const controls = firstNonEmpty(referenced, fallback, declaredScenarios).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame
      instrument={instrument}
      kicker="Try a change"
      title={title}
      status="hypothetical"
      description="Test an assumption without changing the saved decision."
    >
      {controls.length ? (
        <div className="scenario-control-grid">
          {controls.map((item) => <Control key={item.id} item={item} instrument={instrument} snapshot={snapshot} onAction={onAction} />)}
        </div>
      ) : <EmptyInstrumentState>No trusted scenario controls are available for this case.</EmptyInstrumentState>}
      <div className="canonical-lock-note"><IconLock size={18} aria-hidden="true" /> Your saved decision stays unchanged</div>
    </InstrumentFrame>
  );
}

export function ConcessionSetInstrument(props) {
  return <ScenarioControlsInstrument {...props} title="Smallest changes that could work" />;
}

export function UtilizationScenarioInstrument(props) {
  return <ScenarioControlsInstrument {...props} title="Try a healthcare use scenario" />;
}
