import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../../apps/server/src/store.js";
import { WorkspaceOperationCoordinator } from "../../../apps/server/src/projects/workspace-operation-coordinator.js";
import { ProjectWriteLeaseCoordinator } from "../../../apps/server/src/projects/project-write-lease-coordinator.js";

const roots: string[] = [];
const projectId = "44444444-4444-4444-8444-444444444444";
const otherProjectId = "55555555-5555-4555-8555-555555555555";
const orchestrationId = "66666666-6666-4666-8666-666666666666";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "lqam-operations-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    for (const id of [projectId, otherProjectId]) {
      database.projects.push({
        id,
        name: "P " + id.slice(0, 4),
        description: "",
        workspacePath: path.join(root, id, "workspace"),
        teamId: null,
        ownerPrincipalId: "demo-owner",
        status: "active",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
    }
  });
  return store;
}

const cycleInput = {
  projectId,
  orchestrationId,
  actorPrincipalId: "demo-owner",
  expectedEpoch: 0,
};

describe("WorkspaceOperationCoordinator", () => {
  it("holds one reservation per Project and blocks every other writer", async () => {
    const store = await makeStore();
    const coordinator = new WorkspaceOperationCoordinator(store);
    const held = await coordinator.reserveCycle(cycleInput);
    expect(held.reservationHeld).toBe(true);

    await expect(coordinator.reserveCycle(cycleInput)).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    expect(() => coordinator.assertAdmission(store.snapshot(), projectId)).toThrow(
      expect.objectContaining({ code: "PROJECT_BUSY" }),
    );
    expect(() =>
      coordinator.assertAdmission(store.snapshot(), projectId, { workspaceOperationId: held.id, workspaceEpoch: 0 }),
    ).not.toThrow();
    expect(() =>
      coordinator.assertAdmission(store.snapshot(), projectId, { workspaceOperationId: held.id, workspaceEpoch: 1 }),
    ).toThrow(expect.objectContaining({ code: "PROJECT_BUSY" }));
    // A different Project is unaffected.
    await coordinator.reserveCycle({ ...cycleInput, projectId: otherProjectId });

    await coordinator.release(held.id, "settled");
    expect(coordinator.heldOperation(projectId)).toBeNull();
    // A stale owner is refused once its reservation is gone.
    expect(() =>
      coordinator.assertAdmission(store.snapshot(), projectId, { workspaceOperationId: held.id }),
    ).toThrow(expect.objectContaining({ code: "PROJECT_BUSY" }));
  });

  it("refuses a reservation while a lease, a queued Project Run, or a stale epoch exists", async () => {
    const store = await makeStore();
    const coordinator = new WorkspaceOperationCoordinator(store);
    await store.mutate((database) => {
      database.projectLeases.push({ projectId, runId: "run-1", agentId: "agent-1", acquiredAt: "2026-09-01T00:00:00.000Z" });
    });
    await expect(coordinator.reserveCycle(cycleInput)).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    await store.mutate((database) => {
      database.projectLeases = [];
      database.runs.push({
        id: "run-2",
        agentId: "agent-1",
        projectId,
        status: "queued",
        prompt: "x",
        output: null,
        error: null,
        usage: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    });
    await expect(coordinator.reserveCycle(cycleInput)).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    await store.mutate((database) => {
      database.runs = [];
    });
    await expect(coordinator.reserveCycle({ ...cycleInput, expectedEpoch: 3 })).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
    await expect(coordinator.reserveCycle(cycleInput)).resolves.toMatchObject({ kind: "cycle" });
  });

  it("deduplicates recovery requests and rejects a reused request ID with another payload", async () => {
    const store = await makeStore();
    const coordinator = new WorkspaceOperationCoordinator(store);
    const first = await coordinator.reserveRecovery({
      ...cycleInput,
      requestId: "req-1",
      requestFingerprint: "fp-a",
      targetCheckpointId: "cp-a",
    });
    expect(first.duplicate).toBe(false);
    const again = await coordinator.reserveRecovery({
      ...cycleInput,
      requestId: "req-1",
      requestFingerprint: "fp-a",
      targetCheckpointId: "cp-a",
    });
    expect(again.duplicate).toBe(true);
    expect(again.operation.id).toBe(first.operation.id);
    await expect(
      coordinator.reserveRecovery({
        ...cycleInput,
        requestId: "req-1",
        requestFingerprint: "fp-b",
        targetCheckpointId: "cp-b",
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_IDEMPOTENCY_CONFLICT" });
    expect(store.snapshot().workspaceOperations).toHaveLength(1);

    // A pending recovery gates the Project as recovery-required, not merely busy.
    expect(() => coordinator.assertAdmission(store.snapshot(), projectId)).toThrow(
      expect.objectContaining({ code: "PROJECT_RECOVERY_REQUIRED" }),
    );
    expect(coordinator.recoveryGate(projectId)?.id).toBe(first.operation.id);
  });

  it("transfers a recovery to exactly one resume cycle without a free window", async () => {
    const store = await makeStore();
    const coordinator = new WorkspaceOperationCoordinator(store);
    const { operation } = await coordinator.reserveRecovery({
      ...cycleInput,
      requestId: "req-2",
      requestFingerprint: "fp",
      targetCheckpointId: "cp",
    });
    const cycle = await store.mutate((database) =>
      structuredClone(
        coordinator.transferToCycleIn(database, operation.id, {
          orchestrationId,
          executionCycleId: "cycle-9",
          actorPrincipalId: "demo-owner",
          expectedEpoch: 1,
        }),
      ),
    );
    expect(cycle.reservationHeld).toBe(true);
    expect(cycle.kind).toBe("cycle");
    const recovery = coordinator.getOperation(operation.id)!;
    expect(recovery).toMatchObject({ reservationHeld: false, stage: "resume_accepted", resumeCycleId: "cycle-9" });
    await expect(
      store.mutate((database) =>
        coordinator.transferToCycleIn(database, operation.id, {
          orchestrationId,
          executionCycleId: "cycle-10",
          actorPrincipalId: "demo-owner",
          expectedEpoch: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "CHECKPOINT_OPERATION_STAGE_INVALID" });
    expect(coordinator.heldOperation(projectId)?.id).toBe(cycle.id);
  });

  it("quarantines interrupted operations at startup according to their stage", async () => {
    const store = await makeStore();
    const coordinator = new WorkspaceOperationCoordinator(store);
    const cycle = await coordinator.reserveCycle(cycleInput);
    const { operation: recovery } = await coordinator.reserveRecovery({
      ...cycleInput,
      projectId: otherProjectId,
      requestId: "req-3",
      requestFingerprint: "fp",
      targetCheckpointId: "cp",
    });
    await coordinator.transition(recovery.id, "restoring");

    const restarted = new WorkspaceOperationCoordinator(store);
    const report = await restarted.initialize({ unresolvedProjectIds: new Set() });
    expect(report.released.map((item) => item.id)).toEqual([cycle.id]);
    expect(report.retained.map((item) => item.id)).toEqual([recovery.id]);
    expect(restarted.getOperation(cycle.id)).toMatchObject({ reservationHeld: false, stage: "failed" });
    expect(restarted.getOperation(recovery.id)).toMatchObject({ reservationHeld: true, stage: "recovery_required" });

    // An unresolved physical writer keeps even a plain cycle reservation.
    const gated = await restarted.reserveCycle(cycleInput);
    const cautious = new WorkspaceOperationCoordinator(store);
    const second = await cautious.initialize({ unresolvedProjectIds: new Set([projectId]) });
    expect(second.retained.map((item) => item.id)).toContain(gated.id);
  });

  it("makes the write lease coordinator honor the reservation owner", async () => {
    const store = await makeStore();
    const operations = new WorkspaceOperationCoordinator(store);
    const leases = new ProjectWriteLeaseCoordinator(store, async () => undefined);
    leases.setAdmissionGuard((database, id, owner) => operations.assertAdmission(database, id, owner));
    const held = await operations.reserveCycle(cycleInput);

    await expect(
      leases.acquire(projectId, "agent-1", "run-foreign", { waitMs: 10 }),
    ).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    await leases.acquire(projectId, "agent-1", "run-owned", {
      waitMs: 10,
      workspaceOwner: { workspaceOperationId: held.id, workspaceEpoch: 0 },
    });
    expect(store.snapshot().projectLeases[0]).toMatchObject({
      runId: "run-owned",
      workspaceOperationId: held.id,
      workspaceEpoch: 0,
    });
    expect(() => leases.requireNoWriteLease(projectId)).toThrow(expect.objectContaining({ code: "PROJECT_BUSY" }));
    await leases.release(projectId, "run-owned", { settled: true });
    // Even with the lease gone, the reservation still blocks lifecycle work.
    expect(() => leases.assertProjectMutationAllowed(projectId)).toThrow(
      expect.objectContaining({ code: "PROJECT_BUSY" }),
    );
    expect(() =>
      leases.assertProjectMutationAllowed(projectId, { workspaceOperationId: held.id }),
    ).not.toThrow();
  });
});
