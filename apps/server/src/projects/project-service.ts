import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEMO_HUMAN_PRINCIPAL,
  type AuthorizationService,
} from "../access/authorization-service.js";
import { DEFAULT_PROJECT_ROLE } from "../access/access-types.js";
import type { Principal, ProjectRole } from "../access/access-types.js";
import type { ApplicationLifecycleFailureSink } from "../application-health.js";
import type { RuntimeReconciliationResult } from "../types.js";
import type { Storage } from "../store.js";
import type { Agent, Database, OperationOptions } from "../types.js";
import type { ToolApprovalInvalidator } from "../tools/tool-approval-store.js";
import type { SkillService } from "../skills/skill-service.js";
import { ProjectError } from "./project-errors.js";
import { ProjectWorkspaceManager } from "./project-workspace.js";
import {
  ProjectWriteLeaseCoordinator,
  type ProjectWriteLeaseOptions,
} from "./project-write-lease-coordinator.js";
import type { ProjectRunBinding, WorkspaceSettlementPolicy } from "./project-execution.js";
import type { WorkspaceCheckpointService } from "./workspace-checkpoint-service.js";
import {
  CHECKPOINT_POLICY_VERSION,
  WorkspaceCheckpointError,
  type WorkspaceCheckpointStatusView,
  type WorkspaceCheckpointView,
  type WorkspaceExecutionContext,
} from "./workspace-checkpoint-types.js";
import type {
  WorkspaceOperationCoordinator,
  WorkspaceOwner,
} from "./workspace-operation-coordinator.js";
import {
  PROJECT_LIMITS,
  type CreateProjectInput,
  type Project,
  type ProjectAgentAttachment,
  type ProjectMembershipView,
  type ProjectView,
  type UpdateProjectInput,
  ProjectRoleSchema,
} from "./project-types.js";

const now = (): string => new Date().toISOString();
const activeConversationStatuses = new Set(["queued", "running", "stopping"]);

function statusIsActiveSession(status: string): boolean {
  return activeConversationStatuses.has(status);
}

function assertOperationActive(operation: OperationOptions): void {
  if (operation.signal?.aborted) {
    const reason = operation.signal.reason;
    if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
      throw reason;
    }
    const error = new Error("Project preparation was aborted");
    error.name = "AbortError";
    throw error;
  }
  if (
    operation.deadlineAt !== undefined &&
    Number.isFinite(operation.deadlineAt) &&
    Date.now() >= operation.deadlineAt
  ) {
    const error = new Error("Project preparation timed out");
    error.name = "TimeoutError";
    throw error;
  }
}

/** Minimal Agent lookup seam; ProjectService never depends on AgentService. */
export interface ProjectAgentDirectory {
  getAgent(id: string): Agent;
}

/** Emitted for collaboration evidence; see the Project event journal. */
export type ProjectEventSink = (event: {
  type: string;
  projectId: string;
  agentId?: string | undefined;
  teamId?: string | undefined;
  runId?: string | undefined;
  status: string;
  /** Optional operator-readable note; never a permission or routing input. */
  detail?: string | undefined;
}) => void;

/** Narrow trusted seam for stopping a Project-owned Preview during archive. */
export interface ProjectPreviewLifecycleCleanup {
  stopForProject(projectId: string): Promise<void>;
  /** Positively stop any Project preview before a checkpoint operation. */
  quiesceForWorkspaceOperation?(projectId: string): Promise<void>;
}

/** Narrow lifecycle seam for stopping/removing Project-owned conversations. */
export interface ProjectConversationLifecycleCleanup {
  /** Stop active child conversations while retaining their persisted history. */
  stopForProject?(projectId: string): Promise<void>;
  /** Remove child conversation records for a permanent Workspace delete. */
  removeForProject?(projectId: string): Promise<void>;
}

