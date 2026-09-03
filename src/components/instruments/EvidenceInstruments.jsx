import {
  IconAlertTriangle,
  IconFileDescription,
  IconPin,
  IconQuote,
} from "@tabler/icons-react";
import { normalizeStatus } from "../../presentation/presentationSelectors.js";
import {
  BoundedInstrumentRegion,
  EmptyInstrumentState,
  InstrumentAction,
  InstrumentFrame,
  StatusMark,
} from "./InstrumentFrame.jsx";
import {
  citationFor,
  confidenceFor,
  firstNonEmpty,
  getLimit,
  itemsByKinds,
  referencedItems,
  summaryFor,
  titleFor,
} from "./shared.js";

function Confidence({ item }) {
  const confidence = confidenceFor(item);
  if (confidence === null) return null;
  const percent = Math.round(confidence * 100);
  return (
    <span className="instrument-confidence">
      <span>Confidence</span>
      <meter min="0" max="1" low="0.6" high="0.85" optimum="1" value={confidence}>{percent}%</meter>
      <strong>{percent}%</strong>
    </span>
  );
}

function EvidenceRows({ items, instrument, onAction }) {
  return (
    <BoundedInstrumentRegion itemCount={items.length} label="Evidence excerpts" threshold={6}>
      <div className="evidence-excerpt-list">
        {items.map(({ item, reference }) => (
          <section className="evidence-excerpt-row" key={`${reference.kind}:${reference.id}`}>
            <div className="evidence-excerpt-row__meta">
              <span><IconQuote size={15} aria-hidden="true" /> {titleFor(item)}</span>
              {item.status ? <StatusMark status={item.status} /> : null}
            </div>
            <blockquote>{summaryFor(item)}</blockquote>
            {instrument.options?.showCitations !== false && citationFor(item) ? (
              <cite>{citationFor(item)}</cite>
            ) : null}
            {instrument.options?.showConfidence !== false ? <Confidence item={item} /> : null}
            <div className="instrument-inline-actions">
              <InstrumentAction
                type="focus"
                label="Trace"
                entityRef={reference}
                instrumentId={instrument.id}
                onAction={onAction}
              />
              <InstrumentAction
                type="pin"
                label="Pin"
                entityRef={reference}
                instrumentId={instrument.id}
                onAction={onAction}
              />
              {item.attributes?.sourceId ? (
                <InstrumentAction
                  type="open-source"
                  label="Open source"
                  entityRef={{ kind: "source", id: item.attributes.sourceId }}
                  instrumentId={instrument.id}
                  onAction={onAction}
                />
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </BoundedInstrumentRegion>
  );
}

export function EvidenceExcerptInstrument({ snapshot, instrument, onAction }) {
  const referenced = referencedItems(snapshot, instrument, ["evidence", "source"]);
  const fallback = itemsByKinds(snapshot, ["evidence"], getLimit(instrument)).map((item) => ({
    item,
    reference: { kind: item.kind, id: item.id },
  }));
  const items = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame
      instrument={instrument}
      kicker="Exact evidence"
      title={items[0] ? titleFor(items[0].item) : "No cited evidence"}
      status={items[0]?.item?.status}
      description="Canonical text is displayed as untrusted content and is never executed."
    >
      {items.length ? (
        <EvidenceRows items={items} instrument={instrument} onAction={onAction} />
      ) : (
        <EmptyInstrumentState>No evidence has been imported or linked to this view.</EmptyInstrumentState>
      )}
    </InstrumentFrame>
  );
}

export function SourcePreviewInstrument({ snapshot, instrument, onAction }) {
  const referenced = referencedItems(snapshot, instrument, ["source"]);
  const fallback = (snapshot.sources ?? []).map((item) => ({
    item: { ...item, kind: item.kind || "source" },
    reference: { kind: item.kind || "source", id: item.id },
  }));
  const sources = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Source archive" title="Imported sources">
      {sources.length ? (
        <BoundedInstrumentRegion itemCount={sources.length} label="Imported sources">
          <ul className="source-preview-list">
            {sources.map(({ item, reference }) => (
              <li key={`${reference.kind}:${reference.id}`}>
                <IconFileDescription size={19} aria-hidden="true" />
                <span>
                  <strong>{titleFor(item)}</strong>
                  <small>{[item.format, item.version, item.status].filter(Boolean).join(" · ")}</small>
                  {item.locations?.length ? (
                    <span>{item.locations.slice(0, 3).map((location) => location.label).join(", ")}</span>
                  ) : null}
                </span>
                <InstrumentAction
                  type="open-source"
                  label="Open"
                  entityRef={reference}
                  instrumentId={instrument.id}
                  onAction={onAction}
                />
              </li>
            ))}
          </ul>
        </BoundedInstrumentRegion>
      ) : (
        <EmptyInstrumentState>No source files are available in the canonical archive.</EmptyInstrumentState>
      )}
    </InstrumentFrame>
  );
}

export function ClaimInterpretationInstrument({ snapshot, instrument, onAction }) {
  const referenced = referencedItems(snapshot, instrument, ["claim", "interpretation"]);
  const fallback = itemsByKinds(snapshot, ["claim", "interpretation"], getLimit(instrument)).map((item) => ({
    item,
    reference: { kind: item.kind, id: item.id },
  }));
  const claims = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame
      instrument={instrument}
      kicker="Governed interpretation"
      title={claims[0] ? titleFor(claims[0].item) : "No interpretation available"}
      status={claims[0]?.item?.status}
    >
      {claims.length ? (
        <BoundedInstrumentRegion itemCount={claims.length} label="Governed claim interpretations">
          <ol className="claim-interpretation-list">
            {claims.map(({ item, reference }) => (
              <li key={`${reference.kind}:${reference.id}`}>
                <span className="interpretation-index" aria-hidden="true" />
                <div>
                  <strong>{titleFor(item)}</strong>
                  <p>{summaryFor(item)}</p>
                  <Confidence item={item} />
                  <InstrumentAction
                    type="focus"
                    label="Trace interpretation"
                    entityRef={reference}
                    instrumentId={instrument.id}
                    onAction={onAction}
                  />
                </div>
              </li>
            ))}
          </ol>
        </BoundedInstrumentRegion>
      ) : (
        <EmptyInstrumentState>No normalized claim is linked to this path.</EmptyInstrumentState>
      )}
    </InstrumentFrame>
  );
}

export function ContradictionDocketInstrument({ snapshot, instrument, onAction }) {
  const contradictionIds = new Set(
    (snapshot.relations ?? [])
      .filter((relation) => ["contradicts", "disputes", "opposes"].includes(relation.type))
      .flatMap((relation) => [relation.from.id, relation.to.id]),
  );
  const referenced = referencedItems(snapshot, instrument).filter(({ item }) => contradictionIds.has(item.id));
  const fallback = (snapshot.entities ?? [])
    .filter((item) =>
      contradictionIds.has(item.id) ||
      (item.status !== undefined && normalizeStatus(item.status) === "warning"),
    )
    .map((item) => ({ item, reference: { kind: item.kind, id: item.id } }));
  const items = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Challenge exhibit" title="Contradictions and disputes" status={items.length ? "warning" : "neutral"}>
      {items.length ? (
        <ul className="docket-list">
          {items.map(({ item, reference }) => (
            <li key={`${reference.kind}:${reference.id}`}>
              <IconAlertTriangle size={18} aria-hidden="true" />
              <span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small></span>
              <InstrumentAction type="focus" label="Inspect" entityRef={reference} instrumentId={instrument.id} onAction={onAction} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyInstrumentState>No contradictory or disputed canonical claims are linked to this view.</EmptyInstrumentState>
      )}
    </InstrumentFrame>
  );
}

const EVIDENCE_GAP_KINDS = new Set(["evidence", "claim", "source", "unknown", "missing", "document", "passage", "result", "evaluation"]);

function isEvidenceGap(item, allowedKinds) {
  if (!allowedKinds.has(item.kind)) return false;
  const confidence = confidenceFor(item);
  const status = item.status === undefined ? "neutral" : normalizeStatus(item.status);
  const measurementStatus = item.measurementStatus === undefined ? "neutral" : normalizeStatus(item.measurementStatus);
  return status === "warning" || status === "fail" || measurementStatus === "warning" || measurementStatus === "fail" || (confidence !== null && confidence < 0.6);
}

export function MissingEvidenceInstrument({
  snapshot,
  instrument,
  onAction,
  title = "Missing and unresolved evidence",
  kicker = "Evidence gaps",
  allowedKinds = EVIDENCE_GAP_KINDS,
  emptyMessage,
}) {
  const kinds = allowedKinds instanceof Set ? allowedKinds : new Set(allowedKinds);
  const referenced = referencedItems(snapshot, instrument).filter(({ item }) => isEvidenceGap(item, kinds));
  const fallback = [...(snapshot.entities ?? []), ...(snapshot.results ?? []), ...(snapshot.sources ?? [])]
    .filter((item) => isEvidenceGap(item, kinds))
    .map((item) => ({ item, reference: { kind: item.kind || "result", id: item.id } }));
  const items = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  const emptyGraph = (snapshot.entities?.length ?? 0) + (snapshot.sources?.length ?? 0) === 0;
  return (
    <InstrumentFrame instrument={instrument} kicker={kicker} title={title} status={items.length || emptyGraph ? "warning" : "pass"}>
      {items.length ? (
        <BoundedInstrumentRegion itemCount={items.length} label={title}>
          <ul className="docket-list">
            {items.map(({ item, reference }) => (
              <li key={`${reference.kind}:${reference.id}`}>
                <IconAlertTriangle size={18} aria-hidden="true" />
                <span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small></span>
                <InstrumentAction type="focus" label="Inspect gap" entityRef={reference} instrumentId={instrument.id} onAction={onAction} />
              </li>
            ))}
          </ul>
        </BoundedInstrumentRegion>
      ) : (
        <EmptyInstrumentState>
          {emptyMessage || (emptyGraph ? "No evidence has been imported yet." : "No unresolved evidence gaps are visible in this composition.")}
        </EmptyInstrumentState>
      )}
    </InstrumentFrame>
  );
}

export function PinnedContextInstrument({ snapshot, instrument, onAction }) {
  const items = referencedItems(snapshot, instrument).slice(0, getLimit(instrument));
  const unresolved = instrument.unresolvedEntityRefs ?? [];
  return (
    <InstrumentFrame instrument={instrument} kicker="Human-locked context" title="Pinned evidence and policy" status={unresolved.length ? "warning" : "neutral"}>
      {items.length ? (
        <ul className="pinned-context-list">
          {items.map(({ item, reference }) => (
            <li key={`${reference.kind}:${reference.id}`}>
              <IconPin size={17} aria-hidden="true" />
              <span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small></span>
              <InstrumentAction type="focus" label="Trace" entityRef={reference} instrumentId={instrument.id} onAction={onAction} />
            </li>
          ))}
        </ul>
      ) : null}
      {unresolved.length ? (
        <div className="unresolved-reference-warning" role="status">
          <IconAlertTriangle size={18} aria-hidden="true" />
          <span>{unresolved.length} pinned reference is unavailable after the latest import. The pin was retained.</span>
        </div>
      ) : null}
      {!items.length && !unresolved.length ? <EmptyInstrumentState>No human pins are active.</EmptyInstrumentState> : null}
    </InstrumentFrame>
  );
}

export function DataQualityDocketInstrument({ snapshot, instrument }) {
  const lowConfidence = (snapshot.entities ?? []).filter((item) => {
    const confidence = confidenceFor(item);
    return confidence !== null && confidence < 0.6;
  });
  const sourceProblems = (snapshot.sources ?? []).filter((source) => !["ready", "parsed"].includes(source.status));
  const issueCount = lowConfidence.length + sourceProblems.length;
  return (
    <InstrumentFrame instrument={instrument} kicker="Import quality" title="Data quality issues" status={issueCount ? "warning" : "pass"}>
      <dl className="quality-ledger">
        <div><dt>Canonical entities</dt><dd>{snapshot.entities?.length ?? 0}</dd></div>
        <div><dt>Imported sources</dt><dd>{snapshot.sources?.length ?? 0}</dd></div>
        <div><dt>Low-confidence items</dt><dd>{lowConfidence.length}</dd></div>
        <div><dt>Sources needing attention</dt><dd>{sourceProblems.length}</dd></div>
      </dl>
    </InstrumentFrame>
  );
}
