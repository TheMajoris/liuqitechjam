import { randomUUID } from "node:crypto";
import { RunCancelledError } from "../../errors.js";
import type { JsonStore } from "../../store.js";
import {
  ORCHESTRATION_STAGES,
  type AgentRun,
  type AgentRunner,
  type Database,
  type HandoffContentType,
  type OrchestrationStage,
  type QueueJob,
  type SandboxMode,
} from "../../types.js";
import type { OrchestrationControl } from "./orchestration-control.js";
import { decideRetry } from "./retry-policy.js";

const errorCode = (error: unknown): string | undefined =>
  typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : undefined;

const now = (): string => new Date().toISOString();

const STAGE_SANDBOX: Record<OrchestrationStage, SandboxMode> = {
  planner: "read-only",
  builder: "workspace-write",
  reviewer: "read-only",
};

const OUTGOING_CONTENT: Record<OrchestrationStage, HandoffContentType> = {
  planner: "plan",
  builder: "build-summary",
  reviewer: "review",
};

const nextStage = (stage: OrchestrationStage): OrchestrationStage | null => {
  const index = ORCHESTRATION_STAGES.indexOf(stage);
  return ORCHESTRATION_STAGES[index + 1] ?? null;
};

export type TickResult = "idle" | "completed-stage" | "failed-stage" | "skipped";

export interface FixedPipelineDeps {
  store: JsonStore;
  control: OrchestrationControl;
  runner: AgentRunner;
  /** Structured observation hook (stage start/finish). Optional. */
  onEvent?: (event: {
    kind: "stage.start" | "stage.finish";
    orchestrationId: string;
    stage: OrchestrationStage;
    runId: string;
    status?: "completed" | "failed" | "cancelled";
  }) => void;
}

/**
 * Executes the immutable Planner -> Builder -> Reviewer pipeline.
 *
 * One stage runs globally at a time (enforced by `OrchestrationControl.claimNext`).
 * Planner and Reviewer run read-only; the Builder is the sole workspace writer.
 * Every stage is an ordinary correlated Agent Run and produces a handoff
 * message. Failure, block, or cancellation stops every later stage.
 * See `tasks/plan.md` sections 9 and 11.
 */
