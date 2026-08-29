import {
  IconArrowRight,
  IconCheck,
  IconCircleX,
  IconGitBranch,
  IconLock,
  IconPin,
  IconScale,
  IconSparkles,
} from "@tabler/icons-react";
import { EVIDENCE, REQUIREMENTS, STAKEHOLDERS, VENDORS } from "../data/caseData.js";
import {
  evaluateCase,
  evaluateVendor,
  formatCurrency,
  getCausalPaths,
  getEvidence,
  getRequirement,
  runScenario,
} from "../decisionEngine.js";
import {
  openScenario,
  resetScenario,
  saveScenario,
  setManualLens,
  togglePinRequirement,
  updateScenario,
  useRoomStore,
} from "../roomStore.js";
import { EvidenceSlip } from "./EvidenceSlip.jsx";

function CausalLink({ label }) {
  return (
    <div className="causal-link" aria-label={label}>
      <span />
      <IconArrowRight size={20} aria-hidden="true" />
    </div>
  );
}

function GatePlate({ path, pinned = false }) {
  const requirement = path.requirement;
  return (
    <article className={`gate-plate status-${path.status}`} style={{ viewTransitionName: `gate-${requirement.id}` }}>
      <div className="gate-plate__topline">
        <span>{requirement.code}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={`${pinned ? "Unpin" : "Pin"} ${requirement.title}`}
          aria-pressed={pinned}
          onClick={() => togglePinRequirement(requirement.id)}
        >
          <IconPin size={16} />
        </button>
      </div>
      <h3>{requirement.title}</h3>
      <p>{requirement.description}</p>
      <div className="gate-plate__source">
        {requirement.section} · {requirement.citation}
      </div>
      <div className="gate-plate__result">
        {path.status === "pass" ? <IconCheck size={17} /> : <IconCircleX size={17} />}
        <strong>{path.status}</strong>
        <span>{path.reason}</span>
      </div>
    </article>
  );
}

