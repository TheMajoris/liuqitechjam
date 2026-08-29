import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { PackageJsonPreviewCommandResolver } from "./preview-command-resolver.js";
import { PreviewService } from "./preview-service.js";
import type {
  PreviewRuntime,
  PreviewRuntimeHandle,
  PreviewRuntimeStatus,
  PreviewStartInput,
} from "./preview-types.js";

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
  shouldFail = false;
  statusValue: PreviewRuntimeStatus = "running";

  async start(input: PreviewStartInput): Promise<PreviewRuntimeHandle> {
    this.starts.push(input);
    if (this.shouldFail) throw new Error("runtime unavailable");
    return { runtimeId: "runtime-1", hostPort: input.hostPort ?? 41_231, containerPort: input.containerPort };
  }
  async stop(handle: PreviewRuntimeHandle): Promise<void> {
    this.stops.push(handle);
  }
  async status(_handle: PreviewRuntimeHandle): Promise<PreviewRuntimeStatus> {
    return this.statusValue;
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

describe("PreviewCommandResolver", () => {
  it("detects the supported Vite preview shape", async () => {
    const { workspacePath } = await makePreview();
    await writeFile(path.join(workspacePath, "index.html"), "<h1>ignored by Vite</h1>", "utf8");
    const resolved = await new PackageJsonPreviewCommandResolver().resolve({ workspacePath });
    expect(resolved).toEqual({
      command: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
      containerPort: 5173,
      kind: "vite",
    });
  });

  it("selects static preview when the workspace only has index.html", async () => {
    const { workspacePath } = await makePreview();
    await rm(path.join(workspacePath, "package.json"));
    await writeFile(path.join(workspacePath, "index.html"), "<h1>Static</h1>", "utf8");

    await expect(new PackageJsonPreviewCommandResolver().resolve({ workspacePath })).resolves.toEqual({
      command: ["node", "/opt/launchpad/preview-static-server.mjs", "/workspace", "4173"],
      containerPort: 4173,
      kind: "static",
    });
  });

  it("falls back to static preview when package.json is malformed", async () => {
    const { workspacePath } = await makePreview();
    await writeFile(path.join(workspacePath, "package.json"), "{not-json", "utf8");
    await writeFile(path.join(workspacePath, "index.html"), "<h1>Static</h1>", "utf8");

    await expect(new PackageJsonPreviewCommandResolver().resolve({ workspacePath })).resolves.toMatchObject({
      kind: "static",
      command: ["node", "/opt/launchpad/preview-static-server.mjs", "/workspace", "4173"],
      containerPort: 4173,
    });
  });

  it("falls back to static preview when package.json is unsupported", async () => {
    const { workspacePath } = await makePreview();
    await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ name: "plain" }), "utf8");
    await writeFile(path.join(workspacePath, "index.html"), "<h1>Static</h1>", "utf8");

    await expect(new PackageJsonPreviewCommandResolver().resolve({ workspacePath })).resolves.toMatchObject({
      kind: "static",
      command: ["node", "/opt/launchpad/preview-static-server.mjs", "/workspace", "4173"],
      containerPort: 4173,
    });
  });

  it("reports a missing command when package.json and index.html are absent", async () => {
    const { workspacePath } = await makePreview();
    await rm(path.join(workspacePath, "package.json"));

    await expect(new PackageJsonPreviewCommandResolver().resolve({ workspacePath })).rejects.toMatchObject({
      code: "PREVIEW_COMMAND_NOT_FOUND",
    });
  });

  it("reports malformed package metadata when no static entrypoint exists", async () => {
    const { workspacePath } = await makePreview();
    await writeFile(path.join(workspacePath, "package.json"), "{not-json", "utf8");

    await expect(new PackageJsonPreviewCommandResolver().resolve({ workspacePath })).rejects.toMatchObject({
      code: "PREVIEW_UNSUPPORTED_PROJECT",
    });
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

  it("normalizes runtime start failures and persists failed state", async () => {
    const runtime = new FakePreviewRuntime();
    runtime.shouldFail = true;
    const { service, agent, store } = await makePreview({ runtime });
    await expect(service.start({ kind: "agent", agentId: agent.id })).rejects.toMatchObject({
      code: "PREVIEW_START_FAILED",
    });
    expect(store.snapshot().previews[0]).toMatchObject({
      status: "failed",
      errorCode: "PREVIEW_START_FAILED",
    });
  });

  it("bounds and redacts runtime logs", async () => {
    const { service, agent } = await makePreview();
    await service.start({ kind: "agent", agentId: agent.id });
    const result = await service.logs({ kind: "agent", agentId: agent.id }, 10);
    expect(result.logs).toEqual(["ready", "token=[REDACTED]"]);
    expect(result.logs.join(" ")).not.toContain("secret-value");
  });

  it("reconciles an interrupted runtime and permits a fresh start", async () => {
    const { service, agent, runtime, store } = await makePreview();
    await service.start({ kind: "agent", agentId: agent.id });

    await service.initialize();

    expect(runtime.stops).toHaveLength(1);
    expect(store.snapshot().previews[0]).toMatchObject({
      status: "interrupted",
      runtimeId: null,
      url: null,
    });
    await expect(service.start({ kind: "agent", agentId: agent.id })).resolves.toMatchObject({ status: "running" });
  });

  it("removes a failed managed runtime before clearing its handle", async () => {
    const { service, agent, runtime, store } = await makePreview();
    await service.start({ kind: "agent", agentId: agent.id });
    runtime.statusValue = "failed";

    await expect(service.get({ kind: "agent", agentId: agent.id })).resolves.toMatchObject({ status: "failed" });

    expect(runtime.stops).toHaveLength(1);
    expect(store.snapshot().previews[0]?.runtimeId).toBeNull();
    await expect(service.logs({ kind: "agent", agentId: agent.id }, 10)).resolves.toMatchObject({
      logs: ["ready", "token=[REDACTED]"],
    });
  });
});
