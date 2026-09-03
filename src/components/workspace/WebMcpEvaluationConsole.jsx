import { useMemo, useState } from "react";
import {
  IconCheck,
  IconClipboard,
  IconDownload,
  IconFlask,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { WEBMCP_EVAL_CASES } from "../../webmcp/evalCases.js";
import {
  createWebMcpEvidenceBundle,
  scoreWebMcpEvalCase,
} from "../../webmcp/evalScorer.js";

function humanize(value) {
  return String(value ?? "").replaceAll(/[-_]/g, " ");
}

function contextMatches(task, room) {
  const actualPhase = room.frozen ? "frozen" : room.capabilityPhase;
  return task.initialState.phase === actualPhase
    && task.initialState.lens === room.lens
    && task.initialState.domain === room.activeCase?.domain?.packId;
}

export function WebMcpEvaluationConsole({ room }) {
  const [selectedId, setSelectedId] = useState(WEBMCP_EVAL_CASES[0].id);
  const [armed, setArmed] = useState(null);
  const [copied, setCopied] = useState(false);
  const selected = WEBMCP_EVAL_CASES.find((task) => task.id === selectedId) ?? WEBMCP_EVAL_CASES[0];
  const calls = useMemo(() => {
    if (!armed || armed.id !== selected.id) return [];
    const threshold = Date.parse(armed.at);
    return (room.agentActivity?.steps ?? []).filter((step) => (
      step.caseId === armed.caseId && Date.parse(step.startedAt) >= threshold
    ));
  }, [armed, room.agentActivity?.steps, selected.id]);
  const score = useMemo(() => scoreWebMcpEvalCase(selected, calls), [selected, calls]);
  const matches = contextMatches(selected, room);
  const armedCaseIsActive = !armed || armed.caseId === room.activeCase?.id;

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(selected.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  }

  function armCapture() {
    setArmed({
      id: selected.id,
      caseId: room.activeCase?.id,
      at: new Date().toISOString(),
      phase: room.frozen ? "frozen" : room.capabilityPhase,
      lens: room.lens,
      domain: room.activeCase?.domain?.packId,
      decisionRevision: room.activeCase?.revision,
      viewRevision: room.viewRevision,
    });
  }

  function downloadEvidence() {
    if (!armed || !calls.length || !armedCaseIsActive) return;
    const bundle = createWebMcpEvidenceBundle({
      evalCase: selected,
      calls,
      captureContext: {
        armedAt: armed?.at,
        caseId: armed?.caseId,
        phase: armed?.phase,
        lens: armed?.lens,
        domain: armed?.domain,
        decisionRevision: armed?.decisionRevision,
        viewRevision: armed?.viewRevision,
      },
      appState: {
        caseId: room.activeCase?.id,
        phase: room.frozen ? "frozen" : room.capabilityPhase,
        lens: room.lens,
        domain: room.activeCase?.domain?.packId,
        decisionRevision: room.activeCase?.revision,
        viewRevision: room.viewRevision,
      },
    });
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selected.id}-webmcp-evidence.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="os-model-eval" aria-labelledby="model-eval-heading">
      <header>
        <div><span className="os-eyebrow">Real browser-agent test</span><h3 id="model-eval-heading"><IconFlask size={19} /> Test SituationRoom with Codex</h3></div>
        <p>Start a live test, copy the prompt into Codex, and SituationRoom will check only the actions the browser actually received.</p>
      </header>
      <div className="os-model-eval__setup">
        <label>Demo task<select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setArmed(null); setCopied(false); }}>{WEBMCP_EVAL_CASES.map((task) => <option value={task.id} key={task.id}>{humanize(task.id)}</option>)}</select></label>
        <dl>
          <div><dt>Task needs</dt><dd>{selected.initialState.domain} · {selected.initialState.lens} · {selected.initialState.phase}</dd></div>
          <div><dt>You are here</dt><dd>{room.activeCase?.domain?.packId} · {room.lens} · {room.frozen ? "frozen" : room.capabilityPhase}</dd></div>
        </dl>
        <span className={`os-model-eval__context ${matches ? "is-ready" : "is-mismatch"}`}>{matches ? "Ready to run" : "Open the matching example and view first"}</span>
      </div>
      <blockquote>{selected.prompt}</blockquote>
      <div className="os-model-eval__actions">
        <button type="button" onClick={copyPrompt}><IconClipboard size={16} /> {copied ? "Prompt copied" : "Copy test prompt"}</button>
        <button type="button" className="is-primary" disabled={!matches || !room.webMcp.available} onClick={armCapture}><IconPlayerPlay size={16} /> {armed?.id === selected.id ? "Restart live test" : "Start live test"}</button>
        <button type="button" disabled={!armed || !calls.length || !armedCaseIsActive} onClick={downloadEvidence}><IconDownload size={16} /> Download test record</button>
      </div>
      {!room.webMcp.available ? <p className="os-model-eval__notice">Browser tools are not available here, so a real Codex run cannot be recorded in this browser.</p> : null}
      {armed && !armedCaseIsActive ? <p className="os-model-eval__notice">This test belongs to another decision. Return to it or restart the test here.</p> : null}
      <div className="os-model-eval__contract">
        <section><h4>Actions Codex should take</h4><ol>{selected.expectedCalls.map((call) => <li key={call.name}><strong>{humanize(call.name)}</strong><span>{call.argumentsMustInclude?.length ? call.argumentsMustInclude.join(" · ") : "No required details"}</span></li>)}</ol></section>
        <section><h4>Actions Codex must not take</h4><p>{selected.forbiddenCalls.join(" · ")}</p><small>{selected.success}</small></section>
      </div>
      {armed?.id === selected.id ? (
        <div className={`os-model-eval__result status-${score.status}`} role="status">
          <header><span>{score.status === "passed" ? <IconCheck size={18} /> : <IconFlask size={18} />}</span><div><span className="os-eyebrow">Live result</span><strong>{humanize(score.status)} · {Math.round(score.score * 100)}%</strong></div><em>{score.callsObserved} actions recorded</em></header>
          <ol>{score.expected.map((result) => <li key={result.name} className={`status-${result.status}`}><strong>{humanize(result.name)}</strong><span>{result.status}{result.missingArguments.length ? ` · missing ${result.missingArguments.join(", ")}` : ""}{result.constraintFailures.length ? " · argument constraint failed" : ""}</span></li>)}</ol>
          {score.forbiddenCalls.length ? <p>Disallowed actions recorded: {score.forbiddenCalls.join(" · ")}</p> : null}
        </div>
      ) : <p className="os-model-eval__notice">No live test is running. Previous browser actions will not be counted.</p>}
    </section>
  );
}
