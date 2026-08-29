import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconFile,
  IconFileImport,
  IconLoader2,
  IconShieldLock,
  IconTable,
  IconUpload,
} from "@tabler/icons-react";
import { DECLARED_FORMATS, SUPPORTED_FORMATS } from "../../import/index.js";
import {
  cancelImport,
  clearStagedSourceDomain,
  confirmStagedSourceDomain,
  confirmImportProposal,
  recoverImportReview,
  sourceIdForLocalFile,
  stageLocalSources,
  startImportReview,
  toggleIntake,
  unstageLocalSources,
} from "../../workspace/workspaceStore.js";
import { DOMAIN_CONFIG } from "../../workspace/domainConfig.js";
import { ModalSurface } from "./ModalSurface.jsx";

function inferDomain(selection, title, objective, files, pastedText = "") {
  if (selection !== "auto") return selection;
  const text = `${title} ${objective} ${files.map((file) => file.name).join(" ")} ${pastedText.slice(0, 20_000)}`.toLowerCase();
  if (/candidate|resume|résumé|curriculum|\bcv\b|job description|applicant|hiring/.test(text)) return "candidate-review";
  if (/health|insurance|insurer|coverage|deductible|formulary|premium/.test(text)) return "health-plan";
  if (/procurement|vendor|supplier|rfp|tender|bid|proposal/.test(text)) return "procurement";
  return "generic";
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatInferredValue(value) {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ReviewPager({ label, items, pageSize, renderItem, empty = "No entries." }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const visible = items.slice(start, start + pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(0, Math.ceil(items.length / pageSize) - 1)));
  }, [items.length, pageSize]);

  return (
    <div className="os-review-pager" data-review-total={items.length}>
      <div className="os-review-pager__status">
        <span>{items.length ? `Showing ${start + 1}–${start + visible.length} of ${items.length}` : "Showing 0 of 0"}</span>
        {pageCount > 1 ? <span>Page {safePage + 1} of {pageCount}</span> : null}
      </div>
      <ol aria-label={label}>{visible.length ? visible.map(renderItem) : <li>{empty}</li>}</ol>
      {pageCount > 1 ? (
        <div className="os-review-pager__controls">
          <button type="button" disabled={safePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} aria-label={`Show previous ${label} page`}>Previous</button>
          <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} aria-label={`Show next ${label} page`}>Next</button>
        </div>
      ) : null}
    </div>
  );
}

