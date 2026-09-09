import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@mastra/core/storage";
import { z } from "zod";
import { agentPrincipal, systemPrincipal } from "../../../apps/server/src/access/access-types.js";
import { AuditService, JsonAuditStoreAdapter } from "../../../apps/server/src/audit/audit-service.js";
import { emptyDatabase, type Storage } from "../../../apps/server/src/store.js";
import { buildUsageReport } from "../../../apps/server/src/usage/usage-aggregator.js";
import { ToolApprovalStore } from "../../../apps/server/src/tools/tool-approval-store.js";
import {
  createToolApprovalService,
  type ToolApprovalService,
} from "../../../apps/server/src/tools/tool-approval-service.js";
import { createToolApprovalWorkflowService } from "../../../apps/server/src/tools/tool-approval-workflow.js";
import { ToolRegistry } from "../../../apps/server/src/tools/tool-registry.js";
import { ToolService } from "../../../apps/server/src/tools/tool-service.js";
import type { ToolDefinition, ToolExecutionContext } from "../../../apps/server/src/tools/tool-types.js";

const NOW = Date.parse("2026-09-09T00:00:00.000Z");
const TRACEPARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

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

function context(runId = "run-1"): ToolExecutionContext {
  return {
    principal: agentPrincipal("agent-1"),
    agentId: "agent-1",
    projectId: "project-1",
    runId,
  };
}

type Fixture = {
  store: Storage;
  audit: AuditService;
  approvals: ToolApprovalStore;
  bridge: ToolApprovalService;
  workflow: ReturnType<typeof createToolApprovalWorkflowService>;
  pending: Promise<{ approvalId: string; invocationId: string; version: number }>;
  calls: number;
  executionContext?: ToolExecutionContext;
};

function makeFixture(options: { denyRun?: string } = {}): Fixture {
  const store = makeStore();
  const audit = new AuditService(new JsonAuditStoreAdapter(store));
  let calls = 0;
  let executionContext: ToolExecutionContext | undefined;
  const definition: ToolDefinition<unknown, unknown> = {
    id: "project.preview.restart",
    title: "Restart preview",
    description: "Restart the preview",
    risk: "write",
    requiredPermission: "tool.execute:project.preview.restart",
    approvalPolicy: { mode: "required", version: "task9-v1" },
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute(receivedContext) {
      calls += 1;
      executionContext = receivedContext;
      return { ok: true };
    },
  };
  const authorization = {
    decide: async (input: { context?: { runId?: string } }) =>
      input.context?.runId === options.denyRun
        ? { result: "deny" as const, reason: "Denied by test policy", errorCode: "PERMISSION_DENIED" as const }
        : { result: "allow" as const, reason: "Allowed by test policy" },
  };
  const toolService = new ToolService(
    new ToolRegistry([definition]),
    authorization,
    store,
    audit,
  );
  const approvals = new ToolApprovalStore(store, {
    ownerEpoch: 1,
    now: () => NOW,
    audit,
  });
  const workflow = createToolApprovalWorkflowService({
    approvalStore: approvals,
    toolService,
    workflowStorage: new InMemoryStore({ id: "task9-workflow" }),
    allowInMemoryStore: true,
    environment: "test",
  });
  let resolvePending!: (value: { approvalId: string; invocationId: string; version: number }) => void;
  const pending = new Promise<{ approvalId: string; invocationId: string; version: number }>((resolve) => {
    resolvePending = resolve;
  });
  const bridge = createToolApprovalService({
    approvalStore: approvals,
    toolService,
    workflowService: workflow,
    now: () => NOW,
    approvalTimeoutMs: 60_000,
    onPending: resolvePending,
  });
  return {
    store,
    audit,
    approvals,
    bridge,
    workflow,
    pending,
    get calls() {
      return calls;
    },
    get executionContext() {
      return executionContext;
    },
  };
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const record of fixture.approvals.list()) {
      if (["requested", "waiting", "approved", "resuming", "executing"].includes(record.status)) {
        await fixture.bridge.cancel(record.invocationId).catch(() => undefined);
      }
    }
    await fixture.workflow.close().catch(() => undefined);
    await fixture.store.close();
  }
});

