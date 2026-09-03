import { CompiledViewHeading, InstrumentRegion } from "./LayoutPrimitives.jsx";

const CONTROL_TYPES = new Set(["scenario-controls", "concession-set", "utilization-scenario"]);
const OUTCOME_TYPES = new Set(["outcome-seal"]);

export function SimulateLayout({ plan, headingId, renderInstrument }) {
  const controls = plan.instruments.filter((instrument) => CONTROL_TYPES.has(instrument.type));
  const outcomes = plan.instruments.filter((instrument) => OUTCOME_TYPES.has(instrument.type));
  const supporting = plan.instruments.filter((instrument) => !CONTROL_TYPES.has(instrument.type) && !OUTCOME_TYPES.has(instrument.type));
  return (
    <section className="compiled-layout compiled-layout-simulate" aria-labelledby={headingId} data-layout-pattern="fork">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Answering" />
      <div className="compiled-scenario-workbench">
        <InstrumentRegion label="Try a change" region="primary" instruments={controls} renderInstrument={renderInstrument} className="scenario-staged-plane" />
        <InstrumentRegion label="Scenario result" region="secondary" instruments={outcomes} renderInstrument={renderInstrument} className="scenario-canonical-plane" />
      </div>
      {supporting.length ? (
        <details className="compiled-supporting-details">
          <summary><span>Detailed scenario results</span><strong>{supporting.length} sections</strong></summary>
          <div className="compiled-supporting-details__body"><InstrumentRegion label="Detailed scenario results" region="supporting" instruments={supporting} renderInstrument={renderInstrument} className="scenario-outcome-rail" /></div>
        </details>
      ) : null}
    </section>
  );
}
