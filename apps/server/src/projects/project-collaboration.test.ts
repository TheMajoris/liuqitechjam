import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultAuthorizationService } from "../access/default-authorization-service.js";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { ProjectServiceExecutionScope } from "./project-execution.js";
import { ProjectService } from "./project-service.js";
import { ProjectWorkspaceManager } from "./project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A runner that actually touches the filesystem it is handed.
 *
 * The whole point of this wave is which directory gets mounted, so the proof
 * has to be a real read and a real write, not a recorded argument.
 */
class FileWritingRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  /** Appended to app.txt; falls back to the acting Agent ID. */
  nextLine = "";

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    const target = path.join(request.workspacePath, "app.txt");
    const existing = await readFile(target, "utf8").catch(() => "");
    await writeFile(target, existing + (this.nextLine || request.agentId) + "\n", "utf8");
    const instructions = await readFile(
      path.join(request.workspacePath, "AGENTS.md"),
      "utf8",
    ).catch(() => "");
    return {
      output: "read:" + JSON.stringify(existing) + " agents:" + instructions.length,
      threadId: request.threadId ?? "thread-" + request.agentId,
      usage: null,
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function makeStack(runner: AgentRunner = new FileWritingRunner()) {
  const root = await mkdtemp(path.join(tmpdir(), "project-collab-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const agentService = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await agentService.initialize();
  const projectService = new ProjectService(
    store,
    new ProjectWorkspaceManager(path.join(root, "data", "projects")),
    agentService,
    new DefaultAuthorizationService(),
  );
  await projectService.initialize();
  agentService.setProjectExecutionScope(new ProjectServiceExecutionScope(projectService));
  return { agentService, projectService, runner, root };
}

async function runProjectTurn(
  agentService: AgentService,
  agentId: string,
  projectId: string,
  prompt: string,
) {
  const { run } = await agentService.sendMessage(agentId, prompt, { projectId });
  return agentService.waitForRun(run.id, { timeoutMs: 5_000 });
}

describe("Shared Project collaboration", () => {
  it("lets a second Agent read and modify the first Agent's Project files", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({ name: "fe" });
    const builder = await agentService.createAgent({ name: "fe builder2" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);
    await projectService.attachAgent(project.id, builder.id);

    runner.nextLine = "written-by-fe";
    const first = await runProjectTurn(agentService, fe.id, project.id, "build the app");
    expect(first.status).toBe("completed");

    runner.nextLine = "written-by-builder";
    const second = await runProjectTurn(
      agentService,
      builder.id,
      project.id,
      "improve the app",
    );
    expect(second.status).toBe("completed");

    // The second Agent saw the first Agent's file before writing its own line.
    expect(second.output).toContain('read:"written-by-fe\\n"');

    const scope = projectService.projectRunScope(project.id, fe.id);
    const shared = await readFile(path.join(scope.workspacePath, "app.txt"), "utf8");
    expect(shared).toBe("written-by-fe\nwritten-by-builder\n");

    // Neither Agent's private workspace received the shared artifact.
    await expect(
      readFile(path.join(agentService.getAgent(fe.id).workspacePath, "app.txt"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(agentService.getAgent(builder.id).workspacePath, "app.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("mounts the shared workspace and never the Agent's private one", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);
    const scope = projectService.projectRunScope(project.id, fe.id);

    await runProjectTurn(agentService, fe.id, project.id, "build it");

    expect(runner.requests[0]?.workspacePath).toBe(scope.workspacePath);
    expect(runner.requests[0]?.projectId).toBe(project.id);
    expect(runner.requests[0]?.workspacePath).not.toBe(
      agentService.getAgent(fe.id).workspacePath,
    );
  });

  it("gives each turn the acting Agent's own instructions", async () => {
    const { agentService, projectService } = await makeStack();
    const fe = await agentService.createAgent({
      name: "fe",
      instructions: "Build the initial implementation.",
    });
    const builder = await agentService.createAgent({
      name: "fe builder2",
      instructions: "Improve accessibility only.",
    });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);
    await projectService.attachAgent(project.id, builder.id);
    const { workspacePath } = projectService.projectRunScope(project.id, fe.id);
    const agentsFile = path.join(workspacePath, "AGENTS.md");

    await runProjectTurn(agentService, fe.id, project.id, "start");
    expect(await readFile(agentsFile, "utf8")).toContain("Build the initial implementation.");

    await runProjectTurn(agentService, builder.id, project.id, "polish");
    const afterSecond = await readFile(agentsFile, "utf8");
    expect(afterSecond).toContain("Improve accessibility only.");
    expect(afterSecond).toContain("You are the coding Agent named fe builder2.");
    expect(afterSecond).not.toContain("Build the initial implementation.");
  });

  it("keeps private and shared Codex sessions independent", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);

    // A private Playground turn establishes the Agent's own thread.
    const privateRun = await agentService.sendMessage(fe.id, "private work");
    await agentService.waitForRun(privateRun.run.id, { timeoutMs: 5_000 });
    const privateThread = agentService.listConversations(fe.id)[0]?.codexThreadId;
    expect(privateThread).toBe("thread-" + fe.id);

    await runProjectTurn(agentService, fe.id, project.id, "shared work");

    // The Project turn resumed nothing and left the private thread untouched.
    expect(runner.requests[1]?.threadId).toBeNull();
    expect(agentService.listConversations(fe.id)[0]?.codexThreadId).toBe(privateThread);
    expect(projectService.projectRunScope(project.id, fe.id).codexThreadId).toBe(
      "thread-" + fe.id,
    );

    // A later Project turn resumes the shared-scope thread, not the private one.
    await runProjectTurn(agentService, fe.id, project.id, "more shared work");
    expect(runner.requests[2]?.threadId).toBe("thread-" + fe.id);
  });

  it("gives the worker trusted Project context without any host path", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);
    const { workspacePath } = projectService.projectRunScope(project.id, fe.id);

    await runProjectTurn(agentService, fe.id, project.id, 'Change the heading to "My Tasks".');

    const executed = runner.requests[0]?.prompt ?? "";
    expect(executed).toContain('project.name = "Todo App"');
    expect(executed).toContain('project.workspace_scope = "shared_project"');
    expect(executed).toContain('project_preview.status = "not_started"');
    expect(executed).toContain(
      '<user_request>\nChange the heading to "My Tasks".\n</user_request>',
    );
    expect(executed).not.toContain(workspacePath);
    expect(executed).not.toMatch(/\/var\/folders|\/tmp\//);
  });

  it("persists the user message exactly as typed on a Project turn", async () => {
    const { agentService, projectService } = await makeStack();
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);

    await runProjectTurn(agentService, fe.id, project.id, "Change the heading.");

    const messages = agentService.getMessages(fe.id);
    expect(messages[0]).toMatchObject({ role: "user", content: "Change the heading." });
  });

  it("refuses a Project turn for an Agent that is not attached", async () => {
    const { agentService, projectService } = await makeStack();
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });

    await expect(
      agentService.sendMessage(fe.id, "sneak in", { projectId: project.id }),
    ).rejects.toMatchObject({ code: "PROJECT_AGENT_NOT_ATTACHED" });
    // The rejected attempt left no Run or message behind.
    expect(agentService.getRuns(fe.id)).toHaveLength(0);
    expect(agentService.getMessages(fe.id)).toHaveLength(0);
  });
});

