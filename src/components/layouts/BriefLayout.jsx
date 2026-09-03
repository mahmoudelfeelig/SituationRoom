import { CompiledViewHeading, InstrumentRegion } from "./LayoutPrimitives.jsx";

const RECOMMENDATION_TYPES = new Set(["decision-brief", "outcome-seal"]);
const PEOPLE_TYPES = new Set(["stakeholder-mandate"]);

export function BriefLayout({ plan, headingId, renderInstrument }) {
  const recommendation = plan.instruments.filter((instrument) => RECOMMENDATION_TYPES.has(instrument.type));
  const people = plan.instruments.filter((instrument) => PEOPLE_TYPES.has(instrument.type));
  const context = plan.instruments.filter((instrument) => !RECOMMENDATION_TYPES.has(instrument.type) && !PEOPLE_TYPES.has(instrument.type));
  return (
    <section className="compiled-layout compiled-layout-brief" aria-labelledby={headingId} data-layout-pattern="council">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Answering" />
      <div className="compiled-brief-sheet">
        <InstrumentRegion label="Recommendation" region="primary" instruments={recommendation} renderInstrument={renderInstrument} className="council-recommendation-plane" />
        <InstrumentRegion label="People and priorities" region="secondary" instruments={people} renderInstrument={renderInstrument} className="council-mandate-plane" />
      </div>
      {context.length ? (
        <details className="compiled-supporting-details">
          <summary><span>Supporting evidence and checks</span><strong>{context.length} sections</strong></summary>
          <div className="compiled-supporting-details__body"><InstrumentRegion label="Supporting evidence and checks" region="supporting" instruments={context} renderInstrument={renderInstrument} className="council-context-ledger" /></div>
        </details>
      ) : null}
    </section>
  );
}
