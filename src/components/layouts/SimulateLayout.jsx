import { IconGitBranch } from "@tabler/icons-react";
import { CompiledViewHeading, InstrumentRegion, instrumentsInRegion } from "./LayoutPrimitives.jsx";

export function SimulateLayout({ plan, headingId, renderInstrument }) {
  const canonical = instrumentsInRegion(plan, "primary");
  const staged = instrumentsInRegion(plan, "secondary");
  const supporting = instrumentsInRegion(plan, "supporting");
  return (
    <section className="compiled-layout compiled-layout-simulate" aria-labelledby={headingId} data-layout-pattern="fork">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Your question" />
      <div className="compiled-scenario-fold">
        <InstrumentRegion label="Current result" region="primary" instruments={canonical} renderInstrument={renderInstrument} className="scenario-canonical-plane" />
        <div className="compiled-fold-spine" aria-label={`Scenario based on decision version ${plan.baseDecisionRevision}`}>
          <IconGitBranch size={23} aria-hidden="true" />
          <span>Compared with decision version {plan.baseDecisionRevision}</span>
        </div>
        <InstrumentRegion label="Scenario changes" region="secondary" instruments={staged} renderInstrument={renderInstrument} className="scenario-staged-plane" />
      </div>
      {supporting.length ? (
        <details className="compiled-supporting-details">
          <summary><span>Show detailed results</span><strong>{supporting.length} sections</strong></summary>
          <div className="compiled-supporting-details__body"><InstrumentRegion label="Detailed scenario results" region="supporting" instruments={supporting} renderInstrument={renderInstrument} className="scenario-outcome-rail" /></div>
        </details>
      ) : null}
    </section>
  );
}
