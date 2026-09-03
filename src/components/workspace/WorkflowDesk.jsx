import { useEffect, useState } from "react";
import {
  IconArchive,
  IconCheck,
  IconDownload,
  IconEdit,
  IconFileDescription,
  IconGitBranch,
  IconMessage2,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import {
  decideHumanResolution,
  decideModelProposal,
  downloadPreparedOutput,
  prepareCaseExport,
  stageReviewArtifact,
  toggleIntake,
  updateDecisionContract,
} from "../../workspace/workspaceStore.js";
import { ModelEditor } from "./ModelEditor.jsx";

const EXPORT_FORMATS = Object.freeze([
  ["pdf", "PDF report"],
  ["docx", "Word document"],
  ["xlsx", "Excel workbook"],
  ["csv", "Evidence spreadsheet"],
  ["html", "Web page"],
  ["json", "Structured data"],
  ["jsonld", "Linked data"],
]);
const REVIEW_PAGE_SIZE = 6;
const OUTPUT_PAGE_SIZE = 4;

const REVIEW_KIND_LABELS = Object.freeze({
  comment: "Comment",
  request_resolution: "Question to resolve",
  branch_proposal: "Alternative proposal",
  information_request: "Information request",
  external_action_draft: "Draft action",
  human_resolution_request: "Question needing a decision",
  decision_proposeContract: "Suggested question and goal",
  decision_upsertAlternative: "Suggested option",
  decision_upsertCriterion: "Suggested criterion",
  decision_upsertConstraint: "Suggested requirement",
  decision_upsertClaim: "Suggested evidence value",
});

function reviewLabel(value) {
  return REVIEW_KIND_LABELS[value] ?? String(value ?? "Review item")
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[-_]/g, " ")
    .replace(/^decision /, "Suggested ");
}

function reviewSourceLabel(source) {
  return ({ agent: "Browser agent", human: "Person", system: "SituationRoom" })[source] ?? reviewLabel(source);
}

function ContractDesk({ room }) {
  const [question, setQuestion] = useState(room.activeCase.contract.question);
  const [objective, setObjective] = useState(room.activeCase.contract.objective);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setQuestion(room.activeCase.contract.question);
    setObjective(room.pendingModelProposal?.kind === "decision_proposeContract" && typeof room.pendingModelProposal.proposal?.objective === "string"
      ? room.pendingModelProposal.proposal.objective
      : room.activeCase.contract.objective);
    setError("");
  }, [room.activeCase.id, room.activeCase.revision, room.pendingModelProposal?.id]);

  async function commit(activate) {
    setBusy(true);
    setError("");
    try {
      await updateDecisionContract({ question, objective, activate });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="os-workflow-desk contract-desk" aria-labelledby="contract-desk-title">
      <div className="workflow-desk-index"><span>01</span><IconFileDescription size={21} /></div>
      <div className="workflow-desk-copy">
        <span className="os-eyebrow">Start here</span>
        <h2 id="contract-desk-title">Question and goal</h2>
        <p>Say what you are deciding and what a good outcome should achieve.</p>
      </div>
      <div className="contract-fields">
        <label>Decision question<input value={question} maxLength={500} onChange={(event) => setQuestion(event.target.value)} /></label>
        <label>Objective<textarea value={objective} maxLength={800} rows={2} onChange={(event) => setObjective(event.target.value)} /></label>
      </div>
      <div className="workflow-desk-actions">
        <button type="button" onClick={() => toggleIntake(true)}><IconArchive size={17} /> Import sources</button>
        <button type="button" disabled={busy} onClick={() => commit(false)}><IconFileDescription size={17} /> Save draft</button>
        <button type="button" className="is-primary" disabled={busy || !room.activeCase.alternatives.length || !room.activeCase.criteria.length} onClick={() => commit(true)}><IconShieldCheck size={17} /> Start analysis</button>
      </div>
      <ModelEditor room={room} />
      {error ? <p className="workflow-desk-error" role="alert">{error}</p> : null}
    </section>
  );
}