export function IntakeWorkbench({ room }) {
  const inputRef = useRef(null);
  const phaseFocusRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [pastedText, setPastedText] = useState("");
  const [domain, setDomain] = useState("auto");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [phase, setPhase] = useState("stage");
  const [review, setReview] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [dismissBusy, setDismissBusy] = useState(false);
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const inferredDomainId = inferDomain(domain, title, objective, files, pastedText);

  useEffect(() => {
    const surfaced = room.activeImportReview;
    if (!room.intakeOpen || !surfaced) return;
    if (surfaced.job?.id === review?.job?.id && surfaced.job?.version === review?.job?.version) return;
    setReview(surfaced);
    setActiveJob(surfaced.job);
    setConfirmed(false);
    setError(surfaced.recovery ? surfaced.job?.error?.message ?? "This import requires recovery." : "");
    setPhase(surfaced.recovery ? "recovery" : "review");
  }, [room.intakeOpen, room.activeImportReview, review?.job?.id]);

  useEffect(() => {
    if (!room.intakeOpen || !["processing", "review", "recovery", "committing"].includes(phase)) return;
    requestAnimationFrame(() => phaseFocusRef.current?.focus());
  }, [phase, room.intakeOpen]);

  function reset() {
    unstageLocalSources(files);
    setFiles([]);
    setPastedText("");
    setDomain("auto");
    setTitle("");
    setObjective("");
    setPhase("stage");
    setReview(null);
    setActiveJob(null);
    setConfirmed(false);
    setError("");
  }

  function returnToRoom() {
    reset();
    toggleIntake(false);
  }

  async function discardCurrent({ returnToStage = false } = {}) {
    if (!activeJob) return true;
    setDismissBusy(true);
    setError("");
    try {
      await cancelImport(activeJob.id);
      setReview(null);
      setActiveJob(null);
      setConfirmed(false);
      setPhase(returnToStage ? "stage" : "stage");
      return true;
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : String(discardError));
      setPhase("recovery");
      return false;
    } finally {
      setDismissBusy(false);
    }
  }

  async function close() {
    if (review?.cleanupPending || (phase === "recovery" && review?.canDiscard === false)) {
      returnToRoom();
      return;
    }
    if (["processing", "review", "recovery", "error"].includes(phase) && activeJob && review?.canDiscard !== false) {
      const discarded = await discardCurrent();
      if (!discarded) return;
    }
    reset();
    toggleIntake(false);
  }

  function addFiles(nextFiles) {
    const merged = [...files];
    const keys = new Set(merged.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
    for (const file of nextFiles) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (!keys.has(key)) {
        merged.push(file);
        keys.add(key);
      }
    }
    const bounded = merged.slice(0, 100);
    clearStagedSourceDomain(bounded);
    setFiles(bounded);
    stageLocalSources(bounded);
  }

  async function inspect() {
    setError("");
    setPhase("processing");
    const domainId = inferDomain(domain, title, objective, files, pastedText);
    try {
      if (activeJob && ["error", "recovery"].includes(phase)) {
        await cancelImport(activeJob.id);
        setActiveJob(null);
      }
      const result = await startImportReview({
        files,
        pastedText,
        domainId,
        title: title || "Imported decision room",
        objective,
        onJob: setActiveJob,
      });
      if (result?.recovery) {
        setReview(result);
        setActiveJob(result.job);
        setError(result.preparationError ?? result.mappingDiagnostics?.[0]?.message ?? "This import requires a human recovery decision.");
        setPhase("recovery");
        return;
      }
      if (!result.ok) {
        const diagnostic = result.job?.diagnostics?.find((item) => item.severity === "error")?.message ?? result.job?.error?.message;
        throw new Error(diagnostic || `Import ended in ${result.job?.phase ?? "an unknown state"}.`);
      }
      setReview(result);
      setPhase("review");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
      setPhase("error");
    }
  }

  async function commit() {
    setPhase("committing");
    setError("");
    try {
      const result = await confirmImportProposal(review);
      if (result.cleanupPending && result.recovery) {
        setReview(result.recovery);
        setActiveJob(result.recovery.job);
        setConfirmed(false);
        setPhase("recovery");
        return;
      }
      reset();
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : String(commitError));
      setPhase("review");
    }
  }

  async function recover() {
    if (!activeJob) return;
    setPhase("processing");
    setError("");
    try {
      const result = await recoverImportReview(activeJob.id);
      if (result?.committed || result?.cleanupCompleted) {
        reset();
        return;
      }
      if (result?.recovery) {
        setReview(result);
        setActiveJob(result.job);
        setError(result.job?.error?.message ?? "The retry still requires attention.");
        setPhase("recovery");
        return;
      }
      setReview(result);
      setActiveJob(result.job);
      setConfirmed(false);
      setPhase("review");
    } catch (recoveryError) {
      const latest = room.activeImportReview;
      if (latest?.recovery) {
        setReview(latest);
        setActiveJob(latest.job);
      }
      setError(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
      setPhase("recovery");
    }
  }

  const staged = files.length > 0 || pastedText.trim().length > 0;
  const footer = phase === "review" ? (
    <>
      <button type="button" className="os-button-secondary" disabled={dismissBusy} onClick={() => discardCurrent({ returnToStage: true })}>{dismissBusy ? "Verifying deletion" : "Discard and revise intake"}</button>
      <button type="button" className="os-button-primary" disabled={!confirmed} onClick={commit}><IconCheck size={18} /> Commit reviewed draft</button>
    </>
  ) : phase === "recovery" ? (
    <>
      <button type="button" className="os-button-secondary" disabled={dismissBusy} onClick={returnToRoom}>Return to room</button>
      {review?.canDiscard ? <button type="button" className="os-button-secondary" disabled={dismissBusy} onClick={async () => {
        if (await discardCurrent()) reset();
      }}>{dismissBusy ? "Verifying deletion" : "Discard retained source data"}</button> : null}
      {review?.canRetry || review?.canResumeCommit ? <button type="button" className="os-button-primary" onClick={recover}>
        {review.cleanupPending ? "Retry retained-source cleanup" : review.canResumeCommit ? "Reconcile interrupted commit" : "Retry import"}
      </button> : null}
    </>
  ) : phase === "stage" || phase === "error" ? (
    <>
      <button type="button" className="os-button-secondary" onClick={close}>Cancel</button>
      <button type="button" className="os-button-primary" disabled={!staged || !objective.trim()} onClick={inspect}><IconFileImport size={18} /> Inspect and propose contract</button>
    </>
  ) : phase === "processing" ? (
    <button type="button" className="os-button-secondary" disabled={dismissBusy} onClick={() => discardCurrent({ returnToStage: true })}>{dismissBusy ? "Verifying deletion" : "Cancel import"}</button>
  ) : null;

  return (
    <ModalSurface open={room.intakeOpen} title="Construct a new decision room" eyebrow="Local-first staged import" onClose={phase === "committing" || dismissBusy ? undefined : review?.cleanupPending ? returnToRoom : close} size="wide" footer={footer}>
      {phase === "stage" || phase === "error" ? (
        <div className="os-intake-grid">
          <section className="os-intake-brief">
            <span className="os-step-index">A</span>
            <h3>Declare the decision</h3>
            <label>Room title<input value={title} onChange={(event) => { clearStagedSourceDomain(files); setTitle(event.target.value); }} maxLength={160} placeholder="Example: 2027 household health-plan choice" /></label>
            <label>What should the room help decide?<textarea value={objective} onChange={(event) => { clearStagedSourceDomain(files); setObjective(event.target.value); }} maxLength={600} rows={5} placeholder="Describe the objective, affected people, hard constraints, and what a good outcome means." /></label>
            <label>Decision domain<select value={domain} onChange={(event) => { clearStagedSourceDomain(files); setDomain(event.target.value); }}>
              <option value="auto">Infer from objective and sources</option>
              {Object.values(DOMAIN_CONFIG).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
            </select></label>
            <p className="os-field-note"><IconShieldLock size={17} /> The domain selects deterministic policy. Imported text cannot change authority or unlock actions.</p>
          </section>
          <section className="os-intake-sources">
            <span className="os-step-index">B</span>
            <h3>Stage source material</h3>
            <div
              className="os-drop-zone"
              onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add("is-dragging"); }}
              onDragLeave={(event) => event.currentTarget.classList.remove("is-dragging")}
              onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove("is-dragging"); addFiles([...event.dataTransfer.files]); }}
            >
              <IconUpload size={28} />
              <strong>Drop mixed files into the case archive</strong>
              <span>PDF, DOCX, XLSX, PPTX, tables, structured data, EML, text, OCR images, or ZIP bundles</span>
              <button type="button" onClick={() => inputRef.current?.click()}>Choose files</button>
              <input ref={inputRef} type="file" multiple hidden onChange={(event) => addFiles([...event.target.files])} />
            </div>
            <label>Or paste source text<textarea value={pastedText} onChange={(event) => { clearStagedSourceDomain(files); setPastedText(event.target.value); }} rows={4} placeholder="Paste a plan summary, job description, requirements, notes, or tabular text." /></label>
            <div className="os-format-line">
              <span>{SUPPORTED_FORMATS.size} parsed formats · {DECLARED_FORMATS.length - SUPPORTED_FORMATS.size} recognized with explicit diagnostics</span>
              <code>Native: {[...SUPPORTED_FORMATS].join(" · ")} · Diagnostic only: {DECLARED_FORMATS.filter((format) => !SUPPORTED_FORMATS.has(format)).join(" · ")}</code>
            </div>
          </section>
          <section className="os-staged-files" aria-label="Staged files">
            <div><h3>Staged docket</h3><span>{files.length} files · {formatBytes(totalBytes)}</span></div>
            <ul>
              {files.map((file, index) => <li key={`${file.name}:${file.size}:${index}`} data-source-id={sourceIdForLocalFile(file)}><IconFile size={17} /><span><strong>{file.name}</strong><small>{file.type || "signature detected during import"} · {formatBytes(file.size)} · {sourceIdForLocalFile(file)}</small></span><button type="button" onClick={() => { unstageLocalSources([file]); setFiles(files.filter((_, itemIndex) => itemIndex !== index)); }}>Remove</button></li>)}
            </ul>
            {!files.length ? <p>No local files staged. Pasted text can still create a reviewed generic docket.</p> : null}
            {files.length ? (
              <div className="os-agent-source-authority">
                <IconShieldLock size={18} />
                <div><strong>{room.stagedDomainReservation === inferredDomainId ? `${DOMAIN_CONFIG[inferredDomainId].label} policy confirmed` : "Agent source access is not yet authorized"}</strong><span>File names stay human-visible; WebMCP receives only opaque source handles. New-case agent import is denied until you confirm this exact policy domain.</span></div>
                <button type="button" disabled={room.stagedDomainReservation === inferredDomainId} onClick={() => confirmStagedSourceDomain(files, inferredDomainId)}>{room.stagedDomainReservation === inferredDomainId ? "Confirmed" : `Confirm ${DOMAIN_CONFIG[inferredDomainId].label} domain`}</button>
              </div>
            ) : null}
          </section>
          {error ? <p className="os-error-message os-intake-error" role="alert"><IconAlertTriangle size={18} /> {error}</p> : null}
        </div>
      ) : null}

      {phase === "processing" || phase === "committing" ? (
        <div className="os-import-progress" role="status" ref={phaseFocusRef} tabIndex="-1">
          <IconLoader2 className="is-spinning" size={34} />
          <span className="os-eyebrow">{phase === "processing" ? "Parsing and quarantining" : "Atomic canonical commit"}</span>
          <h3>{phase === "processing" ? "Building the source graph" : "Creating the decision room"}</h3>
          <p>{phase === "processing" ? "Files are fingerprinted, type-sniffed, parsed in bounded adapters, scanned as untrusted content, and retained with exact anchors." : "The reviewed contract, documents, fragments, and claims are committing as one atomic canonical case revision."}</p>
          {activeJob ? <code>{activeJob.id}</code> : null}
        </div>
      ) : null}

      {phase === "recovery" && review?.recovery ? (
        <div className="os-import-progress" role="alert" ref={phaseFocusRef} tabIndex="-1">
          <IconAlertTriangle size={34} />
          <span className="os-eyebrow">Human recovery checkpoint · {review.job.phase}</span>
          <h3>{review.cleanupPending ? "Canonical commit complete; source cleanup pending" : review.mappingError ? "Domain-safe mapping cannot proceed" : review.canResumeCommit ? "Reconcile an interrupted canonical commit" : "Retained source data needs a decision"}</h3>
          <p>{review.cleanupPending
            ? "The reviewed decision revision is already canonical. Some raw or parsed local source copies could not yet be deleted. No decision command will be replayed during cleanup."
            : review.preparationError ?? review.mappingDiagnostics?.[0]?.message ?? review.job.error?.message ?? "The import did not reach review."}</p>
          <p>{review.cleanupPending
            ? "Retry cleanup to remove every remaining retained source handle. You may return to the room; the visible recovery docket remains open and governed agent mutations stay retired until deletion succeeds."
            : review.mappingError
              ? "The source remains isolated and has not entered the canonical case. Discard it, then provide a blinded or otherwise policy-compliant structured extraction."
            : review.canResumeCommit
            ? "SituationRoom will replay the exact durable commit intent with the original idempotency key. It will not create a second decision revision."
            : review.canRetry
              ? "Retry runs the retained bytes through the full parser again. Discard permanently removes the retained raw input and parsed documents."
              : "This source cannot safely proceed. Discard it, then revise or reselect the source material."}</p>
          <code>{review.job.id} · version {review.job.version}</code>
        </div>
      ) : null}

      {phase === "review" && review ? (
        <div className="os-contract-review" ref={phaseFocusRef} tabIndex="-1">
          <header>
            <div><span className="os-step-index">C</span><span className="os-eyebrow">Agent-proposed · human-confirmed</span><h3>Decision Contract</h3></div>
            <span className={`os-domain-seal domain-${review.proposal.caseInput.domain.packId}`}>{DOMAIN_CONFIG[review.proposal.caseInput.domain.packId]?.label ?? "General decision"}</span>
          </header>
          <blockquote>{review.proposal.caseInput.contract.objective}</blockquote>
          <div className="os-contract-counts">
            {Object.entries(review.proposal.summary).map(([key, value]) => <div key={key}><strong>{value}</strong><span>{key}</span></div>)}
          </div>
          {(() => {
            const sourceDiagnostics = review.documents.flatMap((document) => document.diagnostics.map((diagnostic, index) => ({ ...diagnostic, id: `${document.id}:${index}`, document: document.name })));
            return (
          <div className="os-contract-columns">
            <section><h4>Alternatives</h4><ReviewPager label="Alternatives" items={review.proposal.caseInput.alternatives} pageSize={16} renderItem={(item) => <li key={item.id}>{item.label}</li>} /></section>
            <section><h4>Criteria and scoring</h4><ReviewPager label="Criteria and scoring" items={review.proposal.caseInput.criteria} pageSize={20} renderItem={(item) => <li key={item.id}><span>{item.label}</span><strong>{item.kind} · {item.valueType}{item.unit ? ` · ${item.unit}` : ""}</strong><small>{item.weight !== undefined ? `Weight ${item.weight}. ` : ""}{item.scoring ? `${item.scoring.direction ?? item.scoring.kind}; range ${formatInferredValue(item.scoring.min)} to ${formatInferredValue(item.scoring.max)}.` : "No automatic scoring rule."}</small></li>} /></section>
            <section><h4>Source diagnostics</h4><ReviewPager label="Source diagnostics" items={sourceDiagnostics} pageSize={18} renderItem={(item) => <li key={item.id} className={`severity-${item.severity}`}><span>{item.document}</span><strong>{item.code}</strong><small>{item.message}</small></li>} /></section>
          </div>
            );
          })()}
          <div className="os-inferred-model-review">
            <section>
              <h4>Mandatory and advisory gates</h4>
              <ol>{review.proposal.caseInput.constraints.length ? review.proposal.caseInput.constraints.map((item) => <li key={item.id}><strong>{item.label ?? item.criterionId}</strong><span>{item.severity} · {item.operator} · expected {formatInferredValue(item.expected)}</span></li>) : <li>No gates were inferred.</li>}</ol>
            </section>
            <section>
              <h4>Evidence values and exact anchors</h4>
              <ReviewPager label="Evidence values and exact anchors" items={review.proposal.claims} pageSize={80} renderItem={(claim) => <li key={claim.id}><strong>{claim.subjectId} → {claim.criterionId}</strong><span>{formatInferredValue(claim.value)} · {claim.status} · confidence {claim.confidence ?? "unknown"}</span><small>{claim.sourceRefs?.[0]?.documentId} · {claim.sourceRefs?.[0]?.fragmentId}</small></li>} />
            </section>
            <section>
              <h4>Authority and activation</h4>
              <dl>
                <div><dt>Mode</dt><dd>{review.proposal.caseInput.contract.authority.mode}</dd></div>
                <div><dt>Automated ranking</dt><dd>{review.proposal.caseInput.contract.authority.allowAutomatedRanking ? "Allowed for decision support" : "Prohibited"}</dd></div>
                <div><dt>Human-only actions</dt><dd>{review.proposal.caseInput.contract.authority.humanOnlyActions.join(", ")}</dd></div>
                <div><dt>Initial status</dt><dd>Draft. Analysis tools remain unavailable until a person activates it.</dd></div>
              </dl>
            </section>
          </div>
          {review.proposal.warnings.length ? <div className="os-review-warnings"><IconAlertTriangle size={18} /><ul>{review.proposal.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
          <label className="os-confirmation-check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I reviewed the complete paginated alternatives, typed criteria, scoring directions and ranges, gates, evidence statuses, exact anchors, authority, and diagnostics. Commit this as a draft for typed editing; do not activate it yet.</span>
          </label>
          <p className="os-field-note"><IconTable size={17} /> Text fields remain informational until an explicit deterministic rule is confirmed. Missing cells remain unknown, never zero.</p>
          {error ? <p className="os-error-message" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </ModalSurface>
  );
}
