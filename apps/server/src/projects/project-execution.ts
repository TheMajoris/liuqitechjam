import type { AgentPreviewStatus } from "../preview/preview-context-provider.js";
import type { Agent } from "../types.js";
import type { ProjectService } from "./project-service.js";

/** Everything a Project-scoped turn needs, resolved at the runtime boundary. */
export interface ProjectRunBinding {
  projectId: string;
  projectName: string;
  /** Backend-derived mount target for the shared workspace. */
  workspacePath: string;
  /** Thread for this (Agent, Project) pair, never the Agent's private one. */
  codexThreadId: string | null;
  previewStatus: AgentPreviewStatus;
}

/**
 * Narrow seam through which AgentService scopes a run to a shared Project.
 *
 * AgentService depends on this interface rather than on ProjectService, so
 * the two never form a cycle and orchestration cannot reach the filesystem
 * except through a normal Agent run.
 */
export interface ProjectExecutionScope {
  /** Throws unless this Agent may currently run against this Project. */
  assertRunnable(projectId: string, agentId: string): void | Promise<void>;
  /**
   * Takes the single-writer lease and prepares the shared workspace for the
   * acting Agent. Callers must pair this with `endTurn` in a `finally`.
   */
  beginTurn(agent: Agent, projectId: string, runId: string): Promise<ProjectRunBinding>;
  /**
   * Releases the lease, and persists the resumed thread only when the turn
   * actually completed. Safe to call on every path, including cancellation.
   */
  endTurn(
    projectId: string,
    agentId: string,
    runId: string,
    outcome: { codexThreadId: string | null } | null,
  ): Promise<void>;
}

/** Reads the Project-owned preview status for read-only runtime context. */
export type ProjectPreviewStatusReader = (
  projectId: string,
) => Promise<AgentPreviewStatus> | AgentPreviewStatus;

/**
 * Binds AgentService to ProjectService.
 *
 * Every filesystem and lease decision stays inside ProjectService; this
 * adapter only translates between the two vocabularies.
 */
export class ProjectServiceExecutionScope implements ProjectExecutionScope {
  constructor(
    private readonly projects: ProjectService,
    private readonly previewStatus: ProjectPreviewStatusReader = () => "not_started",
  ) {}

  async assertRunnable(projectId: string, agentId: string): Promise<void> {
    await this.projects.authorizeAgentExecution(projectId, agentId);
  }

  async beginTurn(
    agent: Agent,
    projectId: string,
    runId: string,
  ): Promise<ProjectRunBinding> {
    // This check is deliberately before the lease mutation. A denied or
    // revoked Agent must never occupy the Project's single-writer slot.
    await this.projects.authorizeAgentExecution(projectId, agent.id);
    // Lease first: preparing the workspace writes AGENTS.md, which must never
    // race another Agent's turn.
    await this.projects.acquireWriteLease(projectId, agent.id, runId, {
      principal: { kind: "agent", id: agent.id },
    });
    try {
      const scope = this.projects.projectRunScope(projectId, agent.id);
      // The role may have changed while waiting for the single-writer lease.
      // Recheck before writing AGENTS.md so a revoked Agent never changes the
      // shared workspace.
      await this.projects.authorizeAgentExecution(projectId, agent.id);
      await this.projects.prepareTurn(scope.project, agent);
      return {
        projectId,
        projectName: scope.project.name,
        workspacePath: scope.workspacePath,
        codexThreadId: scope.codexThreadId,
        previewStatus: await this.previewStatus(projectId),
      };
    } catch (error) {
      await this.projects.releaseWriteLease(projectId, runId);
      throw error;
    }
  }

  async endTurn(
    projectId: string,
    agentId: string,
    runId: string,
    outcome: { codexThreadId: string | null } | null,
  ): Promise<void> {
    try {
      if (outcome) {
        await this.projects.recordProjectThread(projectId, agentId, outcome.codexThreadId);
      }
    } finally {
      await this.projects.releaseWriteLease(projectId, runId);
    }
  }
}

/**
 * Trusted Project metadata for the worker prompt.
 *
 * Deliberately excludes the host workspace path: the mount itself gives the
 * Agent access, so no Agent ever needs to be told where the files live.
 */
export function projectRuntimeContextLines(binding: ProjectRunBinding): string[] {
  return [
    `project.name = ${JSON.stringify(binding.projectName)}`,
    'project.workspace_scope = "shared_project"',
    'project.collaboration = "other Team Agents may edit these same files between your turns"',
    `project_preview.status = ${JSON.stringify(binding.previewStatus)}`,
  ];
}
