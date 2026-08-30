import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";
import { createBuiltInSkillRegistry } from "../../../apps/server/src/skills/index.js";
import { SkillService } from "../../../apps/server/src/skills/skill-service.js";
import type { AuthorizationRequest, AuthorizationService } from "../../../apps/server/src/access/authorization-service.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { Agent } from "../../../apps/server/src/types.js";
import type {
  ToolCapabilitiesView,
  ToolMetadata,
} from "../../../apps/server/src/tools/tool-types.js";
import { WorkspaceManager } from "../../../apps/server/src/workspace.js";
import { ProjectWorkspaceManager } from "../../../apps/server/src/projects/project-workspace.js";
import type { Project } from "../../../apps/server/src/projects/project-types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const metadata: ToolMetadata[] = [
  {
    id: "project.preview.inspect",
    title: "Inspect Project Preview",
    description: "Inspect the preview",
    risk: "read",
    requiredPermission: "tool.execute:project.preview.inspect",
  },
  {
    id: "project.preview.restart",
    title: "Restart Project Preview",
    description: "Restart the preview",
    risk: "write",
    requiredPermission: "tool.execute:project.preview.restart",
  },
  {
    id: "web.search",
    title: "Web Search",
    description: "Search the web",
    risk: "network",
    requiredPermission: "tool.execute:web.search",
  },
];

const agentFor = (skillIds: string[]): Agent => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Researcher",
  description: "",
  instructions: "",
  skillIds,
  status: "ready",
  workspacePath: "/private/should-not-be-rendered",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
});

