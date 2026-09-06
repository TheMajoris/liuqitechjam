import type { AgentAppearance } from "../types";
import { AgentAvatar } from "../components/orchestration/AgentAvatar";
import { AgentSkinEditor } from "./AgentSkinEditor";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { UsageSparkline } from "../components/insights/UsageSparkline";
import { formatBytes, formatPct, metricsRows } from "./agent-metrics-format";
import { useMetricsHistory } from "./use-metrics-history";
import {
  modelResourceObservedLabel,
  modelResourceRateLimitLabel,
  modelResourceStatusLabel,
  modelResourceStatusTone,
  modelResourceUsageRows,
  modelResourceUsageScopeLabel,
} from "../model-resource-format";
import {
  WORKSPACE_ACTIVITY,
  type WorkspaceAgentViewModel,
  type WorkspaceSandboxActivity,
} from "./workspace-view-model";

/** Short label for the sandbox echo shown when no platform tool is open. */
function sandboxActivityLabel(sandbox: WorkspaceSandboxActivity): string {
  if (sandbox.kind === "command") return "$ " + sandbox.program;
  return "editing " + sandbox.fileCount + " " + (sandbox.fileCount === 1 ? "file" : "files");
}

export type AgentLifecycleAction = "start" | "stop";

interface AgentInspectorProps {
  agent: WorkspaceAgentViewModel | null;
  projectName: string | null;
  pending: AgentLifecycleAction | null;
  onLifecycle: (agentId: string, action: AgentLifecycleAction) => void;
  onOpenConversation: () => void;
  onOpenAgent: (agentId: string) => void;
  onClose?: () => void;
  /** Cosmetic-only character edit; absent hides the appearance controls. */
  onAppearanceChange?: (agentId: string, appearance: AgentAppearance) => Promise<void>;
}

/**
 * The Agent control surface.
 *
 * Every button here calls an API the backend already exposes — Agent
 * lifecycle controls and cosmetic appearance updates. Nothing in the room
 * can act on its own: the canvas only decides which Agent this panel is
 * describing.
 */
