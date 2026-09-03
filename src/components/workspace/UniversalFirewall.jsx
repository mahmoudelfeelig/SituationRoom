import {
  IconAlertTriangle,
  IconCheck,
  IconFingerprint,
  IconLock,
  IconScale,
  IconShieldCheck,
  IconUserCheck,
} from "@tabler/icons-react";
import { getDecisionHash } from "../../kernel/index.js";
import { getDomainConfig } from "../../workspace/domainConfig.js";
import { openApprovalPreview } from "../../workspace/workspaceStore.js";

function statusLabel(result) {
  if (!result) return "Unresolved";
  if (result.eligible) return "Eligible";
  return result.blockers?.length ? "Blocked" : "Needs review";
}

export function UniversalFirewall({ room }) {
  const decisionCase = room.activeCase;
  const evaluation = room.evaluation;
  if (!decisionCase || !evaluation) return null;
  const domain = getDomainConfig(decisionCase.domain.packId);
  const rankingAllowed = decisionCase.contract.authority.allowAutomatedRanking;
  const recommendation = evaluation.recommendation;
  const prohibited = decisionCase.contract.authority.prohibitedFields ?? [];
  const mandatory = decisionCase.constraints.filter((constraint) => constraint.severity === "mandatory");
  const candidateReview = decisionCase.domain.packId === "candidate-review";
  const candidateRequirementSummary = candidateReview
    ? mandatory.map((constraint) => {
        const evidence = evaluation.results.map((result) =>
          result.criteria?.find((entry) => entry.criterionId === constraint.criterionId),
        );
        return {
          constraint,
          verified: evidence.filter((entry) => entry?.status === "pass").length,
          notDemonstrated: evidence.filter((entry) => entry?.status === "fail").length,
          unresolved: evidence.filter((entry) => !entry || ["unknown", "conflict"].includes(entry.measurement?.status)).length,
        };
      })
    : [];
  const candidateNotDemonstrated = candidateRequirementSummary.reduce((sum, entry) => sum + entry.notDemonstrated, 0);
  const candidateUnresolved = candidateRequirementSummary.reduce((sum, entry) => sum + entry.unresolved, 0);
  const approved = decisionCase.status === "approved";
  const canApprove =
    !approved &&
    !room.frozen &&
    decisionCase.contract.status === "active" &&
    decisionCase.domain.packId !== "candidate-review" &&
    Boolean(recommendation?.eligible);

  return (
    <aside className="os-firewall" aria-label="Decision safeguards">
      <div className="os-firewall__title">
        <span className="os-eyebrow">Required checks</span>
        <h2>Decision safeguards</h2>
        <span className={`os-risk-stamp risk-${domain.riskLevel}`}>Rules active</span>
      </div>

      <section className="os-firewall__section os-firewall__verdict" aria-labelledby="verdict-heading">
        <div className="os-section-heading">
          <IconScale size={18} />
          <h3 id="verdict-heading">Current outcome</h3>
        </div>
        {rankingAllowed && recommendation ? (
          <>
            <span className="os-verdict-label">Best supported option</span>
            <strong className="os-verdict-name">{recommendation.alternative.label}</strong>
            <span className={`os-verdict-status ${recommendation.eligible ? "is-pass" : "is-blocked"}`}>
              {statusLabel(recommendation)}{Number.isFinite(recommendation.score) ? ` · ${recommendation.score}` : ""}
            </span>
          </>
        ) : (
          <>
            <span className="os-verdict-label">Automatic ranking is off</span>
            <strong className="os-verdict-name">A person must review</strong>
            <span className="os-verdict-status is-review">Evidence is organized, but no shortlist was chosen</span>
          </>
        )}
        <div className="os-firewall__metrics">
          {candidateReview ? (
            <>
              <span><strong>{candidateNotDemonstrated}</strong> not demonstrated</span>
              <span><strong>{candidateUnresolved}</strong> unresolved</span>
            </>
          ) : (
            <>
              <span><strong>{evaluation.blockerCount}</strong> blockers</span>
              <span><strong>{evaluation.unresolvedCount}</strong> unanswered</span>
            </>
          )}
          <span><strong>{room.pins.length}</strong> pins</span>
        </div>
      </section>

      {decisionCase.domain.packId === "candidate-review" ? (
        <button type="button" className="os-approval-button" disabled>
          <IconLock size={17} /> Human employment decision only
        </button>
      ) : (
        <button
          type="button"
          className="os-approval-button"
          onClick={() => openApprovalPreview(recommendation?.alternativeId)}
          disabled={!canApprove}
        >
          <IconLock size={17} />
          {approved ? "Decision approved" : room.frozen ? "Changes paused" : decisionCase.contract.status === "draft" ? "Finish setup before review" : canApprove ? "Review decision" : "Review unavailable"}
        </button>
      )}

      <details className="os-firewall-details">
        <summary>
          <IconShieldCheck size={18} />
          <span>Why this result is allowed or blocked</span>
          <strong>{mandatory.length}</strong>
        </summary>
        <div className="os-firewall-details__body">
          <section className="os-authority-rail" aria-labelledby="authority-heading">
            <div className="os-section-heading">
              <IconUserCheck size={18} />
              <h3 id="authority-heading">Who decides</h3>
            </div>
            <strong>{domain.authorityLabel}</strong>
            <dl>
              <div><dt>Decision type</dt><dd>{decisionCase.contract.authority.mode}</dd></div>
              <div><dt>Region</dt><dd>{decisionCase.locale || "Not specified"}</dd></div>
              <div><dt>What the agent can do</dt><dd>Analyze and prepare changes</dd></div>
            </dl>
          </section>

          <section className="os-firewall__section" aria-labelledby="gates-heading">
            <div className="os-section-heading">
              <IconShieldCheck size={18} />
              <h3 id="gates-heading">{candidateReview ? "Required job evidence" : "Required checks"}</h3>
              <span>{mandatory.length}</span>
            </div>
            <ul className="os-gate-ledger">
              {candidateReview ? candidateRequirementSummary.slice(0, 6).map(({ constraint, verified, notDemonstrated, unresolved }) => (
                <li key={constraint.id} className={notDemonstrated || unresolved ? "is-blocked" : "is-clear"}>
                  {notDemonstrated || unresolved ? <IconAlertTriangle size={16} /> : <IconCheck size={16} />}
                  <span>{constraint.label ?? evaluation.criterionIndex?.[constraint.criterionId]?.label ?? constraint.criterionId}</span>
                  <strong>{notDemonstrated
                    ? `${notDemonstrated} not demonstrated`
                    : unresolved ? `${unresolved} unresolved` : `${verified} verified`}</strong>
                </li>
              )) : mandatory.length ? mandatory.slice(0, 6).map((constraint) => {
                const affected = evaluation.results.filter((result) =>
                  result.blockers.some((entry) => entry.constraints.some((item) => item.constraint.id === constraint.id)),
                );
                return (
                  <li key={constraint.id} className={affected.length ? "is-blocked" : "is-clear"}>
                    {affected.length ? <IconAlertTriangle size={16} /> : <IconCheck size={16} />}
                    <span>{constraint.label ?? evaluation.criterionIndex?.[constraint.criterionId]?.label ?? constraint.criterionId}</span>
                    <strong>{affected.length ? `${affected.length} blocked` : "Clear"}</strong>
                  </li>
                );
              }) : <li className="is-clear"><IconCheck size={16} /><span>No mandatory gates declared</span></li>}
            </ul>
          </section>

          {prohibited.length ? (
            <details className="os-prohibited-ledger">
              <summary>Information the agent cannot use <span>{prohibited.length}</span></summary>
              <p>{prohibited.slice(0, 8).join(" · ")}{prohibited.length > 8 ? " · …" : ""}</p>
            </details>
          ) : null}

          <div className="os-digest">
            <IconFingerprint size={17} />
            <span>Decision version {decisionCase.revision}</span>
            <code>{getDecisionHash(decisionCase).slice(0, 12)}</code>
          </div>
        </div>
      </details>
    </aside>
  );
}
