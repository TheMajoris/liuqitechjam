import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@mastra/core/storage";
import { z } from "zod";
import { agentPrincipal } from "../../../apps/server/src/access/access-types.js";
import { RepositoryAuthorizationService } from "../../../apps/server/src/access/repository-authorization-service.js";
import { emptyDatabase, type Storage } from "../../../apps/server/src/store.js";
import type { Agent } from "../../../apps/server/src/types.js";
import type { Project, ProjectAgentAttachment } from "../../../apps/server/src/projects/project-types.js";
import { ToolRegistry } from "../../../apps/server/src/tools/tool-registry.js";
import { ToolApprovalStore } from "../../../apps/server/src/tools/tool-approval-store.js";
import {
  createToolApprovalWorkflowService,
  ToolApprovalWorkflowConfigurationError,
} from "../../../apps/server/src/tools/tool-approval-workflow.js";
import { ToolService } from "../../../apps/server/src/tools/tool-service.js";
import type { ToolDefinition, ToolExecutionContext } from "../../../apps/server/src/tools/tool-types.js";

const timestamp = "2026-09-09T00:00:00.000Z";

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

function seedProject(store: Storage): Promise<void> {
  const agent: Agent = {
    id: "agent-1",
    name: "Agent",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/tmp/agent-1",
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const project: Project = {
    id: "project-1",
    name: "Project",
    description: "",
    workspacePath: "/tmp/project-1",
    teamId: null,
    ownerPrincipalId: "demo-owner",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const attachment: ProjectAgentAttachment = {
    projectId: "project-1",
    agentId: "agent-1",
    codexThreadId: null,
    attachedAt: timestamp,
    role: "owner",
    toolGrants: [],
    updatedAt: timestamp,
  };
  return store.mutate((database) => {
    database.agents.push(agent);
    database.projects.push(project);
    database.projectAgents.push(attachment);
  });
}

function restartDefinition(
  calls: { count: number; abortSignal?: AbortSignal },
  options: { waitForAbort?: boolean; throwMessage?: string } = {},
): ToolDefinition<unknown, unknown> {
  return {
    id: "project.preview.restart",
    title: "Restart preview",
    description: "Restart the preview",
    risk: "write",
    requiredPermission: "tool.execute:project.preview.restart",
    approvalPolicy: { mode: "required", version: "test-policy-v1" },
    inputSchema: z.object({ target: z.string().min(1) }),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute(executionContext) {
      calls.count += 1;
      calls.abortSignal = executionContext.abortSignal;
      if (options.throwMessage !== undefined) throw new Error(options.throwMessage);
      if (options.waitForAbort) {
        const signal = executionContext.abortSignal;
        if (signal === undefined) throw new Error("missing cooperative cancellation signal");
        if (signal.aborted) throw new Error("already cancelled");
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cooperative cancellation")), {
            once: true,
          });
        });
      }
      return { ok: true };
    },
  };
}

function context(orchestrationId?: string): ToolExecutionContext {
  return {
    principal: agentPrincipal("agent-1"),
    agentId: "agent-1",
    projectId: "project-1",
    runId: "run-1",
    ...(orchestrationId === undefined ? {} : { orchestrationId }),
  };
}

class CancelAfterClaimStore extends ToolApprovalStore {
  constructor(
    appStore: Storage,
    options: ConstructorParameters<typeof ToolApprovalStore>[1],
    private readonly cancelAfterClaim: () => Promise<void>,
  ) {
    super(appStore, options);
  }

  override async claimExecutionStart(input: Parameters<ToolApprovalStore["claimExecutionStart"]>[0]) {
    const result = await super.claimExecutionStart(input);
    if (result.claimed) await this.cancelAfterClaim();
    return result;
  }
}

type FixtureOptions = {
  allowDirectDecision?: boolean;
  waitForAbort?: boolean;
  throwMessage?: string;
  cancelAfterClaim?: boolean;
  orchestrationId?: string;
};

