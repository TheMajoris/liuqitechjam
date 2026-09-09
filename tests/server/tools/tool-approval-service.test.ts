import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@mastra/core/storage";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { agentPrincipal } from "../../../apps/server/src/access/access-types.js";
import { emptyDatabase, type Storage } from "../../../apps/server/src/store.js";
import { ToolApprovalStore } from "../../../apps/server/src/tools/tool-approval-store.js";
import { createMcpServer } from "../../../apps/server/src/mcp-server.js";
import {
  createToolApprovalService,
  type ToolApprovalService,
} from "../../../apps/server/src/tools/tool-approval-service.js";
import { createToolApprovalWorkflowService } from "../../../apps/server/src/tools/tool-approval-workflow.js";
import { ToolRegistry } from "../../../apps/server/src/tools/tool-registry.js";
import { ToolService } from "../../../apps/server/src/tools/tool-service.js";
import type { ToolDefinition, ToolExecutionContext } from "../../../apps/server/src/tools/tool-types.js";

function makeStore(): Storage {
  let data = emptyDatabase();
  return {
    auditRetention: "bounded",
    async initialize() {},
    snapshot: () => structuredClone(data),
    async mutate<T>(mutation: (database: ReturnType<typeof emptyDatabase>) => T | Promise<T>) {
      const next = structuredClone(data);
      const result = await mutation(next);
      data = next;
      return result;
    },
    async close() {},
  };
}

function context(
  runId = "run-1",
  projectId: string | null | undefined = "project-1",
): ToolExecutionContext {
  return {
    principal: agentPrincipal("agent-1"),
    agentId: "agent-1",
    ...(projectId == null ? {} : { projectId }),
    runId,
  };
}