describe("Project write lease around real runs", () => {
  it("releases the lease after a successful turn", async () => {
    const { agentService, projectService } = await makeStack();
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);

    await runProjectTurn(agentService, fe.id, project.id, "build");

    expect(projectService.writeLeaseHolder(project.id)).toBeNull();
  });

  it("releases the lease after a failed turn", async () => {
    class ThrowingRunner implements AgentRunner {
      async run(): Promise<RunnerResult> {
        throw new Error("worker exploded");
      }
      async cancel(): Promise<boolean> {
        return false;
      }
      async isAvailable(): Promise<boolean> {
        return true;
      }
    }
    const { agentService, projectService } = await makeStack(new ThrowingRunner());
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);

    const result = await runProjectTurn(agentService, fe.id, project.id, "build");

    expect(result.status).toBe("failed");
    expect(projectService.writeLeaseHolder(project.id)).toBeNull();
  });

  it("serializes two Agents writing to one Project", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({ name: "fe" });
    const builder = await agentService.createAgent({ name: "fe builder2" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);
    await projectService.attachAgent(project.id, builder.id);

    const firstAccepted = await agentService.sendMessage(fe.id, "one", {
      projectId: project.id,
    });
    const secondAccepted = await agentService.sendMessage(builder.id, "two", {
      projectId: project.id,
    });

    const [first, second] = await Promise.all([
      agentService.waitForRun(firstAccepted.run.id, { timeoutMs: 5_000 }),
      agentService.waitForRun(secondAccepted.run.id, { timeoutMs: 5_000 }),
    ]);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(projectService.writeLeaseHolder(project.id)).toBeNull();

    // Serialized, so both writes survive: neither turn clobbered the other.
    const { workspacePath } = projectService.projectRunScope(project.id, fe.id);
    const shared = await readFile(path.join(workspacePath, "app.txt"), "utf8");
    expect(shared.trim().split("\n").sort()).toEqual([fe.id, builder.id].sort());
  });
});

