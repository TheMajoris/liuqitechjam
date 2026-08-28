import { randomUUID } from "node:crypto";
import { HttpError } from "../../errors.js";
import type { JsonStore } from "../../store.js";
import {
  ORCHESTRATION_STAGES,
  TERMINAL_ORCHESTRATION_STATUSES,
  type Database,
  type HandoffMessage,
  type OrchestrationRecord,
  type OrchestrationStage,
  type QueueJob,
  type StageState,
} from "../../types.js";

const now = (): string => new Date().toISOString();

export interface EnqueueOrchestration {
  projectId: string;
  prompt: string;
  providerId: string;
  idempotencyKey?: string | undefined;
}

export interface OrchestrationQuery {
  projectId?: string | undefined;
  status?: OrchestrationRecord["status"] | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface OrchestrationView {
  orchestration: OrchestrationRecord;
  /** 0 when a stage of this orchestration is running; 1 = next in line, etc. */
  queuePosition: number | null;
  messages: HandoffMessage[];
}

export interface OrchestrationPage {
  items: OrchestrationRecord[];
  nextCursor: string | null;
}

const isTerminal = (status: OrchestrationRecord["status"]): boolean =>
  TERMINAL_ORCHESTRATION_STATUSES.includes(status);

const freshStages = (): StageState[] =>
  ORCHESTRATION_STAGES.map((stage) => ({
    stage,
    status: "pending",
    runId: null,
    attempt: 0,
    startedAt: null,
    completedAt: null,
    error: null,
  }));

/**
 * Owns orchestration admission: idempotent submission, monotonic queue-sequence
 * allocation, the global queue-depth limit, and the single global atomic claim.
 * HTTP routes and the pipeline worker never edit queue rows directly — they go
 * through this module (see `tasks/plan.md` sections 5, 7, 9, 10).
 */
export class OrchestrationControl {
  constructor(
    private readonly store: JsonStore,
    private readonly options: { queueLimit: number },
  ) {}

  async enqueue(input: EnqueueOrchestration): Promise<OrchestrationView> {
    const snapshot = this.store.snapshot();
    if (!snapshot.projects.some((p) => p.id === input.projectId)) {
      throw new HttpError(404, "Project not found");
    }
    if (input.idempotencyKey) {
      const existing = snapshot.orchestrations.find(
        (o) => o.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        return this.viewFrom(this.store.snapshot(), existing.id);
      }
    }

    const id = await this.store.mutate((database) => {
      // Re-check inside the mutation: a concurrent submit may have won the key.
      if (input.idempotencyKey) {
        const existing = database.orchestrations.find(
          (o) => o.idempotencyKey === input.idempotencyKey,
        );
        if (existing) {
          return existing.id;
        }
      }
      const active = database.orchestrations.filter(
        (o) => !isTerminal(o.status),
      ).length;
      if (active >= this.options.queueLimit) {
        throw new HttpError(429, "Orchestration queue is full");
      }

      const sequence = database.nextQueueSequence;
      database.nextQueueSequence += 1;
      const timestamp = now();
      const orchestrationId = randomUUID();
      const traceId = randomUUID();

      const record: OrchestrationRecord = {
        id: orchestrationId,
        projectId: input.projectId,
        prompt: input.prompt,
        providerId: input.providerId,
        status: "queued",
        traceId,
        sequence,
        idempotencyKey: input.idempotencyKey ?? null,
        stages: freshStages(),
        result: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.orchestrations.push(record);

      const project = database.projects.find((p) => p.id === input.projectId);
      database.queueJobs.push({
        id: randomUUID(),
        orchestrationId,
        stage: "planner",
        sequence,
        status: "queued",
        attempt: 0,
        runId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        claimedAt: null,
        completedAt: null,
      });
      database.handoffMessages.push({
        id: randomUUID(),
        orchestrationId,
        projectId: input.projectId,
        traceId,
        fromStage: "user",
        toStage: "planner",
        fromAgentId: null,
        toAgentId: project?.roles.plannerAgentId ?? null,
        contentType: "task",
        content: input.prompt,
        createdAt: timestamp,
      });
      return orchestrationId;
    });

    return this.viewFrom(this.store.snapshot(), id);
  }

  async list(query: OrchestrationQuery = {}): Promise<OrchestrationPage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const ordered = this.store
      .snapshot()
      .orchestrations.filter(
        (o) =>
          (!query.projectId || o.projectId === query.projectId) &&
          (!query.status || o.status === query.status),
      )
      .sort((a, b) => b.sequence - a.sequence);

    const start = query.cursor
      ? ordered.findIndex((o) => o.id === query.cursor) + 1
      : 0;
    const items = ordered.slice(start, start + limit);
    const nextCursor =
      start + limit < ordered.length ? (items.at(-1)?.id ?? null) : null;
    return { items, nextCursor };
  }

