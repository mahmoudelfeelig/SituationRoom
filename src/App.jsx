import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArchive,
  IconBook2,
  IconBolt,
  IconChevronRight,
  IconFilePlus,
  IconFiles,
  IconFingerprint,
  IconHistory,
  IconLock,
  IconLockOpen,
  IconMenu2,
  IconRefresh,
  IconRestore,
  IconRoute,
  IconSearch,
  IconSend,
  IconSnowflake,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { CompiledRoomView } from "./components/composer/index.js";
import { IntakeWorkbench } from "./components/workspace/IntakeWorkbench.jsx";
import { AgentActivityRibbon } from "./components/workspace/AgentActivityRibbon.jsx";
import { ModalSurface } from "./components/workspace/ModalSurface.jsx";
import { UniversalFirewall } from "./components/workspace/UniversalFirewall.jsx";
import { WorkspaceOverlays } from "./components/workspace/WorkspaceOverlays.jsx";
import { WorkspaceSpine } from "./components/workspace/WorkspaceSpine.jsx";
import { WorkflowDesk } from "./components/workspace/WorkflowDesk.jsx";
import { getDomainConfig } from "./workspace/domainConfig.js";
import { useWorkspaceNavigation } from "./workspace/useWorkspaceNavigation.js";
import { parseWorkspacePath, routeFromWorkspaceState, workspacePathFor } from "./workspace/workspaceRouter.js";
import {
  cancelComposition,
  focusEntity,
  initializeWorkspace,
  restoreViewRevision,
  resetLocalDemoData,
  runScenario,
  saveCurrentView,
  submitDecisionQuestion,
  toggleAudit,
  toggleFreeze,
  toggleOutline,
  togglePin,
  toggleReducedMotion,
  toggleSourceDrawer,
  useWorkspaceStore,
} from "./workspace/workspaceStore.js";

const ROUTE_COPY = Object.freeze({
  model: {
    eyebrow: "Set up",
    title: "Define the decision",
    description: "Set the question, options, criteria, and required checks.",
  },
  investigate: {
    eyebrow: "Evidence",
    title: "Review the evidence",
    description: "See which sources support each claim and where information is missing.",
  },
  compare: {
    eyebrow: "Comparison",
    title: "Compare the options",
    description: "See every option against the same criteria.",
  },
  simulate: {
    eyebrow: "What if",
    title: "Try different scenarios",
    description: "Change an assumption and see how the result responds.",
  },
  brief: {
    eyebrow: "Summary",
    title: "Review the decision summary",
    description: "See the recommendation, remaining concerns, and next steps in one place.",
  },
  review: {
    eyebrow: "Review",
    title: "Review open requests",
    description: "Resolve questions and suggested changes that need your attention.",
  },
  outputs: {
    eyebrow: "Download",
    title: "Download the decision",
    description: "Create a file that includes the evidence and current decision version.",
  },
});

