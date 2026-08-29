import { CompiledViewHeading, InstrumentRegion, ThreadConnector, instrumentsInRegion } from "./LayoutPrimitives.jsx";

export function InvestigateLayout({ plan, headingId, renderInstrument }) {
  const primary = instrumentsInRegion(plan, "primary");
  const secondary = instrumentsInRegion(plan, "secondary");
  const supporting = instrumentsInRegion(plan, "supporting");
  return (
    <section className="compiled-layout compiled-layout-investigate" aria-labelledby={headingId} data-layout-pattern="trace">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Causal investigation" />
      <section className="compiled-primary-trace" aria-label="Source-to-outcome causal path">
        {primary.map((instrument, index) => (
          <div className="compiled-trace-step" key={instrument.id}>
            <div className="compiled-instrument-slot">{renderInstrument(instrument)}</div>
            {index < primary.length - 1 ? <ThreadConnector /> : null}
          </div>
        ))}
      </section>
      <InstrumentRegion label="Supporting investigation exhibits" region="secondary" instruments={secondary} renderInstrument={renderInstrument} className="investigation-secondary-docket" />
      <InstrumentRegion label="Protected and contextual exhibits" region="supporting" instruments={supporting} renderInstrument={renderInstrument} className="investigation-supporting-rail" />
    </section>
  );
}

