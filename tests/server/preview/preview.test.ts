import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { Agent } from "../../../apps/server/src/types.js";
import { PackageJsonPreviewCommandResolver } from "../../../apps/server/src/preview/preview-command-resolver.js";
import { PreviewService } from "../../../apps/server/src/preview/preview-service.js";
import type {
  PreviewRuntime,
  PreviewRuntimeHandle,
  PreviewRuntimeStatus,
  PreviewStartInput,
} from "../../../apps/server/src/preview/preview-types.js";
import { composeRuntimeContextPrompt } from "../../../apps/server/src/preview/preview-context-provider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FixedPortAllocator {
  released: number[] = [];
  async reserve(): Promise<number> {
    return 41_231;
  }
  release(port: number): void {
    this.released.push(port);
  }
}

class FakePreviewRuntime implements PreviewRuntime {
  starts: PreviewStartInput[] = [];
  stops: PreviewRuntimeHandle[] = [];

  async start(input: PreviewStartInput): Promise<PreviewRuntimeHandle> {
    this.starts.push(input);
    return { runtimeId: "runtime-1", hostPort: input.hostPort ?? 41_231, containerPort: input.containerPort };
  }
  async stop(handle: PreviewRuntimeHandle): Promise<void> {
    this.stops.push(handle);
  }
  async status(_handle: PreviewRuntimeHandle): Promise<PreviewRuntimeStatus> {
    return "running";
  }
  async logs(): Promise<{ lines: string[]; truncated: boolean }> {
    return { lines: ["ready", "token=secret-value"], truncated: false };
  }
}

function agentFor(workspacePath: string): Agent {
  const timestamp = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Preview Agent",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function makePreview(options: { runtime?: FakePreviewRuntime } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-preview-test-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspacePath));
  await writeFile(
    path.join(workspacePath, "package.json"),
    JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^7.0.0" } }),
    "utf8",
  );
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const agent = agentFor(workspacePath);
  const agents = { getAgent: (id: string): Agent => {
    if (id !== agent.id) throw new Error("missing agent");
    return agent;
  } };
  const runtime = options.runtime ?? new FakePreviewRuntime();
  const service = new PreviewService(
    store,
    agents,
    runtime,
    new PackageJsonPreviewCommandResolver(),
    { require: async () => undefined },
    { portAllocator: new FixedPortAllocator() },
  );
  return { root, workspacePath, store, agent, runtime, service };
}

async function makeProductionVitePreview(context: Awaited<ReturnType<typeof makePreview>>): Promise<void> {
  await writeFile(
    path.join(context.workspacePath, "package.json"),
    JSON.stringify({
      scripts: { build: "tsc -b && vite build", preview: "vite preview" },
      devDependencies: { vite: "^7.0.0" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(context.workspacePath, "index.html"),
    '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    "utf8",
  );
}

describe("composeRuntimeContextPrompt", () => {
  it("includes the default response language policy in trusted runtime context", () => {
    expect(
      composeRuntimeContextPrompt("report the result", { status: "not_started" }),
    ).toContain(
      "Respond in English by default. Use another language only when the user explicitly requests it.",
    );
  });
});

describe("PreviewService", () => {
  it("starts one preview, rejects a second active preview, and stops it", async () => {
    const { service, agent, runtime } = await makePreview();
    const started = await service.start({ kind: "agent", agentId: agent.id });
    expect(started).toMatchObject({ status: "running", url: "http://127.0.0.1:41231" });
    await expect(service.start({ kind: "agent", agentId: agent.id })).rejects.toMatchObject({
      code: "PREVIEW_ALREADY_RUNNING",
      statusCode: 409,
    });
    const stopped = await service.stop({ kind: "agent", agentId: agent.id });
    expect(stopped.status).toBe("stopped");
    expect(runtime.stops).toHaveLength(1);
  });

  it("requests a read-only workspace mount for static previews", async () => {
    const context = await makePreview();
    await rm(path.join(context.workspacePath, "package.json"));
    await writeFile(path.join(context.workspacePath, "index.html"), "<h1>Static</h1>", "utf8");

    await expect(context.service.start({ kind: "agent", agentId: context.agent.id })).resolves.toMatchObject({
      status: "running",
    });
    expect(context.runtime.starts[0]).toMatchObject({
      workspaceReadOnly: true,
      command: ["node", "/opt/launchpad/preview-static-server.mjs", "/workspace", "4173"],
      containerPort: 4173,
    });
  });

  it("uses Vite's production preview script instead of serving raw TSX statically", async () => {
    const context = await makePreview();
    await makeProductionVitePreview(context);

    await expect(context.service.start({ kind: "agent", agentId: context.agent.id })).resolves.toMatchObject({
      status: "running",
      url: "http://127.0.0.1:41231",
    });
    expect(context.runtime.starts[0]).toMatchObject({
      command: ["npm", "run", "preview", "--", "--host", "0.0.0.0"],
      containerPort: 4173,
      workspaceReadOnly: false,
    });
  });

  it("bounds and redacts runtime logs", async () => {
    const { service, agent } = await makePreview();
    await service.start({ kind: "agent", agentId: agent.id });
    const result = await service.logs({ kind: "agent", agentId: agent.id }, 10);
    expect(result.logs).toEqual(["ready", "token=[REDACTED]"]);
    expect(result.logs.join(" ")).not.toContain("secret-value");
  });

});