async function makeFixture(options: {
  maxPending?: number;
  maxPendingPerRun?: number;
  onPending: (pending: { approvalId: string; invocationId: string; version: number }) => void;
  toolId?: "project.preview.restart" | "web.search";
}): {
  bridge: ToolApprovalService;
  approvals: ToolApprovalStore;
  store: Storage;
  calls: { count: number };
  toolService: ToolService;
} {
  const store = makeStore();
  const calls = { count: 0 };
  const toolId = options.toolId ?? "project.preview.restart";
  if (toolId === "web.search") {
    // Direct Agent tools require a server-owned global role before the
    // approval bridge can create a pending invocation.
    await store.mutate((database) => {
      database.agents.push({
        id: "agent-1",
        name: "Researcher",
        description: "",
        instructions: "",
        globalRoleId: "role-1",
        status: "ready",
        workspacePath: "/tmp/agent-1",
        codexThreadId: null,
        lastError: null,
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      });
      database.roles.push({
        id: "role-1",
        name: "Researcher",
        description: "",
        skillIds: [],
        toolIds: ["web.search"],
        permissionIds: ["tool.execute:web.search"],
        source: "user",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      });
    });
  }
  const definition: ToolDefinition<unknown, unknown> = {
    id: toolId,
    title: toolId === "web.search" ? "Web Search" : "Restart preview",
    description: toolId === "web.search" ? "Search" : "Restart the preview",
    risk: toolId === "web.search" ? "network" : "write",
    requiredPermission: toolId === "web.search"
      ? "tool.execute:web.search"
      : "tool.execute:project.preview.restart",
    approvalPolicy: {
      mode: "required",
      version: toolId === "web.search" ? "tool-approval-v2" : "test-policy-v1",
      ...(toolId === "web.search"
        ? {
            decisionAuthority: {
              kind: "project-owner" as const,
              permission: "tool.execute:web.search" as const,
            },
          }
        : {}),
    },
    inputSchema: toolId === "web.search"
      ? z.object({ query: z.string() })
      : z.object({ value: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      calls.count += 1;
      return { ok: true };
    },
  };
  const authorization = {
    decide: async () => ({ result: "allow" as const, reason: "test authorization" }),
  };
  const toolService = new ToolService(
    new ToolRegistry([definition]),
    authorization,
    store,
  );
  const approvals = new ToolApprovalStore(store, {
    ownerEpoch: 1,
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
  });
  const workflowService = createToolApprovalWorkflowService({
    approvalStore: approvals,
    toolService,
    workflowStorage: new InMemoryStore({ id: "tool-approval-bridge-test" }),
    allowInMemoryStore: true,
    environment: "test",
  });
  const bridge = createToolApprovalService({
    approvalStore: approvals,
    toolService,
    workflowService,
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    ...(options.maxPendingPerRun === undefined ? {} : { maxPendingPerRun: options.maxPendingPerRun }),
    onPending: options.onPending,
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
    approvalTimeoutMs: 60_000,
  });
  return { bridge, approvals, store, calls, toolService };
}

const openBridges: ToolApprovalService[] = [];
const openStores: Storage[] = [];

afterEach(async () => {
  for (const bridge of openBridges.splice(0)) {
    for (const record of bridge.approvalStore.list()) {
      if (["requested", "waiting", "approved", "resuming", "executing"].includes(record.status)) {
        await bridge.cancel(record.invocationId).catch(() => undefined);
      }
    }
  }
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

describe("ToolApprovalService MCP completion bridge", () => {
  it("holds the original invocation, then settles it once on approval", async () => {
    let resolvePending!: (pending: { approvalId: string; invocationId: string; version: number }) => void;
    const pending = new Promise<{ approvalId: string; invocationId: string; version: number }>((resolve) => {
      resolvePending = resolve;
    });
    const fixture = await makeFixture({ onPending: resolvePending });
    openBridges.push(fixture.bridge);
    openStores.push(fixture.store);

    const original = fixture.bridge.execute(context(), "project.preview.restart", { value: "restart" });
    const projection = await pending;
    expect(fixture.bridge.pendingCount()).toBe(1);
    expect(fixture.calls.count).toBe(0);

    const decision = await fixture.bridge.approve({
      approvalId: projection.approvalId,
      expectedVersion: projection.version,
      actor: { kind: "system", id: "test-controller" },
    });
    expect(decision.result?.status).toBe("executed");
    await expect(original).resolves.toEqual({ ok: true });
    expect(fixture.calls.count).toBe(1);
    expect(fixture.bridge.pendingCount()).toBe(0);
  });

  it("rejects without invoking the executor and preserves a bounded queue", async () => {
    let resolvePending!: (pending: { approvalId: string; invocationId: string; version: number }) => void;
    const pending = new Promise<{ approvalId: string; invocationId: string; version: number }>((resolve) => {
      resolvePending = resolve;
    });
    const fixture = await makeFixture({ maxPending: 1, onPending: resolvePending });
    openBridges.push(fixture.bridge);
    openStores.push(fixture.store);

    const original = fixture.bridge.execute(context(), "project.preview.restart", { value: "restart" });
    const projection = await pending;
    await expect(
      fixture.bridge.execute(context("run-2"), "project.preview.restart", { value: "second" }),
    ).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    expect(fixture.calls.count).toBe(0);

    await fixture.bridge.reject({
      approvalId: projection.approvalId,
      expectedVersion: projection.version,
      actor: { kind: "system", id: "test-controller" },
    });
    await expect(original).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fixture.calls.count).toBe(0);
    expect(fixture.bridge.pendingCount()).toBe(0);
  });

  it("requires and settles a web.search approval for a Project-scoped Agent", async () => {
    let resolvePending!: (pending: { approvalId: string; invocationId: string; version: number }) => void;
    const pending = new Promise<{ approvalId: string; invocationId: string; version: number }>((resolve) => {
      resolvePending = resolve;
    });
    const fixture = await makeFixture({ toolId: "web.search", onPending: resolvePending });
    openBridges.push(fixture.bridge);
    openStores.push(fixture.store);

    const original = fixture.bridge.execute(context(), "web.search", { query: "launchpad" });
    const projection = await pending;
    expect(projection.version).toBe(2);
    expect(fixture.calls.count).toBe(0);

    await fixture.bridge.approve({
      approvalId: projection.approvalId,
      expectedVersion: projection.version,
      actor: { kind: "system", id: "test-controller" },
    });
    await expect(original).resolves.toEqual({ ok: true });
    expect(fixture.calls.count).toBe(1);
  });

  it("rejects a project-less web.search approval before creating a durable record", async () => {
    const fixture = await makeFixture({ toolId: "web.search", onPending: () => undefined });
    openBridges.push(fixture.bridge);
    openStores.push(fixture.store);

    await expect(
      fixture.bridge.execute(context("run-global", null), "web.search", { query: "launchpad" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", statusCode: 403 });
    expect(fixture.approvals.list()).toHaveLength(0);
    expect(fixture.calls.count).toBe(0);
  });

  it("marks the bridge unavailable when native start fails", async () => {
    const fixture = await makeFixture({ onPending: () => undefined });
    openBridges.push(fixture.bridge);
    openStores.push(fixture.store);
    fixture.bridge.workflowService.start = async () => ({
      status: "success" as const,
      nativeFailure: true,
      result: {
        status: "failed_pre_execution" as const,
        invocationRef: "native-failure",
        reason: "The tool approval could not be completed safely",
      },
    });

    await expect(
      fixture.bridge.execute(context(), "project.preview.restart", { value: "restart" }),
    ).rejects.toMatchObject({ code: "TOOL_INVOCATION_INVALIDATED" });
    expect(fixture.bridge.isAvailable()).toBe(false);
    expect(fixture.bridge.isAdmissionEnabled()).toBe(false);
  });

  it("disables new admissions synchronously while draining", async () => {
    const fixture = await makeFixture({ onPending: () => undefined });
    openBridges.push(fixture.bridge);
    openStores.push(fixture.store);
    fixture.bridge.disableAdmissions();

    await expect(
      fixture.bridge.execute(context(), "project.preview.restart", { value: "restart" }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", statusCode: 503 });
    expect(fixture.bridge.pendingCount()).toBe(0);
  });

  it("keeps an SDK MCP call pending until the bridge settles its original result", async () => {
    let resolvePending!: (pending: { approvalId: string; invocationId: string; version: number }) => void;
    const pending = new Promise<{ approvalId: string; invocationId: string; version: number }>((resolve) => {
      resolvePending = resolve;
    });
    const fixture = await makeFixture({ onPending: resolvePending });
    openBridges.push(fixture.bridge);
    openStores.push(fixture.store);
    const server = createMcpServer(
      {
        principal: agentPrincipal("agent-1"),
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-mcp",
        expiresAt: "2099-01-01T00:00:00.000Z",
        advertisedToolIds: ["project.preview.restart"],
      },
      fixture.toolService,
      { approvalService: fixture.bridge },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "approval-bridge-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      let settled = false;
      const original = client.callTool({ name: "project.preview.restart", arguments: { value: "mcp" } }).then((result) => {
        settled = true;
        return result;
      });
      const projection = await pending;
      expect(settled).toBe(false);
      expect(fixture.calls.count).toBe(0);
      await fixture.bridge.approve({
        approvalId: projection.approvalId,
        expectedVersion: projection.version,
        actor: { kind: "system", id: "test-controller" },
      });
      await expect(original).resolves.toMatchObject({ structuredContent: { ok: true } });
      expect(fixture.calls.count).toBe(1);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
