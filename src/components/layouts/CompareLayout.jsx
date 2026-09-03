import { CompiledViewHeading, InstrumentRegion, instrumentsInRegion } from "./LayoutPrimitives.jsx";

export function CompareLayout({ plan, headingId, renderInstrument }) {
  const secondary = instrumentsInRegion(plan, "secondary");
  const supporting = instrumentsInRegion(plan, "supporting");
  const extraCount = secondary.length + supporting.length;
  return (
    <section className="compiled-layout compiled-layout-compare" aria-labelledby={headingId} data-layout-pattern="matrix">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Answering" />
      <InstrumentRegion label="Main comparison" region="primary" instruments={instrumentsInRegion(plan, "primary")} renderInstrument={renderInstrument} className="comparison-primary-stage" />
      {extraCount ? (
        <details className="compiled-supporting-details">
          <summary><span>More analysis</span><strong>{extraCount} sections</strong></summary>
          <div className="compiled-supporting-details__body">
            <InstrumentRegion label="Additional comparison analysis" region="secondary" instruments={secondary} renderInstrument={renderInstrument} className="comparison-analysis-strip" />
            <InstrumentRegion label="Rules and calculations" region="supporting" instruments={supporting} renderInstrument={renderInstrument} className="comparison-supporting-ledger" />
          </div>
        </details>
      ) : null}
    </section>
  );
}