  async inspect(id: string): Promise<OrchestrationView> {
    return this.viewFrom(this.store.snapshot(), id);
  }

  async cancel(id: string): Promise<OrchestrationView> {
    await this.store.mutate((database) => {
      const record = database.orchestrations.find((o) => o.id === id);
      if (!record) {
        throw new HttpError(404, "Orchestration not found");
      }
      if (isTerminal(record.status)) {
        throw new HttpError(409, "Orchestration is already in a terminal state");
      }
      const timestamp = now();
      record.status = "cancelled";
      record.error = record.error ?? "Cancelled by operator";
      record.updatedAt = timestamp;
      for (const stage of record.stages) {
        if (stage.status === "pending" || stage.status === "queued") {
          stage.status = "cancelled";
          stage.completedAt = timestamp;
        }
      }
      for (const job of database.queueJobs) {
        if (
          job.orchestrationId === id &&
          (job.status === "queued" || job.status === "running")
        ) {
          job.status = "cancelled";
          job.updatedAt = timestamp;
          job.completedAt = timestamp;
        }
      }
    });
    return this.viewFrom(this.store.snapshot(), id);
  }

  /**
   * Atomically claim the lowest-sequence queued job, but only when no job is
   * running anywhere. Returns the claimed job, or `null` when nothing is
   * eligible. Invariant 4: one running queue job globally.
   */
  async claimNext(): Promise<QueueJob | null> {
    return this.store.mutate((database) => {
      if (database.queueJobs.some((job) => job.status === "running")) {
        return null;
      }
      const queued = database.queueJobs
        .filter((job) => job.status === "queued")
        .sort((a, b) => a.sequence - b.sequence);
      const next = queued[0];
      if (!next) {
        return null;
      }
      const timestamp = now();
      next.status = "running";
      next.claimedAt = timestamp;
      next.updatedAt = timestamp;
      const record = database.orchestrations.find(
        (o) => o.id === next.orchestrationId,
      );
      if (record && record.status === "queued") {
        record.status = "running";
        record.updatedAt = timestamp;
      }
      return structuredClone(next);
    });
  }

  private viewFrom(database: Database, id: string): OrchestrationView {
    const orchestration = database.orchestrations.find((o) => o.id === id);
    if (!orchestration) {
      throw new HttpError(404, "Orchestration not found");
    }
    const messages = database.handoffMessages
      .filter((m) => m.orchestrationId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    let queuePosition: number | null = null;
    if (!isTerminal(orchestration.status)) {
      const running = database.queueJobs.some((j) => j.status === "running");
      const ahead = database.orchestrations.filter(
        (o) =>
          !isTerminal(o.status) &&
          o.sequence < orchestration.sequence,
      ).length;
      queuePosition = running && ahead === 0 ? 0 : ahead + (running ? 1 : 0);
      const ownJobRunning = database.queueJobs.some(
        (j) => j.orchestrationId === id && j.status === "running",
      );
      if (ownJobRunning) queuePosition = 0;
    }

    return { orchestration: structuredClone(orchestration), queuePosition, messages };
  }
}
