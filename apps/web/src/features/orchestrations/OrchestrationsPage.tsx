import { useCallback, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import type { OrchestrationStatus } from "../../api/contracts";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import { EmptyState, ErrorState, LoadingState } from "../../shared/ui/states";
import { relativeTime } from "../../shared/utils/format";
import { SubmitOrchestrationForm } from "./SubmitOrchestrationForm";

const STATUS_FILTERS: OrchestrationStatus[] = [
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

const NON_TERMINAL = new Set(["queued", "running", "blocked"]);

export function OrchestrationsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const statusFilter = params.get("status") ?? "";
  const projectFilter = params.get("projectId") ?? "";
  const cursor = params.get("cursor") ?? "";
  const creating = params.get("new") === "1";

  const patchParams = (next: Record<string, string | null>) => {
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    setParams(params, { replace: true });
  };

  const listKey = `orch:${statusFilter}:${projectFilter}:${cursor}`;
  const listFetcher = useCallback(
    () =>
      api.listOrchestrations({
        status: statusFilter || undefined,
        projectId: projectFilter || undefined,
        cursor: cursor || undefined,
        limit: 25,
      }),
    [statusFilter, projectFilter, cursor],
  );
  const list = usePolledResource(listKey, listFetcher, { intervalMs: 2500 });

  const projectsFetcher = useCallback(() => api.listProjects(), []);
  const projects = usePolledResource("orch:projects", projectsFetcher, {
    intervalMs: 30000,
  });

  const providersFetcher = useCallback(() => api.listProviders(), []);
  const providers = usePolledResource("orch:providers", providersFetcher, {
    intervalMs: 30000,
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const projectName = (id: string) =>
    projects.data?.projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const queue = useMemo(
    () =>
      [...items]
        .filter((o) => NON_TERMINAL.has(o.status))
        .sort((a, b) => a.sequence - b.sequence),
    [items],
  );

  return (
    <div className="page">
      <PageHeader
        title="Orchestrations"
        lead="Global FIFO queue. One orchestration completes its fixed stages before the next begins."
        actions={
          <button
            type="button"
            className="button button-primary"
            onClick={() => patchParams({ new: "1" })}
            disabled={creating}
          >
            New orchestration
          </button>
        }
      />

      {creating ? (
        projects.loading || providers.loading ? (
          <LoadingState label="Loading form data…" />
        ) : (
          <SubmitOrchestrationForm
            projects={projects.data?.projects ?? []}
            providers={providers.data?.providers ?? []}
            defaultProjectId={projectFilter || undefined}
            onCancel={() => patchParams({ new: null })}
            onSubmitted={(orch) => {
              patchParams({ new: null });
              list.refetch();
              navigate(`/orchestrations/${orch.id}`);
            }}
          />
        )
      ) : null}

      <section className="panel" aria-label="Queue">
        <h2>Queue</h2>
        {list.loading ? (
          <LoadingState label="Loading queue…" />
        ) : queue.length === 0 ? (
          <p className="cell-muted">Nothing queued or running right now.</p>
        ) : (
          <ol className="queue-list">
            {queue.map((o, index) => (
              <li key={o.id} className="queue-row">
                <span className="queue-pos" aria-hidden="true">
                  {o.status === "running" ? "▶" : `#${index}`}
                </span>
                <Link
                  to={`/orchestrations/${o.id}`}
                  className="text-link queue-prompt"
                >
                  {o.prompt.length > 90
                    ? `${o.prompt.slice(0, 90)}…`
                    : o.prompt}
                </Link>
                <span className="queue-project">{projectName(o.projectId)}</span>
                <StatusPill status={o.status} />
                <span className="queue-meta">
                  {o.status === "running"
                    ? "in flight"
                    : `position ${index}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel">
        <div className="panel-head-row">
          <h2>History</h2>
          <div className="filter-bar" role="group" aria-label="Filters">
            <label className="field field-compact">
              <span className="sr-only">Filter by status</span>
              <select
                value={statusFilter}
                onChange={(e) =>
                  patchParams({ status: e.target.value || null, cursor: null })
                }
              >
                <option value="">All statuses</option>
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-compact">
              <span className="sr-only">Filter by project</span>
              <select
                value={projectFilter}
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
            {(statusFilter || projectFilter || cursor) && (
              <button
                type="button"
                className="button button-ghost"
                onClick={() =>
                  patchParams({ status: null, projectId: null, cursor: null })
                }
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {list.loading ? (
          <LoadingState label="Loading orchestrations…" />
        ) : list.error ? (
          <ErrorState
            message={list.error}
            status={list.status}
            onRetry={list.refetch}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="No orchestrations match"
            hint="Adjust the filters or submit a new orchestration."
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">Orchestration history</caption>
                <thead>
                  <tr>
                    <th scope="col">Seq</th>
                    <th scope="col">Prompt</th>
                    <th scope="col">Project</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Status</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((o) => (
                    <tr key={o.id}>
                      <td>#{o.sequence}</td>
                      <th scope="row">
                        <Link
                          to={`/orchestrations/${o.id}`}
                          className="text-link"
                        >
                          {o.prompt.length > 70
                            ? `${o.prompt.slice(0, 70)}…`
                            : o.prompt}
                        </Link>
                      </th>
                      <td>
                        <Link
                          to={`/projects/${o.projectId}`}
                          className="text-link"
                        >
                          {projectName(o.projectId)}
                        </Link>
                      </td>
                      <td>
                        <code>{o.providerId}</code>
                      </td>
                      <td>
                        <StatusPill status={o.status} />
                      </td>
                      <td>{relativeTime(o.updatedAt)}</td>
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
      </section>
    </div>
  );
}