function VerdictPlate({ evaluation }) {
  return (
    <article className={`verdict-plate ${evaluation.eligible ? "is-eligible" : "is-blocked"}`}>
      <span className="section-kicker">Verdict</span>
      <h2>{evaluation.vendor.code === "B" ? "Vendor B" : evaluation.vendor.name}</h2>
      <strong>{evaluation.eligible ? "Is eligible" : "Is ineligible"}</strong>
      <p>
        {evaluation.eligible
          ? "Every mandatory gate is satisfied."
          : `Fails ${evaluation.failures.length} mandatory ${evaluation.failures.length === 1 ? "gate" : "gates"}.`}
      </p>
      {!evaluation.eligible && (
        <ol>
          {evaluation.failures.map((gate) => (
            <li key={gate.requirementId}>
              {getRequirement(gate.requirementId).title}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export function InvestigateView() {
  const room = useRoomStore();
  const vendorId = room.view.activeVendorIds[0] ?? "vendor-b";
  const evaluation = evaluateVendor(vendorId);
  const paths = getCausalPaths(vendorId);
  const responsePath = paths.find((path) => path.requirement.id === "r1");
  const costPath = paths.find((path) => path.requirement.id === "r4");
  const passedPaths = paths.filter((path) => path.status === "pass");
  const primaryEvidence = getEvidence(
    responsePath.evidence.find((evidence) => evidence.id.includes("response"))?.id ??
      responsePath.evidence[0].id,
  );
  const challenged = room.challengedEvidenceIds.includes(primaryEvidence.id);

  return (
    <section className="room-view investigate-view" aria-labelledby="investigate-title">
      <header className="view-heading">
        <div>
          <span className="section-kicker">Causal trace</span>
          <h2 id="investigate-title">Why ineligible, and what must change</h2>
        </div>
        <p>{room.view.framing}</p>
      </header>

      <div className="primary-trace">
        <EvidenceSlip evidence={primaryEvidence} status={responsePath.status} />
        <CausalLink label="Proposal claim interpreted against the requirement" />
        <article className="interpretation-sheet">
          <span className="section-kicker">Evidence interpretation</span>
          <h3>Monitoring is not incident response</h3>
          <p>
            Platform monitoring detects alerts. It does not commit a named human responder,
            fifteen-minute acknowledgement, or continuous engagement.
          </p>
          <div className="interpretation-sheet__confidence">High confidence · 2 exact excerpts</div>
        </article>
        <CausalLink label="Interpretation is evaluated against a mandatory gate" />
        <GatePlate
          path={responsePath}
          pinned={room.pinnedRequirementIds.includes(responsePath.requirement.id)}
        />
        <CausalLink label="Failed mandatory gate determines eligibility" />
        <VerdictPlate evaluation={evaluation} />
      </div>

      {challenged && (
        <aside className="challenge-exhibit" aria-live="polite">
          <div>
            <IconScale size={20} />
            <span className="section-kicker">Strongest opposing evidence</span>
          </div>
          <blockquote>
            “Our Network Operations Center monitors the platform 24/7 for system health,
            availability, and performance.”
          </blockquote>
          <p>
            This supports continuous monitoring, but it cannot satisfy R1 because the proposal
            separately limits human incident response to business hours.
          </p>
        </aside>
      )}

      <div className="secondary-trace">
        <EvidenceSlip evidence={costPath.evidence[0]} status={costPath.status} compact />
        <CausalLink label="The required recurring fee increases total cost" />
        <GatePlate path={costPath} pinned={room.pinnedRequirementIds.includes("r4")} />
        <button type="button" className="fork-handle" onClick={openScenario}>
          <IconGitBranch size={21} />
          <span>Fork scenario</span>
          <small>Show the minimum changes needed to win</small>
        </button>
      </div>

      <div className="verified-rail">
        <div>
          <IconCheck size={20} />
          <strong>{passedPaths.length} verified gates</strong>
          <span>Collapsed to keep the active blockers legible</span>
        </div>
        {passedPaths.map((path) => (
          <span key={path.id}>
            {path.requirement.code} · {path.requirement.shortTitle}
          </span>
        ))}
      </div>
    </section>
  );
}

export function CompareView() {
  const evaluation = evaluateCase();
  return (
    <section className="room-view compare-view" aria-labelledby="compare-title">
      <header className="view-heading">
        <div>
          <span className="section-kicker">Vendor comparison</span>
          <h2 id="compare-title">The same gates, aligned across every bid</h2>
        </div>
        <p>Mandatory failures remain visible even when a vendor scores well elsewhere.</p>
      </header>

      <div className="comparison-rulers" role="table" aria-label="Vendor comparison">
        <div className="comparison-corner" role="columnheader">Mandatory ruler</div>
        {evaluation.evaluations.map((entry) => (
          <div className="vendor-lane-header" role="columnheader" key={entry.vendorId}>
            <span className={`vendor-mark vendor-${entry.vendor.code.toLowerCase()}`}>{entry.vendor.code}</span>
            <div>
              <strong>{entry.vendor.name}</strong>
              <span>{formatCurrency(entry.totalCost)} · {entry.score}/100</span>
            </div>
          </div>
        ))}

        {REQUIREMENTS.map((requirement) => (
          <div className="comparison-row" role="row" key={requirement.id}>
            <div className="comparison-requirement" role="rowheader">
              <strong>{requirement.code}</strong>
              <span>{requirement.shortTitle}</span>
            </div>
            {evaluation.evaluations.map((entry) => {
              const gate = entry.gates.find((item) => item.requirementId === requirement.id);
              return (
                <div className={`comparison-cell status-${gate.status}`} role="cell" key={entry.vendorId}>
                  {gate.status === "pass" ? <IconCheck size={19} /> : <IconCircleX size={19} />}
                  <strong>{gate.status}</strong>
                  <span>{gate.reason}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="comparison-recommendation">
        <span className="section-kicker">Strongest eligible recommendation</span>
        <strong>{evaluation.recommendation.vendor.name}</strong>
        <span>
          All mandatory gates pass · {formatCurrency(evaluation.recommendation.totalCost)} three-year total
        </span>
      </div>
    </section>
  );
}

function ScenarioToggle({ checked, onChange, label, description }) {
  return (
    <label className={`scenario-toggle ${checked ? "is-on" : ""}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="scenario-toggle__state">{checked ? "Committed" : "Missing"}</span>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

export function SimulateView() {
  const scenario = useRoomStore((state) => state.scenario);
  const result = runScenario("vendor-b", {
    totalCost: scenario.totalCost,
    operations: scenario.operations,
  });
  const current = result.current;
  const staged = result.staged;

  const setOperations = (patch) =>
    updateScenario({ operations: { ...scenario.operations, ...patch } });

  return (
    <section className="room-view simulate-view" aria-labelledby="simulate-title">
      <header className="view-heading">
        <div>
          <span className="section-kicker">Counterfactual fork</span>
          <h2 id="simulate-title">What Vendor B must change to become eligible</h2>
        </div>
        <p>Every control is threaded into the deterministic decision engine.</p>
      </header>

      <div className="scenario-view-actions">
        <button type="button" onClick={resetScenario}>Reset submitted terms</button>
        <button type="button" onClick={() => setManualLens("investigate")}>Return to canonical room</button>
      </div>

      <div className="scenario-fold">
        <section className="canonical-plane" aria-labelledby="canonical-title">
          <span className="section-kicker">Current record · revision 17</span>
          <h3 id="canonical-title">Submitted proposal</h3>
          <div className="canonical-failures">
            {current.failures.map((gate) => (
              <div key={gate.requirementId}>
                <IconCircleX size={18} />
                <span>
                  <strong>{getRequirement(gate.requirementId).title}</strong>
                  <small>{gate.reason}</small>
                </span>
              </div>
            ))}
          </div>
          <div className="canonical-seal">Not eligible</div>
          <p>The canonical record is immutable and never overwritten by this fork.</p>
        </section>

        <div className="fold-spine" aria-hidden="true">
          <IconGitBranch size={24} />
          <span>Forked from revision 17</span>
        </div>

        <section className="staged-plane" aria-labelledby="staged-title">
          <span className="section-kicker">Staged conditions · scenario only</span>
          <h3 id="staged-title">Minimum viable concessions</h3>

          <div className="threshold-instrument">
            <div className="threshold-instrument__heading">
              <div>
                <strong>Three-year total cost</strong>
                <span>R4 · maximum €300,000 including all fees</span>
              </div>
              <output htmlFor="scenario-cost">{formatCurrency(scenario.totalCost)}</output>
            </div>
            <input
              id="scenario-cost"
              type="range"
              min="280000"
              max="320000"
              step="1000"
              value={scenario.totalCost}
              onChange={(event) => updateScenario({ totalCost: Number(event.target.value) })}
            />
            <div className="threshold-scale" aria-hidden="true">
              <span>€280k</span><strong>€300k cap</strong><span>€320k</span>
            </div>
          </div>

          <div className="response-instrument">
            <ScenarioToggle
              checked={scenario.operations.coverage === "24/7"}
              onChange={(checked) => setOperations({ coverage: checked ? "24/7" : "business-hours" })}
              label="24/7 human response"
              description="Removes the business-hours limitation"
            />
            <ScenarioToggle
              checked={scenario.operations.namedEngineer}
              onChange={(namedEngineer) => setOperations({ namedEngineer })}
              label="Named response engineer"
              description="Makes human ownership contractually explicit"
            />
            <ScenarioToggle
              checked={scenario.operations.acknowledgementMinutes <= 15}
              onChange={(checked) => setOperations({ acknowledgementMinutes: checked ? 15 : 60 })}
              label="15-minute acknowledgement"
              description="Meets the RFP response threshold"
            />
            <ScenarioToggle
              checked={scenario.operations.continuousEngagement}
              onChange={(continuousEngagement) => setOperations({ continuousEngagement })}
              label="Continuous engagement"
              description="Keeps the responder engaged until resolution"
            />
          </div>

          <div className="security-lock">
            <IconLock size={20} />
            <div>
              <strong>EU data residency remains locked</strong>
              <span>Security cannot be weakened by the scenario.</span>
            </div>
          </div>

          <div className={`scenario-outcome ${staged.eligible ? "is-viable" : "is-blocked"}`}>
            {staged.eligible ? <IconCheck size={24} /> : <IconCircleX size={24} />}
            <div>
              <span className="section-kicker">Projected outcome</span>
              <strong>{staged.eligible ? "Viable if committed" : "Still blocked"}</strong>
              <small>
                {staged.eligible
                  ? "All mandatory gates would pass. Original decision unchanged."
                  : `${staged.failures.length} mandatory ${staged.failures.length === 1 ? "gate remains" : "gates remain"}.`}
              </small>
            </div>
            <button type="button" onClick={saveScenario} disabled={!staged.eligible}>
              <IconSparkles size={17} /> {scenario.saved ? "Scenario saved" : "Save scenario exhibit"}
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

export function BriefView() {
  const evaluation = evaluateCase();
  const recommendation = evaluation.recommendation;
  const stakeholderRequirements = {
    finance: ["r4"],
    "clinical-ops": ["r1", "r3"],
    infosec: ["r2"],
  };

  return (
    <section className="room-view brief-view" aria-labelledby="brief-title">
      <header className="view-heading">
        <div>
          <span className="section-kicker">Decision council</span>
          <h2 id="brief-title">Three mandates, one protected recommendation</h2>
        </div>
        <p>The same evidence is reframed for each accountable reviewer.</p>
      </header>

      <div className="council-stage">
        {STAKEHOLDERS.map((stakeholder, index) => {
          const requirementIds = stakeholderRequirements[stakeholder.id];
          return (
            <section className={`council-lane council-lane-${index + 1}`} key={stakeholder.id}>
              <div className="council-lane__number">0{index + 1}</div>
              <span className="section-kicker">{stakeholder.label}</span>
              <h3>{stakeholder.question}</h3>
              <p>{stakeholder.mandate}</p>
              <div className="council-findings">
                {requirementIds.map((requirementId) => {
                  const gate = recommendation.gates.find((item) => item.requirementId === requirementId);
                  const requirement = getRequirement(requirementId);
                  return (
                    <div key={requirementId} className={`status-${gate.status}`}>
                      {gate.status === "pass" ? <IconCheck size={18} /> : <IconCircleX size={18} />}
                      <span>
                        <strong>{requirement.title}</strong>
                        <small>{gate.reason}</small>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        <div className="council-convergence" aria-hidden="true">
          <span /><span /><span />
          <IconArrowRight size={26} />
        </div>

        <article className="council-recommendation">
          <span className="section-kicker">Council recommendation</span>
          <h3>{recommendation.vendor.name}</h3>
          <strong>Eligible · {recommendation.score}/100</strong>
          <p>
            Passes every mandatory gate at {formatCurrency(recommendation.totalCost)} over three years.
          </p>
          <small>Human approval remains required.</small>
        </article>
      </div>
    </section>
  );
}

export function ActiveRoomView() {
  const lens = useRoomStore((state) => state.view.lens);
  if (lens === "compare") return <CompareView />;
  if (lens === "simulate") return <SimulateView />;
  if (lens === "brief") return <BriefView />;
  return <InvestigateView />;
}
