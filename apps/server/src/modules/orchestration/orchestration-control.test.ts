import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import type { Project } from "../../types.js";
import { OrchestrationControl } from "./orchestration-control.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const project = (): Project => ({
  id: randomUUID(),
  name: "Demo",
  description: "",
  workspacePath: "/pw/demo",
  roles: {
    plannerAgentId: randomUUID(),
    builderAgentId: randomUUID(),
    reviewerAgentId: randomUUID(),
  },
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const setup = async (queueLimit = 50) => {
  const root = await mkdtemp(path.join(tmpdir(), "orch-control-"));
  dirs.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const proj = project();
  await store.mutate((db) => {
    db.projects.push(proj);
  });
  const control = new OrchestrationControl(store, { queueLimit });
  return { store, control, projectId: proj.id };
};

const enqueueInput = (projectId: string) => ({
  projectId,
  prompt: "do the thing",
  providerId: "mock",
});

describe("OrchestrationControl.enqueue", () => {
  it("persists orchestration, first queue job, message and a monotonic sequence", async () => {
    const { store, control, projectId } = await setup();
    const a = await control.enqueue(enqueueInput(projectId));
    const b = await control.enqueue(enqueueInput(projectId));

    expect(a.orchestration.status).toBe("queued");
    expect(a.orchestration.sequence).toBe(1);
    expect(b.orchestration.sequence).toBe(2);
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]).toMatchObject({ fromStage: "user", toStage: "planner" });

    const db = store.snapshot();
    expect(db.nextQueueSequence).toBe(3);
    expect(db.queueJobs).toHaveLength(2);
    expect(db.queueJobs.every((j) => j.stage === "planner" && j.status === "queued")).toBe(true);
  });

  it("returns the original orchestration for a duplicate idempotency key", async () => {
    const { control, projectId } = await setup();
    const key = "client-key-1";
    const first = await control.enqueue({ ...enqueueInput(projectId), idempotencyKey: key });
    const second = await control.enqueue({ ...enqueueInput(projectId), idempotencyKey: key });
    expect(second.orchestration.id).toBe(first.orchestration.id);
  });

  it("assigns distinct sequences under concurrent submission", async () => {
    const { store, control, projectId } = await setup();
    await Promise.all(
      Array.from({ length: 10 }, () => control.enqueue(enqueueInput(projectId))),
    );
    const sequences = store.snapshot().orchestrations.map((o) => o.sequence).sort((x, y) => x - y);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns 429 once the queue depth limit is reached", async () => {
    const { control, projectId } = await setup(2);
    await control.enqueue(enqueueInput(projectId));
    await control.enqueue(enqueueInput(projectId));
    await expect(control.enqueue(enqueueInput(projectId))).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("rejects an unknown project", async () => {
    const { control } = await setup();
    await expect(control.enqueue(enqueueInput(randomUUID()))).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("OrchestrationControl.claimNext", () => {
  it("claims exactly the lowest-sequence job and only one at a time", async () => {
    const { store, control, projectId } = await setup();
    await control.enqueue(enqueueInput(projectId));
    await control.enqueue(enqueueInput(projectId));

    const claims = await Promise.all([control.claimNext(), control.claimNext()]);
    const claimed = claims.filter((c) => c !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.sequence).toBe(1);
    expect(store.snapshot().queueJobs.filter((j) => j.status === "running")).toHaveLength(1);

    // nothing else can be claimed while one is running
    expect(await control.claimNext()).toBeNull();
  });
});

describe("OrchestrationControl.reconcileAfterRestart", () => {
  it("fails an interrupted running job and frees its Agent, leaving queued work alone", async () => {
    const { store, control, projectId } = await setup();
    await control.enqueue(enqueueInput(projectId));
    await control.enqueue(enqueueInput(projectId));
    const claimed = await control.claimNext();
    await store.mutate((db) => {
      db.agents.push({
        id: "agent-x",
        name: "Planner",
        description: "",
        instructions: "",
        status: "busy",
        workspacePath: "/w/planner",
        codexThreadId: null,
        lastError: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const agent = db.agents[0]!;
      const job = db.queueJobs.find((j) => j.id === claimed!.id)!;
      job.runId = "run-x";
      db.runs.push({
        id: "run-x",
        agentId: agent.id,
        status: "running",
        prompt: "p",
        output: null,
        error: null,
        usage: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    const count = await control.reconcileAfterRestart();
    expect(count).toBe(1);

    const db = store.snapshot();
    expect(db.queueJobs.find((j) => j.id === claimed!.id)!.status).toBe("failed");
    expect(db.queueJobs.filter((j) => j.status === "queued")).toHaveLength(1);
    expect(db.orchestrations.find((o) => o.id === claimed!.orchestrationId)!.status).toBe(
      "failed",
    );
    expect(db.runs.find((r) => r.id === "run-x")!.error).toBe("interrupted_by_restart");
    expect(db.agents.every((a) => a.status !== "busy")).toBe(true);
    // a fresh claim can still proceed on the remaining queued job
    expect(await control.claimNext()).not.toBeNull();
  });

  it("is a no-op when nothing was running", async () => {
    const { control, projectId } = await setup();
    await control.enqueue(enqueueInput(projectId));
    expect(await control.reconcileAfterRestart()).toBe(0);
  });
});

describe("OrchestrationControl.cancel", () => {
  it("moves a queued orchestration and its jobs to a terminal state", async () => {
    const { store, control, projectId } = await setup();
    const view = await control.enqueue(enqueueInput(projectId));
    const cancelled = await control.cancel(view.orchestration.id);

    expect(cancelled.orchestration.status).toBe("cancelled");
    expect(cancelled.orchestration.stages.every((s) => s.status === "cancelled")).toBe(true);
    expect(
      store.snapshot().queueJobs.filter((j) => j.status === "cancelled"),
    ).toHaveLength(1);
    await expect(control.cancel(view.orchestration.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
