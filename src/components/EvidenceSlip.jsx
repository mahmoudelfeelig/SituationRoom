import {
  IconExternalLink,
  IconFocusCentered,
  IconGavel,
  IconLock,
  IconLockOpen,
  IconPin,
  IconPinnedOff,
  IconQuote,
} from "@tabler/icons-react";
import {
  focusEvidence,
  toggleChallengeEvidence,
  toggleEvidenceDispute,
  toggleExpandedEvidence,
  toggleInterpretationLock,
  togglePinEvidence,
  useRoomStore,
} from "../roomStore.js";

export function EvidenceSlip({ evidence, status = "neutral", compact = false }) {
  const pinned = useRoomStore((state) => state.pinnedEvidenceIds.includes(evidence.id));
  const expanded = useRoomStore((state) => state.expandedEvidenceIds.includes(evidence.id));
  const challenged = useRoomStore((state) =>
    state.challengedEvidenceIds.includes(evidence.id),
  );
  const focused = useRoomStore((state) => state.focusedEvidenceId === evidence.id);
  const disputed = useRoomStore((state) => state.disputedEvidenceIds.includes(evidence.id));
  const locked = useRoomStore((state) => state.lockedInterpretationIds.includes(evidence.id));

  return (
    <article
      className={`evidence-slip status-${status} ${compact ? "is-compact" : ""} ${
        focused ? "is-focused" : ""
      } ${pinned ? "is-pinned" : ""} ${disputed ? "is-disputed" : ""}`}
      data-evidence-id={evidence.id}
      style={{ viewTransitionName: `evidence-${evidence.id}` }}
    >
      <header className="evidence-slip__header">
        <span className="evidence-slip__vendor">
          <IconQuote size={15} aria-hidden="true" />
          {evidence.document}
        </span>
        <button
          className="icon-button"
          type="button"
          aria-label={pinned ? `Unpin ${evidence.title}` : `Pin ${evidence.title}`}
          aria-pressed={pinned}
          onClick={() => togglePinEvidence(evidence.id)}
        >
          {pinned ? <IconPinnedOff size={17} /> : <IconPin size={17} />}
        </button>
      </header>
      <div className="evidence-slip__meta">
        <span>{evidence.version}</span>
        <span>{evidence.pages}</span>
      </div>
      <h3>{evidence.title}</h3>
      <blockquote className={expanded ? "is-expanded" : ""}>{evidence.text}</blockquote>
      <div className="evidence-slip__citation">Citation {evidence.citation}</div>
      {!compact && (
        <div className="evidence-slip__actions" aria-label={`Actions for ${evidence.title}`}>
          <button
            type="button"
            className="text-action"
            aria-pressed={focused}
            onClick={() => focusEvidence(evidence.id)}
          >
            <IconFocusCentered size={16} /> Trace
          </button>
          <button
            type="button"
            className="text-action"
            aria-expanded={expanded}
            onClick={() => toggleExpandedEvidence(evidence.id)}
          >
            <IconExternalLink size={16} /> {expanded ? "Fold source" : "Open source"}
          </button>
          <button
            type="button"
            className="text-action"
            aria-pressed={challenged}
            onClick={() => toggleChallengeEvidence(evidence.id)}
          >
            <IconGavel size={16} /> {challenged ? "Close challenge" : "Challenge link"}
          </button>
          <button
            type="button"
            className="text-action"
            aria-pressed={locked}
            onClick={() => toggleInterpretationLock(evidence.id)}
          >
            {locked ? <IconLock size={16} /> : <IconLockOpen size={16} />}
            {locked ? "Mapping locked" : "Lock mapping"}
          </button>
          {challenged && (
            <button
              type="button"
              className="text-action"
              aria-pressed={disputed}
              onClick={() => toggleEvidenceDispute(evidence.id)}
            >
              <IconGavel size={16} /> {disputed ? "Resolve dispute" : "Mark disputed"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
