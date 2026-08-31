import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultAuthorizationService } from "../../../apps/server/src/access/default-authorization-service.js";
import { AgentService } from "../../../apps/server/src/agent-service.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../../apps/server/src/types.js";
import { WorkspaceManager } from "../../../apps/server/src/workspace.js";
import { ProjectServiceExecutionScope } from "../../../apps/server/src/projects/project-execution.js";
import { ProjectService } from "../../../apps/server/src/projects/project-service.js";
import { ProjectWorkspaceManager } from "../../../apps/server/src/projects/project-workspace.js";

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
