import { IconGitBranch } from "@tabler/icons-react";
import { CompiledViewHeading, InstrumentRegion, instrumentsInRegion } from "./LayoutPrimitives.jsx";

export function SimulateLayout({ plan, headingId, renderInstrument }) {
  const canonical = instrumentsInRegion(plan, "primary");
  const staged = instrumentsInRegion(plan, "secondary");
  const supporting = instrumentsInRegion(plan, "supporting");
  return (
    <section className="compiled-layout compiled-layout-simulate" aria-labelledby={headingId} data-layout-pattern="fork">
      <CompiledViewHeading plan={plan} headingId={headingId} kicker="Counterfactual fork" />
      <div className="compiled-scenario-fold">
        <InstrumentRegion label="Canonical record" region="primary" instruments={canonical} renderInstrument={renderInstrument} className="scenario-canonical-plane" />
        <div className="compiled-fold-spine" aria-label={`Scenario forked from decision revision ${plan.baseDecisionRevision}`}>
          <IconGitBranch size={23} aria-hidden="true" />
          <span>Forked from decision revision {plan.baseDecisionRevision}</span>
        </div>
        <InstrumentRegion label="Staged hypothetical controls" region="secondary" instruments={staged} renderInstrument={renderInstrument} className="scenario-staged-plane" />
      </div>
      <InstrumentRegion label="Scenario outcomes and protected context" region="supporting" instruments={supporting} renderInstrument={renderInstrument} className="scenario-outcome-rail" />
    </section>
  );
}

