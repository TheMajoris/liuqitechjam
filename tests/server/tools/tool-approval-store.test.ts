import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore, normalizeDatabase } from "../../../apps/server/src/store.js";
import {
  ToolApprovalStore,
  ToolApprovalStoreError,
  normalizeToolApprovalInvocations,
  type ToolApprovalBinding,
  type ToolApprovalCreateInput,
} from "../../../apps/server/src/tools/tool-approval-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(ownerEpoch = 1): Promise<{
  store: JsonStore;
  approvals: ToolApprovalStore;
  binding: (
    approvalId: string,
    inputBinding?: string,
    overrides?: Partial<ToolApprovalBinding>,
  ) => ToolApprovalBinding;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-tool-approval-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const approvals = new ToolApprovalStore(store, {
    ownerEpoch,
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
  });
  const binding = (
    approvalId: string,
    inputBinding = '{"path":"safe"}',
    overrides: Partial<ToolApprovalBinding> = {},
  ): ToolApprovalBinding => ({
    approvalId,
    invocationId: "invocation-1",
    workflowRunId: "workflow-1",
    agentId: "agent-1",
    projectId: "project-1",
    runId: "run-1",
    orchestrationId: "orchestration-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolId: "project.preview.restart",
    policyVersion: "tool-approval-v1",
    ownerEpoch,
    inputBinding,
    ...overrides,
  });
  return { store, approvals, binding };
}

async function createWaiting(
  approvals: ToolApprovalStore,
  overrides: Partial<ToolApprovalCreateInput> = {},
) {
  return approvals.createInvocation({
    approvalId: "approval-1",
    invocationId: "invocation-1",
    workflowRunId: "workflow-1",
    agentId: "agent-1",
    projectId: "project-1",
    runId: "run-1",
    orchestrationId: "orchestration-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolId: "project.preview.restart",
    policyVersion: "tool-approval-v1",
    inputBinding: '{"path":"safe"}',
    privateInput: { token: "never-persist-this" },
    safeSummary: "Restart preview",
    deadlineAt: "2026-09-09T00:02:00.000Z",
    initialStatus: "waiting",
    ...overrides,
  });
}

