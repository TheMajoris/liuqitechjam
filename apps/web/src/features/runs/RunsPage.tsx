import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import type { RunStatus } from "../../api/contracts";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import { EmptyState, ErrorState, LoadingState } from "../../shared/ui/states";
import { durationBetween, relativeTime } from "../../shared/utils/format";
import { RunInspector } from "./RunInspector";

const STATUSES: RunStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
];

export function RunsPage() {
  const [params, setParams] = useSearchParams();

  const agentId = params.get("agentId") ?? "";
  const projectId = params.get("projectId") ?? "";
  const orchestrationId = params.get("orchestrationId") ?? "";
  const statusFilter = params.get("status") ?? "";
  const cursor = params.get("cursor") ?? "";
  const selectedRun = params.get("run") ?? "";

  const patchParams = (next: Record<string, string | null>) => {
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    setParams(params, { replace: true });
  };

  const listKey = `runs:${agentId}:${projectId}:${orchestrationId}:${statusFilter}:${cursor}`;
  const listFetcher = useCallback(
    () =>
      api.listRuns({
        agentId: agentId || undefined,
        projectId: projectId || undefined,
        orchestrationId: orchestrationId || undefined,
        status: statusFilter || undefined,
        cursor: cursor || undefined,
        limit: 25,
      }),
    [agentId, projectId, orchestrationId, statusFilter, cursor],
  );
  const list = usePolledResource(listKey, listFetcher, { intervalMs: 3000 });

  const agentsFetcher = useCallback(() => api.listAgents(), []);
  const agents = usePolledResource("runs:agents", agentsFetcher, {
    intervalMs: 30000,
  });
  const projectsFetcher = useCallback(() => api.listProjects(), []);
  const projects = usePolledResource("runs:projects", projectsFetcher, {
    intervalMs: 30000,
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const agentName = (id: string) =>
    agents.data?.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  const hasFilters =
    agentId || projectId || orchestrationId || statusFilter || cursor;

  return (
    <div className="page">
      <PageHeader
        title="Runs"
        lead="Every stage and Playground turn produces a run. Select one to open the Run Inspector."
      />

      <div className={`runs-layout${selectedRun ? " has-inspector" : ""}`}>
        <div className="runs-main">
          <div className="filter-bar" role="group" aria-label="Run filters">
            <label className="field field-compact">
              <span className="sr-only">Filter by agent</span>
              <select
                value={agentId}
                onChange={(e) =>
                  patchParams({ agentId: e.target.value || null, cursor: null })
                }
              >
                <option value="">All agents</option>
                {(agents.data?.agents ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-compact">
              <span className="sr-only">Filter by project</span>
              <select
                value={projectId}
                onChange={(e) =>
                  patchParams({
                    projectId: e.target.value || null,
                    cursor: null,
                  })
                }
              >
                <option value="">All projects</option>
                {(projects.data?.projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-compact">
              <span className="sr-only">Filter by status</span>
              <select
                value={statusFilter}
                onChange={(e) =>
                  patchParams({ status: e.target.value || null, cursor: null })
                }
              >
                <option value="">All statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            {orchestrationId ? (
              <span className="tag">
                orchestration {orchestrationId.slice(0, 8)}
              </span>
            ) : null}
            {hasFilters ? (
              <button
                type="button"
                className="button button-ghost"
                onClick={() =>
                  patchParams({
                    agentId: null,
                    projectId: null,
                    orchestrationId: null,
                    status: null,
                    cursor: null,
                  })
                }
              >
                Clear
              </button>
            ) : null}
          </div>

          {list.loading ? (
            <LoadingState label="Loading runs…" />
          ) : list.error ? (
            <ErrorState
              message={list.error}
              status={list.status}
              onRetry={list.refetch}
            />
          ) : items.length === 0 ? (
            <EmptyState
              title="No runs match"
              hint="Adjust the filters, or start a Playground turn or an orchestration."
            />
          ) : (
            <>
              <div className="table-scroll">
                <table className="data-table is-selectable">
                  <caption className="sr-only">Runs</caption>
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">Agent</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Status</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((run) => (
                      <tr
                        key={run.id}
                        aria-selected={run.id === selectedRun}
                        className={
                          run.id === selectedRun ? "row-selected" : undefined
                        }
                      >
                        <th scope="row">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => patchParams({ run: run.id })}
                          >
                            <code>{run.id.slice(0, 8)}</code>
                          </button>
                        </th>
                        <td>{agentName(run.agentId)}</td>
                        <td>{run.stage ?? "—"}</td>
                        <td>
                          <StatusPill status={run.status} />
                        </td>
                        <td>
                          {durationBetween(run.startedAt, run.completedAt)}
                        </td>
                        <td>{relativeTime(run.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => patchParams({ cursor: null })}
                  disabled={!cursor}
                >
                  Back to start
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() =>
                    patchParams({ cursor: list.data?.nextCursor ?? null })
                  }
                  disabled={!list.data?.nextCursor}
                >
                  Next page
                </button>
              </div>
            </>
          )}
        </div>

        {selectedRun ? (
          <RunInspector
            runId={selectedRun}
            onClose={() => patchParams({ run: null })}
          />
        ) : null}
      </div>
    </div>
  );
}
