import {
  CompiledViewHeading,
  InstrumentRegion,
  ThreadConnector,
  instrumentsInRegion,
  instrumentTransitionStyle,
} from "./LayoutPrimitives.jsx";

export function InvestigateLayout({ plan, headingId, renderInstrument }) {
  const primary = instrumentsInRegion(plan, "primary");
  const secondary = instrumentsInRegion(plan, "secondary");
  const supporting = instrumentsInRegion(plan, "supporting");
  return (
    <section className="compiled-layout compiled-layout-investigate" aria-labelledby={headingId} data-layout-pattern="trace">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Answering" />
      <section className="compiled-primary-trace" aria-label="Evidence behind the result">
        {primary.map((instrument, index) => (
          <div className="compiled-trace-step" key={instrument.id}>
            <div className="compiled-instrument-slot" style={instrumentTransitionStyle(instrument)}>{renderInstrument(instrument)}</div>
            {index < primary.length - 1 ? <ThreadConnector /> : null}
          </div>
        ))}
      </section>
      {secondary.length + supporting.length ? (
        <details className="compiled-supporting-details">
          <summary><span>More evidence and checks</span><strong>{secondary.length + supporting.length} sections</strong></summary>
          <div className="compiled-supporting-details__body">
            <InstrumentRegion label="More evidence" region="secondary" instruments={secondary} renderInstrument={renderInstrument} className="investigation-secondary-docket" />
            <InstrumentRegion label="Rules and context" region="supporting" instruments={supporting} renderInstrument={renderInstrument} className="investigation-supporting-rail" />
          </div>
        </details>
      ) : null}
    </section>
  );
}
