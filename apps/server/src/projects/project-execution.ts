import type { AgentPreviewStatus } from "../preview/preview-context-provider.js";
import type { Agent, OperationOptions } from "../types.js";
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
  assertRunnable(
    projectId: string,
    agentId: string,
    operation?: OperationOptions,
  ): void | Promise<void>;
  /**
   * Takes the single-writer lease and prepares the shared workspace for the
   * acting Agent. Callers must pair this with `endTurn` in a `finally`.
   */
  beginTurn(
    agent: Agent,
    projectId: string,
    runId: string,
    operation?: OperationOptions,
  ): Promise<ProjectRunBinding>;
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
  /**
   * Reserves every Project owned by an Agent while its membership and lease
   * records are removed or restored. Optional keeps lightweight test/runtime
   * scopes source-compatible; production ProjectService supplies it.
   */
  beginAgentDeletion?(agentId: string): () => void;
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

  beginAgentDeletion(agentId: string): () => void {
    return this.projects.beginAgentDeletion(agentId);
  }

  async assertRunnable(
    projectId: string,
    agentId: string,
    operation: OperationOptions = {},
  ): Promise<void> {
    assertOperationActive(operation);
    await this.projects.authorizeAgentExecution(projectId, agentId);
    assertOperationActive(operation);
  }

  async beginTurn(
    agent: Agent,
    projectId: string,
    runId: string,
    operation: OperationOptions = {},
  ): Promise<ProjectRunBinding> {
    assertOperationActive(operation);
    // This check is deliberately before the lease mutation. A denied or
    // revoked Agent must never occupy the Project's single-writer slot.
    await this.projects.authorizeAgentExecution(projectId, agent.id);
    // Lease first: preparing the workspace writes AGENTS.md, which must never
    // race another Agent's turn.
    await this.projects.acquireWriteLease(projectId, agent.id, runId, {
      principal: { kind: "agent", id: agent.id },
      ...(operation.signal === undefined ? {} : { signal: operation.signal }),
      ...(operation.deadlineAt === undefined ? {} : { deadlineAt: operation.deadlineAt }),
    });
    try {
      assertOperationActive(operation);
      const scope = this.projects.projectRunScope(projectId, agent.id);
      // The role may have changed while waiting for the single-writer lease.
      // Recheck before writing AGENTS.md so a revoked Agent never changes the
      // shared workspace.
      await this.projects.authorizeAgentExecution(projectId, agent.id);
      assertOperationActive(operation);
      await this.projects.prepareTurn(scope.project, agent, operation);
      assertOperationActive(operation);
      const currentPreviewStatus = await this.previewStatus(projectId);
      assertOperationActive(operation);
      return {
        projectId,
        projectName: scope.project.name,
        workspacePath: scope.workspacePath,
        codexThreadId: scope.codexThreadId,
        previewStatus: currentPreviewStatus,
      };
    } catch (error) {
      // Preparation never dispatched a worker, so the lease owner is known
      // settled and may use the bounded idempotent release retry.
      await this.projects
        .releaseWriteLease(projectId, runId, { settled: true })
        .catch(() => undefined);
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
      // AgentRunCoordinator enters endTurn only after a terminal Run fact is
      // committed and the worker has settled. This is the sole path allowed
      // to use the two-attempt idempotent release budget.
      await this.projects.releaseWriteLease(projectId, runId, { settled: true });
    }
  }
}

function assertOperationActive(operation: OperationOptions): void {
  if (operation.signal?.aborted) {
    const reason = operation.signal.reason;
    if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
      throw reason;
    }
    const error = new Error("Project turn was aborted");
    error.name = "AbortError";
    throw error;
  }
  if (
    operation.deadlineAt !== undefined &&
    Number.isFinite(operation.deadlineAt) &&
    Date.now() >= operation.deadlineAt
  ) {
    const error = new Error("Project turn timed out");
    error.name = "TimeoutError";
    throw error;
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
