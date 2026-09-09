/**
 * Deterministic workspace-checkpoint demo harness.
 *
 * Boots the real server (real routes, storage, Project leases, reservations,
 * private Git checkpoint store, audit) with one substitution: the Codex
 * runtime is replaced by scripted Agents that really edit the shared
 * workspace. The failure is deterministic — the Reviewer breaks the source on
 * its first attempt and succeeds only inside a recovery cycle — so the judge
 * demo never depends on a model corrupting a file on cue.
 *
 * This is a separately launched harness, not a production switch: nothing in
 * configuration selects the scripted runner, and the demo writes only under
 * `.data-demo/`.
 *
 *   npm run demo:checkpoints            # API on http://127.0.0.1:3000
 *   npm run dev -w @launchpad/web       # UI on http://localhost:5173
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bootstrapApplication } from "../apps/server/src/bootstrap.js";
import { loadConfig } from "../apps/server/src/config.js";
import { createWorkerModelResolver } from "../apps/server/src/models/worker-model-resolver.js";
import type { Storage } from "../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../apps/server/src/types.js";

const DEMO_ROOT = path.resolve(process.env.DEMO_DATA_DIR ?? ".data-demo");
const RESET = process.argv.includes("--reset");
const DEMO_MODEL = "demo-model";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  PERSISTENCE_BACKEND: "json",
  APP_DATA_DIR: DEMO_ROOT,
  AGENT_WORKSPACE_ROOT: path.join(DEMO_ROOT, "workspaces"),
  CODEX_HOME: path.join(DEMO_ROOT, "codex-home"),
  ARK_API_KEY: "demo-inference-key-not-real",
  WORKER_CURATED_MODELS: DEMO_MODEL,
  RUNTIME_PROVIDER: "local-process",
  WORKSPACE_CHECKPOINTS_ENABLED: "true",
  WORKSPACE_CHECKPOINT_LOCAL_PROCESS: "allow",
  SEARCH_PROVIDER: "disabled",
  OTEL_TRACES_EXPORTER: "none",
  HOST: process.env.HOST ?? "127.0.0.1",
  PORT: process.env.PORT ?? "3000",
  APP_AUTH_TOKEN: "",
});

if (RESET) await rm(DEMO_ROOT, { recursive: true, force: true });
await mkdir(DEMO_ROOT, { recursive: true });

async function writeInto(workspace: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(workspace, ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Scripted Agents keyed by name. The Reviewer's outcome is keyed by the
 * execution cycle of its Run (a recovery cycle succeeds; an ordinary cycle
 * fails), never by a hidden global counter.
 */
class ScriptedDemoRunner implements AgentRunner {
  private readonly names = new Map<string, string>();
  private store: Storage | null = null;

  attach(store: Storage, agents: Record<string, string>): void {
    this.store = store;
    for (const [name, id] of Object.entries(agents)) this.names.set(id, name);
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const name = this.names.get(request.agentId) ?? "Agent";
    const workspace = request.workspacePath;
    await delay(1_200);
    switch (name) {
      case "Planner": {
        await writeInto(
          workspace,
          "PLAN.md",
          "# Plan\n\n1. Change `src/message.ts` so the app reports it is ready for review.\n2. Have the Reviewer confirm.\n",
        );
        return {
          output: "I wrote PLAN.md: change src/message.ts to report readiness, then hand to the Builder.",
          threadId: "planner-" + request.runId,
          usage: { inputTokens: 412, outputTokens: 96 },
        };
      }
      case "Builder": {
        await writeInto(workspace, "src/message.ts", 'export const message = "Ready for review";\n');
        return {
          output: 'Updated src/message.ts to export "Ready for review". Ready for the Reviewer.',
          threadId: "builder-" + request.runId,
          usage: { inputTokens: 780, outputTokens: 140 },
        };
      }
      case "Reviewer": {
        if (!this.isRecoveryCycle(request.runId)) {
          // The controlled failure: overwrite, delete, create, then crash.
          await writeInto(workspace, "src/message.ts", 'export const message = "BROKEN";\n');
          await rm(path.join(workspace, "PLAN.md"), { force: true });
          await writeInto(workspace, "src/partial.ts", "// review in progress — never finished\n");
          throw new Error("Reviewer runtime exited unexpectedly (exit code 137)");
        }
        const message = await readFile(path.join(workspace, "src", "message.ts"), "utf8");
        await writeInto(workspace, "REVIEW.md", "# Review\n\nApproved. Current message:\n\n```ts\n" + message + "```\n");
        return {
          output: "Reviewed src/message.ts after the restore: it reads \"Ready for review\". Approved in REVIEW.md.",
          threadId: "reviewer-" + request.runId,
          usage: { inputTokens: 655, outputTokens: 120 },
        };
      }
      default:
        return { output: "Nothing to do.", threadId: null, usage: null };
    }
  }

