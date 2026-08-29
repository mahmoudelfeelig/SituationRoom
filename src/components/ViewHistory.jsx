import {
  IconChevronLeft,
  IconChevronRight,
  IconHistory,
  IconRotateClockwise,
} from "@tabler/icons-react";
import {
  restoreDefaultView,
  restoreHistoryEntry,
  undoView,
  useRoomStore,
} from "../roomStore.js";

export function ViewHistory() {
  const history = useRoomStore((state) => state.history);
  const cursor = useRoomStore((state) => state.historyCursor);

  return (
    <footer className="view-history" aria-label="View history">
      <div className="view-history__label">
        <IconHistory size={18} />
        <span>
          <strong>View history</strong>
          <small>Presentation only</small>
        </span>
      </div>
      <div className="view-history__rail" role="list">
        {history.map((entry, index) => (
          <button
            type="button"
            role="listitem"
            key={entry.id}
            className={index === cursor ? "is-current" : ""}
            aria-current={index === cursor ? "step" : undefined}
            onClick={() => restoreHistoryEntry(index)}
          >
            <span className="history-knot" />
            <strong>{entry.viewRevision}</strong>
            <small>{entry.label}</small>
          </button>
        ))}
      </div>
      <div className="view-history__actions">
        <button className="icon-button" type="button" onClick={undoView} disabled={cursor <= 0} aria-label="Undo view change">
          <IconChevronLeft size={19} />
        </button>
        <button className="icon-button" type="button" onClick={() => restoreHistoryEntry(cursor + 1)} disabled={cursor >= history.length - 1} aria-label="Next view">
          <IconChevronRight size={19} />
        </button>
        <button className="text-action" type="button" onClick={restoreDefaultView}>
          <IconRotateClockwise size={17} /> Restore default
        </button>
      </div>
    </footer>
  );
}
