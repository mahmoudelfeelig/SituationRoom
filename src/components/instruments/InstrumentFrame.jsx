import { useId } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleX,
  IconDots,
  IconExternalLink,
  IconFocusCentered,
  IconPin,
} from "@tabler/icons-react";
import { getInstrumentDefinition } from "../../presentation/instrumentRegistry.js";
import { normalizeStatus } from "../../presentation/presentationSelectors.js";

export function StatusMark({ status, label }) {
  const tone = normalizeStatus(status);
  const Icon = tone === "pass" ? IconCheck : tone === "fail" ? IconCircleX : tone === "warning" ? IconAlertTriangle : IconDots;
  const accessibleLabel = label || String(status || "Unknown status");
  return (
    <span className={`instrument-status tone-${tone}`} aria-label={accessibleLabel}>
      <Icon size={16} aria-hidden="true" />
      <span>{accessibleLabel}</span>
    </span>
  );
}

export function InstrumentAction({ type, label, entityRef, instrumentId, onAction, disabled = false }) {
  const Icon = type === "pin" ? IconPin : type === "open-source" ? IconExternalLink : IconFocusCentered;
  return (
    <button
      type="button"
      className="instrument-action"
      disabled={disabled}
      onClick={() => onAction?.({ type, label, entityRef, instrumentId })}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export function EmptyInstrumentState({ children }) {
  return <p className="instrument-empty-state">{children}</p>;
}

export function BoundedInstrumentRegion({ children, itemCount, label, threshold = 8 }) {
  if (itemCount <= threshold) return children;
  return (
    <div
      className="instrument-bounded-region"
      tabIndex="0"
      role="region"
      aria-label={`${label}, ${itemCount} canonical items`}
      data-bounded-item-count={itemCount}
    >
      <p className="instrument-bounded-region__notice">
        {itemCount} canonical items in this ledger. Scroll within the ledger to review every item.
      </p>
      {children}
    </div>
  );
}

export function InstrumentFrame({
  instrument,
  title,
  kicker,
  status = "neutral",
  description,
  children,
  footer,
  className = "",
}) {
  const generatedId = useId();
  const definition = getInstrumentDefinition(instrument.type);
  const headingId = `instrument-${generatedId.replaceAll(":", "")}`;
  const tone = normalizeStatus(status);
  return (
    <article
      className={`decision-instrument instrument-${instrument.type} tone-${tone} ${className}`.trim()}
      aria-labelledby={headingId}
      data-instrument-id={instrument.id}
      data-instrument-type={instrument.type}
      data-instrument-region={instrument.region}
    >
      <header className="decision-instrument__header">
        <div>
          <span className="instrument-kicker">{kicker || definition?.label || "Decision instrument"}</span>
          <h3 id={headingId}>{title || definition?.label || "Unsupported instrument"}</h3>
        </div>
        {status && status !== "neutral" ? <StatusMark status={status} /> : null}
      </header>
      {description ? <p className="decision-instrument__description">{description}</p> : null}
      <div className="decision-instrument__body">{children}</div>
      {footer ? <footer className="decision-instrument__footer">{footer}</footer> : null}
    </article>
  );
}
