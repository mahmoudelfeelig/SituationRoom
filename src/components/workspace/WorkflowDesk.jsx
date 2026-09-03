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
  ["json", "Portable JSON"],
  ["jsonld", "Linked-data JSON"],
  ["csv", "Claims CSV"],
  ["html", "Cited HTML"],
  ["xlsx", "Excel workbook"],
  ["docx", "Word packet"],
  ["pdf", "Print / PDF"],
]);
const REVIEW_PAGE_SIZE = 6;
const OUTPUT_PAGE_SIZE = 4;

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
        <span className="os-eyebrow">You stay in control</span>
        <h2 id="contract-desk-title">Decision setup</h2>
        <p>Set the question and goal. An agent can suggest changes, but only you can accept them.</p>
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
        <span className="os-eyebrow">For people to decide</span>
        <h2 id="collaboration-desk-title">Human review</h2>
        <p>Review comments, open questions, and suggested changes before anything is accepted.</p>
      </div>
      <div className="review-composer">
        <select aria-label="Review artifact type" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="comment">Comment</option>
          <option value="request_resolution">Resolution request</option>
          <option value="branch_proposal">Branch proposal</option>
          <option value="information_request">Information request draft</option>
          <option value="external_action_draft">External action draft</option>
        </select>
        <label className="review-note-field"><span>Review note</span><textarea value={body} maxLength={1000} rows={2} placeholder="Cite the concern, unresolved fact, or hypothetical branch…" onChange={(event) => setBody(event.target.value)} /></label>
        <button type="button" className="is-primary" disabled={!body.trim()} onClick={stage}>{kind === "branch_proposal" ? <IconGitBranch size={17} /> : <IconMessage2 size={17} />} Stage for review</button>
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
              <span>{artifact.source} · {artifact.status?.replaceAll("_", " ").replaceAll("-", " ")}</span>
              <strong>{artifact.kind.replaceAll("_", " ")}</strong>
              <p>{artifact.body}</p>
              {isOpenModelProposal ? (
                <div className="review-artifact-actions">
                  <button type="button" onClick={() => decide(artifact.id, "review")}><IconEdit size={14} /> Review in model</button>
                  <button type="button" onClick={() => decide(artifact.id, "reject")}><IconX size={14} /> Reject proposal</button>
                </div>
              ) : null}
              {isOpenHumanResolution ? (
                <div className="review-resolution-actions">
                  <label><span>Human response</span><textarea rows={2} maxLength={1000} value={resolutionDrafts[artifact.id] ?? ""} onChange={(event) => setResolutionDrafts((current) => ({ ...current, [artifact.id]: event.target.value }))} placeholder="Record the cited resolution or why this request cannot be accepted." /></label>
                  <div>
                    <button type="button" onClick={() => resolveCheckpoint(artifact.id, "resolve")}><IconCheck size={14} /> Resolve checkpoint</button>
                    <button type="button" onClick={() => resolveCheckpoint(artifact.id, "reject")}><IconX size={14} /> Reject request</button>
                    <button type="button" onClick={() => resolveCheckpoint(artifact.id, "defer")}><IconArchive size={14} /> Defer</button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
        {!visible.length ? <li className="is-empty">The review exchange is empty. Every new entry will carry its author and decision revision.</li> : null}
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
        <span className="os-eyebrow">Current decision version</span>
        <h2 id="output-desk-title">Export decision</h2>
        <p>Every file includes the supporting evidence and exact decision version. An agent can prepare it; only you can download it.</p>
      </div>
      <div className="output-format-rail" aria-label="Prepare export format">
        {EXPORT_FORMATS.map(([format, label]) => <button type="button" key={format} disabled={Boolean(busyFormat)} onClick={() => prepare(format)}><span>{format}</span><strong>{label}</strong></button>)}
      </div>
      <ol className="prepared-output-ledger">
        {visibleOutputs.map((artifact) => (
          <li key={artifact.id}>
            <IconCheck size={16} />
            <span><strong>{artifact.fileName}</strong><small>r{artifact.decisionRevision} · {artifact.source}</small></span>
            <button type="button" onClick={() => downloadPreparedOutput(artifact.id)}><IconDownload size={15} /> Download</button>
          </li>
        ))}
        {!room.outputArtifacts.length ? <li className="is-empty">No export has been prepared yet.</li> : null}
      </ol>
      {room.outputArtifacts.length > OUTPUT_PAGE_SIZE ? (
        <nav className="workflow-pager" aria-label="Prepared output pages">
          <button type="button" disabled={outputPage === 0} onClick={() => setOutputPage((current) => current - 1)}>Previous</button>
          <span>Page {outputPage + 1} of {outputPageCount} · {room.outputArtifacts.length} artifacts</span>
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
