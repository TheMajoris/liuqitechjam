import { useCallback, useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { api } from "../../api/client";
import type { SystemInfo } from "../../api/contracts";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import {
  ErrorState,
  InlineError,
  LoadingState,
} from "../../shared/ui/states";
import { formatDateTime } from "../../shared/utils/format";
import { Playground } from "./Playground";

export function AgentDetail() {
  const { agentId = "" } = useParams();
  const navigate = useNavigate();
  const system = useOutletContext<SystemInfo | null>();

  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    description: "",
    instructions: "",
  });

  const fetcher = useCallback(() => api.getAgent(agentId), [agentId]);
  const { data, error, loading, status, refetch } = usePolledResource(
    `agent:${agentId}`,
    fetcher,
    { intervalMs: 3000, enabled: agentId !== "" },
  );
  const agent = data?.agent ?? null;

  useEffect(() => {
    if (agent) {
      setForm({
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
      });
    }
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="page">
        <LoadingState label="Loading agent…" />
      </div>
    );
  }
  if (error || !agent) {
    return (
      <div className="page">
        <PageHeader title="Agent" />
        <ErrorState
          message={error ?? "Agent not found."}
          status={status}
          onRetry={refetch}
        />
      </div>
    );
  }

  const runLifecycle = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      refetch();
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = () =>
    runLifecycle(() =>
      agent.status === "stopped"
        ? api.startAgent(agent.id)
        : api.stopAgent(agent.id),
    );

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    await runLifecycle(async () => {
      await api.updateAgent(agent.id, form);
      setShowSettings(false);
    });
  };

  const remove = async () => {
    if (
      !window.confirm(
        `Delete "${agent.name}"? Its workspace is archived.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteAgent(agent.id);
      navigate("/agents");
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : String(reason),
      );
      setBusy(false);
    }
  };

  const configWarning =
    system && (!system.arkConfigured || !system.codexAvailable)
      ? !system.arkConfigured
        ? "Set ARK_API_KEY and ARK_MODEL before using the Playground."
        : "Codex CLI or the runtime image is unavailable."
      : null;

  return (
    <div className="page">
      <PageHeader
        title={agent.name}
        lead={
          agent.description || "A Codex coding agent in an isolated workspace."
        }
        meta={
          <p className="breadcrumb">
            <Link to="/agents" className="text-link">
              Agents
            </Link>
            <span aria-hidden="true"> / </span>
            {agent.name}
          </p>
        }
        actions={
          <div className="page-header-actions">
            <StatusPill status={agent.status} />
            <button
              type="button"
              className="button button-ghost"
              onClick={() => setShowSettings((v) => !v)}
              disabled={busy || agent.status === "busy"}
              aria-expanded={showSettings}
            >
              Settings
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={toggle}
              disabled={busy}
            >
              {agent.status === "stopped" ? "Start" : "Stop"}
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={remove}
              disabled={busy || agent.status === "busy"}
            >
              Delete
            </button>
          </div>
        }
      />

      {actionError ? <InlineError message={actionError} /> : null}
      {configWarning ? (
        <div className="degraded-banner" role="status">
          <span className="degraded-dot" aria-hidden="true" />
          <span>{configWarning}</span>
        </div>
      ) : null}

      {showSettings ? (
        <form className="panel form-panel" onSubmit={saveSettings}>
          <h2>Instructions and identity</h2>
          <div className="field-row">
            <label className="field">
              <span>Name</span>
              <input
                value={form.name}
                onChange={(e) =>
                  setForm({ ...form, name: e.target.value })
                }
                maxLength={80}
                required
              />
            </label>
            <label className="field">
              <span>Description</span>
              <input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                maxLength={500}
              />
            </label>
          </div>
          <label className="field">
            <span>System instructions</span>
            <textarea
              value={form.instructions}
              onChange={(e) =>
                setForm({ ...form, instructions: e.target.value })
              }
              rows={5}
              maxLength={10000}
            />
          </label>
          <div className="panel-actions">
            <code>{agent.workspacePath}</code>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy}
            >
              Save changes
            </button>
          </div>
        </form>
      ) : null}

      <section className="panel">
        <h2>Details</h2>
        <dl className="detail-grid">
          <div>
            <dt>Workspace</dt>
            <dd>
              <code>{agent.workspacePath}</code>
            </dd>
          </div>
          <div>
            <dt>Codex session</dt>
            <dd>
              {agent.codexThreadId ? (
                <code>{agent.codexThreadId}</code>
              ) : (
                "new session"
              )}
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDateTime(agent.createdAt)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDateTime(agent.updatedAt)}</dd>
          </div>
        </dl>
        {agent.lastError ? (
          <p className="inline-error">{agent.lastError}</p>
        ) : null}
        <p className="fine-print">
          <Link to={`/runs?agentId=${agent.id}`} className="text-link">
            View this agent&apos;s runs in the Run Inspector →
          </Link>
        </p>
      </section>

      <Playground agent={agent} system={system} onRunSettled={refetch} />
    </div>
  );
}
