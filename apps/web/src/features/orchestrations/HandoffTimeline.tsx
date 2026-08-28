import type { Agent, Handoff } from "../../api/contracts";
import { EmptyState } from "../../shared/ui/states";
import { formatDateTime } from "../../shared/utils/format";

function label(
  who: string,
  agentId: string | null,
  agents: Agent[],
): string {
  if (who === "user") return "User task";
  const name = agentId
    ? agents.find((a) => a.id === agentId)?.name
    : undefined;
  const role = who.charAt(0).toUpperCase() + who.slice(1);
  return name ? `${role} · ${name}` : role;
}

/**
 * Correlated inter-agent handoffs: who sent it, who received it, the stage, and
 * the content type. Bounded redacted content only — never chain-of-thought.
 */
export function HandoffTimeline({
  messages,
  agents,
}: {
  messages: Handoff[];
  agents: Agent[];
}) {
  if (messages.length === 0) {
    return (
      <EmptyState
        title="No handoffs yet"
        hint="Messages appear as each stage completes and passes work on."
      />
    );
  }

  return (
    <ol className="handoff-timeline">
      {messages.map((m) => (
        <li key={m.id} className="handoff-item">
          <div className="handoff-line">
            <span className="handoff-from">
              {label(m.fromStage, m.fromAgentId, agents)}
            </span>
            <span className="handoff-arrow" aria-hidden="true">
              →
            </span>
            <span className="handoff-to">
              {label(m.toStage, m.toAgentId, agents)}
            </span>
            <span className="tag handoff-type">{m.contentType}</span>
            <span className="handoff-time">{formatDateTime(m.createdAt)}</span>
          </div>
          <p className="handoff-content">{m.content}</p>
          <p className="handoff-trace">
            trace <code>{m.traceId}</code>
          </p>
        </li>
      ))}
    </ol>
  );
}
