import { useEffect, useState } from "react";
import { api } from "../api";
import type { Agent, AgentCapabilities, ToolCapabilityView } from "../types";

function availabilityLabel(value: ToolCapabilityView["availability"]): string {
  if (value === "approval_required") return "Approval required";
  if (value === "available") return "Available";
  return "Unavailable";
}

/** Compact backend-authoritative capability projection for one Agent. */
export function CapabilitiesPanel({ agent }: { agent: Agent }) {
  const [projectId, setProjectId] = useState("");
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .agentCapabilities(agent.id, projectId.trim() || undefined)
      .then(({ capabilities: next }) => {
        if (active) setCapabilities(next);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agent.id, projectId]);

  const testTool = async (tool: ToolCapabilityView) => {
    setTesting(tool.tool.id);
    setTestMessage(null);
    try {
      await api.testTool(tool.tool.id, {
        agentId: agent.id,
        ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
        input: tool.tool.id === "web.search" ? { query: "Launchpad" } : {},
      });
      setTestMessage(tool.tool.title + " completed.");
    } catch (reason) {
      setTestMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(null);
    }
  };

  return (
    <section className="capabilities-panel" aria-labelledby="capabilities-heading">
      <div className="capabilities-title">
        <div>
          <span className="eyebrow">Platform capabilities</span>
          <h3 id="capabilities-heading">Tools available to this Agent</h3>
        </div>
        {loading && <span className="capabilities-loading">Refreshing…</span>}
      </div>
      <label className="capabilities-project-field">
        Workspace scope (optional)
        <input
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="Paste a Workspace ID to inspect delegated tools"
          aria-describedby="capabilities-note"
        />
      </label>
      <p id="capabilities-note" className="capabilities-note">
        State is resolved by the server. MCP runs authenticate as the Agent; this panel&apos;s test
        action uses the human control-plane identity.
      </p>
      {error && <p className="capabilities-error" role="alert">{error}</p>}
      {testMessage && <p className="capabilities-result" role="status">{testMessage}</p>}
      <div className="capabilities-list">
        {capabilities?.tools.map((tool) => (
          <div className="capability-row" key={tool.tool.id}>
            <div className="capability-copy">
              <strong>{tool.tool.title}</strong>
              <span>{tool.tool.description}</span>
              <code>{tool.tool.id} · {tool.tool.risk}</code>
            </div>
            <div className="capability-actions">
              <span className={"capability-state capability-state-" + tool.availability}>
                {availabilityLabel(tool.availability)}
              </span>
              {tool.grant && (
                <small>
                  {tool.grant.scope === "once" ? "One-time grant" : "Workspace grant"}
                </small>
              )}
              {tool.availability === "available" && projectId.trim() && (
                <button
                  type="button"
                  className="button button-ghost capability-test"
                  disabled={testing !== null}
                  onClick={() => void testTool(tool)}
                >
                  {testing === tool.tool.id ? "Testing…" : "Test"}
                </button>
              )}
            </div>
          </div>
        ))}
        {!loading && !capabilities && <span className="capabilities-empty">No capability state yet.</span>}
      </div>
    </section>
  );
}
