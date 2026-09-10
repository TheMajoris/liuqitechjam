import type { AgentPreviewStatus } from "../preview/preview-context-provider.js";
import type { Agent, Database, OperationOptions } from "../types.js";
import type { ProjectService } from "./project-service.js";
import type { WorkspaceExecutionContext } from "./workspace-checkpoint-types.js";

/**
 * How the coordinator decides that the worker can no longer write. Container
 * execution proves it; local-process execution can only trust the child exit
 * and is admitted solely under an explicit development override.
 */
export type WorkspaceSettlementPolicy = "require_proof" | "trust_process_exit";

/** Trusted checkpoint identity carried through one Project turn. */
export interface ProjectRunWorkspaceBinding extends WorkspaceExecutionContext {
  settlementPolicy: WorkspaceSettlementPolicy;
}

/** Everything a Project-scoped turn needs, resolved at the runtime boundary. */
export interface ProjectRunBinding {
  projectId: string;
  projectName: string;
  /** Backend-derived mount target for the shared workspace. */
  workspacePath: string;
  /**
   * Thread for this (Agent, Project) pair in this turn's scope, never the
   * Agent's private one and never another orchestration's.
   */
  codexThreadId: string | null;
  previewStatus: AgentPreviewStatus;
  /** Present only for a checkpoint-enabled cycle turn. */
  workspace?: ProjectRunWorkspaceBinding | undefined;
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
    workspace?: WorkspaceExecutionContext,
  ): void | Promise<void>;
  /**
   * Synchronous reservation/epoch recheck inside the acceptance mutation, so a
   * restore that landed while acceptance waited in the queue is not missed.
   */
  assertAdmission?(
    database: Database,
    projectId: string,
    workspace?: WorkspaceExecutionContext,
  ): void;
  /**
   * Takes the single-writer lease and prepares the shared workspace for the
   * acting Agent. Callers must pair this with `endTurn` in a `finally`.
   */
  beginTurn(
    agent: Agent,
    projectId: string,
    runId: string,
    operation?: OperationOptions,
    workspace?: WorkspaceExecutionContext,
    /** Scopes the resumable thread; undefined for a direct turn. */
    orchestrationId?: string,
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
    workspace?: WorkspaceExecutionContext,
    /** Must match the `beginTurn` scope so the thread is stored beside it. */
    orchestrationId?: string,
  ): Promise<void>;
  /**
   * Capture the source after a successful turn, while the per-Run lease is
   * still held and the worker is proven settled. Returns the candidate
   * checkpoint; it becomes ready only through the orchestration hook.
   */
  captureSuccessfulTurn?(
    binding: ProjectRunBinding,
    run: { runId: string; agentId: string },
    operation?: OperationOptions,
  ): Promise<{ checkpointId: string }>;
  /** Keep a lease whose worker could not be proven settled; never time it out. */
  retainLeaseForRecovery?(projectId: string, runId: string): void;
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
    workspace?: WorkspaceExecutionContext,
  ): Promise<void> {
    assertOperationActive(operation);
    await this.projects.authorizeAgentExecution(projectId, agentId);
    assertOperationActive(operation);
    this.projects.assertWorkspaceAdmission(projectId, workspace);
  }

  assertAdmission(
    database: Database,
    projectId: string,
    workspace?: WorkspaceExecutionContext,
  ): void {
    this.projects.assertWorkspaceAdmission(projectId, workspace, database);
  }

  captureSuccessfulTurn(
    binding: ProjectRunBinding,
    run: { runId: string; agentId: string },
    operation: OperationOptions = {},
  ): Promise<{ checkpointId: string }> {
    return this.projects.captureSuccessfulTurn(binding, run, operation);
  }

  retainLeaseForRecovery(projectId: string, runId: string): void {
    this.projects.retainLeaseForRecovery(projectId, runId);
  }

  async beginTurn(
    agent: Agent,
    projectId: string,
    runId: string,
    operation: OperationOptions = {},
    workspace?: WorkspaceExecutionContext,
    orchestrationId?: string,
  ): Promise<ProjectRunBinding> {
    assertOperationActive(operation);
    // This check is deliberately before the lease mutation. A denied or
    // revoked Agent must never occupy the Project's single-writer slot.
    await this.projects.authorizeAgentExecution(projectId, agent.id);
    this.projects.assertWorkspaceAdmission(projectId, workspace);
    const owner =
      workspace === undefined
        ? undefined
        : { workspaceOperationId: workspace.workspaceOperationId, workspaceEpoch: workspace.workspaceEpoch };
    // Lease first: preparing the workspace writes AGENTS.md, which must never
    // race another Agent's turn.
    await this.projects.acquireWriteLease(projectId, agent.id, runId, {
      principal: { kind: "agent", id: agent.id },
      ...(operation.signal === undefined ? {} : { signal: operation.signal }),
      ...(operation.deadlineAt === undefined ? {} : { deadlineAt: operation.deadlineAt }),
      ...(owner === undefined ? {} : { workspaceOwner: owner }),
    });
    try {
      assertOperationActive(operation);
      const scope = this.projects.projectRunScope(projectId, agent.id, orchestrationId);
      // The role may have changed while waiting for the single-writer lease.
      // Recheck before writing AGENTS.md so a revoked Agent never changes the
      // shared workspace.
      await this.projects.authorizeAgentExecution(projectId, agent.id);
      assertOperationActive(operation);
      await this.projects.prepareTurn(scope.project, agent, operation, owner);
      assertOperationActive(operation);
      const currentPreviewStatus = await this.previewStatus(projectId);
      assertOperationActive(operation);
      return {
        projectId,
        projectName: scope.project.name,
        workspacePath: scope.workspacePath,
        codexThreadId: scope.codexThreadId,
        previewStatus: currentPreviewStatus,
        ...(workspace === undefined
          ? {}
          : {
              workspace: {
                ...workspace,
                settlementPolicy: this.projects.workspaceSettlementPolicy(),
              },
            }),
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
    workspace?: WorkspaceExecutionContext,
    orchestrationId?: string,
  ): Promise<void> {
    try {
      if (outcome) {
        // A thread written after a restore would resurrect memory of files
        // that no longer exist; the epoch check inside skips a stale outcome.
        await this.projects.recordProjectThread(
          projectId,
          agentId,
          outcome.codexThreadId,
          workspace === undefined
            ? undefined
            : { workspaceOperationId: workspace.workspaceOperationId, workspaceEpoch: workspace.workspaceEpoch },
          orchestrationId,
        );
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