async function makeFixture(options: FixtureOptions = {}) {
  const appStore = makeStore();
  await seedProject(appStore);
  const calls = { count: 0 };
  const registry = new ToolRegistry([
    restartDefinition(calls, {
      waitForAbort: options.waitForAbort,
      throwMessage: options.throwMessage,
    }),
  ]);
  const authorization = new RepositoryAuthorizationService(appStore);
  const toolService = new ToolService(registry, authorization, appStore);
  const prepared = await toolService.prepareInvocation(
    context(options.orchestrationId),
    "project.preview.restart",
    { target: "preview" },
  );
  let workflowService: ReturnType<typeof createToolApprovalWorkflowService> | undefined;
  let approvalStore: ToolApprovalStore;
  const storeOptions = {
    ownerEpoch: 1,
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
  } as const;
  approvalStore = options.cancelAfterClaim
    ? new CancelAfterClaimStore(appStore, storeOptions, async () => {
        if (workflowService !== undefined) {
          await workflowService.cancel("invocation-1");
        }
      })
    : new ToolApprovalStore(appStore, storeOptions);
  const created = await approvalStore.createInvocation({
    approvalId: "approval-1",
    invocationId: "invocation-1",
    workflowRunId: "workflow-1",
    agentId: "agent-1",
    projectId: "project-1",
    orchestrationId: options.orchestrationId ?? null,
    runId: "run-1",
    toolId: "project.preview.restart",
    policyVersion: "test-policy-v1",
    inputBinding: prepared.rawInputBinding,
    privateState: {
      input: prepared,
      inputBinding: prepared.rawInputBinding,
    },
    safeSummary: "Restart the preview",
    deadlineAt: "2099-01-01T00:00:00.000Z",
  });
  workflowService = createToolApprovalWorkflowService({
    approvalStore,
    toolService,
    workflowStorage: new InMemoryStore({ id: "tool-approval-test" }),
    allowInMemoryStore: true,
    environment: "test",
    allowDirectDecision: options.allowDirectDecision ?? true,
  });
  return {
    appStore,
    approvalStore,
    created,
    calls,
    prepared,
    toolService,
    workflowService,
  };
}

const fixtures: Storage[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((store) => store.close()));
});

