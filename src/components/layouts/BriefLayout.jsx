import { IconArrowRight } from "@tabler/icons-react";
import { CompiledViewHeading, InstrumentRegion, instrumentsInRegion } from "./LayoutPrimitives.jsx";

export function BriefLayout({ plan, headingId, renderInstrument }) {
  const mandates = instrumentsInRegion(plan, "primary");
  const recommendation = instrumentsInRegion(plan, "secondary");
  const context = instrumentsInRegion(plan, "supporting");
  return (
    <section className="compiled-layout compiled-layout-brief" aria-labelledby={headingId} data-layout-pattern="council">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Decision council" />
      <div className="compiled-council-stage">
        <InstrumentRegion label="Stakeholder mandates" region="primary" instruments={mandates} renderInstrument={renderInstrument} className="council-mandate-plane" />
        <div className="compiled-council-convergence" aria-label="Stakeholder mandates converge on the cited recommendation">
          <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
          <IconArrowRight size={24} aria-hidden="true" />
        </div>
        <InstrumentRegion label="Cited recommendation" region="secondary" instruments={recommendation} renderInstrument={renderInstrument} className="council-recommendation-plane" />
      </div>
      <InstrumentRegion label="Briefing evidence and safeguards" region="supporting" instruments={context} renderInstrument={renderInstrument} className="council-context-ledger" />
    </section>
  );
}