describe("SkillService", () => {
  it("registers only the four code-owned built-in skills", () => {
    const registry = createBuiltInSkillRegistry();
    expect(registry.list().map((skill) => skill.id)).toEqual([
      "code-review",
      "debug-build",
      "frontend-react",
      "research",
    ]);
    expect(registry.get("research")?.requiredToolIds).toEqual(["web.search"]);
  });

  it("validates assignments without creating capability grants", () => {
    const service = new SkillService(createBuiltInSkillRegistry(), {
      listMetadata: () => metadata,
      listCapabilities: async () => ({
        agentId: "agent",
        projectId: "project",
        tools: [],
      }),
    });
    expect(service.validateSkillIds(["research", "research"])).toEqual(["research"]);
    expect(() => service.validateSkillIds(["not-a-skill"])).toThrow("Skill not found");
  });

  it("authorizes human catalog, read, and assignment operations without accepting a principal", async () => {
    const requests: AuthorizationRequest[] = [];
    const authorization: AuthorizationService = {
      decide: async () => ({ result: "allow", reason: "test" }),
      require: async (request) => {
        requests.push(request);
      },
    };
    const service = new SkillService(
      createBuiltInSkillRegistry(),
      {
        listMetadata: () => metadata,
        listCapabilities: async () => ({ agentId: "agent", projectId: null, tools: [] }),
      },
      authorization,
    );

    await service.list();
    await service.get("research");
    await service.readAgentSkills(agentFor(["research"]));
    await service.authorizeAssignment(
      ["research", "code-review"],
      ["research", "debug-build"],
      "agent-id",
    );

    expect(requests.map((request) => request.permission)).toEqual([
      "skill.read",
      "skill.read",
      "skill.read",
      "skill.assign",
      "skill.assign",
      "skill.assign",
    ]);
    expect(requests.map((request) => request.principal)).toEqual([
      { kind: "human", id: "demo-owner" },
      { kind: "human", id: "demo-owner" },
      { kind: "human", id: "demo-owner" },
      { kind: "human", id: "demo-owner" },
      { kind: "human", id: "demo-owner" },
      { kind: "human", id: "demo-owner" },
    ]);
    expect(requests.slice(0, 3).map((request) => request.resource)).toEqual([
      { kind: "skill", id: "catalog" },
      { kind: "skill", id: "research" },
      { kind: "skill", id: "catalog" },
    ]);
    expect(requests.slice(-3).map((request) => request.resource)).toEqual([
      { kind: "skill", id: "research" },
      { kind: "skill", id: "code-review" },
      { kind: "skill", id: "debug-build" },
    ]);
    expect(requests.at(-1)?.context).toEqual({ agentId: "agent-id" });
  });

  it("reconciles unknown legacy Agent skill IDs while preserving known assignments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-reconcile-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    await store.mutate((database) => {
      database.agents.push(agentFor(["research", "legacy-skill", "research", "unknown"]));
    });
    const service = new SkillService(createBuiltInSkillRegistry(), {
      listMetadata: () => metadata,
      listCapabilities: async () => ({ agentId: "agent", projectId: null, tools: [] }),
    });

    await service.reconcileAgentSkillIds(store);

    expect(store.snapshot().agents[0]?.skillIds).toEqual(["research"]);
    await expect(service.forAgent(store.snapshot().agents[0]!)).resolves.toMatchObject({
      skillIds: ["research"],
    });
  });

  it("projects required tools using current availability", async () => {
    const service = new SkillService(createBuiltInSkillRegistry(), {
      listMetadata: () => metadata,
      listCapabilities: async (): Promise<ToolCapabilitiesView> => ({
        agentId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        tools: metadata.map((tool) => ({
          tool,
          availability: tool.id === "web.search" ? "approval_required" : "available",
          reason: tool.id === "web.search" ? "An active Project grant is required" : "role allows",
          grant: null,
        })),
      }),
    });
    const view = await service.forAgent(
      agentFor(["research", "debug-build"]),
      "22222222-2222-4222-8222-222222222222",
    );
    expect(view.skills.map((skill) => skill.id)).toEqual(["research", "debug-build"]);
    expect(view.skills[0]?.capabilities[0]).toMatchObject({
      toolId: "web.search",
      availability: "approval_required",
    });
    expect(view.skills[1]?.capabilities.map((item) => item.availability)).toEqual([
      "available",
      "available",
    ]);
  });

  it("composes assigned skill guidance and omits unassigned skills", async () => {
    const service = new SkillService(createBuiltInSkillRegistry(), {
      listMetadata: () => metadata,
      listCapabilities: async () => ({
        agentId: "agent",
        projectId: null,
        tools: [],
      }),
    });
    const context = await service.runtimeContext(agentFor(["research"]));
    expect(context.lines.join("\n")).toContain("<platform_skills>");
    expect(context.lines.join("\n")).toContain('skill.research = "Research"');
    expect(context.lines.join("\n")).not.toContain("Frontend React");
    expect(context.lines.join("\n")).not.toContain("/private/should-not-be-rendered");
  });

  it("writes only the acting Agent's assigned skills to private and Project instructions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "skill-instructions-"));
    temporaryDirectories.push(root);
    const service = new SkillService(createBuiltInSkillRegistry(), {
      listMetadata: () => metadata,
      listCapabilities: async () => ({
        agentId: "agent",
        projectId: null,
        tools: [],
      }),
    });
    const agent = agentFor(["research"]);
    const context = await service.runtimeContext(agent);
    const privateAgent = {
      ...agent,
      workspacePath: path.join(root, "private", agent.id),
    };
    const privateWorkspaces = new WorkspaceManager(path.join(root, "private"));
    await privateWorkspaces.initialize();
    await privateWorkspaces.create(privateAgent, context);
    const privateInstructions = await readFile(
      path.join(privateAgent.workspacePath, "AGENTS.md"),
      "utf8",
    );
    expect(privateInstructions).toContain("### Research");
    expect(privateInstructions).not.toContain("### Frontend React");

    const project: Project = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Shared Project",
      description: "",
      workspacePath: path.join(root, "projects", "shared", "workspace"),
      teamId: null,
      ownerPrincipalId: "demo-owner",
      status: "active",
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
    const projectWorkspaces = new ProjectWorkspaceManager(path.join(root, "projects"));
    await projectWorkspaces.initialize();
    await projectWorkspaces.create(project);
    await projectWorkspaces.writeTurnInstructions(project, agent, context);
    const projectInstructions = await readFile(
      path.join(project.workspacePath, "AGENTS.md"),
      "utf8",
    );
    expect(projectInstructions).toContain("### Research");
    expect(projectInstructions).not.toContain("### Frontend React");
    expect(projectInstructions).not.toContain(agent.workspacePath);
  });
});