describe("ToolApprovalWorkflowService", () => {
  it("suspends with a safe reference and does not execute before approval", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture.appStore);

    const result = await fixture.workflowService.start({ invocationRef: fixture.created.invocationId });
    expect(result.status).toBe("suspended");
    expect(result.suspendPayload).toEqual({
      invocationRef: fixture.created.invocationId,
      summary: "Restart the preview",
    });
    expect(fixture.calls.count).toBe(0);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("waiting");

    const duplicate = await fixture.workflowService.start(fixture.created.invocationId);
    expect(duplicate.status).toBe("suspended");
    expect(fixture.calls.count).toBe(0);
  });

  it("approves through the native run and executes once", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: true,
    });
    expect(result).toMatchObject({ status: "success", result: { status: "executed" } });
    expect(fixture.calls.count).toBe(1);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("succeeded");

    const duplicate = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: true,
    });
    expect(duplicate).toMatchObject({ status: "success" });
    expect(fixture.calls.count).toBe(1);
  });

  it("rejects without fetching or executing the prepared invocation", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: false,
    });
    expect(result).toMatchObject({ status: "success", result: { status: "rejected" } });
    expect(fixture.calls.count).toBe(0);
  });

  it("finishes a pre-claimed rejection through the suspended native run", async () => {
    const fixture = await makeFixture({ allowDirectDecision: false });
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);

    const waiting = fixture.approvalStore.get(fixture.created.approvalId);
    expect(waiting?.status).toBe("waiting");
    await fixture.approvalStore.claimDecision({
      approvalId: fixture.created.approvalId,
      expectedVersion: waiting!.version,
      approved: false,
      actor: { kind: "human", id: "demo-owner" },
    });

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: false,
    });
    expect(result).toMatchObject({ status: "success", result: { status: "rejected" } });
    expect(fixture.calls.count).toBe(0);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("rejected");

    const view = await fixture.workflowService.get(fixture.created.invocationId);
    expect(view.workflow).toMatchObject({
      status: "success",
      result: { status: "rejected", invocationRef: fixture.created.invocationId },
    });
  });

  it("settles a durable execution claim when cancellation wins before the executor", async () => {
    const fixture = await makeFixture({ cancelAfterClaim: true });
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: true,
    });
    expect(["success", "canceled"]).toContain(result.status);
    expect(fixture.calls.count).toBe(0);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("failed");
  });

  it("propagates native cancellation to a cooperative executor", async () => {
    const fixture = await makeFixture({ waitForAbort: true });
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);

    const resuming = fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: true,
    });
    await vi.waitFor(() => expect(fixture.calls.abortSignal).toBeDefined());
    await fixture.workflowService.cancel(fixture.created.invocationId);

    const result = await resuming;
    expect(["success", "canceled"]).toContain(result.status);
    expect(fixture.calls.count).toBe(1);
    expect(fixture.calls.abortSignal?.aborted).toBe(true);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("uncertain");
  });

  it("does not persist unexpected executor error messages", async () => {
    const fixture = await makeFixture({ throwMessage: "Bearer secret-value must not escape" });
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: true,
    });
    expect(result).toMatchObject({
      status: "success",
      result: { status: "failed_pre_execution", reason: "The tool approval could not be completed safely" },
    });
    const record = fixture.approvalStore.get(fixture.created.approvalId)!;
    expect(record.status).toBe("uncertain");
    expect(record.terminalReason).toBe("The tool could not complete");
    expect(JSON.stringify(record)).not.toContain("secret-value");
  });

  it("closes when the prepared orchestration correlation changes", async () => {
    const fixture = await makeFixture({ orchestrationId: "orchestration-1" });
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);
    await fixture.appStore.mutate((database) => {
      const record = database.toolApprovalInvocations[0];
      if (record) record.orchestrationId = "orchestration-2";
    });

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: true,
    });
    expect(result).toMatchObject({ status: "success", result: { status: "failed_pre_execution" } });
    expect(fixture.calls.count).toBe(0);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("failed_pre_execution");
  });

  it("fails closed for an invalid decision schema", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: "yes" as unknown as boolean,
    });
    expect(result).toMatchObject({
      status: "success",
      result: { status: "failed_pre_execution" },
    });
    expect(fixture.calls.count).toBe(0);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("cancelled");
  });

  it("fails closed for revoked role while the approval waits", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture.appStore);
    await fixture.workflowService.start(fixture.created.invocationId);
    await fixture.appStore.mutate((database) => {
      database.projectAgents = [];
    });

    const result = await fixture.workflowService.resume({
      invocationRef: fixture.created.invocationId,
      approved: true,
    });
    expect(result).toMatchObject({ status: "success", result: { status: "failed_pre_execution" } });
    expect(fixture.calls.count).toBe(0);
    expect(fixture.approvalStore.get(fixture.created.approvalId)?.status).toBe("failed");
  });

  it("requires explicit native storage and rejects production InMemoryStore", async () => {
    const fixture = await makeFixture();
    fixtures.push(fixture.appStore);
    expect(() =>
      createToolApprovalWorkflowService({
        approvalStore: fixture.approvalStore,
        toolService: fixture.toolService,
        environment: "production",
      }),
    ).toThrow(ToolApprovalWorkflowConfigurationError);
    expect(() =>
      createToolApprovalWorkflowService({
        approvalStore: fixture.approvalStore,
        toolService: fixture.toolService,
        workflowStorage: new InMemoryStore({ id: "production-memory" }),
        environment: "production",
        allowInMemoryStore: true,
      }),
    ).toThrow(ToolApprovalWorkflowConfigurationError);
  });
});
