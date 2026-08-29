import { useEffect, useMemo, useState } from "react";
import {
  IconCheck,
  IconCircleX,
  IconFileText,
  IconInfoCircle,
  IconLock,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { EVIDENCE, REQUIREMENTS, VENDORS } from "../data/caseData.js";
import {
  evaluateCase,
  evaluateVendor,
  getCausalPaths,
  getEvidence,
  getRequirement,
} from "../decisionEngine.js";
import {
  closeApprovalPreview,
  commitApproval,
  focusEvidence,
  toggleSources,
  toggleOutline,
  useRoomStore,
} from "../roomStore.js";

export function SourceDrawer() {
  const open = useRoomStore((state) => state.sourceDrawerOpen);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return EVIDENCE;
    return EVIDENCE.filter((evidence) =>
      [evidence.title, evidence.document, evidence.text, evidence.citation]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [query]);

  if (!open) return null;
  return (
    <aside className="source-drawer" aria-labelledby="source-drawer-title">
      <header>
        <div>
          <span className="section-kicker">Canonical archive</span>
          <h2 id="source-drawer-title">All cited evidence</h2>
        </div>
        <button className="icon-button" type="button" onClick={toggleSources} aria-label="Close evidence archive">
          <IconX size={20} />
        </button>
      </header>
      <label className="drawer-search">
        <IconSearch size={18} />
        <span className="sr-only">Search evidence</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search passages, vendors, or citations" />
      </label>
      <div className="source-drawer__list">
        {filtered.map((evidence) => (
          <button
            type="button"
            className="source-row"
            key={evidence.id}
            onClick={() => {
              focusEvidence(evidence.id);
              toggleSources();
            }}
          >
            <IconFileText size={18} />
            <span>
              <strong>{evidence.title}</strong>
              <small>{evidence.document} · {evidence.citation}</small>
              <span>{evidence.text}</span>
            </span>
          </button>
        ))}
      </div>
      <footer>{filtered.length} of {EVIDENCE.length} passages</footer>
    </aside>
  );
}

export function OutlineView() {
  const open = useRoomStore((state) => state.outlineOpen);
  const view = useRoomStore((state) => state.view);
  if (!open) return null;

  const vendorIds = view.activeVendorIds.length ? view.activeVendorIds : VENDORS.map((vendor) => vendor.id);
  const paths = vendorIds.flatMap((vendorId) => getCausalPaths(vendorId));

  return (
    <section className="outline-overlay" aria-labelledby="outline-title">
      <header>
        <div>
          <span className="section-kicker">Accessible causal outline</span>
          <h2 id="outline-title">{view.question}</h2>
        </div>
        <button className="icon-button" type="button" onClick={toggleOutline} aria-label="Close outline">
          <IconX size={21} />
        </button>
      </header>
      <p className="outline-summary">
        The same entities, values, statuses, and citations are presented below in source-to-outcome reading order.
      </p>
      <ol className="outline-list">
        {paths.map((path) => (
          <li key={path.id}>
            <div className={`outline-status status-${path.status}`}>
              {path.status === "pass" ? <IconCheck size={18} /> : <IconCircleX size={18} />}
              {path.status}
            </div>
            <div>
              <span className="section-kicker">{path.requirement.code} · {path.requirement.title}</span>
              <h3>{path.reason}</h3>
              {path.evidence.map((evidence) => (
                <button type="button" key={evidence.id} onClick={() => focusEvidence(evidence.id)}>
                  <strong>{evidence.title}</strong>
                  <span>“{evidence.text}”</span>
                  <small>{evidence.document} · {evidence.citation}</small>
                </button>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function WhyThisView({ open, onClose }) {
  const room = useRoomStore();
  if (!open) return null;
  return (
    <aside className="why-view" aria-labelledby="why-view-title">
      <header>
        <div>
          <span className="section-kicker">Composition receipt</span>
          <h2 id="why-view-title">Why this view</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close composition receipt">
          <IconX size={20} />
        </button>
      </header>
      <div className="why-view__question">Arranged for: “{room.view.question}”</div>
      <dl>
        <div><dt>Lens</dt><dd>{room.view.lens}</dd></div>
        <div><dt>Visible context</dt><dd>{31 - room.omittedEntityCount} of 31 entities</dd></div>
        <div><dt>Protected gates</dt><dd>All mandatory blockers retained</dd></div>
        <div><dt>Decision revision</dt><dd>{room.caseRevision}</dd></div>
        <div><dt>View revision</dt><dd>{room.viewRevision}</dd></div>
        <div><dt>Human pins</dt><dd>{room.pinnedEvidenceIds.length + room.pinnedRequirementIds.length}</dd></div>
      </dl>
      <div className="why-view__modules">
        <span className="section-kicker">Selected instruments</span>
        {room.view.modules.map((module) => <span key={module}>{module.replaceAll("-", " ")}</span>)}
      </div>
      <div className="why-view__audit">
        <span className="section-kicker">Decision audit</span>
        {room.decisionAudit.slice().reverse().map((event) => (
          <div key={event.id}>
            <strong>Revision {event.revision}</strong>
            <span>{event.action}</span>
            <small>{event.actor} · {new Date(event.at).toLocaleString("en-GB")}</small>
          </div>
        ))}
      </div>
      <p><IconInfoCircle size={18} /> Presentation changed. Decision facts and approval authority did not.</p>
    </aside>
  );
}

export function ApprovalModal() {
  const approval = useRoomStore((state) => state.approval);
  const room = useRoomStore();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (approval.previewOpen) setConfirmed(false);
  }, [approval.previewOpen, approval.digest]);
  if (!approval.previewOpen) return null;

  const evaluation = evaluateVendor(approval.vendorId);
  const recommendation = evaluateCase().recommendation;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <header>
          <div>
            <span className="section-kicker">Human authority checkpoint</span>
            <h2 id="approval-title">Approve award recommendation</h2>
          </div>
          <button className="icon-button" type="button" onClick={closeApprovalPreview} aria-label="Close approval preview">
            <IconX size={20} />
          </button>
        </header>
        <div className="approval-summary">
          <strong>{evaluation.vendor.name}</strong>
          <span>{evaluation.score}/100 · passes all mandatory gates</span>
        </div>
        <dl>
          <div><dt>Decision revision</dt><dd>{room.caseRevision}</dd></div>
          <div><dt>Decision digest</dt><dd>{approval.digest}</dd></div>
          <div><dt>Recommended vendor</dt><dd>{recommendation.vendor.name}</dd></div>
          <div><dt>Approval actor</dt><dd>Human reviewer</dd></div>
        </dl>
        <label className="approval-confirmation">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I have reviewed the cited evidence, mandatory gates, and exact decision digest.</span>
        </label>
        <div className="approval-modal__actions">
          <button type="button" className="secondary-button" onClick={closeApprovalPreview}>Cancel</button>
          <button type="button" className="primary-button" disabled={!confirmed} onClick={commitApproval}>
            <IconLock size={18} /> Commit approval
          </button>
        </div>
      </section>
    </div>
  );
}