function formatDate(value) {
  if (!value) return "Not yet persisted";
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function prefersNativeLinkNavigation(event) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function BootSurface({ status, error, onRetry, onReset }) {
  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [resetArmed, setResetArmed] = useState(false);

  async function run(action, operation) {
    setBusyAction(action);
    setActionError("");
    try {
      await operation();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction("");
    }
  }

  return (
    <main className="os-boot-surface">
      <span className="brand-name">Situation<span>Room</span></span>
      {status === "error" ? (
        <>
          <strong>The decision runtime could not start.</strong>
          <p>{error}</p>
          <div className="os-boot-actions">
            <button type="button" className="os-button-primary" disabled={Boolean(busyAction)} onClick={() => run("retry", onRetry)}>
              <IconRefresh size={17} /> {busyAction === "retry" ? "Retrying startup" : "Retry startup"}
            </button>
            {!resetArmed ? (
              <button type="button" className="os-button-secondary" disabled={Boolean(busyAction)} onClick={() => setResetArmed(true)}>Reset local workspace</button>
            ) : (
              <div className="os-boot-reset-confirm" role="group" aria-label="Confirm local workspace reset">
                <p>This erases local decisions, imports, activity, and prepared files in this browser.</p>
                <button type="button" className="os-button-secondary" disabled={Boolean(busyAction)} onClick={() => setResetArmed(false)}>Keep local data</button>
                <button type="button" className="os-button-primary" disabled={Boolean(busyAction)} onClick={() => run("reset", onReset)}>
                  {busyAction === "reset" ? "Erasing local workspace" : "Confirm erase and reseed"}
                </button>
              </div>
            )}
          </div>
          {actionError ? <p className="os-error-message" role="alert">{actionError}</p> : null}
        </>
      ) : (
        <><IconSparkles className="is-spinning" size={28} /><strong>Opening SituationRoom</strong><p>Restoring your decisions and evidence.</p></>
      )}
    </main>
  );
}

function ViewHistoryRail({ room }) {
  return (
    <details className="os-history-rail" role="region" aria-label="View history">
      <summary><IconHistory size={17} /><span>View history</span>{room.history.length ? <strong>{room.history.length}</strong> : null}<small>Save or return to an earlier layout</small></summary>
      <div className="os-history-rail__body">
        <div className="os-history-track">
          {room.history.map((entry, index) => (
            <button
              type="button"
              key={entry.receipt.id}
              className={index === room.historyCursor ? "is-active" : ""}
              onClick={() => restoreViewRevision(entry.plan.nextViewRevision)}
              disabled={room.frozen || room.compositionPhase !== "idle"}
            >
              <span>{String(entry.plan.nextViewRevision).padStart(2, "0")}</span>
              <strong>{entry.plan.lens}</strong>
              <small>{entry.plan.question}</small>
            </button>
          ))}
          {!room.history.length ? <p>No saved views yet.</p> : null}
        </div>
        <button type="button" className="os-save-view" onClick={saveCurrentView} disabled={!room.plan}><IconRestore size={17} /> Save current view</button>
      </div>
    </details>
  );
}

function QuestionComposer({ room, domain, draft, setDraft, asking, ask, onSubmit }) {
  return (
    <section className="os-question-rail" aria-labelledby="decision-question-label">
      <IconSearch size={21} aria-hidden="true" />
      <form onSubmit={onSubmit}>
        <label id="decision-question-label" htmlFor="decision-question">Ask the room</label>
        <input
          id="decision-question"
          aria-label="Ask SituationRoom to update this view"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={240}
          placeholder="Ask to compare, explain, or test a scenario"
          disabled={asking || room.frozen}
        />
        <button className="os-ask-button" type="submit" aria-label="Ask the room" disabled={asking || room.frozen || !draft.trim()}>
          {asking ? <IconSparkles className="is-spinning" size={19} /> : <IconSend size={19} />}
          {asking ? "Working" : "Ask"}
        </button>
      </form>
      <details className="os-question-prompts">
        <summary>Try an example</summary>
        <div>{domain.prompts.slice(0, 3).map((prompt) => <button type="button" key={prompt} onClick={() => { setDraft(prompt); ask(prompt); }} disabled={room.frozen || asking}>{prompt}</button>)}</div>
      </details>
    </section>
  );
}

function CaseArchive({ room, navigate }) {
  return (
    <main className="os-archive-page" id="decision-stage" tabIndex="-1">
      <header className="os-archive-heading">
        <div><span className="os-eyebrow">All decisions</span><h2 data-route-heading tabIndex="-1">Choose a decision</h2></div>
        <p>Each decision keeps its own evidence, rules, history, and exports.</p>
        <a href="/new" onClick={(event) => { if (prefersNativeLinkNavigation(event)) return; event.preventDefault(); void navigate({ kind: "new" }); }}><IconFilePlus size={18} /> New decision</a>
      </header>
      <ol className="os-archive-ledger">
        {room.workspace.cases.map((item, index) => {
          const domain = getDomainConfig(item.domainPackId);
          const nextRoute = { kind: "case", caseId: item.id, workspace: "analyze", lens: item.id === room.activeCase.id ? room.lens : "investigate" };
          return (
            <li key={item.id} className={item.id === room.activeCase.id ? "is-active" : ""}>
              <span className="os-archive-number">{String(index + 1).padStart(2, "0")}</span>
              <span className={`os-case-mark accent-${domain.accent}`} aria-hidden="true">{domain.label.slice(0, 1)}</span>
              <div><span>{domain.label} · revision {item.revision}</span><strong>{item.title}</strong><small>{item.subtitle}</small></div>
              <a href={workspacePathFor(nextRoute)} onClick={(event) => { if (prefersNativeLinkNavigation(event)) return; event.preventDefault(); void navigate(nextRoute); }}>{item.id === room.activeCase.id ? "Return to room" : "Open case"}</a>
            </li>
          );
        })}
      </ol>
    </main>
  );
}

function MissingRoute({ navigate }) {
  return (
    <main className="os-missing-route" id="decision-stage" tabIndex="-1">
      <span className="os-eyebrow">Page not found</span>
      <h2 data-route-heading tabIndex="-1">We could not find this page.</h2>
      <p>Your decision was not changed. Return to the list and choose another page.</p>
      <a href="/cases" onClick={(event) => { if (prefersNativeLinkNavigation(event)) return; event.preventDefault(); void navigate({ kind: "archive" }); }}><IconFiles size={18} /> View all decisions</a>
    </main>
  );
}

export function App() {
  const room = useWorkspaceStore();
  const [draft, setDraft] = useState("");
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [roomMapOpen, setRoomMapOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const roomMapButtonRef = useRef(null);
  const handleNavigationError = useCallback((error) => {
    setActionError(error instanceof Error ? error.message : String(error));
  }, []);
  const { route, navigate, isNavigating } = useWorkspaceNavigation(room, {
    onError: handleNavigationError,
  });

  useEffect(() => {
    initializeWorkspace({ initialRoute: parseWorkspacePath(window.location.pathname) }).catch(() => undefined);
  }, []);

  useEffect(() => {
    setDraft("");
  }, [room.activeCase?.id]);

  useEffect(() => {
    if (!roomMapOpen) return undefined;
    const panel = document.getElementById("workspace-navigation");
    const focusable = [...(panel?.querySelectorAll('a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])') ?? [])];
    window.requestAnimationFrame(() => focusable[0]?.focus());
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setRoomMapOpen(false);
        roomMapButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [roomMapOpen]);

  useEffect(() => {
    if (room.bootStatus !== "ready" || !room.activeCase) return;
    if (route.kind === "archive") {
      document.title = "Decision archive · SituationRoom";
      return;
    }
    const workspaceLabel = route.kind === "case"
      ? route.workspace === "analyze" ? route.lens : route.workspace
      : "Decision workspace";
    document.title = `${room.activeCase.title} · ${workspaceLabel} · SituationRoom`;
  }, [room.activeCase, room.bootStatus, route]);

  const domain = useMemo(() => getDomainConfig(room.activeCase?.domain?.packId), [room.activeCase?.domain?.packId]);

  if (room.bootStatus !== "ready") {
    return (
      <BootSurface
        status={room.bootStatus}
        error={room.bootError}
        onRetry={() => initializeWorkspace({ initialRoute: parseWorkspacePath(window.location.pathname) })}
        onReset={resetLocalDemoData}
      />
    );
  }

  async function ask(question = draft, options = {}) {
    if (!question.trim()) return;
    setAsking(true);
    setActionError("");
    try {
      await submitDecisionQuestion(question, options);
      setDraft("");
    } catch (error) {
      if (error?.code !== "EXECUTION_CANCELED") setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAsking(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    await ask();
  }

  async function handleInstrumentAction(action) {
    setActionError("");
    try {
      if (action.type === "focus") {
        focusEntity(action.entityRef, room.plan?.focus?.pathId);
      } else if (action.type === "pin") {
        await togglePin(action.entityRef);
      } else if (action.type === "open-source") {
        focusEntity(action.entityRef);
        toggleSourceDrawer(true);
      } else if (action.type === "challenge") {
        await ask(`Challenge the current interpretation of ${action.entityRef?.id ?? "this evidence"} and show contradictions that could change the outcome.`, {
          focusRef: action.entityRef,
          source: "instrument-challenge",
        });
      } else if (action.type === "change-scenario") {
        const scenarioId = action.entityRef?.id;
        if (action.value && room.activeCase.scenarios?.some((scenario) => scenario.id === scenarioId)) {
          await runScenario(scenarioId);
        }
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  const visibleRoute = route.kind === "root" || route.kind === "new"
    ? routeFromWorkspaceState({ ...room, intakeOpen: false })
    : route;
  const caseWorkspaceVisible = visibleRoute.kind === "case" && visibleRoute.caseId === room.activeCase.id;
  const analysisVisible = caseWorkspaceVisible && visibleRoute.workspace === "analyze";
  const workspaceLabel = visibleRoute.kind === "archive"
    ? "Decision archive"
    : visibleRoute.kind === "case"
      ? visibleRoute.workspace === "analyze" ? visibleRoute.lens : visibleRoute.workspace
      : "Unknown location";
  const routeCopy = caseWorkspaceVisible
    ? ROUTE_COPY[visibleRoute.workspace === "analyze" ? visibleRoute.lens : visibleRoute.workspace]
    : null;

  return (
    <div
      className={`decision-os domain-${room.activeCase.domain.packId} lens-${room.lens} ${room.reducedMotion ? "reduce-motion" : ""}`}
      data-composition-phase={room.compositionPhase}
    >
      <a
        className="skip-link"
        href="#decision-stage"
        onClick={(event) => {
          event.preventDefault();
          const stage = document.getElementById("decision-stage");
          stage?.focus({ preventScroll: true });
          stage?.scrollIntoView({ block: "start" });
        }}
      >Skip to decision stage</a>
      <div className="paper-wash" aria-hidden="true" />
      <div className="os-red-thread" aria-hidden="true" />

      <header className="os-header">
        <div className="brand-lockup">
          <img className="brand-elephant" src="/assets/elephant-logo.png" alt="" />
          <h1 className="brand-name">Situation<span>Room</span></h1>
          <span className="brand-mode">Decision workspace</span>
        </div>
        <div className="os-case-identity">
          <span className="os-eyebrow">{visibleRoute.kind === "archive" ? "All decisions" : `Current decision · ${domain.label}`}</span>
          <strong>{visibleRoute.kind === "archive" ? "All case files" : room.activeCase.title}</strong>
          <span>{visibleRoute.kind === "archive" ? `${room.workspace.cases.length} decisions saved in this browser` : room.activeCase.subtitle}</span>
        </div>
        <div className="os-header-ledger">
          <span title={`Case updated ${formatDate(room.activeCase.updatedAt)}`}><IconFingerprint size={15} /> r<strong>{room.activeCase.revision}</strong> · v<strong>{room.viewRevision}</strong></span>
          <span className={`os-webmcp-state ${room.webMcp.available ? "is-live" : ""}`}>
            {room.webMcp.available ? `Browser agent ready · ${room.webMcp.toolCount} actions` : "Browser agent not connected"}
          </span>
        </div>
        {caseWorkspaceVisible ? (
          <button
            ref={roomMapButtonRef}
            type="button"
            className="os-room-map-button"
            aria-expanded={roomMapOpen}
            aria-controls="workspace-navigation"
            onClick={() => setRoomMapOpen((value) => !value)}
          ><IconRoute size={19} /><span>Navigate</span></button>
        ) : null}
        <button type="button" className="utility-menu-button" aria-expanded={utilityOpen} aria-controls="os-utility-menu" onClick={() => setUtilityOpen((value) => !value)}>
          {utilityOpen ? <IconX size={20} /> : <IconMenu2 size={20} />}<span>More</span>
        </button>
        <div className={`os-header-actions ${utilityOpen ? "is-open" : ""}`} id="os-utility-menu">
          <button type="button" onClick={async () => { setUtilityOpen(false); try { await toggleFreeze(); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } }} aria-pressed={room.frozen} disabled={room.activeCase.status === "approved"}>
            {room.frozen ? <IconLock size={17} /> : <IconLockOpen size={17} />}{room.frozen ? "Resume changes" : "Pause changes"}
          </button>
          <button type="button" onClick={() => { setUtilityOpen(false); toggleOutline(true); }}><IconBook2 size={17} /> Accessible summary</button>
          <button type="button" onClick={() => { setUtilityOpen(false); toggleSourceDrawer(true); }}><IconArchive size={17} /> Sources</button>
          <button type="button" onClick={() => { setUtilityOpen(false); toggleAudit(true); }}><IconHistory size={17} /> Activity history</button>
          <button type="button" onClick={() => { setUtilityOpen(false); toggleReducedMotion(); }} aria-pressed={room.reducedMotion}><IconSnowflake size={17} /> Reduced motion {room.reducedMotion ? "on" : "off"}</button>
          <button type="button" onClick={() => { setUtilityOpen(false); void navigate({ kind: "new" }); }}><IconFilePlus size={17} /> New decision</button>
          <a href="/source/SituationRoom-source.tar.gz" download>Corresponding source</a>
          <button type="button" onClick={() => { setUtilityOpen(false); setResetError(""); setResetOpen(true); }}><IconRefresh size={17} /> Reset demo</button>
        </div>
      </header>

      {room.persistenceMode === "session-only" ? (
        <div className="os-persistence-warning" role="alert">
          <IconArchive size={19} aria-hidden="true" />
          <div><strong>Session-only workspace</strong><span>{room.persistenceWarning}</span></div>
        </div>
      ) : null}

      {room.activeImportReview?.recovery && !room.intakeOpen ? (
        <div className="os-recovery-docket" role="alert">
          <IconAlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>{room.activeImportReview.cleanupPending ? "A source file still needs to be removed" : "This import needs your attention"}</strong>
            <span>{room.activeImportReview.cleanupPending
              ? "The decision is available, but the local source file may not have been deleted. Agent changes remain paused."
              : "The source material remains separate until you retry or confirm deletion."}</span>
          </div>
          <button type="button" onClick={() => void navigate({ kind: "new" })}>Review import</button>
        </div>
      ) : null}

      {visibleRoute.kind === "archive" ? (
        <CaseArchive room={room} navigate={navigate} />
      ) : visibleRoute.kind === "not-found" || !caseWorkspaceVisible ? (
        isNavigating && visibleRoute.kind === "case" ? (
          <main className="os-route-loading" id="decision-stage" tabIndex="-1" aria-live="polite">
            <IconSparkles className="is-spinning" size={24} />
            <span className="os-eyebrow">Opening case file</span>
            <strong>Restoring its evidence, governance, and latest view.</strong>
          </main>
        ) : <MissingRoute navigate={navigate} />
      ) : (
        <div className="os-room-shell" data-route-workspace={visibleRoute.workspace} data-navigating={isNavigating ? "true" : "false"}>
          <button className={`os-navigation-backdrop ${roomMapOpen ? "is-visible" : ""}`} type="button" aria-label="Close navigation" tabIndex={roomMapOpen ? 0 : -1} onClick={() => { setRoomMapOpen(false); roomMapButtonRef.current?.focus(); }} />
          <WorkspaceSpine
            room={room}
            route={visibleRoute}
            navigate={navigate}
            mobileOpen={roomMapOpen}
            onClose={() => {
              setRoomMapOpen(false);
              roomMapButtonRef.current?.focus();
            }}
          />
          <main className="os-decision-stage" id="decision-stage" tabIndex="-1" aria-busy={isNavigating}>
            <div className="os-stage-breadcrumb">
              <span>{domain.label}</span><IconChevronRight size={15} /><strong>{routeCopy.eyebrow}</strong>
              <span className="os-stage-question">{analysisVisible ? room.plan?.question : room.activeCase.contract.question}</span>
            </div>
            <header className="os-route-heading">
              <div>
                <span className="os-eyebrow">{routeCopy.eyebrow}</span>
                <h2 data-route-heading tabIndex="-1">{routeCopy.title}</h2>
              </div>
              <p>{routeCopy.description}</p>
            </header>
            <UniversalFirewall room={room} />
            {actionError ? <div className="os-inline-error" role="alert">{actionError}</div> : null}
            {analysisVisible ? (
              <>
                <AgentActivityRibbon room={room} domain={domain} />
                <QuestionComposer room={room} domain={domain} draft={draft} setDraft={setDraft} asking={asking} ask={ask} onSubmit={handleSubmit} />
                {room.compositionPhase !== "idle" ? (
                  <div className={`os-composition-strip phase-${room.compositionPhase}`} role="status">
                    <span className="os-composition-pulse"><IconBolt size={18} /></span>
                    <div><span className="os-eyebrow">Updating this page</span><strong>{room.compositionMessage}</strong></div>
                    <button type="button" onClick={cancelComposition}>{room.compositionPhase === "rejected" ? "Keep previous room" : "Cancel"}</button>
                  </div>
                ) : null}
                <CompiledRoomView snapshot={room.snapshot} plan={room.plan} onAction={handleInstrumentAction} />
                <ViewHistoryRail room={room} />
              </>
            ) : (
              <WorkflowDesk room={room} />
            )}
          </main>
        </div>
      )}

      {!resetOpen ? <WorkspaceOverlays room={room} intake={<IntakeWorkbench room={room} />} /> : null}
      <ModalSurface
        open={resetOpen}
        title="Reset the local demonstration"
        eyebrow="Destructive local action"
        onClose={resetBusy ? undefined : () => setResetOpen(false)}
        footer={<>
          <button type="button" disabled={resetBusy} onClick={() => setResetOpen(false)}>Keep workspace</button>
          <button type="button" className="is-danger" disabled={resetBusy} onClick={async () => {
            setResetBusy(true);
            setResetError("");
            try {
              await resetLocalDemoData();
            } catch (error) {
              setResetError(error instanceof Error ? error.message : String(error));
              setResetBusy(false);
            }
          }}>{resetBusy ? "Resetting…" : "Erase local workspace and reseed"}</button>
        </>}
      >
        <div className="os-reset-warning">
          <IconRefresh size={28} aria-hidden="true" />
          <div>
            <strong>This permanently removes this browser's local SituationRoom data.</strong>
            <p>Decisions, imported evidence, activity history, exports, and saved views will be erased. External source files are not touched. The page will then reload the four example decisions.</p>
          </div>
        </div>
        {resetError ? <p className="workflow-desk-error" role="alert">{resetError}</p> : null}
      </ModalSurface>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{room.lastAnnouncement}</div>
    </div>
  );
}