describe("ToolApprovalStore", () => {
  it("keeps private input out of the JSON projection and serializes competing decisions", async () => {
    const { store, approvals, binding } = await makeStore();
    const created = await createWaiting(approvals);
    const json = await readFile(path.join(roots[0]!, "db.json"), "utf8");
    expect(json).not.toContain("never-persist-this");
    expect(approvals.getPublic(created.approvalId)).not.toHaveProperty("inputBinding");

    const decisions = await Promise.allSettled([
      approvals.claimDecision({
        approvalId: created.approvalId,
        expectedVersion: created.version,
        approved: true,
        actor: { kind: "human", id: "demo-owner" },
        binding: binding(created.approvalId),
      }),
      approvals.claimDecision({
        approvalId: created.approvalId,
        expectedVersion: created.version,
        approved: false,
        actor: { kind: "human", id: "demo-owner" },
        binding: binding(created.approvalId),
      }),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(approvals.get(created.approvalId)?.version).toBe(2);

    const current = approvals.get(created.approvalId)!;
    const duplicate = await approvals.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: current.decision === "approved",
      actor: { kind: "human", id: "another-retry" },
      binding: binding(created.approvalId),
    });
    expect(duplicate.outcome).toBe("idempotent");
    await expect(
      approvals.claimDecision({
        approvalId: created.approvalId,
        expectedVersion: created.version,
        approved: current.decision === "approved",
        actor: { kind: "human", id: "foreign-retry" },
        binding: binding(created.approvalId, '{"foreign":true}'),
      }),
    ).rejects.toMatchObject({ code: "FOREIGN_BINDING" });
    await store.close();
  });

  it("orders cancellation and execution start with one atomic winner", async () => {
    const first = await makeStore();
    const created = await createWaiting(first.approvals);
    await first.approvals.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
      binding: first.binding(created.approvalId),
    });
    const approved = first.approvals.get(created.approvalId)!;
    const [cancelled, started] = await Promise.all([
      first.approvals.cancel({ approvalId: approved.approvalId, expectedVersion: approved.version }),
      first.approvals.claimExecutionStart({
        approvalId: approved.approvalId,
        expectedVersion: approved.version,
        binding: first.binding(approved.approvalId),
      }),
    ]);
    expect(cancelled.status).toBe("cancelled");
    expect(started.claimed).toBe(false);
    expect(first.approvals.get(approved.approvalId)?.executionStartedAt).toBeNull();
    await first.store.close();

    const second = await makeStore();
    const secondCreated = await createWaiting(second.approvals);
    await second.approvals.claimDecision({
      approvalId: secondCreated.approvalId,
      expectedVersion: secondCreated.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
      binding: second.binding(secondCreated.approvalId),
    });
    const secondApproved = second.approvals.get(secondCreated.approvalId)!;
    const [claimed, cancellationRequest] = await Promise.all([
      second.approvals.claimExecutionStart({
        approvalId: secondApproved.approvalId,
        expectedVersion: secondApproved.version,
        binding: second.binding(secondApproved.approvalId),
      }),
      second.approvals.cancel({
        approvalId: secondApproved.approvalId,
        expectedVersion: secondApproved.version,
      }),
    ]);
    expect(claimed.claimed).toBe(true);
    expect(cancellationRequest.status).toBe("executing");
    expect(cancellationRequest.cancellationRequestedAt).not.toBeNull();
    await second.store.close();
  });

  it("invalidates active approvals by Run and session without touching other owners", async () => {
    const { store, approvals, binding } = await makeStore();
    const runPending = await createWaiting(approvals, {
      approvalId: "run-pending",
      invocationId: "run-pending-invocation",
      workflowRunId: "run-pending-workflow",
      runId: "run-target",
      sessionId: "session-run",
    });
    const runExecuting = await createWaiting(approvals, {
      approvalId: "run-executing",
      invocationId: "run-executing-invocation",
      workflowRunId: "run-executing-workflow",
      runId: "run-target",
      sessionId: "session-executing",
    });
    const sessionPending = await createWaiting(approvals, {
      approvalId: "session-pending",
      invocationId: "session-pending-invocation",
      workflowRunId: "session-pending-workflow",
      runId: "run-other",
      sessionId: "session-target",
    });
    const unrelated = await createWaiting(approvals, {
      approvalId: "unrelated",
      invocationId: "unrelated-invocation",
      workflowRunId: "unrelated-workflow",
      runId: "run-other",
      sessionId: "session-other",
    });

    const runExecutingBinding = binding(runExecuting.approvalId, undefined, {
      invocationId: runExecuting.invocationId,
      workflowRunId: runExecuting.workflowRunId,
      runId: runExecuting.runId,
      sessionId: runExecuting.sessionId,
    });
    const approved = await approvals.claimDecision({
      approvalId: runExecuting.approvalId,
      expectedVersion: runExecuting.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
      binding: runExecutingBinding,
    });
    const started = await approvals.claimExecutionStart({
      approvalId: runExecuting.approvalId,
      expectedVersion: approved.record.version,
      binding: runExecutingBinding,
    });
    expect(started.claimed).toBe(true);

    await expect(approvals.invalidateForRun("run-target", "Run stopped")).resolves.toBe(2);
    expect(approvals.get(runPending.approvalId)?.status).toBe("cancelled");
    const executingAfterRun = approvals.get(runExecuting.approvalId)!;
    expect(executingAfterRun.status).toBe("executing");
    expect(executingAfterRun.cancellationReason).toBe("Run stopped");

    await expect(
      approvals.invalidateForSession("session-target", "Session stopped"),
    ).resolves.toBe(1);
    expect(approvals.get(sessionPending.approvalId)?.status).toBe("cancelled");
    expect(approvals.get(unrelated.approvalId)?.status).toBe("waiting");

    // Repeated lifecycle notifications do not churn the durable version or
    // report another invalidation after the fence is already closed.
    const executingVersion = approvals.get(runExecuting.approvalId)!.version;
    await expect(approvals.invalidateForRun("run-target", "Run stopped again")).resolves.toBe(0);
    expect(approvals.get(runExecuting.approvalId)?.version).toBe(executingVersion);
    await store.close();
  });

  it("issues exactly one execution claim when two starts race", async () => {
    const { store, approvals, binding } = await makeStore();
    const created = await createWaiting(approvals);
    const approved = await approvals.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
      binding: binding(created.approvalId),
    });

    const starts = await Promise.all([
      approvals.claimExecutionStart({
        approvalId: created.approvalId,
        expectedVersion: approved.record.version,
        binding: binding(created.approvalId),
      }),
      approvals.claimExecutionStart({
        approvalId: created.approvalId,
        expectedVersion: approved.record.version,
        binding: binding(created.approvalId),
      }),
    ]);
    expect(starts.filter((result) => result.claimed)).toHaveLength(1);
    const loser = starts.find((result) => !result.claimed);
    expect(loser).toBeDefined();
    expect(["already_started", "stale"]).toContain(loser?.reason);
    expect(approvals.get(created.approvalId)?.status).toBe("executing");
    await store.close();
  });

  it("rechecks cancellation at the final execution boundary", async () => {
    const { store, approvals, binding } = await makeStore();
    const created = await createWaiting(approvals);
    const approved = await approvals.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
      binding: binding(created.approvalId),
    });
    const resuming = await approvals.markResuming(
      created.approvalId,
      approved.record.version,
      binding(created.approvalId),
    );
    const started = await approvals.claimExecutionStart({
      approvalId: created.approvalId,
      expectedVersion: resuming.version,
      binding: binding(created.approvalId),
    });
    expect(started.claimed).toBe(true);
    await approvals.cancel({
      approvalId: created.approvalId,
      expectedVersion: started.record.version,
    });
    await expect(
      approvals.confirmExecutionStart({
        approvalId: created.approvalId,
        expectedVersion: started.claim!.version,
        binding: binding(created.approvalId),
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_CLAIM_INVALID" });
    await store.close();
  });

  it("keeps the same decision idempotent after an approved invocation completes", async () => {
    const { store, approvals, binding } = await makeStore();
    const created = await createWaiting(approvals);
    const approved = await approvals.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
      binding: binding(created.approvalId),
    });
    const resuming = await approvals.markResuming(
      created.approvalId,
      approved.record.version,
      binding(created.approvalId),
    );
    const started = await approvals.claimExecutionStart({
      approvalId: created.approvalId,
      expectedVersion: resuming.version,
      binding: binding(created.approvalId),
    });
    expect(started.claimed).toBe(true);
    const settled = await approvals.settleExecution({
      approvalId: created.approvalId,
      claim: started.claim!,
      outcome: "succeeded",
    });
    const duplicate = await approvals.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: true,
      actor: { kind: "human", id: "retrying-actor" },
      binding: binding(created.approvalId),
    });
    expect(duplicate).toEqual({ outcome: "idempotent", record: settled });
    expect(() =>
      approvals.getPrivateState(created.approvalId, binding(created.approvalId)),
    ).toThrowError(expect.objectContaining({ code: "PRIVATE_STATE_UNAVAILABLE" }));
    await store.close();
  });

  it("rejects foreign bindings and records guard failures before execution", async () => {
    const { store, approvals, binding } = await makeStore();
    const created = await createWaiting(approvals);
    await expect(
      approvals.claimDecision({
        approvalId: created.approvalId,
        expectedVersion: created.version,
        approved: true,
        actor: { kind: "human", id: "demo-owner" },
        binding: binding(created.approvalId, '{"path":"different"}'),
      }),
    ).rejects.toMatchObject<ToolApprovalStoreError>({ code: "FOREIGN_BINDING" });

    const approved = await approvals.claimDecision({
      approvalId: created.approvalId,
      expectedVersion: created.version,
      approved: true,
      actor: { kind: "human", id: "demo-owner" },
      binding: binding(created.approvalId),
    });
    const failed = await approvals.markPreExecutionFailure(
      created.approvalId,
      approved.record.version,
      "Current authorization no longer permits restart",
      binding(created.approvalId),
    );
    expect(failed.status).toBe("failed_pre_execution");
    expect(failed.executionStartedAt).toBeNull();
    expect(approvals.getPublic(created.approvalId)).not.toHaveProperty("privateInputHandle");
    await store.close();
  });

  it("invalidates old owner epochs without replaying private state and normalizes historical snapshots", async () => {
    const first = await makeStore(1);
    const created = await createWaiting(first.approvals);
    await first.approvals.rotateOwnerEpoch(2);
    expect(first.approvals.get(created.approvalId)?.status).toBe("cancelled");
    expect(() =>
      first.approvals.getPrivateState(created.approvalId, first.binding(created.approvalId)),
    ).toThrowError(expect.objectContaining({ code: "PRIVATE_STATE_UNAVAILABLE" }));
    await first.store.close();

    const historical = normalizeDatabase({
      version: 1,
      agents: [],
      messages: [],
      runs: [],
      approvalRequests: [],
      capabilityGrants: [],
      auditEvents: [],
      permitApprovalCorrelations: [],
    });
    expect(historical.toolApprovalInvocations).toEqual([]);
  });

  it("rejects imported decision metadata and state combinations PostgreSQL rejects", async () => {
    const { store, approvals } = await makeStore();
    const created = await createWaiting(approvals);
    expect(() => normalizeToolApprovalInvocations([{
      ...created,
      status: "approved",
      decision: "approved",
      decisionActor: null,
      decisionAt: null,
    }])).toThrow("Decision, actor, and decisionAt must be present together");
    expect(() => normalizeToolApprovalInvocations([{
      ...created,
      status: "executing",
      decision: null,
      decisionActor: null,
      decisionAt: null,
    }])).toThrow("executing state requires an approval decision");
    await store.close();
  });

  it("allowlists normalized projection fields and snapshots private input", async () => {
    const { store, approvals, binding } = await makeStore();
    const privateInput = { nested: { value: "original" } };
    const created = await approvals.createInvocation({
      approvalId: "allowlist-approval",
      invocationId: "allowlist-invocation",
      workflowRunId: "allowlist-workflow",
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      toolId: "project.preview.restart",
      policyVersion: "tool-approval-v1",
      inputBinding: '{"nested":{"value":"original"}}',
      privateInput,
      safeSummary: "Restart preview",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      initialStatus: "waiting",
    });
    privateInput.nested.value = "mutated-after-create";
    const state = approvals.getPrivateState(created.approvalId, {
      ...binding(created.approvalId),
      invocationId: created.invocationId,
      workflowRunId: created.workflowRunId,
      orchestrationId: null,
      turnId: null,
      sessionId: null,
      inputBinding: '{"nested":{"value":"original"}}',
    });
    expect(state.input).toEqual({ nested: { value: "original" } });
    expect(Object.isFrozen(state.input)).toBe(true);
    expect(Object.isFrozen((state.input as { nested: object }).nested)).toBe(true);

    const normalized = normalizeToolApprovalInvocations([{
      ...created,
      apiKey: "must-not-persist",
      headers: { authorization: "must-not-persist" },
      requestBody: { rawInput: "must-not-persist" },
    }])[0]!;
    expect(normalized).not.toHaveProperty("apiKey");
    expect(normalized).not.toHaveProperty("headers");
    expect(normalized).not.toHaveProperty("requestBody");
    expect(JSON.stringify(normalized)).not.toContain("must-not-persist");
    await store.close();
  });

  it("advances the owner epoch before reconciling old active approvals", async () => {
    const first = await makeStore(1);
    const created = await createWaiting(first.approvals);
    const restarted = new ToolApprovalStore(first.store, {
      now: () => Date.parse("2026-09-09T00:00:00.000Z"),
    });
    await restarted.initializeOwnerEpoch();
    expect(restarted.ownerEpoch).toBe(2);
    expect(restarted.get(created.approvalId)?.status).toBe("cancelled");
    expect(() => restarted.getPrivateStateForWorkflow(created.invocationId)).toThrowError(
      expect.objectContaining({ code: "OWNER_EPOCH_MISMATCH" }),
    );
    await first.store.close();
  });
});
