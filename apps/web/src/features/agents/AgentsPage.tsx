import { useCallback } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import { EmptyState, ErrorState, LoadingState } from "../../shared/ui/states";
import { relativeTime } from "../../shared/utils/format";
import { CreateAgentForm } from "./CreateAgentForm";

export function AgentsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const creating = params.get("new") === "1";

  const fetcher = useCallback(() => api.listAgents(), []);
  const { data, error, loading, status, refetch } = usePolledResource(
    "agents",
    fetcher,
    { intervalMs: 5000 },
  );
  const agents = data?.agents ?? [];

  const openCreate = () => {
    params.set("new", "1");
    setParams(params, { replace: true });
  };
  const closeCreate = () => {
    params.delete("new");
    setParams(params, { replace: true });
  };

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        lead="Codex agents in isolated workspaces. Open an agent to manage its lifecycle and use the Playground."
        actions={
          <button
            type="button"
            className="button button-primary"
            onClick={openCreate}
          >
            Create agent
          </button>
        }
      />

      {creating ? (
        <CreateAgentForm
          onClose={closeCreate}
          onCreated={(agent) => {
            closeCreate();
            refetch();
            navigate(`/agents/${agent.id}`);
          }}
        />
      ) : null}

      {loading ? (
        <LoadingState label="Loading agents…" />
      ) : error ? (
        <ErrorState message={error} status={status} onRetry={refetch} />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          hint="Create your first coding agent to get started."
          action={
            <button
              type="button"
              className="button button-primary"
              onClick={openCreate}
            >
              Create agent
            </button>
          }
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Agent catalog</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Status</th>
                <th scope="col">Session</th>
                <th scope="col">Workspace</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <th scope="row">
                    <Link to={`/agents/${agent.id}`} className="text-link">
                      {agent.name}
                    </Link>
                    {agent.description ? (
                      <span className="cell-sub">{agent.description}</span>
                    ) : null}
                  </th>
                  <td>
                    <StatusPill status={agent.status} />
                  </td>
                  <td>
                    {agent.codexThreadId ? "connected" : "new session"}
                  </td>
                  <td>
                    <code>{agent.workspacePath}</code>
                  </td>
                  <td>{relativeTime(agent.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
