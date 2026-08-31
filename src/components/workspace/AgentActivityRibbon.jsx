import { useMemo, useState } from "react";
import {
  IconAlertCircle,
  IconArrowsDiff,
  IconCheck,
  IconCopy,
  IconLoader2,
  IconRobot,
} from "@tabler/icons-react";
import { selectAgentActivityForCase } from "../../workspace/agentActivity.js";

function humanize(value) {
  return String(value ?? "").replaceAll(/[-_]/g, " ");
}

function statusCopy(status) {
  if (status === "running") return "Working through the governed tool surface";
  if (status === "rejected") return "Last tool call was safely rejected";
  if (status === "settled") return "Latest tool sequence settled visibly";
  return "Ready for a browser-agent request";
}

function diffCopy(diff) {
  if (diff?.decisionChanged && diff?.viewChanged) return "Decision and view changed";
  if (diff?.decisionChanged) return "Canonical decision changed";
  if (diff?.viewChanged) return "View changed; decision stayed fixed";
  return "Decision and view stayed fixed";
}

export function AgentActivityRibbon({ room, domain }) {
  const [copied, setCopied] = useState(false);
  const activity = useMemo(
    () => selectAgentActivityForCase(room.agentActivity, room.activeCase?.id),
    [room.agentActivity, room.activeCase?.id],
  );
  const recentSteps = activity?.steps?.slice(-5) ?? [];
  const visible = room.webMcp.available || recentSteps.length > 0;
  const demoPrompt = useMemo(() => (
    `Using this page's Site tools, inspect the active ${domain.label} decision, compare the eligible alternatives, `
    + "explain the decisive evidence, and recompose the page into the most useful governed view. "
    + "Do not approve the decision or perform any external action."
  ), [domain.label]);

  if (!visible) return null;

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(demoPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className={`os-agent-wire status-${activity?.status ?? "idle"}`}
      aria-labelledby="browser-agent-channel"
      aria-live="polite"
    >
      <header className="os-agent-wire__header">
        <IconRobot size={20} aria-hidden="true" />
        <div>
          <span className="os-eyebrow">Browser-agent channel</span>
          <strong id="browser-agent-channel">{statusCopy(activity?.status)}</strong>
        </div>
        <span>{room.webMcp.toolCount} contextual site tools</span>
      </header>

      {recentSteps.length ? (
        <ol className="os-agent-wire__track" aria-label="Recent browser-agent tool activity">
          {recentSteps.map((step, index) => (
            <li key={step.id} className={`status-${step.status}`}>
              <span className="os-agent-wire__node" aria-hidden="true">{index + 1}</span>
              <div>
                <small>{humanize(step.family)}</small>
                <strong>{humanize(step.tool)}</strong>
              </div>
              <span className="os-agent-wire__step-status">
                {step.status === "rejected" ? <IconAlertCircle size={15} /> : step.status === "started" ? <IconLoader2 size={15} /> : <IconCheck size={15} />}
                {humanize(step.status)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="os-agent-wire__ready">
          <p><strong>The page is listening for a real Site-tools request.</strong><span>Ask Codex from its browser side panel; each tool call and resulting change will appear on this red thread.</span></p>
          <button type="button" onClick={copyPrompt}><IconCopy size={16} /> {copied ? "Demo request copied" : "Copy live demo request"}</button>
        </div>
      )}

      {recentSteps.length ? (
        <aside className="os-agent-wire__diff" aria-label="Latest agent result">
          <IconArrowsDiff size={18} aria-hidden="true" />
          <div>
            <span className="os-eyebrow">Receipt-backed result</span>
            <strong>{diffCopy(activity.lastDiff)}</strong>
            {activity.lastDiff.changedEntityIds.length
              ? <small>{activity.lastDiff.changedEntityIds.length} canonical {activity.lastDiff.changedEntityIds.length === 1 ? "entity" : "entities"} changed</small>
              : <small>No canonical changes inferred</small>}
          </div>
        </aside>
      ) : null}
    </section>
  );
}
