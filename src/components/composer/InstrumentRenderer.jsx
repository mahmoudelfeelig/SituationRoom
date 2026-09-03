import { getInstrumentDefinition } from "../../presentation/instrumentRegistry.js";
import { getInstrumentComponent } from "../instruments/index.js";
import { InstrumentBoundary } from "./InstrumentBoundary.jsx";

function UnsupportedInstrument({ instrument }) {
  const definition = getInstrumentDefinition(instrument.type);
  return (
    <section className="instrument-render-fallback" role="status" data-instrument-id={instrument.id}>
      <strong>{definition?.label || "Unsupported instrument"}</strong>
      <span>This section could not be displayed. The underlying decision information is still available in the full view.</span>
    </section>
  );
}

export function InstrumentRenderer({ snapshot, instrument, onAction }) {
  const Component = getInstrumentComponent(instrument.type);
  return (
    <InstrumentBoundary instrumentId={instrument.id} onRenderError={onAction}>
      {Component ? (
        <Component snapshot={snapshot} instrument={instrument} onAction={onAction} />
      ) : (
        <UnsupportedInstrument instrument={instrument} />
      )}
    </InstrumentBoundary>
  );
}