describe("Playground isolation from Team turns", () => {
  it("keeps Team turns out of the Agent Playground conversation", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);

    // A direct Playground message from the user.
    const direct = await agentService.sendMessage(fe.id, "hello from the Playground");
    await agentService.waitForRun(direct.run.id, { timeoutMs: 5_000 });

    // A Team turn, authored by the orchestrator rather than the user.
    const team = await agentService.sendMessage(fe.id, "orchestrator-authored prompt", {
      projectId: project.id,
      origin: "orchestration",
    });
    await agentService.waitForRun(team.run.id, { timeoutMs: 5_000 });

    const playground = agentService.getMessages(fe.id);
    expect(playground).toHaveLength(2);
    expect(playground[0]).toMatchObject({
      role: "user",
      content: "hello from the Playground",
    });
    expect(playground[1]?.role).toBe("assistant");
    expect(playground.every((message) => message.origin === "direct")).toBe(true);
    // The orchestrator's prompt never appears as something the user typed.
    expect(
      playground.some((message) => message.content.includes("orchestrator-authored")),
    ).toBe(false);

    // The Team turn is still persisted for audit and Team-side display.
    const everything = agentService.getMessages(fe.id, { origin: "all" });
    expect(everything).toHaveLength(4);
    expect(
      everything.filter((message) => message.origin === "orchestration"),
    ).toHaveLength(2);
  });

  it("still delivers the orchestration prompt to the runner unchanged", async () => {
    const runner = new FileWritingRunner();
    const { agentService, projectService } = await makeStack(runner);
    const fe = await agentService.createAgent({ name: "fe" });
    const project = await projectService.create({ name: "Todo App" });
    await projectService.attachAgent(project.id, fe.id);

    const team = await agentService.sendMessage(fe.id, "orchestrator-authored prompt", {
      projectId: project.id,
      origin: "orchestration",
    });
    await agentService.waitForRun(team.run.id, { timeoutMs: 5_000 });

    // Hiding it from the Playground must not strip execution context.
    const executed = runner.requests[0]?.prompt ?? "";
    expect(executed).toContain("<platform_runtime_context>");
    expect(executed).toContain('project.name = "Todo App"');
    expect(executed).toContain(
      "<user_request>\norchestrator-authored prompt\n</user_request>",
    );
    expect(runner.requests[0]?.workspacePath).toBe(
      projectService.projectRunScope(project.id, fe.id).workspacePath,
    );
  });
});
