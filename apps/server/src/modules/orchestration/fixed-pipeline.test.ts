import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { RunCancelledError } from "../../errors.js";
import { JsonStore } from "../../store.js";
import type { Agent, AgentRunner, Project, RunnerRequest, RunnerResult } from "../../types.js";
import { TelemetryLedger } from "../telemetry/telemetry-ledger.js";
import { FixedPipeline } from "./fixed-pipeline.js";
import { OrchestrationControl } from "./orchestration-control.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const agent = (name: string): Agent => ({
  id: randomUUID(),
  name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: "/w/" + name,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

class RecordingRunner implements AgentRunner {
  seen: RunnerRequest[] = [];
  behavior: (request: RunnerRequest) => Promise<RunnerResult> = async (request) => ({
    output: `output for ${request.sandboxMode}`,
    threadId: null,
    usage: { inputTokens: 3, outputTokens: 4 },
  });
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.seen.push(request);
    return this.behavior(request);
  }
  async cancel(): Promise<boolean> {
    return true;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-pipeline-"));
  dirs.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const planner = agent("planner");
  const builder = agent("builder");
  const reviewer = agent("reviewer");
  const project: Project = {
    id: randomUUID(),
    name: "Demo",
    description: "",
    workspacePath: path.join(root, "pw"),
    roles: {
      plannerAgentId: planner.id,
      builderAgentId: builder.id,
      reviewerAgentId: reviewer.id,
    },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.mutate((db) => {
    db.agents.push(planner, builder, reviewer);
    db.projects.push(project);
  });
  const control = new OrchestrationControl(store, { queueLimit: 50 });
  const runner = new RecordingRunner();
  const pipeline = new FixedPipeline({ store, control, runner });
  return { store, control, runner, pipeline, project, planner, builder, reviewer };
};

const drain = async (pipeline: FixedPipeline): Promise<string[]> => {
  const results: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await pipeline.tick();
    results.push(r);
    if (r === "idle") break;
  }
  return results;
};

