import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/libre-baskerville/latin-400.css";
import "@fontsource/libre-baskerville/latin-700.css";
import "@fontsource/ibm-plex-sans-condensed/latin-400.css";
import "@fontsource/ibm-plex-sans-condensed/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { CompiledRoomView } from "../src/components/composer/CompiledRoomView.jsx";
import { compilePresentation, createDefaultPresentationRecipe } from "../src/presentation/index.js";
import "../src/styles/composition.css";
import "./presentation-preview.css";

const snapshot = {
  schemaVersion: "1.0",
  caseId: "GENERIC-DECISION-001",
  decisionRevision: 8,
  decisionHash: "sha256:8d4d863dd7be320f802e527f20ca3213897b507a5c5b34dcbf0d70db850d44e1",
  viewRevision: 2,
  frozen: false,
  domain: { id: "generic-v1", kind: "generic", label: "General decision", riskLevel: "standard" },
  contract: { title: "Choose an evidence-backed option", question: "Which option best satisfies our declared constraints?", status: "active", authority: "human-only" },
  entities: [
    { id: "option-a", kind: "alternative", label: "Option A", summary: "Strongest verified option", status: "eligible", attributes: { risk: 2, benefit: 8, totalCost: 280000 } },
    { id: "option-b", kind: "alternative", label: "Option B", summary: "Blocked by the protected cost limit", status: "blocked", attributes: { risk: 6, benefit: 5, totalCost: 305000 } },
    { id: "criterion-cost", kind: "criterion", label: "Three-year cost", summary: "Must remain within EUR 300,000", status: "pass", attributes: { weight: 10, threshold: 300000 } },
    { id: "criterion-support", kind: "criterion", label: "Continuous support", summary: "Named support must remain available continuously", status: "pass", attributes: { weight: 8 } },
    { id: "constraint-cost", kind: "constraint", label: "Approved cost limit", summary: "This protected cap cannot be weakened", status: "fail", attributes: { mandatory: true, code: "C1" } },
    { id: "evidence-cost", kind: "evidence", label: "Submitted commercial terms", summary: "Option B totals EUR 305,000 after required recurring fees.", status: "verified", attributes: { citation: "Commercial terms, p. 23", sourceId: "source-commercial", confidence: 0.98 } },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `evidence-support-${index + 1}`,
      kind: "evidence",
      label: `Support exhibit ${index + 1}`,
      summary: `Canonical support exhibit ${index + 1} remains available for detailed review.`,
      status: "verified",
      attributes: { citation: `Support appendix, p. ${index + 2}`, sourceId: "source-commercial", confidence: 0.9 },
    })),
    { id: "claim-cost", kind: "claim", label: "Required fees exceed the cap", summary: "The mandatory recurring fee raises the evaluated total above the protected threshold.", status: "verified", attributes: { confidence: 0.98 } },
    { id: "stakeholder-finance", kind: "stakeholder", label: "Finance", summary: "Protect the approved envelope", attributes: { question: "Does the option remain inside the approved cost limit?", mandate: "Expose every required recurring fee." } },
    { id: "stakeholder-operations", kind: "stakeholder", label: "Operations", summary: "Protect continuity", attributes: { question: "Can operations depend on the selected option?", mandate: "Require continuous named support." } },
    { id: "control-cost", kind: "control", label: "Hypothetical total cost", summary: "Stages a value without changing the canonical record", attributes: { control: "range", min: 260000, max: 320000, step: 1000, value: 305000, baseline: 305000, unit: "EUR" } },
    { id: "control-support", kind: "control", label: "Continuous support commitment", summary: "Stages a contractual commitment", attributes: { control: "boolean", value: false, baseline: false } },
  ],
  results: [
    { id: "a-cost", kind: "evaluation", subjectId: "option-a", criterionId: "criterion-cost", status: "pass", value: 280000, unit: "EUR", reason: "Inside the approved cap.", evidenceIds: ["evidence-cost"] },
    { id: "b-cost", kind: "evaluation", subjectId: "option-b", criterionId: "criterion-cost", status: "fail", value: 305000, unit: "EUR", reason: "Exceeds the cap by EUR 5,000.", evidenceIds: ["evidence-cost"] },
    { id: "a-support", kind: "evaluation", subjectId: "option-a", criterionId: "criterion-support", status: "pass", value: 8, unit: "points", reason: "Continuous named support is committed.", evidenceIds: ["evidence-cost"] },
    { id: "b-support", kind: "evaluation", subjectId: "option-b", criterionId: "criterion-support", status: "fail", value: 3, unit: "points", reason: "Continuous named support is not committed.", evidenceIds: ["evidence-cost"] },
  ],
  relations: [
    { id: "supports", type: "supports", from: { kind: "evidence", id: "evidence-cost" }, to: { kind: "claim", id: "claim-cost" } },
    { id: "evaluates", type: "evaluated-against", from: { kind: "claim", id: "claim-cost" }, to: { kind: "constraint", id: "constraint-cost" } },
  ],
  paths: [{ id: "cost-path", label: "Commercial terms to protected cost outcome", entityRefs: [{ kind: "evidence", id: "evidence-cost" }, { kind: "claim", id: "claim-cost" }, { kind: "constraint", id: "constraint-cost" }, { kind: "alternative", id: "option-b" }], resultIds: ["b-cost"], status: "fail" }],
  sources: [{ id: "source-commercial", kind: "source", label: "Commercial terms.pdf", format: "pdf", status: "ready", locations: [{ label: "p. 23", locator: "page:23" }] }],
  pins: [{ kind: "evidence", id: "evidence-cost" }],
  protected: { entityRefs: [{ kind: "constraint", id: "constraint-cost" }], blockerResultIds: ["b-cost"], omittedEntityCount: 7, prohibitedEntityKinds: [], authority: { mode: "human-only", canApprove: false } },
  policy: { allowedInstrumentTypes: null, blockedInstrumentTypes: [], maxInstrumentCount: 10 },
  permissions: { canCompose: true, canSimulate: true, canApprove: false },
  metadata: { locale: "en-GB", currency: "EUR" },
  domainData: {},
};

const lenses = ["investigate", "compare", "simulate", "brief"];

function compile(lens) {
  const result = compilePresentation(snapshot, createDefaultPresentationRecipe(snapshot, { lens }));
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.plan;
}

function Preview() {
  const [lens, setLens] = useState("investigate");
  const [lastAction, setLastAction] = useState(null);
  const plan = useMemo(() => compile(lens), [lens]);
  return (
    <main className="presentation-preview">
      <header className="preview-header">
        <div><strong>Situation<span>Room</span></strong><small>Semantic compiler preview</small></div>
        <nav aria-label="Preview layouts">
          {lenses.map((item) => <button type="button" key={item} aria-current={item === lens ? "page" : undefined} onClick={() => setLens(item)}>{item}</button>)}
        </nav>
      </header>
      <section className="preview-contract" aria-label="Decision contract">
        <span>Case {snapshot.caseId}</span><strong>{snapshot.contract.title}</strong><span>Human authority retained</span>
      </section>
      <div className="preview-stage">
        <CompiledRoomView snapshot={snapshot} plan={plan} onAction={setLastAction} />
      </div>
      <output className="preview-action-receipt" aria-live="polite">{lastAction ? JSON.stringify(lastAction) : "No interaction yet"}</output>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Preview />);
