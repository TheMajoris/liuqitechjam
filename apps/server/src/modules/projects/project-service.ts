import { randomUUID } from "node:crypto";
import { HttpError } from "../../errors.js";
import type { JsonStore } from "../../store.js";
import type { Project, ProjectRoles } from "../../types.js";
import { ProjectWorkspaceManager } from "./project-workspace.js";

const now = (): string => new Date().toISOString();

export interface CreateProjectInput {
  name: string;
  description?: string | undefined;
  roles: ProjectRoles;
}

export interface UpdateProjectInput {
  name?: string | undefined;
  description?: string | undefined;
  roles?: ProjectRoles | undefined;
}

/**
 * Project CRUD plus ownership of the shared workspace lifecycle.
 *
 * Invariants enforced here (see `tasks/plan.md` section 7):
 *  - Planner, Builder, and Reviewer must be three distinct, existing Agents.
 *  - The workspace path always sits under the configured project root.
 *  - Archiving a Project archives its workspace; Agents never own it.
 */
export class ProjectService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: ProjectWorkspaceManager,
  ) {}

  async initialize(): Promise<void> {
    await this.workspaces.initialize();
  }

  list(): Project[] {
    return this.store
      .snapshot()
      .projects.slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Project {
    const project = this.store.snapshot().projects.find((p) => p.id === id);
    if (!project) {
      throw new HttpError(404, "Project not found");
    }
    return project;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const roles = this.validateRoles(input.roles);
    const id = randomUUID();
    const workspacePath = await this.workspaces.create(id, input.name.trim());
    const timestamp = now();
    const project: Project = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      workspacePath,
      roles,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.projects.push(project);
    });
    return project;
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const nextRoles = input.roles ? this.validateRoles(input.roles) : undefined;
    return this.store.mutate((database) => {
      const project = database.projects.find((p) => p.id === id);
      if (!project) {
        throw new HttpError(404, "Project not found");
      }
      if (project.status === "archived") {
        throw new HttpError(409, "Archived projects cannot be edited");
      }
      if (input.name !== undefined) project.name = input.name.trim();
      if (input.description !== undefined) {
        project.description = input.description.trim();
      }
      if (nextRoles) project.roles = nextRoles;
      project.updatedAt = now();
      return structuredClone(project);
    });
  }

  async archive(id: string): Promise<{ project: Project; archivedWorkspace: string }> {
    const existing = this.get(id);
    if (existing.status === "archived") {
      throw new HttpError(409, "Project is already archived");
    }
    const archivedWorkspace = await this.workspaces.archive(id);
    const project = await this.store.mutate((database) => {
      const found = database.projects.find((p) => p.id === id);
      if (!found) {
        throw new HttpError(404, "Project not found");
      }
      found.status = "archived";
      found.workspacePath = archivedWorkspace;
      found.updatedAt = now();
      return structuredClone(found);
    });
    return { project, archivedWorkspace };
  }

  private validateRoles(roles: ProjectRoles): ProjectRoles {
    const { plannerAgentId, builderAgentId, reviewerAgentId } = roles;
    const ids = [plannerAgentId, builderAgentId, reviewerAgentId];
    if (new Set(ids).size !== 3) {
      throw new HttpError(
        422,
        "Planner, Builder, and Reviewer must be three distinct Agents",
      );
    }
    const agents = this.store.snapshot().agents;
    for (const id of ids) {
      if (!agents.some((agent) => agent.id === id)) {
        throw new HttpError(422, `Role Agent ${id} does not exist`);
      }
    }
    return { plannerAgentId, builderAgentId, reviewerAgentId };
  }
}