export function AgentInspector({
  agent,
  projectName,
  pending,
  onLifecycle,
  onOpenConversation,
  onOpenAgent,
  onClose = () => undefined,
  onAppearanceChange,
}: AgentInspectorProps) {
  const history = useMetricsHistory(agent?.agentId ?? null, agent?.metrics ?? null);

  if (!agent) {
    return (
      <aside className="ws-inspector is-empty" aria-label="Agent inspector">
        <div className="ws-inspector-empty">
          <span className="ws-inspector-glyph" aria-hidden="true">◍</span>
          <strong>Select an Agent</strong>
          <p>Pick anyone in the room to see what they are doing and control them.</p>
        </div>
      </aside>
    );
  }

  const descriptor = WORKSPACE_ACTIVITY[agent.activity];
  const stopped = agent.lifecycle === "stopped";
  const action: AgentLifecycleAction = stopped ? "start" : "stop";

  return (
    <aside className="ws-inspector" aria-label={`Inspector for ${agent.name}`}>
      <header className="ws-inspector-head">
        <AgentAvatar agentId={agent.agentId} name={agent.name} />
        <div className="ws-inspector-identity">
          <h3>{agent.name}</h3>
          {agent.role && <span className="ws-inspector-role">{agent.role}</span>}
        </div>
        <button
          type="button"
          className="ws-inspector-close"
          aria-label="Hide Agent details"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="ws-inspector-status" data-tone={descriptor.tone}>
        <span className="ws-inspector-status-glyph" aria-hidden="true">{descriptor.glyph}</span>
        <div>
          <strong>{descriptor.label}</strong>
          <span>{descriptor.detail}</span>
        </div>
      </div>

      {agent.activeTool && (
        <section className="ws-inspector-block">
          <h4>Running now</h4>
          <p className="ws-inspector-tool">
            <code>{agent.activeTool.toolId}</code>
          </p>
        </section>
      )}

      {!agent.activeTool && agent.sandboxActivity && (
        <section className="ws-inspector-block">
          <h4>Running now</h4>
          <p className="ws-inspector-tool">
            <code>{sandboxActivityLabel(agent.sandboxActivity)}</code>
          </p>
        </section>
      )}

      {agent.safeSummary && (
        <section className="ws-inspector-block">
          <h4>Latest safe summary</h4>
          {/* Agent output, so it goes through the one markdown renderer. */}
          <MarkdownMessage className="ws-inspector-summary" content={agent.safeSummary} />
        </section>
      )}

      <section className="ws-inspector-block ws-inspector-resource" aria-label="Model resource">
        <h4>Model resource</h4>
        {agent.modelResource ? (
          <>
            <div
              className="ws-inspector-resource-status"
              data-tone={modelResourceStatusTone(agent.modelResource.endpointStatus)}
              data-freshness={agent.modelResource.freshness}
            >
              <strong>{modelResourceStatusLabel(agent.modelResource.endpointStatus)}</strong>
              <span>{modelResourceObservedLabel(agent.modelResource)}</span>
            </div>
            <dl className="ws-inspector-facts">
              {modelResourceUsageRows(agent.modelResource).map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            {agent.modelResource.usage && (
              <p className="ws-inspector-muted">
                {modelResourceUsageScopeLabel(agent.modelResource)}; counters are not a quota.
              </p>
            )}
            {modelResourceRateLimitLabel(agent.modelResource) && (
              <p className="ws-inspector-muted">
                {modelResourceRateLimitLabel(agent.modelResource)}
              </p>
            )}
            {agent.modelResource.freshness !== "fresh" && (
              <p className="ws-inspector-muted">
                This is the last observed resource state; a newer check is not available yet.
              </p>
            )}
          </>
        ) : (
          <p className="ws-inspector-muted">
            {agent.modelAssigned
              ? "Live resource data is unavailable for this Agent's persisted model assignment."
              : "Select and save a worker model before this Agent can run."}
          </p>
        )}
      </section>

      {agent.metrics && (
        <section className="ws-inspector-block">
          <h4>Metrics</h4>
          <dl className="ws-inspector-facts">
            {metricsRows(agent.metrics).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          {agent.metrics.container ? (
            <div className="ws-inspector-sparklines">
              <UsageSparkline
                label="CPU"
                series={history.cpu.map((value, index) => ({ key: String(index), value }))}
                formatValue={formatPct}
              />
              <UsageSparkline
                label="Memory"
                series={history.mem.map((value, index) => ({ key: String(index), value }))}
                formatValue={formatBytes}
              />
            </div>
          ) : (
            <p className="ws-inspector-muted">No container metrics (local runner)</p>
          )}
        </section>
      )}

      {onAppearanceChange && agent.available && (
        <AgentSkinEditor
          agentId={agent.agentId}
          agentName={agent.name}
          appearance={agent.appearance}
          disabled={pending !== null}
          onChange={(appearance) => onAppearanceChange(agent.agentId, appearance)}
        />
      )}

      <dl className="ws-inspector-facts">
        <div>
          <dt>Runtime status</dt>
          <dd>{agent.lifecycle === "unknown" ? "Unavailable" : agent.lifecycle}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{agent.modelLabel ?? "Model assignment required"}</dd>
        </div>
        {projectName && (
          <div>
            <dt>Access preset</dt>
            <dd>Manage in Roles &amp; skills</dd>
          </div>
        )}
        <div>
          <dt>Current run</dt>
          <dd className="ws-inspector-mono">{agent.currentRunId ?? "None"}</dd>
        </div>
      </dl>

      <footer className="ws-inspector-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={onOpenConversation}
        >
          Open conversation
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={!agent.available}
          onClick={() => onOpenAgent(agent.agentId)}
        >
          Open Agent workspace
        </button>
        <button
          type="button"
          className={"button " + (stopped ? "button-primary" : "button-danger")}
          disabled={!agent.available || pending !== null}
          onClick={() => onLifecycle(agent.agentId, action)}
        >
          {pending === "start"
            ? "Starting…"
            : pending === "stop"
              ? "Stopping…"
              : stopped
                ? "Start Agent"
                : "Stop Agent"}
        </button>
      </footer>
    </aside>
  );
}
