import { useEffect, useMemo, useState } from "react";
import {
  IconArchive,
  IconCheck,
  IconCopy,
  IconFileSearch,
  IconFingerprint,
  IconHistory,
  IconPin,
  IconRoute,
  IconShieldCheck,
} from "@tabler/icons-react";
import { getDecisionHash } from "../../kernel/index.js";
import {
  closeApprovalPreview,
  commitHumanApproval,
  focusEntity,
  toggleAudit,
  toggleOutline,
  togglePin,
  toggleSourceDrawer,
} from "../../workspace/workspaceStore.js";
import { ModalSurface } from "./ModalSurface.jsx";

function humanize(value) {
  return String(value ?? "").replaceAll(/[-_]/g, " ");
}

function formatTimestamp(value) {
  if (!value) return "Current session";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function SourceArchive({ room }) {
  const [query, setQuery] = useState("");
  const sources = room.snapshot?.sources ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sources;
    return sources.filter((source) =>
      `${source.label} ${source.text} ${source.locator} ${source.format}`.toLowerCase().includes(needle),
    );
  }, [sources, query]);
  return (
    <ModalSurface
      open={room.sourceDrawerOpen}
      title="Source archive"
      eyebrow="Untrusted material · exact anchors retained"
      onClose={() => toggleSourceDrawer(false)}
      size="large"
    >
      <div className="os-source-toolbar">
        <label>
          <IconFileSearch size={18} />
          <span className="sr-only">Search source archive</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search passages, cells, pages, or files" />
        </label>
        <span>{filtered.length} of {sources.length} anchored passages</span>
      </div>
      <ol className="os-source-ledger">
        {filtered.map((source, index) => {
          const ref = { kind: "source", id: source.id };
          const pinned = room.pins.some((pin) => pin.kind === ref.kind && pin.id === ref.id);
          return (
            <li key={source.id} data-source-id={source.id}>
              <div className="os-source-number">{String(index + 1).padStart(2, "0")}</div>
              <div className="os-source-content">
                <div className="os-source-meta">
                  <strong>{source.label}</strong>
                  <span>{source.format} · {source.locator}</span>
                  <span>{Math.round((source.confidence ?? 1) * 100)}% extraction confidence</span>
                </div>
                <blockquote>{source.text}</blockquote>
                <div className="os-source-actions">
                  <button type="button" onClick={() => focusEntity(ref)}><IconRoute size={16} /> Trace</button>
                  <button type="button" aria-pressed={pinned} onClick={() => togglePin(ref)}><IconPin size={16} /> {pinned ? "Pinned" : "Pin"}</button>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(`${source.label} · ${source.locator}\n${source.text}`)}><IconCopy size={16} /> Copy citation</button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {!filtered.length ? <p className="os-empty-state">No anchored source passage matches this search.</p> : null}
    </ModalSurface>
  );
}

export function AccessibleOutline({ room }) {
  const plan = room.plan;
  const itemIndex = useMemo(() => {
    const items = [
      ...(room.snapshot?.entities ?? []),
      ...(room.snapshot?.results ?? []),
      ...(room.snapshot?.sources ?? []),
    ];
    return new Map(items.map((item) => [`${item.kind ?? (item.text ? "source" : "result")}:${item.id}`, item]));
  }, [room.snapshot]);
  return (
    <ModalSurface open={room.outlineOpen} title="Accessible room outline" eyebrow="Same plan · linear reading order" onClose={() => toggleOutline(false)} size="large">
      {plan ? (
        <article className="os-outline" aria-label={`${plan.question} outline`}>
          <header><span>{humanize(plan.lens)}</span><h3>{plan.question}</h3><p>{plan.framing}</p></header>
          {plan.instruments.map((instrument) => (
            <section key={instrument.id}>
              <span className="os-eyebrow">{instrument.systemInjected ? "Protected" : humanize(instrument.region)}</span>
              <h4>{humanize(instrument.type)}</h4>
              <ul>
                {(instrument.entityRefs ?? []).slice(0, 16).map((reference) => {
                  const item = itemIndex.get(`${reference.kind}:${reference.id}`);
                  return <li key={`${reference.kind}:${reference.id}`}><strong>{item?.label ?? reference.id}</strong><span>{item?.summary ?? item?.formattedValue ?? humanize(item?.status ?? reference.kind)}</span></li>;
                })}
              </ul>
              {(instrument.entityRefs?.length ?? 0) > 16 ? <p>{instrument.entityRefs.length - 16} more canonical items remain reachable in the full room.</p> : null}
            </section>
          ))}
        </article>
      ) : <p className="os-empty-state">No compiled room is active.</p>}
    </ModalSurface>
  );
}

export function AuditLedger({ room }) {
  const receipts = room.receipts;
  return (
    <ModalSurface open={room.auditOpen} title="Revision and tool ledger" eyebrow="Append-only local receipts" onClose={() => toggleAudit(false)} size="large">
      <div className="os-audit-summary">
        <div><IconFingerprint size={19} /><span>Decision digest</span><code>{room.activeCase ? getDecisionHash(room.activeCase) : "Unavailable"}</code></div>
        <div><IconHistory size={19} /><span>Decision / view</span><strong>{room.activeCase?.revision ?? 0} / {room.viewRevision}</strong></div>
      </div>
      <ol className="os-receipt-ledger">
        {receipts.map((receipt) => (
          <li key={receipt.id}>
            <span className={`os-receipt-status status-${receipt.status ?? "committed"}`}><IconCheck size={15} /> {receipt.status ?? "committed"}</span>
            <div><strong>{humanize(receipt.type ?? receipt.commandType)}</strong><span>{receipt.source ? `${receipt.source} · ` : ""}{formatTimestamp(receipt.at)}</span></div>
            <dl>
              {receipt.revisionBefore !== undefined ? <div><dt>Decision</dt><dd>{receipt.revisionBefore ?? "new"} → {receipt.revisionAfter}</dd></div> : null}
              {receipt.viewRevisionBefore !== undefined ? <div><dt>View</dt><dd>{receipt.viewRevisionBefore} → {receipt.viewRevisionAfter}</dd></div> : null}
              <div><dt>Receipt</dt><dd>{receipt.id.slice(0, 20)}</dd></div>
            </dl>
          </li>
        ))}
      </ol>
      {!receipts.length ? <p className="os-empty-state">No workspace receipts have been recorded for this case. Seed-case creation remains in the canonical case audit.</p> : null}
    </ModalSurface>
  );
}

export function HumanApprovalModal({ room }) {
  const [confirmed, setConfirmed] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const target = room.evaluation?.results.find((result) => result.alternativeId === room.approvalTargetId);
  const digest = room.activeCase ? getDecisionHash(room.activeCase) : "";
  useEffect(() => {
    if (room.approvalOpen) {
      setConfirmed(false);
      setError("");
    }
  }, [room.approvalOpen]);
  function close() {
    if (committing) return;
    setConfirmed(false);
    setError("");
    closeApprovalPreview();
  }
  async function commit() {
    setCommitting(true);
    setError("");
    try {
      await commitHumanApproval();
      setConfirmed(false);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
    } finally {
      setCommitting(false);
    }
  }
  return (
    <ModalSurface
      open={room.approvalOpen}
      title="Commit the human decision"
      eyebrow="Not exposed through WebMCP · explicit UI confirmation"
      onClose={close}
      closeDisabled={committing}
      footer={(
        <>
          <button type="button" className="os-button-secondary" disabled={committing} onClick={close}>Cancel</button>
          <button type="button" className="os-button-primary" disabled={!confirmed || committing || !target?.eligible} onClick={commit}>
            <IconShieldCheck size={18} /> {committing ? "Committing exact digest" : "Commit approval"}
          </button>
        </>
      )}
    >
      {target ? (
        <div className="os-approval-sheet">
          <span className="os-verdict-label">Selected alternative</span>
          <h3>{target.alternative.label}</h3>
          <p>This action approves the current evidence-backed recommendation and freezes the exact decision revision. It does not perform any external purchase, enrollment, hiring, or submission.</p>
          <dl>
            <div><dt>Decision revision</dt><dd>{room.activeCase.revision}</dd></div>
            <div><dt>Eligibility</dt><dd>{target.eligible ? "Every mandatory gate passes" : "Blocked"}</dd></div>
            <div><dt>Digest</dt><dd><code>{digest}</code></dd></div>
          </dl>
          <label className="os-confirmation-check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I reviewed the cited evidence, unresolved items, and protected constraints. This is my decision.</span>
          </label>
          {error ? <p className="os-error-message" role="alert">{error}</p> : null}
        </div>
      ) : <p className="os-empty-state">The proposed alternative is no longer available. Close this dialog and refresh the decision.</p>}
    </ModalSurface>
  );
}

export function WorkspaceOverlays({ room, intake }) {
  // A single modal owns focus at a time. Human approval and import recovery
  // outrank utility overlays; hidden utility state can resume after they close.
  if (room.approvalOpen) return <HumanApprovalModal room={room} />;
  if (room.intakeOpen) return intake;
  if (room.auditOpen) return <AuditLedger room={room} />;
  if (room.outlineOpen) return <AccessibleOutline room={room} />;
  if (room.sourceDrawerOpen) return <SourceArchive room={room} />;
  return null;
}
