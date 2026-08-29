import {
  IconCheck,
  IconCircleX,
  IconLock,
  IconPin,
  IconRobot,
  IconShieldLock,
} from "@tabler/icons-react";
import { REQUIREMENTS } from "../data/caseData.js";
import { evaluateCase, evaluateVendor, getRequirement } from "../decisionEngine.js";
import {
  openApprovalPreview,
  togglePinRequirement,
  useRoomStore,
} from "../roomStore.js";

export function DecisionFirewall() {
  const room = useRoomStore();
  const caseEvaluation = evaluateCase();
  const vendorId =
    room.view.lens === "brief" || room.view.lens === "compare"
      ? caseEvaluation.recommendation.vendorId
      : room.view.activeVendorIds[0] ?? "vendor-b";
  const evaluation = evaluateVendor(vendorId);
  const pinned = room.pinnedRequirementIds;
  const hasDisputedEvidence = room.disputedEvidenceIds.some((evidenceId) =>
    evaluation.vendor.evidenceIds.includes(evidenceId),
  );

  return (
    <aside className="decision-firewall" aria-labelledby="firewall-heading" style={{ viewTransitionName: "decision-firewall" }}>
      <div className="firewall-bolts" aria-hidden="true"><span /><span /><span /><span /></div>
      <header className="firewall-header">
        <IconShieldLock size={22} />
        <div>
          <h2 id="firewall-heading">Decision Firewall</h2>
          <p>Invariant policy edge</p>
        </div>
      </header>

      <section className="firewall-section" aria-labelledby="gate-status-heading">
        <div className="section-kicker" id="gate-status-heading">Mandatory gates</div>
        <div className="firewall-gates">
          {evaluation.gates.map((gate) => {
            const requirement = getRequirement(gate.requirementId);
            const isPinned = pinned.includes(gate.requirementId);
            return (
              <div className={`firewall-gate status-${gate.status}`} key={gate.requirementId}>
                <span className="firewall-gate__status" aria-label={gate.status}>
                  {gate.status === "pass" ? <IconCheck size={16} /> : <IconCircleX size={16} />}
                </span>
                <span className="firewall-gate__copy">
                  <strong>{requirement.code}</strong>
                  <span>{requirement.shortTitle}</span>
                </span>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`${isPinned ? "Unpin" : "Pin"} ${requirement.title}`}
                  aria-pressed={isPinned}
                  onClick={() => togglePinRequirement(requirement.id)}
                >
                  <IconPin size={15} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="firewall-section">
        <div className="section-kicker">Human-locked policy</div>
        <div className="pinned-policy-list">
          {pinned.map((requirementId) => {
            const requirement = REQUIREMENTS.find((item) => item.id === requirementId);
            return (
              <div className="pinned-policy" key={requirementId}>
                <IconPin size={15} />
                <span>{requirement?.title}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="firewall-section firewall-receipt">
        <div className="section-kicker">View receipt</div>
        <p>{31 - room.omittedEntityCount} of 31 entities shown</p>
        <p>{evaluation.failures.length} mandatory blockers retained</p>
        <p>Decision revision {room.caseRevision} unchanged</p>
        <p>{room.pinnedEvidenceIds.length + room.pinnedRequirementIds.length} human pins preserved</p>
        <p>{hasDisputedEvidence ? "Disputed evidence blocks approval" : "No unresolved evidence disputes"}</p>
        <p>{room.viewStale ? "Current view is stale and must be recomposed" : "Current view matches decision state"}</p>
      </section>

      <section className="firewall-section webmcp-status">
        <IconRobot size={17} />
        <span>
          {room.webMcpAvailable
            ? `${room.webMcpToolCount} site tools available`
            : "Manual mode · site tools unavailable"}
        </span>
      </section>

      <div className={`eligibility-seal ${evaluation.eligible ? "is-eligible" : "is-blocked"}`}>
        <span className="section-kicker">Eligibility outcome</span>
        <strong>{evaluation.eligible ? "Eligible" : "Not eligible"}</strong>
        <span>{evaluation.vendor.name}</span>
        <span>
          {evaluation.eligible
            ? `Passes all ${evaluation.gates.length} mandatory gates`
            : `Fails ${evaluation.failures.length} of ${evaluation.gates.length} mandatory gates`}
        </span>
      </div>

      <button
        className="approval-button"
        type="button"
        disabled={!evaluation.eligible || hasDisputedEvidence || room.approval.status === "approved"}
        onClick={() => openApprovalPreview(evaluation.vendorId)}
      >
        <IconLock size={17} />
        {room.approval.status === "approved"
          ? "Award approved"
          : hasDisputedEvidence
            ? "Resolve evidence dispute"
            : evaluation.eligible
            ? "Preview human approval"
            : "Approval blocked"}
      </button>
    </aside>
  );
}
