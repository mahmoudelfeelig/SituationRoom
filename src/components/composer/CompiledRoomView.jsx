import { useCallback, useId } from "react";
import { IconAlertTriangle, IconCircleCheck, IconFileDescription } from "@tabler/icons-react";
import { PRESENTATION_SCHEMA_VERSION } from "../../presentation/contracts.js";
import { BriefLayout, CompareLayout, InvestigateLayout, SimulateLayout } from "../layouts/index.js";
import { InstrumentRenderer } from "./InstrumentRenderer.jsx";

const LAYOUTS = Object.freeze({
  investigate: InvestigateLayout,
  compare: CompareLayout,
  simulate: SimulateLayout,
  brief: BriefLayout,
});

function InvalidPlan({ message }) {
  return (
    <section className="compiled-room-error" role="alert">
      <IconAlertTriangle size={22} aria-hidden="true" />
      <div><strong>The composed room cannot be rendered.</strong><span>{message}</span></div>
    </section>
  );
}

function PlanWarnings({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <aside className="compiled-plan-warnings" aria-label="Composition warnings">
      {warnings.map((warning, index) => (
        <div key={`${warning.code}-${index}`} role={warning.code.includes("ORPHANED") ? "alert" : "status"}>
          <IconAlertTriangle size={17} aria-hidden="true" />
          <span><strong>{warning.code.replaceAll("_", " ")}</strong>{warning.message}</span>
        </div>
      ))}
    </aside>
  );
}

/**
 * Render an already validated presentation plan.
 *
 * @param {Object} props
 * @param {import("../../presentation/contracts.js").PresentationSnapshot} props.snapshot
 * @param {Object} props.plan Output from compilePresentation.
 * @param {(action:Object) => void=} props.onAction Receives governed semantic actions only.
 * @param {string=} props.className
 */
export function CompiledRoomView({ snapshot, plan, onAction, className = "" }) {
  const generatedId = useId();
  const headingId = `compiled-room-${generatedId.replaceAll(":", "")}`;

  if (!snapshot || !plan) return <InvalidPlan message="A canonical snapshot and compiled plan are required." />;
  if (plan.schemaVersion !== PRESENTATION_SCHEMA_VERSION) {
    return <InvalidPlan message={`Unsupported plan schema: ${String(plan.schemaVersion)}.`} />;
  }
  const Layout = LAYOUTS[plan.lens];
  if (!Layout) return <InvalidPlan message={`Unsupported layout lens: ${String(plan.lens)}.`} />;

  const decisionStale =
    plan.baseDecisionRevision !== snapshot.decisionRevision ||
    plan.decisionHash !== snapshot.decisionHash;
  const viewOutOfSequence =
    snapshot.viewRevision !== plan.baseViewRevision &&
    snapshot.viewRevision !== plan.nextViewRevision;

  const handleAction = useCallback((action) => {
    if (!action || typeof action !== "object") return;
    onAction?.({ ...action, planId: plan.planId, viewHash: plan.viewHash });
  }, [onAction, plan.planId, plan.viewHash]);

  const renderInstrument = useCallback((instrument) => (
    <InstrumentRenderer
      key={instrument.id}
      snapshot={snapshot}
      instrument={instrument}
      onAction={handleAction}
    />
  ), [snapshot, handleAction]);

  return (
    <section
      className={`compiled-room-view lens-${plan.lens} density-${plan.layout.density} ${className}`.trim()}
      data-plan-id={plan.planId}
      data-view-hash={plan.viewHash}
      data-decision-stale={decisionStale ? "true" : "false"}
      aria-busy="false"
    >
      {decisionStale ? (
        <div className="compiled-stale-banner" role="alert">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <span>This composition targets an earlier decision revision. Recompose before relying on its arrangement.</span>
        </div>
      ) : null}
      {viewOutOfSequence ? (
        <div className="compiled-stale-banner" role="status">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <span>This view is outside the current presentation sequence. Its decision data remains canonical.</span>
        </div>
      ) : null}
      <PlanWarnings warnings={plan.warnings} />
      <Layout plan={plan} headingId={headingId} renderInstrument={renderInstrument} />
      <footer className="compiled-view-receipt" aria-label="Composition receipt">
        <span><IconCircleCheck size={17} aria-hidden="true" /> Decision hash {plan.decisionHash} unchanged</span>
        <span>Decision revision {plan.baseDecisionRevision}</span>
        <span>View {plan.baseViewRevision} to {plan.nextViewRevision}</span>
        <span>{plan.preservedPins.length} human pins preserved</span>
        <span><IconFileDescription size={17} aria-hidden="true" /> {plan.omitted.entityCount} canonical items remain in full context</span>
      </footer>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {plan.lens} room composed with {plan.instruments.length} instruments. Decision facts are unchanged.
      </div>
    </section>
  );
}

export default CompiledRoomView;

