import { useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import type { Agent } from "../../api/contracts";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import {
  EmptyState,
  ErrorState,
  InlineError,
  LoadingState,
} from "../../shared/ui/states";
import { formatDateTime, relativeTime } from "../../shared/utils/format";

function agentName(agents: Agent[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id;
}

export function ProjectDetail() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const projectFetcher = useCallback(
    () => api.getProject(projectId),
    [projectId],
  );
  const project = usePolledResource(
    `project:${projectId}`,
    projectFetcher,
    { intervalMs: 10000, enabled: projectId !== "" },
  );

  const agentsFetcher = useCallback(() => api.listAgents(), []);
  const agents = usePolledResource("project-detail:agents", agentsFetcher, {
    intervalMs: 30000,
  });

  const orchFetcher = useCallback(
    () => api.listOrchestrations({ projectId, limit: 50 }),
    [projectId],
  );
  const orchestrations = usePolledResource(
    `project:${projectId}:orch`,
    orchFetcher,
    { intervalMs: 5000, enabled: projectId !== "" },
  );

  if (project.loading) {
    return (
      <div className="page">
        <LoadingState label="Loading project…" />
      </div>
    );
  }
  if (project.error || !project.data) {
    return (
      <div className="page">
        <PageHeader title="Project" />
        <ErrorState
          message={project.error ?? "Project not found."}
          status={project.status}
          onRetry={project.refetch}
        />
      </div>
    );
  }

  const p = project.data.project;
  const agentList = agents.data?.agents ?? [];
  const roleRows = [
    { label: "Planner", id: p.roles.plannerAgentId, sandbox: "read-only" },
    { label: "Builder", id: p.roles.builderAgentId, sandbox: "workspace-write" },
    { label: "Reviewer", id: p.roles.reviewerAgentId, sandbox: "read-only" },
  ];
  const orchItems = orchestrations.data?.items ?? [];

  const archive = async () => {
    if (
      !window.confirm(
        `Archive "${p.name}"? Its shared workspace is archived and the project becomes read-only.`,
      )
    ) {
      return;
    }
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      await api.archiveProject(p.id);
      project.refetch();
    } catch (reason) {
      setArchiveError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title={p.name}
        lead={p.description || "Fixed Planner → Builder → Reviewer pipeline."}
        meta={
          <p className="breadcrumb">
            <Link to="/projects" className="text-link">
              Projects
            </Link>
            <span aria-hidden="true"> / </span>
            {p.name}
          </p>
        }
        actions={
          <div className="page-header-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() =>
                navigate(`/orchestrations?new=1&projectId=${p.id}`)
              }
              disabled={p.status === "archived"}
            >
              New orchestration
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={archive}
              disabled={archiveBusy || p.status === "archived"}
            >
              {archiveBusy ? "Archiving…" : "Archive project"}
            </button>
          </div>
        }
      />

      {archiveError ? <InlineError message={archiveError} /> : null}

      <section className="panel">
        <h2>Workspace</h2>
        <dl className="detail-grid">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusPill status={p.status} />
            </dd>
          </div>
          <div>
            <dt>Shared workspace path</dt>
            <dd>
              <code>{p.workspacePath}</code>
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDateTime(p.createdAt)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDateTime(p.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>Role assignments</h2>
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Assigned agents by role</caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Agent</th>
                <th scope="col">Sandbox</th>
              </tr>
            </thead>
            <tbody>
              {roleRows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>
                    <Link
                      to={`/agents/${row.id}`}
                      className="text-link"
                    >
                      {agentName(agentList, row.id)}
                    </Link>
                  </td>
                  <td>
                    <span className="tag">{row.sandbox}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Orchestrations</h2>
        {orchestrations.loading ? (
          <LoadingState label="Loading orchestrations…" />
        ) : orchestrations.error ? (
          <ErrorState
            message={orchestrations.error}
            status={orchestrations.status}
            onRetry={orchestrations.refetch}
          />
        ) : orchItems.length === 0 ? (
          <EmptyState
            title="No orchestrations for this project"
            hint="Submit one to see the fixed stage progression."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">
                Orchestrations for this project
              </caption>
              <thead>
                <tr>
                  <th scope="col">Seq</th>
                  <th scope="col">Prompt</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {orchItems.map((o) => (
                  <tr key={o.id}>
                    <td>#{o.sequence}</td>
                    <th scope="row">
                      <Link
                        to={`/orchestrations/${o.id}`}
                        className="text-link"
                      >
                        {o.prompt.length > 80
                          ? `${o.prompt.slice(0, 80)}…`
                          : o.prompt}
                      </Link>
                    </th>
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
        )}
      </section>
    </div>
  );
}
