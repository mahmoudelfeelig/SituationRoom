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
  return String(value ?? "")
    .replaceAll(/[-_]/g, " ")
    .replaceAll(/\bkernel\b/gi, "decision data")
    .replaceAll(/\bpackets\b/gi, "reports")
    .replaceAll(/\bpacket\b/gi, "report")
    .replaceAll(/\brelays?\b/gi, "communications");
}

function statusCopy(status) {
  if (status === "running") return "The agent is working";
  if (status === "rejected") return "The last request was blocked safely";
  if (status === "settled") return "The agent finished its latest request";
  return "Ready for an agent request";
}

function diffCopy(diff) {
  if (diff?.decisionChanged && diff?.viewChanged) return "Decision and view changed";
  if (diff?.decisionChanged) return "Decision information changed";
  if (diff?.viewChanged) return "Page changed; decision stayed the same";
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
      aria-labelledby="agent-status-heading"
      aria-live="polite"
    >
      <header className="os-agent-wire__header">
        <IconRobot size={20} aria-hidden="true" />
        <div>
          <span className="os-eyebrow">Agent activity</span>
          <strong id="agent-status-heading">{statusCopy(activity?.status)}</strong>
        </div>
        <span>{room.webMcp.toolCount} site tools ready</span>
      </header>

      {recentSteps.length ? (
        <ol className="os-agent-wire__track" aria-label="Recent agent activity">
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
          <p><strong>This page is ready for an agent.</strong><span>Ask from a browser that supports WebMCP. Changes will appear here as they happen.</span></p>
          <button type="button" onClick={copyPrompt}><IconCopy size={16} /> {copied ? "Request copied" : "Copy example request"}</button>
        </div>
      )}

      {recentSteps.length ? (
        <aside className="os-agent-wire__diff" aria-label="Latest agent result">
          <IconArrowsDiff size={18} aria-hidden="true" />
          <div>
            <span className="os-eyebrow">Latest result</span>
            <strong>{diffCopy(activity.lastDiff)}</strong>
            {activity.lastDiff.changedEntityIds.length
              ? <small>{activity.lastDiff.changedEntityIds.length} decision {activity.lastDiff.changedEntityIds.length === 1 ? "item" : "items"} changed</small>
              : <small>No decision facts changed</small>}
          </div>
        </aside>
      ) : null}
    </section>
  );
}
