import { IconArrowRight } from "@tabler/icons-react";

export function CompiledViewHeading({ plan, headingId, kicker }) {
  return (
    <header className="compiled-view-heading">
      <div>
        <span className="instrument-kicker">{kicker}</span>
        <h2 id={headingId}>{plan.question}</h2>
      </div>
      <p>{plan.framing}</p>
    </header>
  );
}

export function InstrumentRegion({ label, region, instruments, renderInstrument, className = "" }) {
  if (!instruments.length) return null;
  return (
    <section className={`compiled-instrument-region region-${region} ${className}`.trim()} aria-label={label}>
      {instruments.map((instrument) => (
        <div className="compiled-instrument-slot" key={instrument.id} data-slot-instrument={instrument.id}>
          {renderInstrument(instrument)}
        </div>
      ))}
    </section>
  );
}

export function ThreadConnector({ label = "Leads to the next canonical decision step" }) {
  return (
    <div className="compiled-thread-connector" aria-label={label} role="img">
      <span aria-hidden="true" />
      <IconArrowRight size={21} aria-hidden="true" />
    </div>
  );
}

export function instrumentsInRegion(plan, region) {
  return plan.instruments.filter((instrument) => instrument.region === region);
}