describe("FixedPipeline", () => {
  it("runs planner -> builder -> reviewer with correct sandboxes and correlated records", async () => {
    const { store, control, runner, pipeline, project } = await setup();
    const { orchestration } = await control.enqueue({
      projectId: project.id,
      prompt: "ship the feature",
      providerId: "mock",
    });

    await drain(pipeline);

    expect(runner.seen.map((r) => r.sandboxMode)).toEqual([
      "read-only",
      "workspace-write",
      "read-only",
    ]);
    expect(runner.seen.map((r) => r.agentId)).toEqual([
      project.roles.plannerAgentId,
      project.roles.builderAgentId,
      project.roles.reviewerAgentId,
    ]);

    const db = store.snapshot();
    const record = db.orchestrations.find((o) => o.id === orchestration.id)!;
    expect(record.status).toBe("completed");
    expect(record.stages.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    const stageRuns = db.runs.filter((r) => r.orchestrationId === record.id);
    expect(stageRuns).toHaveLength(3);
    expect(stageRuns.every((r) => r.traceId === record.traceId)).toBe(true);
    expect(new Set(stageRuns.map((r) => r.stage))).toEqual(
      new Set(["planner", "builder", "reviewer"]),
    );
    // handoffs: user->planner, planner->builder, builder->reviewer, reviewer->user
    const handoffs = db.handoffMessages.filter((m) => m.orchestrationId === record.id);
    expect(handoffs.map((m) => m.contentType)).toEqual([
      "task",
      "plan",
      "build-summary",
      "review",
    ]);
    // role agents released
    expect(db.agents.every((a) => a.status === "ready")).toBe(true);
  });

  it("blocks later stages when the planner fails", async () => {
    const { store, control, runner, pipeline, project } = await setup();
    runner.behavior = async () => {
      throw new Error("planner exploded");
    };
    const { orchestration } = await control.enqueue({
      projectId: project.id,
      prompt: "x",
      providerId: "mock",
    });

    const results = await drain(pipeline);
    expect(results).toEqual(["failed-stage", "idle"]);

    const db = store.snapshot();
    const record = db.orchestrations.find((o) => o.id === orchestration.id)!;
    expect(record.status).toBe("failed");
    expect(record.stages.map((s) => s.status)).toEqual([
      "failed",
      "blocked",
      "blocked",
    ]);
    expect(db.queueJobs.filter((j) => j.status === "queued")).toHaveLength(0);
    expect(runner.seen).toHaveLength(1);
  });

  it("does not start a later stage after the orchestration is cancelled", async () => {
    const { store, control, runner, pipeline, project } = await setup();
    const { orchestration } = await control.enqueue({
      projectId: project.id,
      prompt: "x",
      providerId: "mock",
    });

    expect(await pipeline.tick()).toBe("completed-stage"); // planner done
    await control.cancel(orchestration.id);
    const after = await pipeline.tick();
    expect(after === "idle" || after === "skipped").toBe(true);

    const db = store.snapshot();
    expect(db.orchestrations[0]!.status).toBe("cancelled");
    expect(runner.seen).toHaveLength(1); // builder never ran
  });

  it("finishes one orchestration's stages before starting the next (FIFO)", async () => {
    const { store, control, runner, pipeline, project } = await setup();
    const first = await control.enqueue({
      projectId: project.id,
      prompt: "first",
      providerId: "mock",
    });
    const second = await control.enqueue({
      projectId: project.id,
      prompt: "second",
      providerId: "mock",
    });

    // exactly three ticks should complete the first orchestration
    await pipeline.tick();
    await pipeline.tick();
    await pipeline.tick();

    const db = store.snapshot();
    const firstRecord = db.orchestrations.find((o) => o.id === first.orchestration.id)!;
    const secondRecord = db.orchestrations.find((o) => o.id === second.orchestration.id)!;
    expect(firstRecord.status).toBe("completed");
    expect(secondRecord.status).toBe("queued");
    expect(
      runner.seen.every((r) => r.prompt.includes("first")),
    ).toBe(true);
  });

  it("retries a transient planner failure once, then succeeds", async () => {
    const { store, control, runner, pipeline, project } = await setup();
    let calls = 0;
    runner.behavior = async (request) => {
      calls += 1;
      if (calls === 1) throw new Error("provider returned 503");
      return { output: `ok ${request.stage}`, threadId: null, usage: null };
    };
    const { orchestration } = await control.enqueue({
      projectId: project.id,
      prompt: "x",
      providerId: "mock",
    });

    await drain(pipeline);

    const db = store.snapshot();
    const record = db.orchestrations.find((o) => o.id === orchestration.id)!;
    expect(record.status).toBe("completed");
    const plannerRuns = db.runs.filter(
      (r) => r.orchestrationId === record.id && r.stage === "planner",
    );
    expect(plannerRuns).toHaveLength(2);
    expect(plannerRuns.map((r) => r.status).sort()).toEqual(["completed", "failed"]);
    expect(plannerRuns.find((r) => r.status === "completed")!.attempt).toBe(1);
  });

  it("does not retry a builder failure after process start", async () => {
    const { store, control, runner, pipeline, project } = await setup();
    runner.behavior = async (request) => {
      if (request.stage === "builder") {
        throw new Error("container exited with code 1");
      }
      return { output: "ok", threadId: null, usage: null };
    };
    const { orchestration } = await control.enqueue({
      projectId: project.id,
      prompt: "x",
      providerId: "mock",
    });

    await drain(pipeline);

    const db = store.snapshot();
    const record = db.orchestrations.find((o) => o.id === orchestration.id)!;
    expect(record.status).toBe("failed");
    expect(db.runs.filter((r) => r.stage === "builder")).toHaveLength(1);
  });

  it("records correlated, redacted telemetry spans for each stage", async () => {
    const { store, control, runner, project } = await setup();
    runner.behavior = async (request) => ({
      output: `stage output ${request.stage}`,
      threadId: null,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const ledger = new TelemetryLedger({ store, secretValues: () => [] });
    const pipeline = new FixedPipeline({ store, control, runner, telemetry: ledger });
    const { orchestration } = await control.enqueue({
      projectId: project.id,
      prompt: "x",
      providerId: "mock",
    });

    await drain(pipeline);

    const db = store.snapshot();
    const record = db.orchestrations.find((o) => o.id === orchestration.id)!;
    const spans = db.telemetry.filter((t) => t.traceId === record.traceId);
    expect(spans.some((s) => s.kind === "stage.planner")).toBe(true);
    expect(spans.some((s) => s.kind === "stage.builder")).toBe(true);
    expect(spans.some((s) => s.kind === "stage.reviewer")).toBe(true);
    expect(spans.some((s) => s.kind === "orchestration")).toBe(true);

    const plannerRun = db.runs.find((r) => r.stage === "planner")!;
    const view = await ledger.inspectRun(plannerRun.id);
    expect(view.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(view.counts.total).toBeGreaterThanOrEqual(2);
  });

  it("marks a cancelled stage run without failing the whole record twice", async () => {
    const { store, control, runner, pipeline, project } = await setup();
    runner.behavior = async () => {
      throw new RunCancelledError();
    };
    const { orchestration } = await control.enqueue({
      projectId: project.id,
      prompt: "x",
      providerId: "mock",
    });
    await drain(pipeline);
    const record = store.snapshot().orchestrations.find((o) => o.id === orchestration.id)!;
    expect(record.status).toBe("cancelled");
    expect(record.stages[0]!.status).toBe("cancelled");
  });
});