export function publicProject(
  project: Project,
  membershipsOrAgentIds: readonly ProjectAgentAttachment[] | readonly string[] | readonly ProjectMembershipView[],
  options: {
    recoveryRequired?: boolean;
    workspaceCheckpoints?: ProjectView["workspaceCheckpoints"] | undefined;
  } = {},
): ProjectView {
  const memberships: ProjectMembershipView[] = (
    project.status === "archived" ? [] : membershipsOrAgentIds
  ).map((item) =>
    typeof item === "string"
      ? { agentId: item, role: DEFAULT_PROJECT_ROLE }
      : {
          agentId: item.agentId,
          role: item.role ?? DEFAULT_PROJECT_ROLE,
        },
  );
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    teamId: project.teamId,
    agentIds: memberships.map((membership) => membership.agentId),
    memberships,
    status: project.status,
    ...(options.recoveryRequired === true ? { recoveryRequired: true as const } : {}),
    ...(options.workspaceCheckpoints === undefined
      ? {}
      : { workspaceCheckpoints: options.workspaceCheckpoints }),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function requireText(
  value: string | undefined,
  field: string,
  maxLength: number,
  required: boolean,
): string {
  const trimmed = (value ?? "").trim();
  if (required && trimmed.length === 0) {
    throw new ProjectError("PROJECT_INVALID_INPUT", 422, field + " is required");
  }
  if (trimmed.length > maxLength) {
    throw new ProjectError(
      "PROJECT_INVALID_INPUT",
      422,
      field + " must be at most " + maxLength + " characters",
    );
  }
  return trimmed;
}

/**
 * Owns Projects: the shared workspace, its Team/Agent attachments, the
 * per-(Agent, Project) Codex thread, and single-writer coordination.
 *
 * Agents keep their own identity and private workspace. A Project only owns
 * the artifact a Team collaborates on.
 */

/**
 * The thread a turn may resume, or null when it must start fresh.
 *
 * Continuity is kept per scope rather than per pair. A direct turn resumes the
 * pair's direct thread; an orchestration resumes only a thread opened by that
 * same orchestration. The refusal is the point: Codex re-sends an entire thread
 * as the prompt of every turn resuming it, so letting one orchestration inherit
 * another's thread makes each task pay for every task before it, without bound.
 */
function resumableThread(
  attachment: ProjectAgentAttachment,
  orchestrationId: string | undefined,
): string | null {
  if (orchestrationId === undefined) return attachment.codexThreadId;
  return attachment.orchestrationThreadScope === orchestrationId
    ? attachment.orchestrationThreadId ?? null
    : null;
}

export class ProjectService {
  private readonly leaseCoordinator: ProjectWriteLeaseCoordinator;
  private skillService: SkillService | undefined;
  private conversationLifecycle: ProjectConversationLifecycleCleanup | undefined;
  private lifecycleFailureSink: ApplicationLifecycleFailureSink | undefined;
  private toolApprovalInvalidator: ToolApprovalInvalidator | undefined;
  private startupReconciliation: RuntimeReconciliationResult | undefined;
  private checkpoints: WorkspaceCheckpointService | undefined;
  private operations: WorkspaceOperationCoordinator | undefined;
  private settlementPolicy: WorkspaceSettlementPolicy = "require_proof";
  private checkpointRuntimeSupported = false;

  constructor(
    private readonly store: Storage,
    private readonly workspaces: ProjectWorkspaceManager,
    private readonly agents: ProjectAgentDirectory,
    private readonly authorization: AuthorizationService,
    private readonly onEvent: ProjectEventSink = () => undefined,
    private projectPreviewLifecycle?: ProjectPreviewLifecycleCleanup,
    skillService?: SkillService,
  ) {
    this.leaseCoordinator = new ProjectWriteLeaseCoordinator(
      store,
      (projectId, agentId, principal) =>
        this.authorizeAgentExecution(projectId, agentId, principal),
      onEvent,
      (failure) => this.lifecycleFailureSink?.reportLifecycleFailure(failure),
    );
    this.skillService = skillService;
  }

  /** Attach the Project Preview cleanup seam after the app graph is assembled. */
  setProjectPreviewLifecycle(
    previewLifecycle: ProjectPreviewLifecycleCleanup,
  ): void {
    this.projectPreviewLifecycle = previewLifecycle;
  }

  /** Attach orchestration cleanup after the app graph is assembled. */
  setConversationLifecycle(
    conversationLifecycle: ProjectConversationLifecycleCleanup,
  ): void {
    this.conversationLifecycle = conversationLifecycle;
  }

  /** Attach the code-owned skill composer after the app graph is assembled. */
  setSkillService(skillService: SkillService): void {
    this.skillService = skillService;
  }

  /** Attach the application-owned lifecycle failure sink after app assembly. */
  setLifecycleFailureSink(sink: ApplicationLifecycleFailureSink): void {
    this.lifecycleFailureSink = sink;
  }

  /**
   * Attach the native tool-approval lifecycle fence after composition. The
   * type-only seam avoids a dependency on AgentService or a concrete store.
   */
  setToolApprovalInvalidator(invalidator: ToolApprovalInvalidator): void {
    this.toolApprovalInvalidator = invalidator;
  }

  /**
   * Attach source checkpointing. Once attached, every Project-scoped turn
   * must belong to a reserved cycle; the lease coordinator repeats that check
   * inside its own mutation.
   */
  setWorkspaceCheckpoints(
    checkpoints: WorkspaceCheckpointService,
    operations: WorkspaceOperationCoordinator,
    options: { settlementPolicy: WorkspaceSettlementPolicy; runtimeSupported: boolean },
  ): void {
    this.checkpoints = checkpoints;
    this.operations = operations;
    this.settlementPolicy = options.settlementPolicy;
    this.checkpointRuntimeSupported = options.runtimeSupported;
    this.leaseCoordinator.setAdmissionGuard((database, projectId, owner) =>
      operations.assertAdmission(database, projectId, owner),
    );
  }

  workspaceCheckpointService(): WorkspaceCheckpointService | undefined {
    return this.checkpoints;
  }

  workspaceOperationCoordinator(): WorkspaceOperationCoordinator | undefined {
    return this.operations;
  }

  workspaceCheckpointsEnabled(): boolean {
    return this.checkpoints?.isEnabled() === true;
  }

  workspaceSettlementPolicy(): WorkspaceSettlementPolicy {
    return this.settlementPolicy;
  }

  /** Enabled checkpointing on a runtime that cannot prove settlement fails closed. */
  assertCheckpointRuntimeSupported(): void {
    if (!this.workspaceCheckpointsEnabled()) return;
    this.checkpoints?.assertAvailable();
    if (!this.checkpointRuntimeSupported) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_RUNTIME_UNSUPPORTED",
        "Source checkpoints need the container runtime, or the explicit local-process override, to prove that a worker has stopped writing",
      );
    }
  }

  /**
   * Admission for a Project-scoped Run. With checkpoints enabled, a direct
   * (non-cycle) Project Run is rejected before any record exists; a cycle Run
   * must name the held reservation and the current epoch.
   */
  assertWorkspaceAdmission(
    projectId: string,
    workspace?: WorkspaceExecutionContext,
    database: Pick<Database, "workspaceOperations" | "projects"> = this.store.snapshot(),
  ): void {
    if (this.workspaceCheckpointsEnabled() && workspace === undefined) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_DIRECT_PROJECT_RUN_UNSUPPORTED",
        "Shared Workspace files are checkpointed per Team cycle; start or continue a Conversation instead of running this Agent directly on the Workspace",
      );
    }
    if (workspace !== undefined && workspace.projectId !== projectId) {
      throw new ProjectError("PROJECT_BUSY", 409, "The execution context names a different Project");
    }
    this.operations?.assertAdmission(
      database,
      projectId,
      workspace === undefined
        ? undefined
        : { workspaceOperationId: workspace.workspaceOperationId, workspaceEpoch: workspace.workspaceEpoch },
    );
  }

  /** Capture the source after a successful turn, while the per-Run lease is held. */
  async captureSuccessfulTurn(
    binding: ProjectRunBinding,
    run: { runId: string; agentId: string },
    operation: OperationOptions = {},
  ): Promise<{ checkpointId: string }> {
    if (!this.checkpoints || !binding.workspace) {
      throw new WorkspaceCheckpointError("CHECKPOINT_UNAVAILABLE", "Workspace checkpoints are not configured for this turn");
    }
    assertOperationActive(operation);
    const checkpoint = await this.checkpoints.captureTurn({
      projectId: binding.projectId,
      operationId: binding.workspace.workspaceOperationId,
      workspaceEpoch: binding.workspace.workspaceEpoch,
      orchestrationId: binding.workspace.orchestrationId,
      executionCycleId: binding.workspace.executionCycleId,
      runId: run.runId,
      agentId: run.agentId,
      ...(operation.signal === undefined ? {} : { signal: operation.signal }),
    });
    return { checkpointId: checkpoint.id };
  }

  retainLeaseForRecovery(projectId: string, runId: string): void {
    this.leaseCoordinator.retainLeaseForRecovery(projectId, runId);
  }

  /** Safe checkpoint listing for one Project, newest first. */
  async listWorkspaceCheckpoints(
    projectId: string,
    query: { limit?: number | undefined; beforeOrdinal?: number | undefined } = {},
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<{
    checkpoints: WorkspaceCheckpointView[];
    nextBeforeOrdinal: number | null;
    status: WorkspaceCheckpointStatusView;
  }> {
    await this.authorization.require({
      principal,
      permission: "project.read",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    this.requireProject(projectId);
    if (!this.checkpoints) {
      return { checkpoints: [], nextBeforeOrdinal: null, status: this.workspaceCheckpointStatus(projectId) };
    }
    const page = this.checkpoints.listProjectCheckpoints(projectId, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.beforeOrdinal === undefined ? {} : { beforeOrdinal: query.beforeOrdinal }),
    });
    return {
      checkpoints: page.checkpoints.map((checkpoint) => this.checkpoints!.toView(checkpoint)),
      nextBeforeOrdinal: page.nextBeforeOrdinal,
      status: this.workspaceCheckpointStatus(projectId),
    };
  }

  /** One checkpoint; a foreign Project's identity is simply not found. */
  async getWorkspaceCheckpoint(
    projectId: string,
    checkpointId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<WorkspaceCheckpointView> {
    await this.authorization.require({
      principal,
      permission: "project.read",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    this.requireProject(projectId);
    if (!this.checkpoints) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Checkpoint not found");
    }
    return this.checkpoints.toView(this.checkpoints.requireCheckpoint(projectId, checkpointId));
  }

  workspaceCheckpointStatus(projectId: string): WorkspaceCheckpointStatusView {
    const capability = this.checkpoints?.capability();
    const gate = this.operations?.recoveryGate(projectId) ?? null;
    return {
      enabled: capability?.enabled === true,
      available: capability?.available === true && this.checkpointRuntimeSupported,
      scope: CHECKPOINT_POLICY_VERSION,
      busy: (this.operations?.heldOperation(projectId) ?? null) !== null,
      recoveryRequired: gate !== null || this.leaseCoordinator.isRecoveryRequired(projectId),
      errorCode:
        capability?.enabled && !capability.available
          ? capability.errorCode
          : capability?.enabled && !this.checkpointRuntimeSupported
            ? "CHECKPOINT_RUNTIME_UNSUPPORTED"
            : gate?.errorCode ?? null,
    };
  }

  /** The human must currently hold Project write authority to restore files. */
  async authorizeWorkspaceRecovery(
    projectId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<void> {
    await this.authorization.require({
      principal,
      permission: "project.write",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    this.requireActiveProject(projectId);
  }

  workspaceEpoch(projectId: string): number {
    return this.requireProject(projectId).workspaceEpoch ?? 0;
  }

  /** No lease may be held and no unresolved writer may remain. */
  requireNoPhysicalWriter(projectId: string): void {
    this.leaseCoordinator.assertProjectRecoveryClear(projectId);
    if (this.leaseCoordinator.writeLeaseHolder(projectId)) {
      throw new ProjectError("PROJECT_BUSY", 409, "Another Agent is currently writing to this Project");
    }
  }

  /** Positively stop the Project preview before a checkpoint operation. */
  async quiescePreviewsForWorkspaceOperation(projectId: string): Promise<void> {
    const lifecycle = this.projectPreviewLifecycle;
    if (!lifecycle) return;
    if (lifecycle.quiesceForWorkspaceOperation) {
      await lifecycle.quiesceForWorkspaceOperation(projectId);
      return;
    }
    await lifecycle.stopForProject(projectId);
    this.assertNoActiveProjectPreview(projectId);
  }

  /**
   * The atomic tail of a verified restore: advance the epoch, clear every
   * Project-scoped thread so no Agent resumes memory of files that no longer
   * exist, and record the verified boundary. Runs inside the caller's mutation.
   */
  resetWorkspaceIn(database: Database, projectId: string, checkpointId: string): number {
    const project = database.projects.find((item) => item.id === projectId);
    if (!project) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
    const nextEpoch = (project.workspaceEpoch ?? 0) + 1;
    project.workspaceEpoch = nextEpoch;
    project.currentCheckpointId = checkpointId;
    project.updatedAt = now();
    for (const attachment of database.projectAgents) {
      if (attachment.projectId !== projectId) continue;
      // Both scopes, without exception. A restore invalidates a thread because
      // the thread remembers files that are gone, and that is as true of an
      // orchestration's thread as of a direct one — clearing only the direct
      // slot would let a mid-orchestration participant resume against a
      // workspace it no longer recognises.
      attachment.codexThreadId = null;
      attachment.orchestrationThreadId = null;
      attachment.orchestrationThreadScope = null;
      attachment.updatedAt = project.updatedAt;
    }
    return nextEpoch;
  }

  /** Supply the verified runtime evidence before stale leases are considered. */
  setStartupReconciliation(result: RuntimeReconciliationResult): void {
    this.startupReconciliation = {
      provider: result.provider,
      confirmedAgentIds: [...result.confirmedAgentIds],
      confirmedPreviewIds: [...result.confirmedPreviewIds],
      unresolvedAgentIds: [...result.unresolvedAgentIds],
      unresolvedPreviewIds: [...result.unresolvedPreviewIds],
    };
  }

  /**
   * Reconciles leases orphaned by a restart using the runtime evidence
   * collected before Agent status reset. Uncertain ownership remains gated.
   */
  async initialize(reconciliation = this.startupReconciliation): Promise<void> {
    await this.workspaces.initialize();
    await this.leaseCoordinator.initialize(reconciliation);
    // Reservations are quarantined only after lease evidence is known, so a
    // Project with an unresolved writer keeps every gate it had.
    if (this.operations) {
      const unresolvedProjectIds = new Set(
        this.store
          .snapshot()
          .projects.map((project) => project.id)
          .filter((projectId) => this.leaseCoordinator.isRecoveryRequired(projectId)),
      );
      const { retained } = await this.operations.initialize({ unresolvedProjectIds });
      for (const operation of retained) {
        this.lifecycleFailureSink?.reportLifecycleFailure({
          code: "WORKSPACE_RECOVERY_REQUIRED",
          message: "A workspace checkpoint operation was interrupted; operator recovery is required",
          projectId: operation.projectId,
        });
      }
    }
  }

  /**
   * Reserve all Projects that still contain Agent-owned membership or lease
   * evidence. Agent deletion holds this reservation through its database
   * mutation and rollback so archive compensation cannot overwrite it.
   */
  beginAgentDeletion(agentId: string): () => void {
    const database = this.store.snapshot();
    const projectIds = [
      ...new Set([
        ...database.projectAgents
          .filter((item) => item.agentId === agentId)
          .map((item) => item.projectId),
        ...database.projectLeases
          .filter((item) => item.agentId === agentId)
          .map((item) => item.projectId),
      ]),
    ].sort();
    const acquired: string[] = [];
    try {
      for (const projectId of projectIds) {
        this.leaseCoordinator.beginProjectMutation(projectId);
        acquired.push(projectId);
      }
    } catch (error) {
      for (const projectId of acquired) {
        this.leaseCoordinator.endProjectMutation(projectId);
      }
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const projectId of acquired) {
        this.leaseCoordinator.endProjectMutation(projectId);
      }
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async create(
    input: CreateProjectInput,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    await this.authorization.require({ principal, permission: "project.manage" });
    const name = requireText(input.name, "Project name", PROJECT_LIMITS.maxNameLength, true);
    const description = requireText(
      input.description,
      "Project description",
      PROJECT_LIMITS.maxDescriptionLength,
      false,
    );
    const timestamp = now();
    const id = randomUUID();
    const project: Project = {
      id,
      name,
      description,
      workspacePath: this.workspaces.workspacePath(id),
      teamId: null,
      ownerPrincipalId: principal.kind === "human" ? principal.id : DEMO_HUMAN_PRINCIPAL.id,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let workspaceCreated = false;
    let persisted = false;
    try {
      await this.workspaces.create(project);
      workspaceCreated = true;
      await this.store.mutate((database) => {
        database.projects.push(project);
      });
      persisted = true;
      this.onEvent({ type: "project_created", projectId: id, status: "active" });
      return this.projectView(project, []);
    } catch (error) {
      // Keep a Project out of the repository when local creation fails so the
      // caller can retry the privileged action.
      if (persisted) {
        await this.store.mutate((database) => {
          database.projects = database.projects.filter((item) => item.id !== id);
        });
      }
      if (workspaceCreated) await this.workspaces.archive(project).catch(() => undefined);
      throw error;
    }
  }

  /** Archiving is how a Project is removed, so an archived one is not listed. */
  async list(principal: Principal = DEMO_HUMAN_PRINCIPAL): Promise<ProjectView[]> {
    await this.authorization.require({ principal, permission: "project.read" });
    const database = this.store.snapshot();
    return database.projects
      .filter((project) => project.status !== "archived")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((project) => this.projectView(project, this.attachedMemberships(project.id)));
  }

  async get(
    projectId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.read",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    const project = this.requireProject(projectId);
    return this.projectView(project, this.attachedMemberships(projectId));
  }

  async update(
    projectId: string,
    input: UpdateProjectInput,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.write",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    this.requireActiveProject(projectId);
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
    const name =
      input.name === undefined
        ? undefined
        : requireText(input.name, "Project name", PROJECT_LIMITS.maxNameLength, true);
    const description =
      input.description === undefined
        ? undefined
        : requireText(
            input.description,
            "Project description",
            PROJECT_LIMITS.maxDescriptionLength,
            false,
          );
    const before = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!before) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
    const updated = await this.store.mutate((database) => {
      this.leaseCoordinator.assertProjectMutationAllowed(projectId);
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      if (name !== undefined) stored.name = name;
      if (description !== undefined) stored.description = description;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
    try {
      return this.projectView(updated, this.attachedMemberships(projectId));
    } catch (error) {
      await this.store.mutate((database) => {
        this.leaseCoordinator.assertProjectMutationAllowed(projectId);
        const stored = database.projects.find((item) => item.id === projectId);
        if (stored) Object.assign(stored, structuredClone(before));
      });
      throw error;
    }
  }

  /**
   * Archives a Project: active child conversations are stopped, the shared
   * workspace is moved aside rather than deleted, and all Project history is
   * retained for recovery. Transient write leases are the one exception.
   */
  async archive(
    projectId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<{ archivedWorkspace: string | null }> {
    await this.authorization.require({
      principal,
      permission: "project.manage",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    const project = this.requireProject(projectId);
    this.leaseCoordinator.beginArchive(projectId);
    try {
      // Stop the shared Preview before moving its workspace. This is an
      // injected lifecycle seam so ProjectService never reaches runtime code.
      await this.projectPreviewLifecycle?.stopForProject(projectId);
      // Archive stops active conversations but deliberately keeps their
      // sessions, turns, events, and continuation prompts as history.
      await this.conversationLifecycle?.stopForProject?.(projectId);
      this.assertNoActiveProjectConversations(projectId);
      this.assertNoActiveProjectPreview(projectId);
      this.leaseCoordinator.requireNoWriteLease(projectId);
      // Stop/finalization may persist terminal child state. Roll back to this
      // safe snapshot if the subsequent filesystem or local persistence fails;
      // restoring an active pre-stop record would create a phantom runner.
      const afterStop = this.store.snapshot();
      const archivedWorkspace = await this.workspaces.archive(project);
      try {
        await this.store.mutate((database) => {
          this.leaseCoordinator.assertDatabaseLeaseFree(database, projectId);
          const stored = database.projects.find((item) => item.id === projectId);
          if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
          stored.status = "archived";
          stored.teamId = null;
          stored.updatedAt = now();
          // Leases are coordination state, not recoverable history. A stopped
          // child should already have released its lease, but filter defensively
          // inside the same mutation as the status transition.
          database.projectLeases = database.projectLeases.filter(
            (item) => item.projectId !== projectId,
          );
        });
        this.onEvent({ type: "project_archived", projectId, status: "archived" });
        return { archivedWorkspace };
      } catch (error) {
        // Archive changes both repository authority and the physical shared
        // workspace. Restore the last safe persisted state before moving the
        // files back so the archive can be retried without losing history.
        await this.restoreProjectSnapshot(afterStop, projectId);
        if (archivedWorkspace !== null) {
          await this.workspaces.restore(project, archivedWorkspace).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      this.leaseCoordinator.endArchive(projectId);
    }
  }

  /**
   * Permanently removes a Workspace's database records after first moving its
   * files through the recoverable archive path. Agent identity, private Agent
   * messages/runs, audit history, and other Workspaces remain untouched.
   */
  async deletePermanently(
    projectId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<{ deleted: boolean }> {
    await this.authorization.require({
      principal,
      permission: "project.manage",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    const project = this.requireProject(projectId);
    this.leaseCoordinator.beginArchive(projectId);
    try {
      // Runtime cleanup runs before the filesystem move. The production seam
      // stops active children but does not delete their persisted history;
      // this method owns the final all-or-nothing database purge below.
      await this.projectPreviewLifecycle?.stopForProject(projectId);
      await this.conversationLifecycle?.stopForProject?.(projectId);
      this.assertNoActiveProjectConversations(projectId);
      this.assertNoActiveProjectPreview(projectId);
      this.leaseCoordinator.requireNoWriteLease(projectId);
      const afterStop = this.store.snapshot();
      const childIdsToRemove = new Set(
        afterStop.orchestrations
          .filter((session) => session.projectId === projectId)
          .map((session) => session.id),
      );

      let archivedWorkspace: string | null = null;
      // An archived Project has already had its live workspace moved. Its
      // recoverable archive is intentionally left in place while the DB row is
      // deleted. Active Projects are moved exactly once through the manager.
      if (project.status === "active") {
        archivedWorkspace = await this.workspaces.archive(project);
      }

      try {
        // The orchestration service owns its in-process cancellation map and
        // child-session cleanup. Production wiring has already stopped the
        // children above; this second seam removes those child records after
        // the recoverable filesystem move. The final mutation below remains
        // authoritative for callers that do not provide that seam.
        await this.conversationLifecycle?.removeForProject?.(projectId);
        // Close approval-backed invocations before the Project row and its
        // attachments are removed. A failed later cleanup remains fail-closed
        // and cannot leave an executable approval for a deleted Project.
        await this.toolApprovalInvalidator?.invalidateForProject(
          projectId,
          "Project was deleted",
        );
        await this.store.mutate((database) => {
          this.leaseCoordinator.assertDatabaseLeaseFree(database, projectId);
          // Include IDs from the post-stop snapshot even when an injected
          // lifecycle seam already removed the parent session. This prevents
          // orphaned turns/events/continuations from surviving a delete.
          const childIds = new Set(childIdsToRemove);
          for (const session of database.orchestrations) {
            if (session.projectId === projectId) childIds.add(session.id);
          }
          for (const childId of childIds) {
            const session = database.orchestrations.find((item) => item.id === childId);
            if (session && statusIsActiveSession(session.status)) {
              throw new ProjectError(
                "PROJECT_BUSY",
                409,
                "Stop the active Conversation before deleting this Workspace",
              );
            }
          }

          database.projects = database.projects.filter((item) => item.id !== projectId);
          database.projectAgents = database.projectAgents.filter(
            (item) => item.projectId !== projectId,
          );
          database.projectLeases = database.projectLeases.filter(
            (item) => item.projectId !== projectId,
          );
          database.orchestrations = database.orchestrations.filter(
            (item) => !childIds.has(item.id),
          );
          database.orchestrationTurns = database.orchestrationTurns.filter(
            (item) => !childIds.has(item.sessionId),
          );
          database.orchestrationEvents = database.orchestrationEvents.filter(
            (item) => !childIds.has(item.sessionId),
          );
          database.orchestrationContinuationPrompts =
            database.orchestrationContinuationPrompts.filter(
              (item) => !childIds.has(item.sessionId),
            );
          database.previews = database.previews.filter(
            (item) => item.projectId !== projectId,
          );
          database.approvalRequests = database.approvalRequests.filter(
            (item) => item.projectId !== projectId,
          );
          database.capabilityGrants = database.capabilityGrants.filter(
            (item) => item.projectId !== projectId,
          );
          database.permitApprovalCorrelations = database.permitApprovalCorrelations.filter(
            (item) => item.projectId !== projectId,
          );
          database.workspaceCheckpoints = database.workspaceCheckpoints.filter(
            (item) => item.projectId !== projectId,
          );
          database.workspaceExecutionCycles = database.workspaceExecutionCycles.filter(
            (item) => item.projectId !== projectId,
          );
          database.workspaceOperations = database.workspaceOperations.filter(
            (item) => item.projectId !== projectId,
          );
        });
        this.onEvent({ type: "project_deleted", projectId, status: "deleted" });
        // The private snapshot store is removed only after the rows are gone.
        // A failed physical cleanup is reported, never claimed as complete.
        try {
          await this.checkpoints?.deleteProjectData(projectId);
        } catch {
          this.lifecycleFailureSink?.reportLifecycleFailure({
            code: "WORKSPACE_CHECKPOINT_CLEANUP_FAILED",
            message: "Project checkpoint storage could not be removed after permanent deletion",
            projectId,
          });
        }
        return { deleted: true };
      } catch (error) {
        // The JSON store mutation is atomic. If local cleanup fails, restore
        // the last safe post-stop snapshot and put the moved
        // workspace back. Restoration is best effort; the original stable
        // operation error remains the response if a host rename itself fails.
        await this.restoreProjectSnapshot(afterStop, projectId);
        if (archivedWorkspace !== null) {
          await this.workspaces.restore(project, archivedWorkspace).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      this.leaseCoordinator.endArchive(projectId);
    }
  }

  /** Alias that keeps the destructive operation explicit at service callers. */
  async delete(
    projectId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<{ deleted: boolean }> {
    return this.deletePermanently(projectId, principal);
  }

  // --------------------------------------------------------------- attachment

  async attachAgent(
    projectId: string,
    agentId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
    role: ProjectRole = DEFAULT_PROJECT_ROLE,
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.members.manage",
      projectId,
      agentId,
      resource: { kind: "project", id: projectId },
    });
    const project = this.requireActiveProject(projectId);
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
    this.agents.getAgent(agentId);
    if (this.attachedAgentIds(projectId).includes(agentId)) {
      throw new ProjectError(
        "PROJECT_AGENT_ALREADY_ATTACHED",
        409,
        "That Agent is already attached to this Project",
      );
    }
    const attachedAt = now();
    // Write the membership tier explicitly. Leaving it unset made every
    // attachment an editor by way of three separate read-side fallbacks,
    // which is invisible both here and to the caller.
    const attachment: ProjectAgentAttachment = {
      projectId,
      agentId,
      codexThreadId: null,
      attachedAt,
      role,
      toolGrants: [],
      updatedAt: attachedAt,
    };
    let persisted = false;
    try {
      await this.store.mutate((database) => {
        this.leaseCoordinator.assertProjectMutationAllowed(projectId);
        database.projectAgents.push(attachment);
      });
      persisted = true;
      this.onEvent({
        type: "project_agent_attached",
        projectId,
        agentId,
        status: "attached",
      });
      return this.projectView(project, this.attachedMemberships(projectId));
    } catch (error) {
      if (persisted) {
        await this.store.mutate((database) => {
          this.leaseCoordinator.assertProjectMutationAllowed(projectId);
          database.projectAgents = database.projectAgents.filter(
            (item) => !(item.projectId === projectId && item.agentId === agentId && item.attachedAt === attachedAt),
          );
        });
      }
      throw error;
    }
  }

  /** Detaching drops the shared-scope thread; Project files are untouched. */
  async detachAgent(
    projectId: string,
    agentId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.members.manage",
      projectId,
      agentId,
      resource: { kind: "project", id: projectId },
    });
    const project = this.requireProject(projectId);
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
    const existing = this.store
      .snapshot()
      .projectAgents.find(
        (item) => item.projectId === projectId && item.agentId === agentId,
      );
    // A draft Conversation is still being composed, so a roster entry for an
    // Agent that has just left the room is stale rather than historical.
    // Removing it here is what keeps the room, the roster, and the runnable
    // participant list in agreement — otherwise the departed Agent keeps a
    // desk in the workspace and blocks the start with AGENT_NOT_FOUND until
    // the whole Conversation is deleted. Started and finished Conversations
    // keep their roster verbatim: those records explain runs that happened.
    const removedFromDrafts: string[] = [];
    let persisted = false;
    try {
      await this.store.mutate((database) => {
        this.leaseCoordinator.assertProjectMutationAllowed(projectId);
        database.projectAgents = database.projectAgents.filter(
          (item) => !(item.projectId === projectId && item.agentId === agentId),
        );
        for (const session of database.orchestrations) {
          if (session.projectId !== projectId || session.status !== "draft") continue;
          if (!session.participants.some((item) => item.agentId === agentId)) continue;
          session.participants = session.participants
            .filter((item) => item.agentId !== agentId)
            .map((item, position) => ({ ...item, position }));
          session.updatedAt = new Date().toISOString();
          removedFromDrafts.push(session.id);
        }
      });
      persisted = true;
      this.onEvent({
        type: "project_agent_detached",
        projectId,
        agentId,
        status: "detached",
        ...(removedFromDrafts.length > 0
          ? { detail: `Removed from ${removedFromDrafts.length} draft conversation(s)` }
          : {}),
      });
      return this.projectView(project, this.attachedMemberships(projectId));
    } catch (error) {
      if (persisted && existing) {
        await this.store.mutate((database) => {
          this.leaseCoordinator.assertProjectMutationAllowed(projectId);
          if (!database.projectAgents.some(
            (item) => item.projectId === projectId && item.agentId === agentId,
          )) {
            database.projectAgents.push(structuredClone(existing));
          }
        });
      }
      throw error;
    }
  }

  /**
   * Bind one orchestration conversation to a Project and union its Agents into
   * the Project membership set. Unlike the legacy `attachTeam` method, this
   * operation is intentionally repeatable: a Project may own many
   * conversations, while `teamId` remains only the first-conversation pointer
   * needed by older records and callers.
   */
  async bindConversation(
    projectId: string,
    conversationId: string,
    agentIds: readonly string[],
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.members.manage",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    this.requireActiveProject(projectId);
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
    const uniqueAgentIds = [...new Set(agentIds)];
    for (const agentId of uniqueAgentIds) this.agents.getAgent(agentId);

    const before = this.store.snapshot();
    const updated = await this.store.mutate((database) => {
      this.leaseCoordinator.assertProjectMutationAllowed(projectId);
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      if (stored.status !== "active") {
        throw new ProjectError("PROJECT_ARCHIVED", 409, "This Project is archived");
      }

      let changed = false;
      // Preserve the legacy pointer for existing consumers, but never reject a
      // second conversation just because that pointer is occupied.
      if (stored.teamId === null) {
        stored.teamId = conversationId;
        changed = true;
      }
      for (const agentId of uniqueAgentIds) {
        if (
          database.projectAgents.some(
            (item) => item.projectId === projectId && item.agentId === agentId,
          )
        ) {
          continue;
        }
        const timestamp = now();
        database.projectAgents.push({
          projectId,
          agentId,
          codexThreadId: null,
          attachedAt: timestamp,
          toolGrants: [],
          updatedAt: timestamp,
        });
        changed = true;
      }
      if (changed) stored.updatedAt = now();
      return structuredClone(stored);
    });

    try {
      const newlyAttached = uniqueAgentIds.filter(
        (agentId) =>
          !before.projectAgents.some(
            (item) => item.projectId === projectId && item.agentId === agentId,
          ),
      );
      for (const agentId of newlyAttached) {
        this.onEvent({
          type: "project_agent_attached",
          projectId,
          agentId,
          teamId: conversationId,
          status: "attached",
        });
      }
      this.onEvent({
        type: "project_conversation_bound",
        projectId,
        teamId: conversationId,
        status: "attached",
      });
      return this.projectView(updated, this.attachedMemberships(projectId));
    } catch (error) {
      await this.store.mutate((database) => {
        this.leaseCoordinator.assertProjectMutationAllowed(projectId);
        const previousProject = before.projects.find((item) => item.id === projectId);
        const stored = database.projects.find((item) => item.id === projectId);
        if (previousProject && stored) Object.assign(stored, structuredClone(previousProject));
        database.projectAgents = database.projectAgents.filter(
          (item) => item.projectId !== projectId,
        );
        database.projectAgents.push(
          ...before.projectAgents
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      });
      throw error;
    }
  }

  async attachTeam(
    projectId: string,
    teamId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.members.manage",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    this.requireActiveProject(projectId);
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
    const before = this.store.snapshot().projects.find((item) => item.id === projectId);
    const updated = await this.store.mutate((database) => {
      this.leaseCoordinator.assertProjectMutationAllowed(projectId);
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      if (stored.teamId && stored.teamId !== teamId) {
        throw new ProjectError(
          "PROJECT_TEAM_ALREADY_ATTACHED",
          409,
          "Another Team is already attached to this Project",
        );
      }
      stored.teamId = teamId;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
    try {
      this.onEvent({
        type: "project_team_attached",
        projectId,
        teamId,
        status: "attached",
      });
      return this.projectView(updated, this.attachedMemberships(projectId));
    } catch (error) {
      if (before) {
        await this.store.mutate((database) => {
          this.leaseCoordinator.assertProjectMutationAllowed(projectId);
          const stored = database.projects.find((item) => item.id === projectId);
          if (stored) Object.assign(stored, structuredClone(before));
        });
      }
      throw error;
    }
  }

  async detachTeam(
    projectId: string,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.members.manage",
      projectId,
      resource: { kind: "project", id: projectId },
    });
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
    const before = this.store.snapshot().projects.find((item) => item.id === projectId);
    const updated = await this.store.mutate((database) => {
      this.leaseCoordinator.assertProjectMutationAllowed(projectId);
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      stored.teamId = null;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
    try {
      return this.projectView(updated, this.attachedMemberships(projectId));
    } catch (error) {
      if (before) {
        await this.store.mutate((database) => {
          this.leaseCoordinator.assertProjectMutationAllowed(projectId);
          const stored = database.projects.find((item) => item.id === projectId);
          if (stored) Object.assign(stored, structuredClone(before));
        });
      }
      throw error;
    }
  }

  /** Changes one Agent's fixed Project role at a trusted human boundary. */
  async updateAgentRole(
    projectId: string,
    agentId: string,
    role: ProjectRole,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<ProjectView> {
    const parsedRole = ProjectRoleSchema.safeParse(role);
    if (!parsedRole.success) {
      throw new ProjectError("PROJECT_INVALID_INPUT", 422, "Invalid Project role");
    }
    await this.authorization.require({
      principal,
      permission: "project.members.manage",
      projectId,
      agentId,
      resource: { kind: "project", id: projectId },
    });
    this.requireActiveProject(projectId);
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
    const before = this.store.snapshot();
    const updated = await this.store.mutate((database) => {
      this.leaseCoordinator.assertProjectMutationAllowed(projectId);
      const attachment = database.projectAgents.find(
        (item) => item.projectId === projectId && item.agentId === agentId,
      );
      if (!attachment) {
        throw new ProjectError(
          "PROJECT_AGENT_NOT_ATTACHED",
          422,
          "That Agent is not attached to this Project",
        );
      }
      // The membership level is independent of the Agent's role template.
      attachment.role = parsedRole.data;
      attachment.updatedAt = now();
      const project = database.projects.find((item) => item.id === projectId);
      if (!project) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      project.updatedAt = now();
      return structuredClone(project);
    });
    try {
      this.onEvent({
        type: "project_agent_role_changed",
        projectId,
        agentId,
        status: parsedRole.data,
      });
      return this.projectView(updated, this.attachedMemberships(projectId));
    } catch (error) {
      await this.store.mutate((database) => {
        this.leaseCoordinator.assertProjectMutationAllowed(projectId);
        const previousProject = before.projects.find((item) => item.id === projectId);
        if (previousProject) {
          const stored = database.projects.find((item) => item.id === projectId);
          if (stored) Object.assign(stored, structuredClone(previousProject));
        }
        const currentAttachment = database.projectAgents.find(
          (item) => item.projectId === projectId && item.agentId === agentId,
        );
        const previousAttachment = before.projectAgents.find(
          (item) => item.projectId === projectId && item.agentId === agentId,
        );
        if (currentAttachment && previousAttachment) {
          Object.assign(currentAttachment, structuredClone(previousAttachment));
        }
      });
      throw error;
    }
  }

  /**
   * Performs the two checks required before a Project Agent turn can begin.
   * Membership is resolved first, then both delegated Agent invocation and
   * Project write authority are evaluated against the repository role.
   */
  async authorizeAgentExecution(
    projectId: string,
    agentId: string,
    principal: Principal = { kind: "agent", id: agentId },
  ): Promise<void> {
    this.leaseCoordinator.assertProjectRecoveryClear(projectId);
    const scope = this.projectRunScope(projectId, agentId);
    const resource = { kind: "project", id: projectId } as const;
    await this.authorization.require({
      principal,
      permission: "agent.invoke",
      projectId,
      agentId,
      resource,
    });
    await this.authorization.require({
      principal,
      permission: "project.write",
      projectId,
      agentId,
      resource,
    });
    if (!(await this.workspaces.hasWorkspaceDirectory(scope.project))) {
      throw this.workspaceRecoveryRequired();
    }
  }

  // ------------------------------------------------------------- run scoping

  /**
   * Resolves the mount target and session for a Project-scoped Agent turn.
   *
   * Returns the backend-derived workspace path and the thread belonging to
   * this exact (Agent, Project) pair, never the Agent's private thread.
   */
  projectRunScope(
    projectId: string,
    agentId: string,
    /**
     * The orchestration this turn belongs to, or undefined for a direct turn.
     *
     * A thread is resumed only by the scope that opened it: an orchestration
     * resumes its own thread and nothing else, so an unrelated orchestration
     * starts fresh instead of inheriting a prompt it never sent.
     */
    orchestrationId?: string,
  ): { project: Project; workspacePath: string; codexThreadId: string | null } {
    const project = this.requireActiveProject(projectId);
    const attachment = this.store
      .snapshot()
      .projectAgents.find(
        (item) => item.projectId === projectId && item.agentId === agentId,
      );
    if (!attachment) {
      throw new ProjectError(
        "PROJECT_AGENT_NOT_ATTACHED",
        422,
        "That Agent is not attached to this Project",
      );
    }
    // With checkpoints enabled the mount and the snapshot must be the same
    // directory. Derive it, and refuse a persisted path that disagrees.
    const canonical = this.workspaces.workspacePath(projectId);
    if (
      this.workspaceCheckpointsEnabled() &&
      path.resolve(project.workspacePath) !== path.resolve(canonical)
    ) {
      throw this.workspaceRecoveryRequired();
    }
    return {
      project,
      workspacePath: project.workspacePath,
      codexThreadId: resumableThread(attachment, orchestrationId),
    };
  }

  /** Persists the resumable thread for this Agent's shared-Project scope. */
  async recordProjectThread(
    projectId: string,
    agentId: string,
    codexThreadId: string | null,
    owner?: WorkspaceOwner,
    orchestrationId?: string,
  ): Promise<void> {
    const ownerWithoutEpoch =
      owner === undefined ? undefined : { workspaceOperationId: owner.workspaceOperationId };
    this.leaseCoordinator.assertProjectMutationAllowed(projectId, ownerWithoutEpoch);
    await this.store.mutate((database) => {
      this.leaseCoordinator.assertProjectMutationAllowed(projectId, ownerWithoutEpoch);
      const project = database.projects.find((item) => item.id === projectId);
      // A restore advanced the epoch after this turn was accepted: its thread
      // remembers files that are gone, so the cleared pointer is kept.
      if (
        owner?.workspaceEpoch !== undefined &&
        (project?.workspaceEpoch ?? 0) !== owner.workspaceEpoch
      ) {
        return;
      }
      const attachment = database.projectAgents.find(
        (item) => item.projectId === projectId && item.agentId === agentId,
      );
      if (attachment) {
        if (orchestrationId === undefined) {
          attachment.codexThreadId = codexThreadId;
        } else {
          attachment.orchestrationThreadId = codexThreadId;
          attachment.orchestrationThreadScope = orchestrationId;
        }
      }
      if (project) project.updatedAt = now();
    });
  }

  /**
   * Brings the shared workspace contract current before a turn runs.
   *
   * The acting Agent's identity is no longer written here: a shared directory
   * cannot represent one of several Team Agents, and the per-run runtime
   * context delivers identity and standing guidance instead. The lease still
   * wraps this call because the turn that follows edits shared files, and
   * because a migrating write must not race another turn.
   */
  async prepareTurn(
    project: Project,
    agent: Agent,
    operation: OperationOptions = {},
    owner?: WorkspaceOwner,
  ): Promise<void> {
    assertOperationActive(operation);
    // The contract refresh below writes into the live workspace; the owning
    // cycle is admitted, any other caller is not.
    if (this.operations) {
      this.operations.assertAdmission(this.store.snapshot(), project.id, owner);
    }
    await this.authorization.require({
      principal: { kind: "agent", id: agent.id },
      permission: "project.write",
      projectId: project.id,
      agentId: agent.id,
      resource: { kind: "project", id: project.id },
    });
    assertOperationActive(operation);
    // Identity, skills, and capability state are all composed by
    // AgentRuntimePromptComposer immediately before execution, so this file
    // depends on nothing about the acting Agent and is usually left untouched.
    if (!(await this.workspaces.hasWorkspaceDirectory(project))) {
      throw this.workspaceRecoveryRequired();
    }
    const contractResult = await this.workspaces.ensureWorkspaceContract(project, operation);
    if (contractResult === "workspace_missing") {
      throw this.workspaceRecoveryRequired();
    }
  }

  // ------------------------------------------------------------ write leases

  /**
   * Acquires the single-writer lease, waiting briefly if another turn holds it.
   *
   * Ordinary overlap — a Playground turn while a Team run is routing — resolves
   * itself within the wait. Genuine contention surfaces a stable PROJECT_BUSY
   * rather than blocking forever.
   */
  async acquireWriteLease(
    projectId: string,
    agentId: string,
    runId: string,
    options: ProjectWriteLeaseOptions = {},
  ): Promise<void> {
    await this.leaseCoordinator.acquire(projectId, agentId, runId, options);
  }

  /** Idempotent; safe to call from a `finally` on a known-settled path. */
  async releaseWriteLease(
    projectId: string,
    runId: string,
    options: { settled?: boolean } = {},
  ): Promise<void> {
    await this.leaseCoordinator.release(projectId, runId, options);
  }

  writeLeaseHolder(projectId: string): { agentId: string; runId: string } | null {
    return this.leaseCoordinator.writeLeaseHolder(projectId);
  }

  /** Guard Project-owned mutations during archive or compensation. */
  assertProjectMutationAllowed(projectId: string): void {
    this.leaseCoordinator.assertProjectMutationAllowed(projectId);
  }

  /** Operator-facing status for a Project whose settled lease needs repair. */
  recoveryRequired(projectId: string): boolean {
    return this.leaseCoordinator.isRecoveryRequired(projectId);
  }

  recoveryStatus(projectId: string) {
    return this.leaseCoordinator.recoveryStatus(projectId);
  }

  // ---------------------------------------------------------------- internals

  private projectView(
    project: Project,
    memberships: readonly ProjectAgentAttachment[] | readonly string[] | readonly ProjectMembershipView[],
  ): ProjectView {
    const capability = this.checkpoints?.capability();
    const recoveryGate = this.operations?.recoveryGate(project.id) ?? null;
    return publicProject(project, memberships, {
      recoveryRequired: this.leaseCoordinator.isRecoveryRequired(project.id) || recoveryGate !== null,
      ...(capability === undefined || !capability.enabled
        ? {}
        : {
            workspaceCheckpoints: {
              enabled: true,
              available: capability.available,
              busy: this.operations?.heldOperation(project.id) !== null,
              recoveryRequired: recoveryGate !== null,
              workspaceEpoch: project.workspaceEpoch ?? 0,
            },
          }),
    });
  }

  private workspaceRecoveryRequired(): ProjectError {
    return new ProjectError(
      "PROJECT_WORKSPACE_INVALID",
      422,
      "The active Project workspace is missing; operator recovery is required before another Agent can write",
    );
  }

  private assertNoActiveProjectConversations(projectId: string): void {
    const active = this.store.snapshot().orchestrations.some(
      (session) => session.projectId === projectId && statusIsActiveSession(session.status),
    );
    if (active) {
      throw new ProjectError(
        "PROJECT_BUSY",
        409,
        "Stop the active Conversation before changing this Workspace",
      );
    }
  }

  private assertNoActiveProjectPreview(projectId: string): void {
    const active = this.store.snapshot().previews.some(
      (preview) =>
        preview.projectId === projectId &&
        (statusIsActiveSession(preview.status) || preview.runtimeId !== null),
    );
    if (active) {
      throw new ProjectError(
        "PROJECT_BUSY",
        409,
        "Stop the active Workspace preview before changing this Workspace",
      );
    }
  }

  /**
   * Restore only records owned by one Project. Unrelated concurrent store
   * changes stay intact, while deleted children and access projections return
   * to the post-stop state used for a safe retry.
   */
  private async restoreProjectSnapshot(
    snapshot: Database,
    projectId: string,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const childIds = new Set(
        snapshot.orchestrations
          .filter((session) => session.projectId === projectId)
          .map((session) => session.id),
      );
      database.projects = database.projects
        .filter((item) => item.id !== projectId)
        .concat(
          snapshot.projects
            .filter((item) => item.id === projectId)
            .map((item) => structuredClone(item)),
        );
      database.projectAgents = database.projectAgents
        .filter((item) => item.projectId !== projectId)
        .concat(
          snapshot.projectAgents
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.projectLeases = database.projectLeases
        .filter((item) => item.projectId !== projectId)
        .concat(
          snapshot.projectLeases
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.orchestrations = database.orchestrations
        .filter((item) => item.projectId !== projectId && !childIds.has(item.id))
        .concat(
          snapshot.orchestrations
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.orchestrationTurns = database.orchestrationTurns
        .filter((item) => !childIds.has(item.sessionId))
        .concat(
          snapshot.orchestrationTurns
            .filter((item) => childIds.has(item.sessionId))
            .map((item) => structuredClone(item)),
        );
      database.orchestrationEvents = database.orchestrationEvents
        .filter((item) => !childIds.has(item.sessionId))
        .concat(
          snapshot.orchestrationEvents
            .filter((item) => childIds.has(item.sessionId))
            .map((item) => structuredClone(item)),
        );
      database.orchestrationContinuationPrompts = database.orchestrationContinuationPrompts
        .filter((item) => !childIds.has(item.sessionId))
        .concat(
          snapshot.orchestrationContinuationPrompts
            .filter((item) => childIds.has(item.sessionId))
            .map((item) => structuredClone(item)),
        );
      database.previews = database.previews
        .filter((item) => item.projectId !== projectId)
        .concat(
          snapshot.previews
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.approvalRequests = database.approvalRequests
        .filter((item) => item.projectId !== projectId)
        .concat(
          snapshot.approvalRequests
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.capabilityGrants = database.capabilityGrants
        .filter((item) => item.projectId !== projectId)
        .concat(
          snapshot.capabilityGrants
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.permitApprovalCorrelations = database.permitApprovalCorrelations
        .filter((item) => item.projectId !== projectId)
        .concat(
          snapshot.permitApprovalCorrelations
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      // Checkpoint records are Project-owned evidence. Restore them with the
      // rest, but never resurrect an operation accepted after the snapshot.
      const acceptedSince = new Set(
        database.workspaceOperations
          .filter((item) => item.projectId === projectId)
          .filter((item) => !snapshot.workspaceOperations.some((prior) => prior.id === item.id))
          .map((item) => item.id),
      );
      database.workspaceCheckpoints = database.workspaceCheckpoints
        .filter((item) => item.projectId !== projectId || acceptedSince.has(item.operationId))
        .concat(
          snapshot.workspaceCheckpoints
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.workspaceExecutionCycles = database.workspaceExecutionCycles
        .filter((item) => item.projectId !== projectId || acceptedSince.has(item.operationId))
        .concat(
          snapshot.workspaceExecutionCycles
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
      database.workspaceOperations = database.workspaceOperations
        .filter((item) => item.projectId !== projectId || acceptedSince.has(item.id))
        .concat(
          snapshot.workspaceOperations
            .filter((item) => item.projectId === projectId)
            .map((item) => structuredClone(item)),
        );
    });
  }

  private attachedAgentIds(projectId: string): string[] {
    return this.attachedMemberships(projectId).map((membership) => membership.agentId);
  }

  private attachedMemberships(projectId: string): ProjectMembershipView[] {
    return this.store
      .snapshot()
      .projectAgents.filter((item) => item.projectId === projectId)
      .sort((left, right) => left.attachedAt.localeCompare(right.attachedAt))
      .map((item) => ({
        agentId: item.agentId,
        role: item.role ?? DEFAULT_PROJECT_ROLE,
      }));
  }

  private requireProject(projectId: string): Project {
    const project = this.store
      .snapshot()
      .projects.find((item) => item.id === projectId);
    if (!project) {
      throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
    }
    return project;
  }

  private requireActiveProject(projectId: string): Project {
    const project = this.requireProject(projectId);
    if (project.status !== "active") {
      throw new ProjectError("PROJECT_ARCHIVED", 409, "This Project is archived");
    }
    return project;
  }
}