function CollaborationDesk({ room }) {
  const [kind, setKind] = useState("comment");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [resolutionDrafts, setResolutionDrafts] = useState({});
  const [artifactPage, setArtifactPage] = useState(0);
  const ordered = [
    ...room.reviewArtifacts.filter((artifact) => artifact.kind === "human_resolution_request" && ["awaiting-human", "under-human-review"].includes(artifact.status)),
    ...room.reviewArtifacts.filter((artifact) => !(artifact.kind === "human_resolution_request" && ["awaiting-human", "under-human-review"].includes(artifact.status))),
  ];
  const artifactPageCount = Math.max(1, Math.ceil(ordered.length / REVIEW_PAGE_SIZE));
  const visible = ordered.slice(artifactPage * REVIEW_PAGE_SIZE, (artifactPage + 1) * REVIEW_PAGE_SIZE);

  useEffect(() => {
    setArtifactPage((current) => Math.min(current, Math.max(0, Math.ceil(room.reviewArtifacts.length / REVIEW_PAGE_SIZE) - 1)));
  }, [room.activeCase.id, room.reviewArtifacts.length]);

  function stage() {
    setError("");
    try {
      const reference = room.focusRef ?? (room.evaluation?.recommendation
        ? { kind: "alternative", id: room.evaluation.recommendation.alternativeId }
        : null);
      stageReviewArtifact({ kind, body, entityRefs: reference ? [reference] : [] });
      setBody("");
      setArtifactPage(0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function decide(artifactId, action) {
    setError("");
    try {
      decideModelProposal(artifactId, action);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function resolveCheckpoint(artifactId, action) {
    setError("");
    try {
      await decideHumanResolution(artifactId, action, resolutionDrafts[artifactId] ?? "");
      setArtifactPage(0);
      if (action !== "defer") {
        setResolutionDrafts((current) => {
          const next = { ...current };
          delete next[artifactId];
          return next;
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="os-workflow-desk collaboration-desk" aria-labelledby="collaboration-desk-title">
      <div className="workflow-desk-index"><span>02</span><IconMessage2 size={21} /></div>
      <div className="workflow-desk-copy">
        <span className="os-eyebrow">Needs your attention</span>
        <h2 id="collaboration-desk-title">Review queue</h2>
        <p>Handle open questions and suggested changes that need a person.</p>
      </div>
      <div className="review-composer">
        <select aria-label="Review artifact type" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="comment">Comment</option>
          <option value="request_resolution">Question to resolve</option>
          <option value="branch_proposal">Alternative proposal</option>
          <option value="information_request">Request for information</option>
          <option value="external_action_draft">Draft external action</option>
        </select>
        <label className="review-note-field"><span>Add a note</span><textarea value={body} maxLength={1000} rows={2} placeholder="Describe the question, concern, or suggested change" onChange={(event) => setBody(event.target.value)} /></label>
        <button type="button" className="is-primary" disabled={!body.trim()} onClick={stage}>{kind === "branch_proposal" ? <IconGitBranch size={17} /> : <IconMessage2 size={17} />} Add to review</button>
      </div>
      <ol className="review-artifact-strip">
        {visible.map((artifact) => {
          const isOpenModelProposal = artifact.source === "agent"
            && artifact.kind.startsWith("decision_")
            && !["rejected-by-human", "incorporated-by-human"].includes(artifact.status);
          const isOpenHumanResolution = artifact.kind === "human_resolution_request"
            && ["awaiting-human", "under-human-review"].includes(artifact.status);
          return (
            <li key={artifact.id}>
              <span>{reviewSourceLabel(artifact.source)} · {reviewLabel(artifact.status)}</span>
              <strong>{reviewLabel(artifact.kind)}</strong>
              <p>{artifact.body}</p>
              {isOpenModelProposal ? (
                <div className="review-artifact-actions">
                  <button type="button" onClick={() => decide(artifact.id, "review")}><IconEdit size={14} /> Review in model</button>
                  <button type="button" onClick={() => decide(artifact.id, "reject")}><IconX size={14} /> Reject proposal</button>
                </div>
              ) : null}
              {isOpenHumanResolution ? (
                <div className="review-resolution-actions">
                  <label><span>Your response</span><textarea rows={2} maxLength={1000} value={resolutionDrafts[artifact.id] ?? ""} onChange={(event) => setResolutionDrafts((current) => ({ ...current, [artifact.id]: event.target.value }))} placeholder="Explain your answer or why this request cannot be accepted." /></label>
                  <div>
                    <button type="button" onClick={() => resolveCheckpoint(artifact.id, "resolve")}><IconCheck size={14} /> Save response</button>
                    <button type="button" onClick={() => resolveCheckpoint(artifact.id, "reject")}><IconX size={14} /> Reject request</button>
                    <button type="button" onClick={() => resolveCheckpoint(artifact.id, "defer")}><IconArchive size={14} /> Defer</button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
        {!visible.length ? <li className="is-empty"><strong>Nothing needs your attention.</strong><span>Add a note above if you want someone else to review something.</span></li> : null}
      </ol>
      {ordered.length > REVIEW_PAGE_SIZE ? (
        <nav className="workflow-pager" aria-label="Human review pages">
          <button type="button" disabled={artifactPage === 0} onClick={() => setArtifactPage((current) => current - 1)}>Previous</button>
          <span>Page {artifactPage + 1} of {artifactPageCount} · {ordered.length} entries</span>
          <button type="button" disabled={artifactPage + 1 >= artifactPageCount} onClick={() => setArtifactPage((current) => current + 1)}>Next</button>
        </nav>
      ) : null}
      {error ? <p className="workflow-desk-error" role="alert">{error}</p> : null}
    </section>
  );
}

function OutputDesk({ room }) {
  const [busyFormat, setBusyFormat] = useState("");
  const [error, setError] = useState("");
  const [outputPage, setOutputPage] = useState(0);
  const outputPageCount = Math.max(1, Math.ceil(room.outputArtifacts.length / OUTPUT_PAGE_SIZE));
  const visibleOutputs = room.outputArtifacts.slice(outputPage * OUTPUT_PAGE_SIZE, (outputPage + 1) * OUTPUT_PAGE_SIZE);

  useEffect(() => {
    setOutputPage((current) => Math.min(current, Math.max(0, Math.ceil(room.outputArtifacts.length / OUTPUT_PAGE_SIZE) - 1)));
  }, [room.activeCase.id, room.outputArtifacts.length]);

  async function prepare(format) {
    setBusyFormat(format);
    setError("");
    try {
      await prepareCaseExport(format);
      setOutputPage(0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyFormat("");
    }
  }

  return (
    <section className="os-workflow-desk output-desk" aria-labelledby="output-desk-title">
      <div className="workflow-desk-index"><span>03</span><IconDownload size={21} /></div>
      <div className="workflow-desk-copy">
        <span className="os-eyebrow">Download</span>
        <h2 id="output-desk-title">Choose a file type</h2>
        <p>Every download includes the supporting evidence and the version used to create it.</p>
      </div>
      <div className="output-format-rail" aria-label="Prepare export format">
        {EXPORT_FORMATS.map(([format, label]) => <button type="button" key={format} disabled={Boolean(busyFormat)} onClick={() => prepare(format)}><span>{format}</span><strong>{label}</strong></button>)}
      </div>
      <ol className="prepared-output-ledger">
        {visibleOutputs.map((artifact) => (
          <li key={artifact.id}>
            <IconCheck size={16} />
            <span><strong>{artifact.fileName}</strong><small>Decision version {artifact.decisionRevision} · {reviewSourceLabel(artifact.source)}</small></span>
            <button type="button" onClick={() => downloadPreparedOutput(artifact.id)}><IconDownload size={15} /> Download</button>
          </li>
        ))}
        {!room.outputArtifacts.length ? <li className="is-empty"><strong>No files created yet.</strong><span>PDF report is the best choice for most people.</span></li> : null}
      </ol>
      {room.outputArtifacts.length > OUTPUT_PAGE_SIZE ? (
        <nav className="workflow-pager" aria-label="Prepared output pages">
          <button type="button" disabled={outputPage === 0} onClick={() => setOutputPage((current) => current - 1)}>Previous</button>
          <span>Page {outputPage + 1} of {outputPageCount} · {room.outputArtifacts.length} files</span>
          <button type="button" disabled={outputPage + 1 >= outputPageCount} onClick={() => setOutputPage((current) => current + 1)}>Next</button>
        </nav>
      ) : null}
      {error ? <p className="workflow-desk-error" role="alert">{error}</p> : null}
    </section>
  );
}

export function WorkflowDesk({ room }) {
  if (room.capabilityPhase === "contract_draft") return <ContractDesk room={room} />;
  if (room.capabilityPhase === "collaboration") return <CollaborationDesk room={room} />;
  if (room.capabilityPhase === "output") return <OutputDesk room={room} />;
  return null;
}
