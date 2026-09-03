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
import { DECLARED_FORMATS } from "../../import/index.js";
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

const REVIEW_LABELS = Object.freeze({
  alternatives: "options",
  criteria: "criteria",
  constraints: "requirements",
  claims: "evidence values",
  gate: "must-have",
  score: "scored preference",
  informational: "information only",
  boolean: "yes or no",
  number: "number",
  currency: "money",
  string: "text",
  enum: "choice list",
  date: "date",
  mandatory: "must-have",
  advisory: "preference",
  eq: "equals",
  ne: "does not equal",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  contains: "contains",
  not_contains: "does not contain",
  in: "is one of",
  not_in: "is not one of",
});

function reviewLabel(value) {
  return REVIEW_LABELS[value] ?? String(value ?? "").replaceAll(/[-_]/g, " ");
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

function anchorLabel(anchor) {
  if (!anchor) return "Unanchored";
  const locator = anchor.locator ?? {};
  const location = locator.range
    ?? (locator.page ? `page ${locator.page}` : null)
    ?? (locator.paragraph ? `paragraph ${locator.paragraph}` : null)
    ?? locator.jsonPointer
    ?? locator.xpath
    ?? anchor.fragmentId;
  return `${anchor.documentId} · ${location}`;
}

function SemanticIntakeReview({ proposal }) {
  if (!proposal) return null;
  const agentProposals = proposal.agentSuggestionReview?.proposed ?? [];
  const rejectedSuggestions = proposal.agentSuggestionReview?.rejected ?? [];
  const entityLabels = new Map(proposal.entities.map((entity) => [entity.id, entity.canonicalLabel]));
  return (
    <section className="os-semantic-intake-review" aria-labelledby="semantic-intake-heading">
      <header>
        <div><span className="os-eyebrow">How your files were understood</span><h4 id="semantic-intake-heading">Matches and possible conflicts</h4></div>
        <p>SituationRoom only accepts matches backed by exact source locations. Agent suggestions stay separate until you review them.</p>
      </header>
      <dl className="os-semantic-summary">
        <div><dt>Recognized records</dt><dd>{proposal.summary.entities}</dd></div>
        <div><dt>Matched fields</dt><dd>{proposal.summary.mappings}</dd></div>
        <div className={proposal.summary.conflicts ? "has-warning" : ""}><dt>Possible conflicts</dt><dd>{proposal.summary.conflicts}</dd></div>
        <div><dt>Needs review</dt><dd>{proposal.summary.unresolved}</dd></div>
        <div><dt>Agent suggestions</dt><dd>{proposal.summary.agentProposals}</dd></div>
        <div><dt>Overall confidence</dt><dd>{Math.round((proposal.confidence.overall ?? 0) * 100)}%</dd></div>
      </dl>
      <div className="os-semantic-ledgers">
        <section>
          <h5>Records found across your files</h5>
          <ReviewPager
            label="Records found across files"
            items={proposal.entities}
            pageSize={12}
            renderItem={(entity) => (
              <li key={entity.id}>
                <strong>{entity.canonicalLabel}</strong>
                <span>{entity.aliases.join(" · ")}</span>
                <small>{entity.documentIds.length} source {entity.documentIds.length === 1 ? "document" : "documents"} · {Math.round(entity.confidence * 100)}% confidence · {entity.status}</small>
              </li>
            )}
            empty="No record could be matched safely across the files."
          />
        </section>
        <section>
          <h5>Fields we could match safely</h5>
          <ReviewPager
            label="Safely matched fields"
            items={proposal.mappings}
            pageSize={16}
            renderItem={(mapping) => (
              <li key={mapping.id} className={`status-${mapping.status}`}>
                <strong>{mapping.sourceFields.join(" · ")} → {mapping.targetCriterion}</strong>
                <span>{mapping.status} · {Math.round(mapping.confidence * 100)}% confidence</span>
                <small>{mapping.sourceAnchors.slice(0, 2).map(anchorLabel).join(" / ")}</small>
              </li>
            )}
            empty="No field match had enough source evidence."
          />
        </section>
        <section>
          <h5>Possible conflicts and missing matches</h5>
          <ReviewPager
            label="Possible conflicts and missing matches"
            items={[
              ...proposal.conflicts.map((item) => ({ ...item, reviewKind: "conflict" })),
              ...proposal.unresolved.map((item) => ({ ...item, reviewKind: "unresolved" })),
            ]}
            pageSize={16}
            renderItem={(item, index) => (
              <li key={item.id ?? `${item.code}:${item.fragmentId ?? item.recordRef ?? index}`} className="has-warning">
                <strong>{item.reviewKind === "conflict" ? `${entityLabels.get(item.entityId) ?? item.entityId} · ${item.normalizedField}` : item.code}</strong>
                <span>{item.message ?? `${item.values?.length ?? 0} incompatible values remain visible.`}</span>
                <small>{(item.sourceAnchors ?? item.values?.flatMap((value) => value.sourceAnchors) ?? []).slice(0, 2).map(anchorLabel).join(" / ") || "Human interpretation required"}</small>
              </li>
            )}
            empty="No conflicts or missing source matches."
          />
        </section>
      </div>
      <details className="os-semantic-agent-review" open={agentProposals.length > 0 || rejectedSuggestions.length > 0}>
        <summary>Optional agent suggestions · {agentProposals.length} to review · {rejectedSuggestions.length} rejected</summary>
        <div>
          <section><h5>Suggestions to review</h5><ol>{agentProposals.length ? agentProposals.map((item) => <li key={item.id}><strong>{item.kind === "field-mapping" ? `${item.sourceField} → ${item.targetCriterion}` : item.aliases.join(" ↔ ")}</strong><span>{Math.round(item.confidence * 100)}% confidence · {item.wouldOverride ? "differs from a confirmed match" : "leaves confirmed matches unchanged"}</span><small>{item.sourceAnchors.map(anchorLabel).join(" / ")}</small></li>) : <li>No agent suggestion passed validation.</li>}</ol></section>
          <section><h5>Rejected suggestions</h5><ol>{rejectedSuggestions.length ? rejectedSuggestions.map((item, index) => <li key={`${item.id ?? "rejected"}:${index}`}><strong>{item.code}</strong><span>{item.message}</span></li>) : <li>No rejected suggestions.</li>}</ol></section>
        </div>
      </details>
      {(proposal.conflicts.length || proposal.resolutionProposals.length || agentProposals.length) ? <p className="os-semantic-resolution-route">Review each highlighted item and its source before saving. You can correct accepted matches during setup.</p> : null}
    </section>
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
      <button type="button" className="os-button-secondary" disabled={dismissBusy} onClick={() => discardCurrent({ returnToStage: true })}>{dismissBusy ? "Removing files" : "Go back and edit"}</button>
      <button type="button" className="os-button-primary" disabled={!confirmed} onClick={commit}><IconCheck size={18} /> Create decision draft</button>
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
      <button type="button" className="os-button-primary" disabled={!staged || !objective.trim()} onClick={inspect}><IconFileImport size={18} /> Review and continue</button>
    </>
  ) : phase === "processing" ? (
    <button type="button" className="os-button-secondary" disabled={dismissBusy} onClick={() => discardCurrent({ returnToStage: true })}>{dismissBusy ? "Verifying deletion" : "Cancel import"}</button>
  ) : null;

  return (
    <ModalSurface open={room.intakeOpen} title="Create a decision" eyebrow="Your files stay in this browser" onClose={phase === "committing" || dismissBusy ? undefined : review?.cleanupPending ? returnToRoom : close} size="wide" footer={footer}>
      {phase === "stage" || phase === "error" ? (
        <div className="os-intake-grid">
          <section className="os-intake-brief">
            <span className="os-step-index">A</span>
            <h3>What are you deciding?</h3>
            <label>Decision name<input value={title} onChange={(event) => { clearStagedSourceDomain(files); setTitle(event.target.value); }} maxLength={160} placeholder="Example: Choose our 2027 health plan" /></label>
            <label>What should SituationRoom help you decide?<textarea value={objective} onChange={(event) => { clearStagedSourceDomain(files); setObjective(event.target.value); }} maxLength={600} rows={5} placeholder="Describe the goal, the people affected, your must-haves, and what a good outcome looks like." /></label>
            <label>Type of decision<select value={domain} onChange={(event) => { clearStagedSourceDomain(files); setDomain(event.target.value); }}>
              <option value="auto">Choose automatically from my information</option>
              {Object.values(DOMAIN_CONFIG).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
            </select></label>
            <p className="os-field-note"><IconShieldLock size={17} /> Imported text can provide evidence, but it cannot change who is allowed to decide or approve.</p>
          </section>
          <section className="os-intake-sources">
            <span className="os-step-index">B</span>
            <h3>Add your information</h3>
            <div
              className="os-drop-zone"
              onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add("is-dragging"); }}
              onDragLeave={(event) => event.currentTarget.classList.remove("is-dragging")}
              onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove("is-dragging"); addFiles([...event.dataTransfer.files]); }}
            >
              <IconUpload size={28} />
              <strong>Drop files here</strong>
              <span>PDF, Word, Excel, PowerPoint, CSV, email, text, images, JSON, YAML, or ZIP</span>
              <button type="button" onClick={() => inputRef.current?.click()}>Choose files</button>
              <input ref={inputRef} type="file" multiple hidden onChange={(event) => addFiles([...event.target.files])} />
            </div>
            <label>Or paste text<textarea value={pastedText} onChange={(event) => { clearStagedSourceDomain(files); setPastedText(event.target.value); }} rows={4} placeholder="Paste a plan summary, job description, requirements, notes, or table." /></label>
            <details className="os-format-line">
              <summary>Supports {DECLARED_FORMATS.length} common file formats</summary>
              <p>Works directly with PDF, Word, Excel, PowerPoint, CSV, email, text, images, JSON, YAML, and ZIP. Older or specialist files are kept separate when they cannot be read safely.</p>
            </details>
          </section>
          <section className="os-staged-files" aria-label="Staged files">
            <div><h3>Files to review</h3><span>{files.length} files · {formatBytes(totalBytes)}</span></div>
            <ul>
              {files.map((file, index) => <li key={`${file.name}:${file.size}:${index}`} data-source-id={sourceIdForLocalFile(file)}><IconFile size={17} /><span><strong>{file.name}</strong><small>{file.type || "File type checked during import"} · {formatBytes(file.size)}</small></span><button type="button" onClick={() => { unstageLocalSources([file]); setFiles(files.filter((_, itemIndex) => itemIndex !== index)); }}>Remove</button></li>)}
            </ul>
            {!files.length ? <p>No local files added. You can still paste text and review it before importing.</p> : null}
            {files.length ? (
              <div className="os-agent-source-authority">
                <IconShieldLock size={18} />
                <div><strong>{room.stagedDomainReservation === inferredDomainId ? `${DOMAIN_CONFIG[inferredDomainId].label} rules confirmed` : "Confirm how these files will be handled"}</strong><span>The agent receives private file references instead of file names. Confirm the decision type before it reads the imported information.</span></div>
                <button type="button" disabled={room.stagedDomainReservation === inferredDomainId} onClick={() => confirmStagedSourceDomain(files, inferredDomainId)}>{room.stagedDomainReservation === inferredDomainId ? "Confirmed" : `Use ${DOMAIN_CONFIG[inferredDomainId].label} rules`}</button>
              </div>
            ) : null}
          </section>
          {error ? <p className="os-error-message os-intake-error" role="alert"><IconAlertTriangle size={18} /> {error}</p> : null}
        </div>
      ) : null}

      {phase === "processing" || phase === "committing" ? (
        <div className="os-import-progress" role="status" ref={phaseFocusRef} tabIndex="-1">
          <IconLoader2 className="is-spinning" size={34} />
          <span className="os-eyebrow">{phase === "processing" ? "Reading your information" : "Saving your decision"}</span>
          <h3>{phase === "processing" ? "Organizing the evidence" : "Creating the decision"}</h3>
          <p>{phase === "processing" ? "SituationRoom is identifying the file types, checking the content, and linking each extracted fact back to its source." : "SituationRoom is saving the question, options, criteria, requirements, and supporting evidence together."}</p>
          {activeJob ? <code>{activeJob.id}</code> : null}
        </div>
      ) : null}

      {phase === "recovery" && review?.recovery ? (
        <div className="os-import-progress" role="alert" ref={phaseFocusRef} tabIndex="-1">
          <IconAlertTriangle size={34} />
          <span className="os-eyebrow">Import needs attention · {review.job.phase}</span>
          <h3>{review.cleanupPending ? "Decision saved; source cleanup still needed" : review.mappingError ? "These files cannot be imported safely" : review.canResumeCommit ? "Finish saving the interrupted import" : "Choose what to do with these source files"}</h3>
          <p>{review.cleanupPending
            ? "The decision is already saved, but some temporary local copies could not be deleted. Retrying cleanup will not save the decision again."
            : review.preparationError ?? review.mappingDiagnostics?.[0]?.message ?? review.job.error?.message ?? "The import did not reach review."}</p>
          <p>{review.cleanupPending
            ? "Retry cleanup to remove the remaining temporary source copies. You can return to the decision while this warning stays visible."
            : review.mappingError
              ? "The source is still separate from the decision. Remove it, then provide a safer structured or blinded version."
            : review.canResumeCommit
            ? "SituationRoom will finish the original save. It will not create a duplicate decision version."
            : review.canRetry
              ? "Retry reads the files again. Discard permanently removes the temporary originals and extracted copies."
              : "These files cannot safely continue. Remove them, then revise or choose different files."}</p>
          <code>{review.job.id} · version {review.job.version}</code>
        </div>
      ) : null}

      {phase === "review" && review ? (
        <div className="os-contract-review" ref={phaseFocusRef} tabIndex="-1">
          <header>
            <div><span className="os-step-index">C</span><span className="os-eyebrow">Review before saving</span><h3>Check the imported decision</h3></div>
            <span className={`os-domain-seal domain-${review.proposal.caseInput.domain.packId}`}>{DOMAIN_CONFIG[review.proposal.caseInput.domain.packId]?.label ?? "General decision"}</span>
          </header>
          <blockquote>{review.proposal.caseInput.contract.objective}</blockquote>
          <div className="os-contract-counts">
            {Object.entries(review.proposal.summary).map(([key, value]) => <div key={key}><strong>{value}</strong><span>{reviewLabel(key)}</span></div>)}
          </div>
          {(() => {
            const sourceDiagnostics = review.documents.flatMap((document) => document.diagnostics.map((diagnostic, index) => ({ ...diagnostic, id: `${document.id}:${index}`, document: document.name })));
            return (
          <div className="os-contract-columns">
            <section><h4>Options</h4><ReviewPager label="Options" items={review.proposal.caseInput.alternatives} pageSize={16} renderItem={(item) => <li key={item.id}>{item.label}</li>} /></section>
            <section><h4>Criteria</h4><ReviewPager label="Criteria" items={review.proposal.caseInput.criteria} pageSize={20} renderItem={(item) => <li key={item.id}><span>{item.label}</span><strong>{reviewLabel(item.kind)} · {reviewLabel(item.valueType)}{item.unit ? ` · ${item.unit}` : ""}</strong><small>{item.weight !== undefined ? `Weight ${item.weight}. ` : ""}{item.scoring ? `${reviewLabel(item.scoring.direction ?? item.scoring.kind)}; range ${formatInferredValue(item.scoring.min)} to ${formatInferredValue(item.scoring.max)}.` : "Not automatically scored."}</small></li>} /></section>
            <section><h4>File issues</h4><ReviewPager label="File issues" items={sourceDiagnostics} pageSize={18} renderItem={(item) => <li key={item.id} className={`severity-${item.severity}`}><span>{item.document}</span><strong>{item.code}</strong><small>{item.message}</small></li>} /></section>
          </div>
            );
          })()}
          <div className="os-inferred-model-review">
            <section>
              <h4>Must-haves and preferences</h4>
              <ol>{review.proposal.caseInput.constraints.length ? review.proposal.caseInput.constraints.map((item) => <li key={item.id}><strong>{item.label ?? item.criterionId}</strong><span>{reviewLabel(item.severity)} · {reviewLabel(item.operator)} · {formatInferredValue(item.expected)}</span></li>) : <li>No requirements were found.</li>}</ol>
            </section>
            <section>
              <h4>Evidence values and source locations</h4>
              <ReviewPager label="Evidence values and source locations" items={review.proposal.claims} pageSize={80} renderItem={(claim) => <li key={claim.id}><strong>{claim.subjectId} → {claim.criterionId}</strong><span>{formatInferredValue(claim.value)} · {reviewLabel(claim.status)} · confidence {claim.confidence ?? "unknown"}</span><small>{claim.sourceRefs?.[0]?.documentId} · {claim.sourceRefs?.[0]?.fragmentId}</small></li>} />
            </section>
            <section>
              <h4>Decision permissions</h4>
              <dl>
                <div><dt>Final decision</dt><dd>{review.proposal.caseInput.contract.authority.mode.replaceAll("_", " ").replaceAll("-", " ")}</dd></div>
                <div><dt>Option ranking</dt><dd>{review.proposal.caseInput.contract.authority.allowAutomatedRanking ? "Allowed as decision support" : "Turned off"}</dd></div>
                <div><dt>Actions only a person can take</dt><dd>{review.proposal.caseInput.contract.authority.humanOnlyActions.join(", ").replaceAll("_", " ")}</dd></div>
                <div><dt>After import</dt><dd>Saved as a draft until a person finishes setup.</dd></div>
              </dl>
            </section>
          </div>
          <SemanticIntakeReview proposal={review.semanticProposal} />
          {review.proposal.warnings.length ? <div className="os-review-warnings"><IconAlertTriangle size={18} /><ul>{review.proposal.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
          <label className="os-confirmation-check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I checked the options, criteria, requirements, evidence links, unresolved conflicts, and who is allowed to make the final decision. Save this as a draft for further review.</span>
          </label>
          <p className="os-field-note"><IconTable size={17} /> Text stays informational until you confirm a rule. Missing cells stay unknown; they are never treated as zero.</p>
          {error ? <p className="os-error-message" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </ModalSurface>
  );
}
