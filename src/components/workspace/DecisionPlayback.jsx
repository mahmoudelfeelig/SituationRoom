import { useEffect, useMemo, useState } from "react";
import {
  IconArrowRight,
  IconGitCompare,
  IconPlayerPlay,
  IconRoute,
} from "@tabler/icons-react";
import {
  buildDecisionPlayback,
  comparePlaybackEvents,
} from "../../workspace/decisionPlayback.js";

function formatTimestamp(value) {
  if (!value) return "Session order";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Session order";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(date);
}

function revisionValue(value) {
  return value === null || value === undefined ? "—" : value;
}

function scopeLabel(scope) {
  if (scope === "canonical") return "Decision change";
  if (scope === "presentation") return "Page-only change";
  return String(scope ?? "Activity").replaceAll(/[-_]/g, " ");
}

function EventDelta({ event }) {
  return (
    <dl className="os-playback-delta">
      <div>
        <dt>Decision</dt>
        <dd>{revisionValue(event.decision.before)} <IconArrowRight size={14} /> {revisionValue(event.decision.after)}</dd>
      </div>
      <div>
        <dt>Page view</dt>
        <dd>{revisionValue(event.view.before)} <IconArrowRight size={14} /> {revisionValue(event.view.after)}</dd>
      </div>
      <div>
        <dt>Effect</dt>
        <dd>{event.decision.changed ? "Decision changed" : event.view.changed ? "Page only" : "No change"}</dd>
      </div>
    </dl>
  );
}

export function DecisionPlayback({ receipts, activeCaseId }) {
  const playback = useMemo(
    () => buildDecisionPlayback(receipts, { activeCaseId }),
    [receipts, activeCaseId],
  );
  const [selectedId, setSelectedId] = useState(playback.events.at(-1)?.id ?? "");
  const [compareOpen, setCompareOpen] = useState(false);
  const [leftId, setLeftId] = useState(playback.events.at(-2)?.id ?? playback.events[0]?.id ?? "");
  const [rightId, setRightId] = useState(playback.events.at(-1)?.id ?? "");

  useEffect(() => {
    if (!playback.events.some((event) => event.id === selectedId)) {
      setSelectedId(playback.events.at(-1)?.id ?? "");
    }
    if (!playback.events.some((event) => event.id === leftId)) {
      setLeftId(playback.events.at(-2)?.id ?? playback.events[0]?.id ?? "");
    }
    if (!playback.events.some((event) => event.id === rightId)) {
      setRightId(playback.events.at(-1)?.id ?? "");
    }
  }, [playback.events, selectedId, leftId, rightId]);

  const selected = playback.events.find((event) => event.id === selectedId) ?? playback.events.at(-1);
  const left = playback.events.find((event) => event.id === leftId);
  const right = playback.events.find((event) => event.id === rightId);
  const comparison = comparePlaybackEvents(left, right, playback.events);

  if (!playback.events.length) {
    return <p className="os-empty-state">No activity has been recorded for this decision yet.</p>;
  }

  return (
    <section className="os-decision-playback" aria-labelledby="decision-playback-heading">
      <header className="os-playback-heading">
        <div>
          <span className="os-eyebrow">Change history</span>
          <h3 id="decision-playback-heading">Trace what changed and why</h3>
          <p>See decision changes, page-only changes, imports, human actions, and agent activity separately.</p>
        </div>
        <div className="os-playback-summary" aria-label="Playback summary">
          <span><strong>{playback.summary.total}</strong> events</span>
          <span><strong>{playback.summary.canonicalChanges}</strong> decision changes</span>
          <span><strong>{playback.summary.presentationChanges}</strong> page-only changes</span>
          <button type="button" aria-pressed={compareOpen} onClick={() => setCompareOpen((value) => !value)}>
            <IconGitCompare size={17} /> Compare
          </button>
        </div>
      </header>

      {compareOpen ? (
        <section className="os-playback-compare" aria-labelledby="playback-compare-heading">
          <div className="os-playback-compare-controls">
            <h4 id="playback-compare-heading">Compare two events</h4>
            <label>Earlier event<select value={leftId} onChange={(event) => setLeftId(event.target.value)}>{playback.events.map((event) => <option key={event.id} value={event.id}>{formatTimestamp(event.at)} · {event.label}</option>)}</select></label>
            <label>Later event<select value={rightId} onChange={(event) => setRightId(event.target.value)}>{playback.events.map((event) => <option key={event.id} value={event.id}>{formatTimestamp(event.at)} · {event.label}</option>)}</select></label>
          </div>
          {comparison ? (
            <div className={`os-playback-comparison-result ${comparison.decisionChanged ? "is-canonical" : "is-view-only"}`} role="status">
              <strong>{comparison.decisionChanged ? "Decision changed" : comparison.viewChanged ? "Page changed" : "No change"}</strong>
              <p>{comparison.summary}</p>
              {comparison.changedEntityIds.length ? <span>{comparison.changedEntityIds.length} decision items: {comparison.changedEntityIds.join(" · ")}</span> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="os-playback-workbench">
        <ol className="os-playback-track" aria-label="Ordered decision history">
          {playback.events.map((event, index) => (
            <li key={event.id} className={`scope-${event.scope} status-${event.status}`}>
              <button type="button" aria-current={event.id === selected?.id ? "step" : undefined} onClick={() => setSelectedId(event.id)}>
                <span className="os-playback-index">{String(index + 1).padStart(2, "0")}</span>
                <span><strong>{event.label}</strong><small>{formatTimestamp(event.at)} · {event.source}</small></span>
                <em>{scopeLabel(event.scope)}</em>
              </button>
            </li>
          ))}
        </ol>

        {selected ? (
          <article className={`os-playback-inspector scope-${selected.scope}`} aria-live="polite">
            <header>
              <span className="os-playback-seal"><IconPlayerPlay size={18} /> {scopeLabel(selected.scope)}</span>
              <div><span>{formatTimestamp(selected.at)}</span><h4>{selected.label}</h4><p>{selected.summary}</p></div>
            </header>
            <EventDelta event={selected} />
            <div className="os-playback-causal-path">
              <span className="os-eyebrow"><IconRoute size={16} /> Changed decision items</span>
              {selected.causalPath.length ? (
                <ol>{selected.causalPath.map((item) => <li key={item.entityId}><span>{item.order}</span><code>{item.entityId}</code></li>)}</ol>
              ) : <p>No decision item changed in this event.</p>}
            </div>
            <footer><code>{selected.id}</code><span>{selected.status}</span></footer>
          </article>
        ) : null}
      </div>
    </section>
  );
}

export default DecisionPlayback;
