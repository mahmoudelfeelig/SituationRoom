import { IconBuildingHospital, IconPill } from "@tabler/icons-react";
import { normalizeStatus } from "../../presentation/presentationSelectors.js";
import { ComparisonMatrixInstrument, MetricWaterfallInstrument, RiskFrontierInstrument, TimelineInstrument } from "./AnalysisInstruments.jsx";
import { EmptyInstrumentState, InstrumentAction, InstrumentFrame, StatusMark } from "./InstrumentFrame.jsx";
import { MissingEvidenceInstrument } from "./EvidenceInstruments.jsx";
import { firstNonEmpty, getLimit, itemsByKinds, referencedItems, summaryFor, titleFor } from "./shared.js";

export function VendorLanesInstrument(props) {
  return <ComparisonMatrixInstrument {...props} title="Requirements by vendor" />;
}

export function TotalCostWaterfallInstrument(props) {
  return <MetricWaterfallInstrument {...props} title="Costs by option" />;
}

export function CandidateRequirementCoverageInstrument(props) {
  return <ComparisonMatrixInstrument {...props} title="Candidate requirement coverage" />;
}

export function VerifiedExperienceTimelineInstrument(props) {
  return <TimelineInstrument {...props} title="Verified experience timeline" />;
}

export function MissingVerificationDocketInstrument(props) {
  return (
    <MissingEvidenceInstrument
      {...props}
      title="Missing verification"
      kicker="Verification gaps"
      allowedKinds={["claim", "evidence", "source", "document", "passage"]}
      emptyMessage="Every job-related claim in this composition has accepted source evidence."
    />
  );
}

export function PlanCostWaterfallInstrument(props) {
  return <MetricWaterfallInstrument {...props} title="Premium, deductible, and out-of-pocket waterfall" />;
}

export function ProviderNetworkCheckInstrument({ snapshot, instrument, onAction }) {
  const kinds = ["provider", "network", "facility", "plan", "alternative"];
  const referenced = referencedItems(snapshot, instrument, kinds);
  const fallback = itemsByKinds(snapshot, kinds, getLimit(instrument)).map((item) => ({
    item,
    reference: { kind: item.kind, id: item.id },
  }));
  const items = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Coverage evidence" title="Provider network check" status={items.some(({ item }) => normalizeStatus(item.status) !== "pass") ? "warning" : "pass"}>
      {items.length ? (
        <ul className="network-check-list">
          {items.map(({ item, reference }) => (
            <li key={`${reference.kind}:${reference.id}`}>
              <IconBuildingHospital size={20} aria-hidden="true" />
              <span><strong>{titleFor(item)}</strong><small>{summaryFor(item)}</small></span>
              <StatusMark status={item.status} />
              <InstrumentAction type="focus" label="Inspect evidence" entityRef={reference} instrumentId={instrument.id} onAction={onAction} />
            </li>
          ))}
        </ul>
      ) : <EmptyInstrumentState>No provider-network evidence is available. Treat network status as unresolved.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

export function FormularyCoverageTableInstrument({ snapshot, instrument }) {
  const kinds = ["drug", "medication", "formulary-entry"];
  const referenced = referencedItems(snapshot, instrument, kinds).map(({ item }) => item);
  const fallback = itemsByKinds(snapshot, kinds, getLimit(instrument));
  const items = firstNonEmpty(referenced, fallback).slice(0, getLimit(instrument));
  return (
    <InstrumentFrame instrument={instrument} kicker="Cited plan rules" title="Formulary coverage">
      {items.length ? (
        <div className="comparison-table-scroll" tabIndex="0" role="region" aria-label="Formulary coverage table">
          <table className="formulary-table">
            <caption className="sr-only">Canonical drug tier and restriction information</caption>
            <thead><tr><th scope="col">Medication</th><th scope="col">Tier</th><th scope="col">Restriction</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <th scope="row"><IconPill size={17} aria-hidden="true" /> {titleFor(item)}</th>
                  <td>{item.attributes?.tier ?? "Unknown"}</td>
                  <td>{item.attributes?.restriction ?? item.summary ?? "Not provided"}</td>
                  <td><StatusMark status={item.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyInstrumentState>No formulary entries are available. Coverage must remain unresolved.</EmptyInstrumentState>}
    </InstrumentFrame>
  );
}

export function ParetoFrontierInstrument(props) {
  return <RiskFrontierInstrument {...props} title="Pareto trade-off frontier" />;
}

export function GenericRequirementCoverageInstrument(props) {
  return <ComparisonMatrixInstrument {...props} title="Declared criteria coverage" />;
}
