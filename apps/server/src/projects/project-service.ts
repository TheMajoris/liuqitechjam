import { randomUUID } from "node:crypto";
import type { AuthorizationService } from "../access/authorization-service.js";
import type { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { ProjectError } from "./project-errors.js";
import { ProjectWorkspaceManager } from "./project-workspace.js";
import {
  PROJECT_LIMITS,
  type CreateProjectInput,
  type Project,
  type ProjectView,
  type UpdateProjectInput,
} from "./project-types.js";

const now = (): string => new Date().toISOString();

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

export function publicProject(
  project: Project,
  agentIds: readonly string[],
): ProjectView {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    teamId: project.teamId,
    agentIds: [...agentIds],
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
  /** In-process waiters for a held write lease, keyed by project ID. */
  private readonly leaseWaiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: ProjectWorkspaceManager,
    private readonly agents: ProjectAgentDirectory,
    private readonly authorization: AuthorizationService,
    private readonly onEvent: ProjectEventSink = () => undefined,
  ) {}

  /**
   * Releases leases orphaned by a server restart.
   *
   * A lease only ever guards a live run; nothing in-flight survives a restart,
   * so any persisted lease at boot is stale by definition.
   */
  async initialize(): Promise<void> {
    await this.workspaces.initialize();
    const stale = this.store.snapshot().projectLeases;
    if (stale.length === 0) return;
    await this.store.mutate((database) => {
      database.projectLeases = [];
    });
    for (const lease of stale) {
      this.onEvent({
        type: "project_write_lease_released",
        projectId: lease.projectId,
        agentId: lease.agentId,
        runId: lease.runId,
        status: "reconciled",
      });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async create(input: CreateProjectInput): Promise<ProjectView> {
    await this.authorization.require({ permission: "project.write" });
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
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(project);
    await this.store.mutate((database) => {
      database.projects.push(project);
    });
    this.onEvent({ type: "project_created", projectId: id, status: "active" });
    return publicProject(project, []);
  }

  async list(): Promise<ProjectView[]> {
    await this.authorization.require({ permission: "project.read" });
    const database = this.store.snapshot();
    return database.projects
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((project) => publicProject(project, this.attachedAgentIds(project.id)));
  }

  async get(projectId: string): Promise<ProjectView> {
    await this.authorization.require({ permission: "project.read", projectId });
    const project = this.requireProject(projectId);
    return publicProject(project, this.attachedAgentIds(projectId));
  }

  async update(projectId: string, input: UpdateProjectInput): Promise<ProjectView> {
    await this.authorization.require({ permission: "project.write", projectId });
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
    const updated = await this.store.mutate((database) => {
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      if (name !== undefined) stored.name = name;
      if (description !== undefined) stored.description = description;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
    return publicProject(updated, this.attachedAgentIds(projectId));
  }

  /**
   * Archives a Project: attachments and leases are dropped, but the shared
   * workspace is moved aside rather than deleted. Hackathon-safe by default.
   */
  async archive(projectId: string): Promise<{ archivedWorkspace: string }> {
    await this.authorization.require({ permission: "project.write", projectId });
    const project = this.requireProject(projectId);
    const archivedWorkspace = await this.workspaces.archive(project);
    await this.store.mutate((database) => {
      const stored = database.projects.find((item) => item.id === projectId);
      if (stored) {
        stored.status = "archived";
        stored.teamId = null;
        stored.updatedAt = now();
      }
      database.projectAgents = database.projectAgents.filter(
        (item) => item.projectId !== projectId,
      );
      database.projectLeases = database.projectLeases.filter(
        (item) => item.projectId !== projectId,
      );
    });
    this.onEvent({ type: "project_archived", projectId, status: "archived" });
    return { archivedWorkspace };
  }

  // --------------------------------------------------------------- attachment

  async attachAgent(projectId: string, agentId: string): Promise<ProjectView> {
    await this.authorization.require({ permission: "project.write", projectId, agentId });
    const project = this.requireActiveProject(projectId);
    this.agents.getAgent(agentId);
    if (this.attachedAgentIds(projectId).includes(agentId)) {
      throw new ProjectError(
        "PROJECT_AGENT_ALREADY_ATTACHED",
        409,
        "That Agent is already attached to this Project",
      );
    }
    await this.store.mutate((database) => {
      database.projectAgents.push({
        projectId,
        agentId,
        codexThreadId: null,
        attachedAt: now(),
      });
    });
    this.onEvent({
      type: "project_agent_attached",
      projectId,
      agentId,
      status: "attached",
    });
    return publicProject(project, this.attachedAgentIds(projectId));
  }

  /** Detaching drops the shared-scope thread; Project files are untouched. */
  async detachAgent(projectId: string, agentId: string): Promise<ProjectView> {
    await this.authorization.require({ permission: "project.write", projectId, agentId });
    const project = this.requireProject(projectId);
    await this.store.mutate((database) => {
      database.projectAgents = database.projectAgents.filter(
        (item) => !(item.projectId === projectId && item.agentId === agentId),
      );
    });
    this.onEvent({
      type: "project_agent_detached",
      projectId,
      agentId,
      status: "detached",
    });
    return publicProject(project, this.attachedAgentIds(projectId));
  }

  async attachTeam(projectId: string, teamId: string): Promise<ProjectView> {
    await this.authorization.require({ permission: "project.write", projectId });
    this.requireActiveProject(projectId);
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
    this.onEvent({
      type: "project_team_attached",
      projectId,
      teamId,
      status: "attached",
    });
    return publicProject(updated, this.attachedAgentIds(projectId));
  }

  async detachTeam(projectId: string): Promise<ProjectView> {
    await this.authorization.require({ permission: "project.write", projectId });
    const updated = await this.store.mutate((database) => {
      const stored = database.projects.find((item) => item.id === projectId);
      if (!stored) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
      stored.teamId = null;
      stored.updatedAt = now();
      return structuredClone(stored);
    });
    return publicProject(updated, this.attachedAgentIds(projectId));
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
    await this.workspaces.writeTurnInstructions(project, agent);
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
    options: { waitMs?: number } = {},
  ): Promise<void> {
    const waitMs = options.waitMs ?? PROJECT_LIMITS.writeLeaseWaitMs;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const acquired = await this.store.mutate((database) => {
        const held = database.projectLeases.find((item) => item.projectId === projectId);
        if (held) return false;
        database.projectLeases.push({
          projectId,
          agentId,
          runId,
          acquiredAt: now(),
        });
        return true;
      });
      if (acquired) {
        this.onEvent({
          type: "project_write_lease_acquired",
          projectId,
          agentId,
          runId,
          status: "held",
        });
        return;
      }
      if (Date.now() >= deadline) {
        throw new ProjectError(
          "PROJECT_BUSY",
          409,
          "Another Agent is currently writing to this Project",
        );
      }
      await this.waitForRelease(projectId, deadline);
    }
  }

  /** Idempotent; safe to call from a `finally` on any completion path. */
  async releaseWriteLease(projectId: string, runId: string): Promise<void> {
    const released = await this.store.mutate((database) => {
      const held = database.projectLeases.find(
        (item) => item.projectId === projectId && item.runId === runId,
      );
      if (!held) return null;
      database.projectLeases = database.projectLeases.filter(
        (item) => !(item.projectId === projectId && item.runId === runId),
      );
      return held;
    });
    this.notifyRelease(projectId);
    if (released) {
      this.onEvent({
        type: "project_write_lease_released",
        projectId,
        agentId: released.agentId,
        runId,
        status: "released",
      });
    }
  }

  writeLeaseHolder(projectId: string): { agentId: string; runId: string } | null {
    const held = this.store
      .snapshot()
      .projectLeases.find((item) => item.projectId === projectId);
    return held ? { agentId: held.agentId, runId: held.runId } : null;
  }

  // ---------------------------------------------------------------- internals

  private async waitForRelease(projectId: string, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const waiters = this.leaseWaiters.get(projectId) ?? new Set<() => void>();
    this.leaseWaiters.set(projectId, waiters);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        clearTimeout(timer);
        resolve();
      };
      // Poll as well as listen: a lease released by another process only shows
      // up in the store, and no in-process waiter would ever be notified.
      const timer = setTimeout(
        finish,
        Math.min(PROJECT_LIMITS.writeLeasePollIntervalMs, remaining),
      );
      waiters.add(finish);
    });
  }

  private notifyRelease(projectId: string): void {
    const waiters = this.leaseWaiters.get(projectId);
    if (!waiters) return;
    this.leaseWaiters.delete(projectId);
    for (const waiter of waiters) waiter();
  }

  private attachedAgentIds(projectId: string): string[] {
    return this.store
      .snapshot()
      .projectAgents.filter((item) => item.projectId === projectId)
      .sort((left, right) => left.attachedAt.localeCompare(right.attachedAt))
      .map((item) => item.agentId);
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