describe("Task9 native approval audit and correlation", () => {
  it("emits one native admission marker, one execution pair, and full trusted correlation", async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const original = fixture.bridge.execute(
      context(),
      "project.preview.restart",
      { value: "secret-input" },
      {
        sessionId: "session-1",
        turnId: "turn-1",
        traceparent: TRACEPARENT,
      },
    );
    const projection = await fixture.pending;
    const record = fixture.approvals.get(projection.approvalId)!;
    expect(record.traceRefs).toEqual({
      traceId: "0123456789abcdef0123456789abcdef",
      parentSpanId: "0123456789abcdef",
    });

    await fixture.bridge.approve({
      approvalId: projection.approvalId,
      expectedVersion: projection.version,
      actor: { kind: "human", id: "operator-7" },
    });
    await expect(original).resolves.toEqual({ ok: true });
    expect(fixture.calls).toBe(1);
    expect(fixture.executionContext).toMatchObject({
      turnId: "turn-1",
      sessionId: "session-1",
      invocationId: record.invocationId,
      approvalId: record.approvalId,
      workflowRunId: record.workflowRunId,
    });

    const events = fixture.audit.query({ invocationId: record.invocationId });
    expect(events.slice().sort((left, right) => left.sequence - right.sequence).map((event) => event.type)).toEqual([
      "approval_requested",
      "approval_waiting",
      "approval_decided",
      "approval_resumed",
      "tool_started",
      "tool_succeeded",
    ]);
    expect(events.filter((event) => event.type === "approval_requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_succeeded")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_failed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "tool_approval_required")).toHaveLength(0);
    for (const event of events) {
      expect(event).toMatchObject({
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-1",
        turnId: "turn-1",
        sessionId: "session-1",
        invocationId: record.invocationId,
        approvalId: record.approvalId,
        workflowRunId: record.workflowRunId,
      });
      expect(event.traceId).toBe("0123456789abcdef0123456789abcdef");
    }
    expect(events.find((event) => event.type === "approval_decided")).toMatchObject({
      actorType: "human",
      principal: { kind: "human", id: "operator-7" },
    });
    for (const event of events.filter((item) => item.type.startsWith("approval_") && item.type !== "approval_decided")) {
      expect(event).toMatchObject({ actorType: "system", principal: systemPrincipal() });
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret-input");
    expect(serialized).not.toContain("business-output");

    const report = buildUsageReport({
      agents: [],
      runs: [],
      messages: [],
      orchestrations: [],
      orchestrationTurns: [],
      projects: [],
      auditEvents: events,
    });
    expect(report.totals.activity).toMatchObject({
      approvalsRequired: 1,
      toolCalls: 1,
      toolFailures: 0,
    });
  });

  it("keeps rejected and denied paths out of business execution counts", async () => {
    const fixture = makeFixture({ denyRun: "run-denied" });
    fixtures.push(fixture);
    const original = fixture.bridge.execute(
      context(),
      "project.preview.restart",
      { value: "reject-me" },
    );
    const projection = await fixture.pending;
    await fixture.bridge.reject({
      approvalId: projection.approvalId,
      expectedVersion: projection.version,
      actor: { kind: "human", id: "operator-8" },
    });
    await expect(original).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    await expect(
      fixture.bridge.execute(
        context("run-denied"),
        "project.preview.restart",
        { value: "denied-input" },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(fixture.calls).toBe(0);
    const report = buildUsageReport({
      agents: [],
      runs: [],
      messages: [],
      orchestrations: [],
      orchestrationTurns: [],
      projects: [],
      auditEvents: fixture.audit.query(),
    });
    expect(report.totals.activity.approvalsRequired).toBe(1);
    expect(report.totals.activity.toolCalls).toBe(0);
    expect(report.totals.activity.toolFailures).toBe(1);
    expect(JSON.stringify(fixture.audit.query())).not.toContain("denied-input");
  });

  it("makes expiry and cancellation lifecycle transitions idempotent and runtime-attributed", async () => {
    const store = makeStore();
    const audit = new AuditService(new JsonAuditStoreAdapter(store));
    const approvals = new ToolApprovalStore(store, { ownerEpoch: 1, now: () => NOW, audit });
    const created = await approvals.createInvocation({
      approvalId: "approval-lifecycle",
      invocationId: "invocation-lifecycle",
      workflowRunId: "workflow-lifecycle",
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-lifecycle",
      turnId: "turn-lifecycle",
      sessionId: "session-lifecycle",
      toolId: "project.preview.restart",
      policyVersion: "task9-v1",
      inputBinding: "private-binding",
      privateInput: { value: "private" },
      safeSummary: "Restart preview",
      deadlineAt: "2026-09-09T00:00:00.000Z",
      initialStatus: "waiting",
    });
    await approvals.expire({ approvalId: created.approvalId, expectedVersion: created.version });
    await approvals.expire({ approvalId: created.approvalId, expectedVersion: created.version });
    const events = audit.query({ invocationId: created.invocationId });
    expect(events.filter((event) => event.type === "approval_requested")).toHaveLength(0);
    expect(events.filter((event) => event.type === "approval_waiting")).toHaveLength(1);
    expect(events.filter((event) => event.type === "approval_expired")).toHaveLength(1);
    expect(events.filter((event) => event.type === "approval_expired")[0]).toMatchObject({
      actorType: "system",
      principal: systemPrincipal(),
    });
    expect(JSON.stringify(events)).not.toContain("private");
    await store.close();
  });
});