export class FixedPipeline {
  private readonly store: JsonStore;
  private readonly control: OrchestrationControl;
  private readonly runner: AgentRunner;
  private readonly onEvent: NonNullable<FixedPipelineDeps["onEvent"]>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: FixedPipelineDeps) {
    this.store = deps.store;
    this.control = deps.control;
    this.runner = deps.runner;
    this.onEvent = deps.onEvent ?? (() => undefined);
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    const loop = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        // Drain as many stages as are eligible this pass.
        while ((await this.tick()) !== "idle") {
          /* keep going */
        }
      } catch {
        /* a failed tick is already recorded on the record; keep the loop alive */
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void loop(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Claim and execute at most one stage. Returns what happened. */
  async tick(): Promise<TickResult> {
    const job = await this.control.claimNext();
    if (!job) return "idle";

    const prepared = await this.prepareStage(job);
    if (!prepared) return "skipped";
    const { runId, prompt, roleAgentId, workspacePath } = prepared;

    this.onEvent({
      kind: "stage.start",
      orchestrationId: job.orchestrationId,
      stage: job.stage,
      runId,
    });

    try {
      const result = await this.runner.run({
        agentId: roleAgentId,
        workspacePath,
        prompt,
        threadId: null,
        runId,
        sandboxMode: STAGE_SANDBOX[job.stage],
        orchestrationId: job.orchestrationId,
        stage: job.stage,
        attempt: job.attempt,
      });
      await this.completeStage(job, runId, roleAgentId, result.output, result.usage);
      this.onEvent({
        kind: "stage.finish",
        orchestrationId: job.orchestrationId,
        stage: job.stage,
        runId,
        status: "completed",
      });
      return "completed-stage";
    } catch (error) {
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const decision = cancelled
        ? { retry: false, backoffMs: 0, reason: "cancelled" }
        : decideRetry({
            stage: job.stage,
            attempt: job.attempt,
            code: errorCode(error),
            message,
          });
      await this.failStage(job, runId, roleAgentId, message, cancelled, decision.retry);
      this.onEvent({
        kind: "stage.finish",
        orchestrationId: job.orchestrationId,
        stage: job.stage,
        runId,
        status: cancelled ? "cancelled" : "failed",
      });
      return "failed-stage";
    }
  }

  private async prepareStage(job: QueueJob): Promise<
    | { runId: string; prompt: string; roleAgentId: string; workspacePath: string }
    | null
  > {
    return this.store.mutate((database) => {
      const record = database.orchestrations.find(
        (o) => o.id === job.orchestrationId,
      );
      const project = record
        ? database.projects.find((p) => p.id === record.projectId)
        : undefined;
      const liveJob = database.queueJobs.find((j) => j.id === job.id);
      if (!record || !project || !liveJob || liveJob.status !== "running") {
        if (liveJob && liveJob.status === "running") {
          liveJob.status = "cancelled";
          liveJob.updatedAt = now();
        }
        return null;
      }
      if (record.status === "cancelled" || record.status === "failed") {
        liveJob.status = "cancelled";
        liveJob.completedAt = now();
        liveJob.updatedAt = now();
        return null;
      }

      const roleAgentId = {
        planner: project.roles.plannerAgentId,
        builder: project.roles.builderAgentId,
        reviewer: project.roles.reviewerAgentId,
      }[job.stage];

      const timestamp = now();
      const runId = randomUUID();
      const stageState = record.stages.find((s) => s.stage === job.stage);
      if (stageState) {
        stageState.status = "running";
        stageState.runId = runId;
        stageState.attempt = liveJob.attempt;
        stageState.startedAt = timestamp;
      }
      record.updatedAt = timestamp;

      const prompt = this.buildPrompt(database, record.id, job.stage, record.prompt);

      const run: AgentRun = {
        id: runId,
        agentId: roleAgentId,
        status: "running",
        prompt,
        output: null,
        error: null,
        usage: null,
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
        projectId: record.projectId,
        orchestrationId: record.id,
        traceId: record.traceId,
        stage: job.stage,
        attempt: liveJob.attempt,
      };
      database.runs.push(run);

      const agent = database.agents.find((a) => a.id === roleAgentId);
      if (agent && agent.status !== "stopped") {
        agent.status = "busy";
        agent.updatedAt = timestamp;
      }

      liveJob.runId = runId;
      liveJob.updatedAt = timestamp;

      return {
        runId,
        prompt,
        roleAgentId,
        workspacePath: project.workspacePath,
      };
    });
  }

  private buildPrompt(
    database: Database,
    orchestrationId: string,
    stage: OrchestrationStage,
    task: string,
  ): string {
    const messages = database.handoffMessages
      .filter((m) => m.orchestrationId === orchestrationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const planMsg = messages.find((m) => m.contentType === "plan");
    const buildMsg = messages.find((m) => m.contentType === "build-summary");

    if (stage === "planner") {
      return [
        "You are the PLANNER. Produce a bounded, concrete implementation plan.",
        "Do not modify any files; you are running read-only.",
        "",
        "## Task",
        task,
      ].join("\n");
    }
    if (stage === "builder") {
      return [
        "You are the BUILDER. Implement the plan in the shared project workspace.",
        "You are the only role permitted to write files.",
        "",
        "## Original task",
        task,
        "",
        "## Plan from the Planner",
        planMsg?.content ?? "(no plan recorded)",
        "",
        "When done, summarize exactly what you changed.",
      ].join("\n");
    }
    return [
      "You are the REVIEWER. Inspect the workspace read-only and review the work.",
      "Do not modify any files.",
      "",
      "## Original task",
      task,
      "",
      "## Plan",
      planMsg?.content ?? "(no plan recorded)",
      "",
      "## Builder summary",
      buildMsg?.content ?? "(no builder summary recorded)",
      "",
      "State whether the task is satisfied and list any remaining issues.",
    ].join("\n");
  }

  private async completeStage(
    job: QueueJob,
    runId: string,
    roleAgentId: string,
    output: string,
    usage: AgentRun["usage"],
  ): Promise<void> {
    await this.store.mutate((database) => {
      const timestamp = now();
      const record = database.orchestrations.find(
        (o) => o.id === job.orchestrationId,
      );
      const run = database.runs.find((r) => r.id === runId);
      const liveJob = database.queueJobs.find((j) => j.id === job.id);
      const agent = database.agents.find((a) => a.id === roleAgentId);
      if (!record || !run || !liveJob) return;
      // Duplicate completion is a no-op (plan section 9).
      if (liveJob.status !== "running") return;

      run.status = "completed";
      run.output = output;
      run.usage = usage;
      run.completedAt = timestamp;
      database.messages.push({
        id: randomUUID(),
        agentId: roleAgentId,
        runId,
        role: "assistant",
        content: output,
        createdAt: timestamp,
        orchestrationId: record.id,
        traceId: record.traceId,
        stage: job.stage,
      });

      const stageState = record.stages.find((s) => s.stage === job.stage);
      if (stageState) {
        stageState.status = "completed";
        stageState.completedAt = timestamp;
      }
      liveJob.status = "completed";
      liveJob.completedAt = timestamp;
      liveJob.updatedAt = timestamp;
      if (agent && agent.status === "busy") {
        agent.status = "ready";
        agent.updatedAt = timestamp;
      }

      const following = nextStage(job.stage);
      if (record.status === "cancelled" || record.status === "failed") {
        return; // a cancel landed mid-stage; do not advance
      }
      if (!following) {
        record.status = "completed";
        record.result = output;
        record.updatedAt = timestamp;
        // record a terminal handoff back to the operator
        database.handoffMessages.push({
          id: randomUUID(),
          orchestrationId: record.id,
          projectId: record.projectId,
          traceId: record.traceId,
          fromStage: "reviewer",
          toStage: "reviewer",
          fromAgentId: roleAgentId,
          toAgentId: null,
          contentType: OUTGOING_CONTENT[job.stage],
          content: output,
          createdAt: timestamp,
        });
        return;
      }

      const project = database.projects.find((p) => p.id === record.projectId);
      const toAgentId = project
        ? {
            planner: project.roles.plannerAgentId,
            builder: project.roles.builderAgentId,
            reviewer: project.roles.reviewerAgentId,
          }[following]
        : null;
      database.handoffMessages.push({
        id: randomUUID(),
        orchestrationId: record.id,
        projectId: record.projectId,
        traceId: record.traceId,
        fromStage: job.stage,
        toStage: following,
        fromAgentId: roleAgentId,
        toAgentId,
        contentType: OUTGOING_CONTENT[job.stage],
        content: output,
        createdAt: timestamp,
      });
      database.queueJobs.push({
        id: randomUUID(),
        orchestrationId: record.id,
        stage: following,
        sequence: record.sequence,
        status: "queued",
        attempt: 0,
        runId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        claimedAt: null,
        completedAt: null,
      });
    });
  }

  private async failStage(
    job: QueueJob,
    runId: string,
    roleAgentId: string,
    message: string,
    cancelled: boolean,
    retry = false,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const timestamp = now();
      const record = database.orchestrations.find(
        (o) => o.id === job.orchestrationId,
      );
      const run = database.runs.find((r) => r.id === runId);
      const liveJob = database.queueJobs.find((j) => j.id === job.id);
      const agent = database.agents.find((a) => a.id === roleAgentId);

      if (run) {
        run.status = cancelled ? "cancelled" : "failed";
        run.error = message;
        run.completedAt = timestamp;
      }
      if (liveJob) {
        liveJob.status = cancelled ? "cancelled" : "failed";
        liveJob.lastError = message;
        liveJob.completedAt = timestamp;
        liveJob.updatedAt = timestamp;
      }
      if (agent && agent.status === "busy") {
        agent.status = "ready";
        agent.lastError = null;
        agent.updatedAt = timestamp;
      }

      // Retry path: the failed attempt is recorded, but the stage is re-queued
      // with an incremented attempt and the orchestration stays in flight.
      if (retry && record && record.status !== "cancelled" && liveJob) {
        const stageState = record.stages.find((s) => s.stage === job.stage);
        if (stageState) {
          stageState.status = "queued";
          stageState.runId = null;
          stageState.error = message;
        }
        record.updatedAt = timestamp;
        database.queueJobs.push({
          id: randomUUID(),
          orchestrationId: record.id,
          stage: job.stage,
          sequence: record.sequence,
          status: "queued",
          attempt: job.attempt + 1,
          runId: null,
          lastError: message,
          createdAt: timestamp,
          updatedAt: timestamp,
          claimedAt: null,
          completedAt: null,
        });
        return;
      }

      if (record) {
        const stageState = record.stages.find((s) => s.stage === job.stage);
        if (stageState) {
          stageState.status = cancelled ? "cancelled" : "failed";
          stageState.error = message;
          stageState.completedAt = timestamp;
        }
        for (const s of record.stages) {
          if (s.status === "pending" || s.status === "queued") {
            s.status = cancelled ? "cancelled" : "blocked";
            s.completedAt = timestamp;
          }
        }
        if (record.status !== "cancelled") {
          record.status = cancelled ? "cancelled" : "failed";
          record.error = message;
        }
        record.updatedAt = timestamp;
      }
    });
  }
}
