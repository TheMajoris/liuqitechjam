import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultAuthorizationService } from "../../../apps/server/src/access/default-authorization-service.js";
import { OrchestrationService } from "../../../apps/server/src/orchestration/orchestration-service.js";
import { PlatformAgentInvoker } from "../../../apps/server/src/orchestration/platform-agent-invoker.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { Agent } from "../../../apps/server/src/types.js";
import { ProjectService } from "../../../apps/server/src/projects/project-service.js";
import { ProjectWorkspaceManager } from "../../../apps/server/src/projects/project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function agentFor(id: string): Agent {
  const timestamp = new Date().toISOString();
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/agents/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const FE = "11111111-1111-4111-8111-111111111111";
const BUILDER = "22222222-2222-4222-8222-222222222222";

const agents = {
  getAgent: (id: string) => agentFor(id),
  listAgents: () => [agentFor(FE), agentFor(BUILDER)],
};

async function makeStack() {
  const root = await mkdtemp(path.join(tmpdir(), "project-orch-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const projectService = new ProjectService(
    store,
    new ProjectWorkspaceManager(path.join(root, "projects")),
    agents,
    new DefaultAuthorizationService(),
  );
  await projectService.initialize();
  const orchestration = new OrchestrationService({
    store,
    agents,
    projectBinding: {
      async bindConversation(projectId, conversationId, agentIds) {
        await projectService.bindConversation(projectId, conversationId, agentIds);
      },
    },
  });
  projectService.setConversationLifecycle({
    async removeForProject(projectId) {
      await orchestration.removeSessionsForProject(projectId);
    },
  });
  await orchestration.initialize();
  return { orchestration, projectService, store };
}

function participants() {
  return [
    { id: "p1", agentId: FE, role: "builder", position: 0 },
    { id: "p2", agentId: BUILDER, role: "reviewer", position: 1 },
  ];
}

describe("Team attached to a shared Project", () => {
  it("binds the Team and every participant Agent on creation", async () => {
    const { orchestration, projectService } = await makeStack();
    const project = await projectService.create({ name: "Todo App" });

    const session = await orchestration.createSession({
      name: "Build the todo app",
      originalPrompt: "Create a todo-list app. Have fe builder2 help fe.",
      participants: participants(),
      projectId: project.id,
      maxSteps: 4,
      perAgentTimeoutMs: 60_000,
    });

    expect(session.projectId).toBe(project.id);
    const bound = await projectService.get(project.id);
    expect(bound.teamId).toBe(session.id);
    expect(bound.agentIds.sort()).toEqual([FE, BUILDER].sort());
  });

  it("attaches a participant Agent only once across repeat occurrences", async () => {
    const { orchestration, projectService } = await makeStack();
    const project = await projectService.create({ name: "Todo App" });

    await orchestration.createSession({
      name: "Solo with repeats",
      originalPrompt: "iterate twice",
      participants: [
        { id: "p1", agentId: FE, role: "first", position: 0 },
        { id: "p2", agentId: FE, role: "second", position: 1 },
      ],
      projectId: project.id,
      maxSteps: 4,
      perAgentTimeoutMs: 60_000,
    });

    expect((await projectService.get(project.id)).agentIds).toEqual([FE]);
  });

  it("leaves a Team without a Project completely unbound", async () => {
    const { orchestration, projectService } = await makeStack();
    const project = await projectService.create({ name: "Untouched" });

    const session = await orchestration.createSession({
      name: "Text-only team",
      originalPrompt: "just talk",
      participants: participants(),
      maxSteps: 4,
      perAgentTimeoutMs: 60_000,
    });

    expect(session.projectId).toBeUndefined();
    const untouched = await projectService.get(project.id);
    expect(untouched.teamId).toBeNull();
    expect(untouched.agentIds).toEqual([]);
  });

  it("refuses to create a Team on a Project that does not exist", async () => {
    const { orchestration } = await makeStack();

    await expect(
      orchestration.createSession({
        name: "Bad project",
        originalPrompt: "nope",
        participants: participants(),
        projectId: "33333333-3333-4333-8333-333333333333",
        maxSteps: 4,
        perAgentTimeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("keeps sibling conversations when one is deleted and archives all on Workspace deletion", async () => {
    const { orchestration, projectService, store } = await makeStack();
    const project = await projectService.create({ name: "Shared Workspace" });

    const first = await orchestration.createSession({
      name: "First conversation",
      originalPrompt: "Set up the project",
      participants: participants(),
      projectId: project.id,
      maxSteps: 4,
      perAgentTimeoutMs: 60_000,
    });
    const sibling = await orchestration.createSession({
      name: "Second conversation",
      originalPrompt: "Review the project",
      participants: participants(),
      projectId: project.id,
      maxSteps: 4,
      perAgentTimeoutMs: 60_000,
    });

    await orchestration.deleteSession(first.id);
    expect((await projectService.get(project.id)).status).toBe("active");
    expect((await orchestration.listSessions()).map((session) => session.id)).toEqual([
      sibling.id,
    ]);

    const archived = await projectService.archive(project.id);
    expect(await orchestration.listSessions()).toEqual([]);
    expect(store.snapshot().orchestrations).toEqual([]);
    expect((await projectService.list()).some((item) => item.id === project.id)).toBe(false);
    expect((await stat(archived.archivedWorkspace)).isDirectory()).toBe(true);
  });
});

describe("PlatformAgentInvoker Project scope", () => {
  const run = { id: "run-1", status: "completed", output: "done" };

  function bridge() {
    return {
      sendMessage: vi.fn().mockResolvedValue({ run, message: {} }),
      waitForRun: vi.fn().mockResolvedValue(run),
      cancelRun: vi.fn().mockResolvedValue(run),
    };
  }

  it("forwards the Project scope to AgentService", async () => {
    const service = bridge();
    const invoker = new PlatformAgentInvoker(service as never);

    await invoker.invoke({
      agentId: FE,
      prompt: "build it",
      projectId: "project-1",
      timeoutMs: 1_000,
    });

    expect(service.sendMessage).toHaveBeenCalledWith(FE, "build it", {
      origin: "orchestration",
      projectId: "project-1",
    });
  });

  it("tags an unscoped Team turn without adding a Project scope", async () => {
    const service = bridge();
    const invoker = new PlatformAgentInvoker(service as never);

    await invoker.invoke({ agentId: FE, prompt: "build it", timeoutMs: 1_000 });

    expect(service.sendMessage).toHaveBeenCalledWith(FE, "build it", {
      origin: "orchestration",
    });
  });
});
