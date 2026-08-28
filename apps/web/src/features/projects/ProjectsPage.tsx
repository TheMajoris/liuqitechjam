import { useCallback } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import type { Agent, Orchestration } from "../../api/contracts";
import { usePolledResource } from "../../shared/hooks/usePolledResource";
import { PageHeader } from "../../shared/ui/PageHeader";
import { StatusPill } from "../../shared/ui/StatusPill";
import { EmptyState, ErrorState, LoadingState } from "../../shared/ui/states";
import { relativeTime } from "../../shared/utils/format";
import { CreateProjectForm } from "./CreateProjectForm";

function agentName(agents: Agent[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? "unknown agent";
}

export function ProjectsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const creating = params.get("new") === "1";

  const projectsFetcher = useCallback(() => api.listProjects(), []);
  const projects = usePolledResource("projects", projectsFetcher, {
    intervalMs: 10000,
  });

  const agentsFetcher = useCallback(() => api.listAgents(), []);
  const agents = usePolledResource("projects:agents", agentsFetcher, {
    intervalMs: 30000,
  });

  const orchFetcher = useCallback(
    () => api.listOrchestrations({ limit: 100 }),
    [],
  );
  const orchestrations = usePolledResource("projects:orch", orchFetcher, {
    intervalMs: 8000,
  });

  const latestByProject = new Map<string, Orchestration>();
  for (const item of orchestrations.data?.items ?? []) {
    const existing = latestByProject.get(item.projectId);
    if (!existing || item.sequence > existing.sequence) {
      latestByProject.set(item.projectId, item);
    }
  }

  const rows = projects.data?.projects ?? [];
  const agentList = agents.data?.agents ?? [];

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
        title="Projects"
        lead="Each project assigns Planner, Builder and Reviewer agents to the fixed pipeline and owns one shared workspace."
        actions={
          <button
            type="button"
            className="button button-primary"
            onClick={openCreate}
            disabled={creating}
          >
            New project
          </button>
        }
      />

      {creating ? (
        agents.loading ? (
          <LoadingState label="Loading agents…" />
        ) : (
          <CreateProjectForm
            agents={agentList}
            onCancel={closeCreate}
            onCreated={(project) => {
              closeCreate();
              projects.refetch();
              navigate(`/projects/${project.id}`);
            }}
          />
        )
      ) : null}

      {projects.loading ? (
        <LoadingState label="Loading projects…" />
      ) : projects.error ? (
        <ErrorState
          message={projects.error}
          status={projects.status}
          onRetry={projects.refetch}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No projects yet"
          hint="Create a project to run Planner → Builder → Reviewer over a shared workspace."
          action={
            !creating ? (
              <button
                type="button"
                className="button button-primary"
                onClick={openCreate}
              >
                New project
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">Project catalog</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Workspace</th>
                <th scope="col">Planner</th>
                <th scope="col">Builder</th>
                <th scope="col">Reviewer</th>
                <th scope="col">Latest orchestration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((project) => {
                const latest = latestByProject.get(project.id);
                return (
                  <tr key={project.id}>
                    <th scope="row">
                      <Link
                        to={`/projects/${project.id}`}
                        className="text-link"
                      >
                        {project.name}
                      </Link>
                      {project.description ? (
                        <span className="cell-sub">{project.description}</span>
                      ) : null}
                    </th>
                    <td>
                      <StatusPill status={project.status} />
                    </td>
                    <td>{agentName(agentList, project.roles.plannerAgentId)}</td>
                    <td>{agentName(agentList, project.roles.builderAgentId)}</td>
                    <td>
                      {agentName(agentList, project.roles.reviewerAgentId)}
                    </td>
                    <td>
                      {latest ? (
                        <Link
                          to={`/orchestrations/${latest.id}`}
                          className="cell-inline-link"
                        >
                          <StatusPill status={latest.status} />
                          <span className="cell-sub">
                            {relativeTime(latest.updatedAt)}
                          </span>
                        </Link>
                      ) : orchestrations.loading ? (
                        "…"
                      ) : (
                        <span className="cell-muted">none yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
