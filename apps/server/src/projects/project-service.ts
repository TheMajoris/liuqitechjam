import { randomUUID } from "node:crypto";
import {
  DEMO_HUMAN_PRINCIPAL,
  type AuthorizationService,
} from "../access/authorization-service.js";
import type { Principal, ProjectRole } from "../access/access-types.js";
import type { Storage } from "../store.js";
import type { Agent, Database } from "../types.js";
import type { SkillRuntimeContext } from "../skills/skill-types.js";
import type { SkillService } from "../skills/skill-service.js";
import type { PermitDirectoryReconciliationSink } from "../access/permit-directory-reconciler.js";
import { ProjectError } from "./project-errors.js";
import { ProjectWorkspaceManager } from "./project-workspace.js";
import { ProjectWriteLeaseCoordinator } from "./project-write-lease-coordinator.js";
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
import { LEGACY_ROLE_IDS } from "../roles/role-types.js";

const now = (): string => new Date().toISOString();
const activeConversationStatuses = new Set(["queued", "running", "stopping"]);

function statusIsActiveSession(status: string): boolean {
  return activeConversationStatuses.has(status);
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
}) => void;

/** Narrow trusted seam for stopping a Project-owned Preview during archive. */
export interface ProjectPreviewLifecycleCleanup {
  stopForProject(projectId: string): Promise<void>;
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
): ProjectView {
  const memberships: ProjectMembershipView[] = (
    project.status === "archived" ? [] : membershipsOrAgentIds
  ).map((item) =>
    typeof item === "string"
      ? { agentId: item, role: "editor" }
      : {
          agentId: item.agentId,
          role: item.role ?? "editor",
          ...(item.roleId === undefined ? {} : { roleId: item.roleId }),
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
export class ProjectService {
  private readonly leaseCoordinator: ProjectWriteLeaseCoordinator;
  private skillService: SkillService | undefined;
  private permitDirectory: PermitDirectoryReconciliationSink | undefined;
  private conversationLifecycle: ProjectConversationLifecycleCleanup | undefined;

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

  /** Attach the Permit directory synchronization seam after app assembly. */
  setPermitDirectoryReconciler(
    reconciler: PermitDirectoryReconciliationSink,
  ): void {
    this.permitDirectory = reconciler;
  }

  /**
   * Releases leases orphaned by a server restart.
   *
   * A lease only ever guards a live run; nothing in-flight survives a restart,
   * so any persisted lease at boot is stale by definition.
   */
  async initialize(): Promise<void> {
    await this.workspaces.initialize();
    await this.leaseCoordinator.initialize();
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
      await this.permitDirectory?.reconcile();
      this.onEvent({ type: "project_created", projectId: id, status: "active" });
      return publicProject(project, []);
    } catch (error) {
      // Keep a Project out of the repository when its Permit resource could
      // not be created/synchronized; callers can retry the privileged action.
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
      .map((project) => publicProject(project, this.attachedMemberships(project.id)));
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
    return publicProject(project, this.attachedMemberships(projectId));
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
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      if (name !== undefined) stored.name = name;
      if (description !== undefined) stored.description = description;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
    try {
      await this.permitDirectory?.reconcile();
      return publicProject(updated, this.attachedMemberships(projectId));
    } catch (error) {
      await this.store.mutate((database) => {
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
      // safe snapshot if the subsequent filesystem or Permit operation fails;
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
        await this.permitDirectory?.reconcile();
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
        });
        await this.permitDirectory?.reconcile();
        this.onEvent({ type: "project_deleted", projectId, status: "deleted" });
        return { deleted: true };
      } catch (error) {
        // The JSON store mutation is atomic. If external Permit reconciliation
        // fails, restore the last safe post-stop snapshot and put the moved
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
  ): Promise<ProjectView> {
    await this.authorization.require({
      principal,
      permission: "project.members.manage",
      projectId,
      agentId,
      resource: { kind: "project", id: projectId },
    });
    const project = this.requireActiveProject(projectId);
    this.agents.getAgent(agentId);
    if (this.attachedAgentIds(projectId).includes(agentId)) {
      throw new ProjectError(
        "PROJECT_AGENT_ALREADY_ATTACHED",
        409,
        "That Agent is already attached to this Project",
      );
    }
    const attachedAt = now();
    const attachment: ProjectAgentAttachment = {
      projectId,
      agentId,
      codexThreadId: null,
      attachedAt,
      toolGrants: [],
      updatedAt: attachedAt,
    };
    try {
      await this.store.mutate((database) => {
        database.projectAgents.push(attachment);
      });
      await this.permitDirectory?.reconcile();
      this.onEvent({
        type: "project_agent_attached",
        projectId,
        agentId,
        status: "attached",
      });
      return publicProject(project, this.attachedMemberships(projectId));
    } catch (error) {
      await this.store.mutate((database) => {
        database.projectAgents = database.projectAgents.filter(
          (item) => !(item.projectId === projectId && item.agentId === agentId && item.attachedAt === attachedAt),
        );
      });
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
    const existing = this.store
      .snapshot()
      .projectAgents.find(
        (item) => item.projectId === projectId && item.agentId === agentId,
      );
    try {
      await this.store.mutate((database) => {
        database.projectAgents = database.projectAgents.filter(
          (item) => !(item.projectId === projectId && item.agentId === agentId),
        );
      });
      await this.permitDirectory?.reconcile();
      this.onEvent({
        type: "project_agent_detached",
        projectId,
        agentId,
        status: "detached",
      });
      return publicProject(project, this.attachedMemberships(projectId));
    } catch (error) {
      if (existing) {
        await this.store.mutate((database) => {
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
    const uniqueAgentIds = [...new Set(agentIds)];
    for (const agentId of uniqueAgentIds) this.agents.getAgent(agentId);

    const before = this.store.snapshot();
    const updated = await this.store.mutate((database) => {
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
      await this.permitDirectory?.reconcile();
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
      return publicProject(updated, this.attachedMemberships(projectId));
    } catch (error) {
      await this.store.mutate((database) => {
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
    const before = this.store.snapshot().projects.find((item) => item.id === projectId);
    const updated = await this.store.mutate((database) => {
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
      await this.permitDirectory?.reconcile();
      this.onEvent({
        type: "project_team_attached",
        projectId,
        teamId,
        status: "attached",
      });
      return publicProject(updated, this.attachedMemberships(projectId));
    } catch (error) {
      if (before) {
        await this.store.mutate((database) => {
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
    const before = this.store.snapshot().projects.find((item) => item.id === projectId);
    const updated = await this.store.mutate((database) => {
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      stored.teamId = null;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
    try {
      await this.permitDirectory?.reconcile();
      return publicProject(updated, this.attachedMemberships(projectId));
    } catch (error) {
      if (before) {
        await this.store.mutate((database) => {
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
    const before = this.store.snapshot();
    const updated = await this.store.mutate((database) => {
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
      attachment.role = parsedRole.data;
      attachment.roleId = LEGACY_ROLE_IDS[parsedRole.data];
      attachment.updatedAt = now();
      const project = database.projects.find((item) => item.id === projectId);
      if (!project) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      project.updatedAt = now();
      return structuredClone(project);
    });
    try {
      await this.permitDirectory?.reconcile();
      this.onEvent({
        type: "project_agent_role_changed",
        projectId,
        agentId,
        status: parsedRole.data,
      });
      return publicProject(updated, this.attachedMemberships(projectId));
    } catch (error) {
      await this.store.mutate((database) => {
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
    this.projectRunScope(projectId, agentId);
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
    return {
      project,
      workspacePath: project.workspacePath,
      codexThreadId: attachment.codexThreadId,
    };
  }

  /** Persists the resumable thread for this Agent's shared-Project scope. */
  async recordProjectThread(
    projectId: string,
    agentId: string,
    codexThreadId: string | null,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const attachment = database.projectAgents.find(
        (item) => item.projectId === projectId && item.agentId === agentId,
      );
      if (attachment) attachment.codexThreadId = codexThreadId;
      const project = database.projects.find((item) => item.id === projectId);
      if (project) project.updatedAt = now();
    });
  }

  /** Rewrites AGENTS.md so the acting Agent's identity applies to this turn. */
  async prepareTurn(project: Project, agent: Agent): Promise<void> {
    await this.authorization.require({
      principal: { kind: "agent", id: agent.id },
      permission: "project.write",
      projectId: project.id,
      agentId: agent.id,
      resource: { kind: "project", id: project.id },
    });
    let skillContext: SkillRuntimeContext | undefined;
    if (this.skillService) {
      try {
        skillContext = await this.skillService.runtimeContext(agent, project.id);
      } catch {
        // Capability metadata is additive context; a transient lookup failure
        // must not bypass the existing Project instruction safeguards.
      }
    }
    await this.workspaces.writeTurnInstructions(project, agent, skillContext);
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
    options: { waitMs?: number; principal?: Principal } = {},
  ): Promise<void> {
    await this.leaseCoordinator.acquire(projectId, agentId, runId, options);
  }

  /** Idempotent; safe to call from a `finally` on any completion path. */
  async releaseWriteLease(projectId: string, runId: string): Promise<void> {
    await this.leaseCoordinator.release(projectId, runId);
  }

  writeLeaseHolder(projectId: string): { agentId: string; runId: string } | null {
    return this.leaseCoordinator.writeLeaseHolder(projectId);
  }

  // ---------------------------------------------------------------- internals

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
        role: item.role ?? "editor",
        ...(item.roleId === undefined ? {} : { roleId: item.roleId }),
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
