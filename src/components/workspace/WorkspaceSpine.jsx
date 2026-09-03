import {
  IconArchive,
  IconArrowsSplit,
  IconChartArrows,
  IconChevronDown,
  IconFileDescription,
  IconFilePlus,
  IconFiles,
  IconHistory,
  IconLayoutBoardSplit,
  IconMessage2,
  IconRoute,
  IconX,
} from "@tabler/icons-react";
import { getDomainConfig, LENS_CONFIG } from "../../workspace/domainConfig.js";
import { workspacePathFor } from "../../workspace/workspaceRouter.js";
import { toggleAudit, toggleSourceDrawer } from "../../workspace/workspaceStore.js";

const LENS_ICONS = {
  investigate: IconRoute,
  compare: IconChartArrows,
  simulate: IconArrowsSplit,
  brief: IconLayoutBoardSplit,
};

const WORKFLOW_ROUTES = Object.freeze([
  { workspace: "model", label: "Set up decision", note: "Question and rules", icon: IconFileDescription },
  { workspace: "review", label: "Review requests", note: "For people", icon: IconMessage2 },
  { workspace: "outputs", label: "Export", note: "Files", icon: IconArchive },
]);

function routeForCase(route, caseId, fallbackLens) {
  if (route?.kind === "case") return { ...route, caseId };
  return { kind: "case", caseId, workspace: "analyze", lens: fallbackLens || "investigate" };
}

export function WorkspaceSpine({ room, route, navigate, mobileOpen, onClose }) {
  const activeCaseId = room.activeCase?.id;
  const domain = getDomainConfig(room.activeCase.domain.packId);

  function follow(event, nextRoute, { disabled = false } = {}) {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (mobileOpen) onClose?.();
    void navigate(nextRoute);
  }

  return (
    <aside className={`os-spine ${mobileOpen ? "is-open" : ""}`} id="workspace-navigation" aria-label="Decision navigation">
      <div className="os-spine-mobile-header">
        <div><span className="os-eyebrow">Current decision</span><strong>Navigate</strong></div>
        <button type="button" onClick={onClose} aria-label="Close navigation"><IconX size={20} /></button>
      </div>

      <div className="os-case-switcher">
        <a className="os-all-cases-link" href="/cases" onClick={(event) => follow(event, { kind: "archive" })}>
          <IconFiles size={18} /><span>All decisions</span><strong>{room.workspace.cases.length}</strong>
        </a>
        <details>
          <summary>
            <span className={`os-case-mark accent-${domain.accent}`} aria-hidden="true">{domain.label.slice(0, 1)}</span>
            <span><small>Current decision</small><strong>{room.activeCase.title}</strong></span>
            <IconChevronDown size={18} aria-hidden="true" />
          </summary>
          <div className="os-case-tabs" aria-label="Switch active decision">
            {room.workspace.cases.map((item) => {
              const itemDomain = getDomainConfig(item.domainPackId);
              const active = item.id === activeCaseId;
              const nextRoute = routeForCase(route, item.id, room.lens);
              return (
                <a
                  href={workspacePathFor(nextRoute)}
                  key={item.id}
                  className={`os-case-tab ${active ? "is-active" : ""}`}
                  aria-current={active ? "true" : undefined}
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    follow(event, nextRoute);
                  }}
                >
                  <span className={`os-case-mark accent-${itemDomain.accent}`} aria-hidden="true">{itemDomain.label.slice(0, 1)}</span>
                  <span><strong>{item.title}</strong><small>{itemDomain.shortLabel} · r{item.revision}</small></span>
                </a>
              );
            })}
          </div>
        </details>
      </div>

      <nav className="os-route-nav" aria-label="Analysis views">
        <span className="os-spine__label"><IconRoute size={16} /><span>Understand the decision</span></span>
        <div className="os-lens-tabs">
          {Object.values(LENS_CONFIG).map((lens) => {
            const Icon = LENS_ICONS[lens.id];
            const nextRoute = { kind: "case", caseId: activeCaseId, workspace: "analyze", lens: lens.id };
            const active = route?.kind === "case" && route.workspace === "analyze" && route.lens === lens.id;
            return (
              <a
                href={workspacePathFor(nextRoute)}
                key={lens.id}
                className={active ? "is-active" : ""}
                aria-current={active ? "page" : undefined}
                onClick={(event) => follow(event, nextRoute)}
              >
                <Icon size={18} /><span>{lens.longLabel}</span><strong>{lens.pattern}</strong>
              </a>
            );
          })}
        </div>
      </nav>

      <nav className="os-route-nav os-route-nav--workflow" aria-label="Decision workflow">
        <span className="os-spine__label"><IconFileDescription size={16} /><span>Manage the decision</span></span>
        <div className="os-workflow-tabs">
          {WORKFLOW_ROUTES.map((page) => {
            const Icon = page.icon;
            const nextRoute = { kind: "case", caseId: activeCaseId, workspace: page.workspace };
            const active = route?.kind === "case" && route.workspace === page.workspace;
            const disabled = room.frozen;
            const note = page.workspace === "review"
              ? `${room.reviewArtifacts.length} entries`
              : page.workspace === "outputs" ? `${room.outputArtifacts.length} ready` : page.note;
            return (
              <a
                href={workspacePathFor(nextRoute)}
                key={page.workspace}
                className={active ? "is-active" : ""}
                aria-current={active ? "page" : undefined}
                aria-disabled={disabled || undefined}
                tabIndex={disabled ? -1 : undefined}
                onClick={(event) => follow(event, nextRoute, { disabled })}
              >
                <Icon size={18} /><span>{page.label}</span><strong>{note}</strong>
              </a>
            );
          })}
        </div>
      </nav>

      <div className="os-spine-utilities" aria-label="Case utilities">
        <a href="/new" className="os-spine-action os-new-docket" onClick={(event) => follow(event, { kind: "new" })}>
          <IconFilePlus size={18} /><span>New decision</span><strong>Import</strong>
        </a>
        <button type="button" className="os-spine-action" onClick={() => { if (mobileOpen) onClose?.(); toggleSourceDrawer(true); }}>
          <IconArchive size={18} /><span>Sources</span><strong>{room.snapshot?.sources?.length ?? 0}</strong>
        </button>
        <button type="button" className="os-spine-action" onClick={() => { if (mobileOpen) onClose?.(); toggleAudit(true); }}>
          <IconHistory size={18} /><span>Activity</span><strong>{room.receipts.length}</strong>
        </button>
      </div>
    </aside>
  );
}