  private isRecoveryCycle(runId: string | undefined): boolean {
    if (!this.store || runId === undefined) return false;
    const database = this.store.snapshot();
    const run = database.runs.find((item) => item.id === runId);
    if (!run?.executionCycleId) return false;
    const cycle = database.workspaceExecutionCycles.find((item) => item.id === run.executionCycleId);
    return cycle?.sourceCheckpointId !== null && cycle?.sourceCheckpointId !== undefined;
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const runner = new ScriptedDemoRunner();
const application = await bootstrapApplication(config, {
  runner,
  workerModelResolver: createWorkerModelResolver(config),
});
const { agentService, projectService, orchestrationService, projectWorkspaces, store } = application;

// ---------------------------------------------------------------- seed
const seeded: Record<string, string> = {};
const existing = agentService.listAgents();
for (const [name, description, instructions] of [
  ["Planner", "Turns the request into a short plan.", "Write PLAN.md with the steps, nothing else."],
  ["Builder", "Implements the plan.", "Edit src/message.ts as the plan says."],
  ["Reviewer", "Checks the result.", "Review the change and write REVIEW.md."],
] as const) {
  const found = existing.find((agent) => agent.name === name);
  const agent = found ?? (await agentService.createAgent({
    name,
    description,
    instructions,
    modelRef: { providerId: "volcengine_ark", modelId: DEMO_MODEL },
  }));
  seeded[name] = agent.id;
}
runner.attach(store, seeded);

const projects = await projectService.list();
let project = projects.find((item) => item.name === "Checkpoint demo") ?? null;
if (!project) {
  project = await projectService.create({
    name: "Checkpoint demo",
    description: "Planner → Builder → Reviewer on one shared workspace.",
  });
  for (const id of Object.values(seeded)) await projectService.attachAgent(project.id, id);
  const workspace = projectWorkspaces.workspacePath(project.id);
  await writeInto(workspace, "src/message.ts", 'export const message = "hello";\n');
  await writeInto(workspace, "README.md", "# Checkpoint demo\n\nThree Agents share this workspace.\n");
}

const sessions = await orchestrationService.listSessions();
let session = sessions.find((item) => item.projectId === project.id && item.status === "draft") ?? null;
if (!session && !sessions.some((item) => item.projectId === project.id)) {
  session = await orchestrationService.createSession({
    name: "Ship the review-ready message",
    originalPrompt: "Change src/message.ts to say the app is ready for review, then review it.",
    projectId: project.id,
    mode: "sequential",
    participants: (["Planner", "Builder", "Reviewer"] as const).map((name, position) => ({
      id: "demo-" + name.toLowerCase(),
      agentId: seeded[name]!,
      role: name,
      position,
    })),
    maxSteps: 3,
    perAgentTimeoutMs: 60_000,
  });
}

const exitAfterShutdown = async (signal: string): Promise<void> => {
  await application.shutdown(signal);
  process.exit(0);
};
process.on("SIGTERM", () => void exitAfterShutdown("SIGTERM"));
process.on("SIGINT", () => void exitAfterShutdown("SIGINT"));

await application.app.listen({ host: config.host, port: config.port });
const workspacePath = projectWorkspaces.workspacePath(project.id);
console.log(
  [
    "",
    "Workspace checkpoint demo is running.",
    "  API:        http://" + config.host + ":" + String(config.port),
    "  UI:         start `npm run dev -w @launchpad/web` and open http://localhost:5173",
    "  Workspace:  " + workspacePath,
    "  Data:       " + DEMO_ROOT + (RESET ? " (reset)" : ""),
    "",
    "Script: Planner writes PLAN.md, Builder sets src/message.ts to \"Ready for review\" (checkpoints",
    "after each), the Reviewer then overwrites the message with \"BROKEN\", deletes PLAN.md, leaves",
    "src/partial.ts and crashes. Open the Builder turn and choose \"Restore after Builder and resume\":",
    "a safety checkpoint is saved, the source is restored, and the Reviewer succeeds with a fresh thread.",
    "",
    "Pass --reset to start from a clean demo directory.",
    "",
  ].join("\n"),
);
