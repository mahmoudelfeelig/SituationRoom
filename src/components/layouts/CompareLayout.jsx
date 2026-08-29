import { CompiledViewHeading, InstrumentRegion, instrumentsInRegion } from "./LayoutPrimitives.jsx";

export function CompareLayout({ plan, headingId, renderInstrument }) {
  return (
    <section className="compiled-layout compiled-layout-compare" aria-labelledby={headingId} data-layout-pattern="matrix">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Aligned comparison" />
      <InstrumentRegion label="Primary comparison instruments" region="primary" instruments={instrumentsInRegion(plan, "primary")} renderInstrument={renderInstrument} className="comparison-primary-stage" />
      <InstrumentRegion label="Comparison analysis instruments" region="secondary" instruments={instrumentsInRegion(plan, "secondary")} renderInstrument={renderInstrument} className="comparison-analysis-strip" />
      <InstrumentRegion label="Comparison safeguards and context" region="supporting" instruments={instrumentsInRegion(plan, "supporting")} renderInstrument={renderInstrument} className="comparison-supporting-ledger" />
    </section>
  );
}

