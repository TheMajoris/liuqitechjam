import { createHash, randomUUID } from "node:crypto";
import { HttpError, MODEL_RATE_LIMITED_MESSAGE } from "../errors.js";
import type { Agent, Database } from "../types.js";
import type { Storage } from "../store.js";
import {
  ContinueOrchestrationSchema,
  RecoverOrchestrationSchema,
  RestoreSafetySchema,
  ResumeRecoverySchema,
  RetryOrchestrationSchema,
  CreateOrchestrationSchema,
  ORCHESTRATION_LIMITS,
  OrchestrationErrorCodeSchema,
  StartOrchestrationSchema,
} from "./schemas.js";
import type { PlatformAgentInvokerContract } from "./platform-agent-invoker.js";
import type {
  CreateOrchestrationInput,
  OrchestrationContinuationPrompt,
  OrchestrationErrorCode,
  OrchestrationFailureRule,
  OrchestrationParticipant,
  OrchestrationSession,
  OrchestrationSessionDetail,
  RecoverOrchestrationInput,
  RestoreSafetyInput,
  ResumeRecoveryInput,
} from "./types.js";
import {
  buildInitialResumeState,
  buildRecoveryExecutionInput,
  checkResumeBudget,
  contextFromAcceptedCheckpoint,
  rosterMatches,
  type CheckpointResumeState,
} from "./checkpoint-resume-state.js";
import type { SharedConversationTurn } from "./handoff.js";
import type { OrchestrationExecutionTurn } from "./orchestrator.js";
import {
  DEMO_HUMAN_PRINCIPAL,
  type Principal,
} from "../access/access-types.js";
import {
  WorkspaceCheckpointError,
  isRecoveryPending,
  isWorkspaceCheckpointError,
  toWorkspaceRecoveryView,
  type WorkspaceExecutionContext,
  type WorkspaceOperation,
  type WorkspaceRecoveryView,
} from "../projects/workspace-checkpoint-types.js";
import type { OrchestrationWorkspaceRecovery } from "../projects/workspace-recovery-facade.js";
import type { ToolApprovalInvalidator } from "../tools/tool-approval-store.js";
import type {
  OrchestrationExecutionHooks,
  OrchestrationExecutionInput,
  OrchestrationExecutionResult,
  OrchestrationParticipantProfile,
  OrchestrationParticipantSelector,
  Orchestrator,
} from "./orchestrator.js";
import {
  correlationAttributes,
  type RuntimeTelemetry,
  type TelemetrySpan,
} from "../telemetry/telemetry-types.js";
import {
  createOrchestrationExecutionHooks,
  DispatchLifecycleError,
} from "./orchestration-execution-hooks.js";
import type {
  AuditEventInput,
  AuditRecorder,
  AuditSpan,
} from "../audit/audit-types.js";
import { newSpanId } from "../audit/audit-span.js";
import { systemPrincipal } from "../access/access-types.js";
import {
  appendEvent,
  boundedSafeText,
  cloneSession,
  now,
  safeErrorMessage,
  safeParticipant,
  statusIsActive,
  statusIsTerminal,
  OrchestrationJournal,
  type OrchestrationEventFields,
} from "./orchestration-journal.js";
import {
  normalizeOrchestrationDependencies,
  type ActiveOrchestrationSession,
  type OrchestrationAgentAccess,
  type OrchestrationInvokerFactory,
  type OrchestrationProjectBinding,
  type OrchestrationServiceDependencies,
  type OrchestrationWorkspaceCycle,
  type SupervisorModelAssignment,
} from "./orchestration-runtime.js";
import { SupervisorError, createAbortError } from "./supervisor/errors.js";
import { DEFAULT_SUPERVISOR_TIMEOUT_MS } from "./supervisor/provider.js";
import { createSupervisorRequestBudget } from "./supervisor/types.js";

export type {
  OrchestrationAgentAccess,
  OrchestrationInvokerFactory,
  OrchestrationProjectBinding,
  OrchestrationServiceDependencies,
  OrchestrationSupervisorModelResolver,
  SupervisorModelAssignment,
} from "./orchestration-runtime.js";

/** Maximum number of sessions returned by a default or bounded listing. */
export const DEFAULT_ORCHESTRATION_LIST_LIMIT = 100;
/** Stable lifecycle error returned when a saved draft is not runnable yet. */
export const EMPTY_ORCHESTRATION_START_MESSAGE =
  "A task and at least one Agent are required before starting this Conversation";
const STORAGE_QUIESCE_TIMEOUT_MS = 5_000;

function lifecycleConflict(message: string): HttpError {
  return new HttpError(409, message);
}

/** Observe all cleanup branches while bounding the shutdown observer. */
async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const boundedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs
      : STORAGE_QUIESCE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, boundedTimeout);
    timer.unref();
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stable digest of the mutable part of an idempotent recovery request. */
function requestFingerprint(value: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(value).sort())))
    .digest("hex");
}

function applySupervisorModel(
  session: OrchestrationSession,
  supervisorModel: SupervisorModelAssignment | undefined,
): void {
  if (supervisorModel === undefined) return;
  session.supervisorModelRef = structuredClone(supervisorModel.modelRef);
  if (supervisorModel.catalogRevision === undefined) {
    delete session.supervisorModelCatalogRevision;
  } else {
    session.supervisorModelCatalogRevision = supervisorModel.catalogRevision;
  }
}

/** Everything one checkpoint-enabled cycle needs before it is reserved. */
interface CheckpointedCyclePlan {
  kind: "start" | "continue" | "retry" | "recovery";
  cyclePrompt: string;
  cycleIndex: number;
  startStepIndex: number;
  contextTurns: readonly SharedConversationTurn[];
  parentCheckpointId: string | null;
  sourceCheckpointId: string | null;
  seedTurns?: readonly OrchestrationExecutionTurn[] | undefined;
  lastRunId?: string | null | undefined;
  lastOutput?: string | null | undefined;
  contextBeforeStepIndex?: number | undefined;
  retryAgentId?: string | undefined;
  retryParticipantId?: string | undefined;
  allowErroredAgents?: boolean | undefined;
  /** Queue the session inside the acceptance mutation; returns the step offset. */
  commit: (database: Database, cycleId: string) => { stepOffset: number };
  audit: {
    type: AuditEventInput["type"];
    summary: string;
    metadata: Readonly<Record<string, unknown>>;
  };
}

function participantsMatch(
  left: readonly OrchestrationParticipant[],
  right: readonly OrchestrationParticipant[],
): boolean {
  return (
    left.length === right.length &&
    left.every((participant, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        participant.id === other.id &&
        participant.agentId === other.agentId &&
        participant.role === other.role &&
        participant.position === other.position
      );
    })
  );
}

/**
 * Owns orchestration lifecycle and persistence around the selected
 * orchestration engine. Engine state stays behind the repository-owned seam;
 * this module owns all Agent lookups, child Run cancellation, event journaling,
 * and recovery.
 */
export class OrchestrationService {
  private readonly store: Storage;
  private readonly journal: OrchestrationJournal;
  private readonly agents: OrchestrationAgentAccess;
  private readonly invokerFactory: () => PlatformAgentInvokerContract;
  private readonly selectorFactory: () => OrchestrationParticipantSelector | undefined;
  private readonly resolveSupervisorModel:
    | (() => SupervisorModelAssignment | Promise<SupervisorModelAssignment>)
    | undefined;
  private readonly supervisorTimeoutMs: number | undefined;
  private readonly orchestratorFactory: () => Orchestrator;
  private readonly projectBinding: OrchestrationProjectBinding | undefined;
  private readonly workspaceRecovery: OrchestrationWorkspaceRecovery | undefined;
  private toolApprovalInvalidator: ToolApprovalInvalidator | undefined;
  /** Background recovery operations keyed by operation ID. */
  private readonly recoveryTasks = new Map<string, Promise<void>>();
  private telemetry: RuntimeTelemetry | undefined;
  private readonly audit: AuditRecorder | undefined;
  /** Trace roots keyed by orchestration ID; participants parent under these. */
  private readonly orchestrationSpans = new Map<string, AuditSpan>();
  private readonly activeSessions = new Map<string, ActiveOrchestrationSession>();

  constructor(dependencies: OrchestrationServiceDependencies);
  constructor(
    store: Storage,
    agents: OrchestrationAgentAccess,
    invoker?: OrchestrationInvokerFactory,
  );
  constructor(
    value: Storage | OrchestrationServiceDependencies,
    agents?: OrchestrationAgentAccess,
    invoker?: OrchestrationInvokerFactory,
  ) {
    const normalized = normalizeOrchestrationDependencies(value, agents, invoker);
    this.store = normalized.store;
    this.journal = new OrchestrationJournal(this.store);
    this.agents = normalized.agents;
    this.invokerFactory = normalized.invokerFactory;
    this.selectorFactory = normalized.selectorFactory;
    this.resolveSupervisorModel = normalized.resolveSupervisorModel;
    this.supervisorTimeoutMs = normalized.supervisorTimeoutMs;
    this.orchestratorFactory = normalized.orchestratorFactory;
    this.projectBinding = normalized.projectBinding;
    this.workspaceRecovery = normalized.workspaceRecovery;
    this.toolApprovalInvalidator = normalized.toolApprovalInvalidator;
    this.audit = normalized.audit;
  }

  /** Attach the central approval fence after the composition root is built. */
  setToolApprovalInvalidator(invalidator: ToolApprovalInvalidator | undefined): void {
    this.toolApprovalInvalidator = invalidator;
  }

  /**
   * The trace root of one orchestration. A session continued after a restart
   * has no in-memory span, so the root is created lazily on first use.
   */
  orchestrationSpan(id: string): AuditSpan {
    const existing = this.orchestrationSpans.get(id);
    if (existing) return existing;
    const created: AuditSpan = { traceId: id, spanId: newSpanId() };
    this.orchestrationSpans.set(id, created);
    return created;
  }

  /** An audit sink failure must never change an orchestration's outcome. */
  private async recordAudit(input: AuditEventInput): Promise<void> {
    if (!this.audit) return;
    await this.audit.record(input).catch((error) => {
      console.warn("audit write failed", error);
    });
  }

  private async recordLifecycle(
    id: string,
    type: AuditEventInput["type"],
    summary: string,
    options: {
      status?: AuditEventInput["status"];
      durationMs?: number | undefined;
      metadata?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<void> {
    await this.recordAudit({
      type,
      status: options.status ?? "success",
      orchestrationId: id,
      principal: systemPrincipal(),
      summary,
      span: this.orchestrationSpan(id),
      ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
  }

  /** Attach runtime telemetry after the orchestration runtime is assembled. */
  setTelemetry(telemetry: RuntimeTelemetry): void {
    this.telemetry = telemetry;
  }

  async initialize(): Promise<void> {
    await this.cancelActiveSessions();
    await this.journal.initialize();
    // A cycle that was active at shutdown is interrupted, never resumed on
    // its own: the reservation coordinator has already decided whether its
    // Project stays gated.
    await this.store.mutate((database) => {
      const interruptedAt = now();
      for (const cycle of database.workspaceExecutionCycles) {
        if (cycle.status === "queued" || cycle.status === "running") {
          cycle.status = "interrupted";
          cycle.completedAt = interruptedAt;
        }
      }
      for (const session of database.orchestrations) {
        if (session.activeExecutionCycleId) session.activeExecutionCycleId = null;
      }
    });
  }

  /** Abort and settle every in-process child run before server shutdown. */
  async shutdown(): Promise<void> {
    await this.cancelActiveSessions();
  }

  /**
   * Storage-fatal shutdown path. It never reads or mutates the journal: the
   * active-session map and each context's child Run handle are sufficient to
   * abort Team routing and request physical child cancellation.
   */
  async quiesceForStorageFailure(options: { timeoutMs?: number } = {}): Promise<void> {
    const active = [...this.activeSessions.values()];
    if (active.length === 0) return;
    const cancellations = active.map(async (context) => {
      if (context.currentRunId) {
        await this.cancelChildRunForStorageFailure(context, context.currentRunId);
      }
      // Fence/physically cancel the accepted child before aborting the
      // orchestration loop. This ordering prevents a late loop callback from
      // observing a still-open approval while the parent is being stopped.
      context.controller.abort();
      await context.execution?.catch(() => undefined);
    });
    await settleWithin(
      Promise.all(cancellations).then(() => undefined),
      options.timeoutMs ?? STORAGE_QUIESCE_TIMEOUT_MS,
    );
  }

  private async cancelActiveSessions(): Promise<void> {
    const active = [...this.activeSessions.values()];
    for (const context of active) {
      if (context.currentRunId) {
        await this.cancelChildRun(context, context.currentRunId);
      }
      context.controller.abort();
    }
    await Promise.all(
      active.map(async (context) => {
        try {
          await context.execution;
        } catch {
          // The persisted interruption record is the recovery source of truth.
        }
      }),
    );
  }

  async createSession(input: CreateOrchestrationInput): Promise<OrchestrationSession> {
    const parsed = CreateOrchestrationSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(422, "Invalid orchestration request");
    }

    const normalized = parsed.data;
    const participants = [...normalized.participants]
      .sort((left, right) => left.position - right.position)
      .map(safeParticipant);
    const mode = normalized.mode ?? "sequential";
    const timestamp = now();
    const session: OrchestrationSession = {
      id: randomUUID(),
      name: boundedSafeText(
        normalized.name.trim(),
        ORCHESTRATION_LIMITS.maxNameLength,
        "[NAME TRUNCATED]",
      ),
      originalPrompt: boundedSafeText(
        normalized.originalPrompt.trim(),
        ORCHESTRATION_LIMITS.maxPromptLength,
        "[TASK TRUNCATED]",
      ),
      participants,
      mode,
      ...(normalized.clarifyFirst ? { clarifyFirst: true } : {}),
      ...(normalized.projectId ? { projectId: normalized.projectId } : {}),
      completionReason: null,
      status: "draft",
      currentParticipantId: null,
      currentRunId: null,
      stepIndex: 0,
      maxSteps: normalized.maxSteps,
      perAgentTimeoutMs: normalized.perAgentTimeoutMs,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
    };

    // Bind the shared Project before the session is visible, so a Team can
    // never be started against a Project its Agents are not attached to.
    if (session.projectId) {
      const bindConversation =
        this.projectBinding?.bindConversation ?? this.projectBinding?.bindTeam;
      await bindConversation?.(
        session.projectId,
        session.id,
        participants.map((participant) => participant.agentId),
      );
    }

    await this.store.mutate((database) => {
      database.orchestrations.push(session);
      appendEvent(database, session, "orchestration_created", {
        safeSummary: session.projectId
          ? "Orchestration created on a shared Project"
          : "Orchestration created",
      });
    });
    return cloneSession(session);
  }

  async listSessions(
    limit = DEFAULT_ORCHESTRATION_LIST_LIMIT,
  ): Promise<OrchestrationSession[]> {
    const boundedLimit =
      Number.isInteger(limit) && limit > 0
        ? Math.min(limit, DEFAULT_ORCHESTRATION_LIST_LIMIT)
        : DEFAULT_ORCHESTRATION_LIST_LIMIT;
    const database = this.store.snapshot();
    const activeProjectIds = new Set(
      database.projects
        .filter((project) => project.status === "active")
        .map((project) => project.id),
    );
    return database.orchestrations
      // Archived/missing Workspaces are retained for recovery in the store,
      // but are intentionally absent from active navigation APIs.
      .filter(
        (session) =>
          session.projectId === undefined ||
          session.projectId === null ||
          activeProjectIds.has(session.projectId),
      )
      .sort((left, right) => {
        const updated = right.updatedAt.localeCompare(left.updatedAt);
        return updated || right.createdAt.localeCompare(left.createdAt);
      })
      .slice(0, boundedLimit)
      .map(cloneSession);
  }

  async getSession(id: string): Promise<OrchestrationSessionDetail> {
    const detail = await this.journal.getSessionDetail(id);
    if (!this.checkpointsEnabledFor(detail.session) || !this.workspaceRecovery) return detail;
    const recovery = this.workspaceRecovery;
    const latest = recovery.latestOperationForSession(id, "recovery");
    return {
      ...detail,
      checkpoints: recovery.listSessionCheckpoints(id).map((checkpoint) => recovery.checkpointView(checkpoint)),
      recovery: latest === null ? null : toWorkspaceRecoveryView(latest),
    };
  }

  async startSession(
    id: string,
    firstPrompt?: string,
  ): Promise<OrchestrationSession> {
    const current = this.findSession(id);
    this.assertActiveProject(current.projectId);
    if (current.status !== "draft") {
      throw lifecycleConflict(
        current.status === "completed" ||
          current.status === "failed" ||
          current.status === "stopped" ||
          current.status === "interrupted"
          ? "Orchestration is already terminal"
          : "Orchestration is already active",
      );
    }

    const prepared = await this.prepareStartSession(current, firstPrompt);
    if (!prepared.originalPrompt.trim() || prepared.participants.length === 0) {
      throw new HttpError(422, EMPTY_ORCHESTRATION_START_MESSAGE);
    }

    await this.preflightRoster(prepared);
    const supervisorModel = await this.preflightSupervisor(prepared);
    const queueStart = (database: Database): OrchestrationSession => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (session.projectId !== undefined && session.projectId !== null) {
        const project = database.projects.find((item) => item.id === session.projectId);
        if (!project || project.status !== "active") {
          throw lifecycleConflict("This Workspace is archived or no longer available");
        }
      }
      if (session.status !== "draft") {
        throw lifecycleConflict("Orchestration is already active");
      }
      if (
        session.originalPrompt !== current.originalPrompt ||
        !participantsMatch(session.participants, current.participants)
      ) {
        throw lifecycleConflict("Orchestration draft changed; retry the start request");
      }
      session.originalPrompt = prepared.originalPrompt;
      session.participants = structuredClone(prepared.participants);
      if (supervisorModel !== undefined) {
        applySupervisorModel(session, supervisorModel);
      } else {
        delete session.supervisorModelRef;
        delete session.supervisorModelCatalogRevision;
      }
      const timestamp = now();
      session.status = "queued";
      session.currentParticipantId = null;
      session.currentRunId = null;
      session.completionReason = null;
      session.stepIndex = 0;
      session.errorCode = null;
      session.errorMessage = null;
      session.startedAt = timestamp;
      session.completedAt = null;
      session.updatedAt = timestamp;
      appendEvent(database, session, "orchestration_started", {
        safeSummary: "Orchestration queued",
      });
      return structuredClone(session);
    };
    if (this.checkpointsEnabledFor(prepared)) {
      return this.acceptCheckpointedCycle(prepared, {
        kind: "start",
        cyclePrompt: prepared.originalPrompt,
        cycleIndex: 0,
        startStepIndex: 0,
        contextTurns: [],
        parentCheckpointId: null,
        sourceCheckpointId: null,
        commit: (database) => {
          queueStart(database);
          return { stepOffset: 0 };
        },
        audit: {
          type: "orchestration_started",
          summary: "Orchestration queued",
          metadata: {
            mode: prepared.mode ?? "sequential",
            participantCount: prepared.participants.length,
            maxSteps: prepared.maxSteps,
          },
        },
      });
    }
    const accepted = await this.store.mutate(queueStart);

    await this.recordLifecycle(accepted.id, "orchestration_started", "Orchestration queued", {
      metadata: {
        mode: accepted.mode ?? "sequential",
        participantCount: accepted.participants.length,
        maxSteps: accepted.maxSteps,
      },
    });
    this.launch(accepted);
    return cloneSession(accepted);
  }

  /**
   * Queue a new internal execution cycle in the same visible Team session.
   * Prior turns/events are intentionally retained and become bounded context
   * for the new cycle; only the user follow-up is appended to the prompt log.
   */
  async continueSession(id: string, prompt: string): Promise<OrchestrationSession> {
    const parsed = ContinueOrchestrationSchema.safeParse({ prompt });
    if (!parsed.success) {
      throw new HttpError(422, "Invalid continuation request");
    }

    const current = this.findSession(id);
    this.assertActiveProject(current.projectId);
    if (!statusIsTerminal(current.status)) {
      throw lifecycleConflict(
        current.status === "draft"
          ? "Draft orchestrations cannot be continued"
          : "Stop the active orchestration before continuing it",
      );
    }
    if (this.activeSessions.has(id)) {
      // A terminal record can briefly coexist with its in-process cleanup.
      // Treat that window as active so a new cycle cannot race finalization.
      throw lifecycleConflict("Orchestration is still settling");
    }

    await this.preflightRoster(current);
    const supervisorModel = await this.preflightSupervisor(current);
    const normalizedPrompt = boundedSafeText(
      parsed.data.prompt.trim(),
      ORCHESTRATION_LIMITS.maxPromptLength,
      "[PROMPT TRUNCATED]",
    );
    const queueContinue = (database: Database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (session.projectId !== undefined && session.projectId !== null) {
        const project = database.projects.find((item) => item.id === session.projectId);
        if (!project || project.status !== "active") {
          throw lifecycleConflict("This Workspace is archived or no longer available");
        }
      }
      if (!statusIsTerminal(session.status)) {
        throw lifecycleConflict(
          session.status === "draft"
            ? "Draft orchestrations cannot be continued"
            : "Stop the active orchestration before continuing it",
        );
      }
      applySupervisorModel(session, supervisorModel);
      if (database.orchestrationContinuationPrompts.filter(
        (item) => item.sessionId === id,
      ).length >= ORCHESTRATION_LIMITS.maxContinuationPromptsPerSession) {
        throw new HttpError(422, "Conversation continuation limit reached");
      }

      const cycleIndex = database.orchestrationContinuationPrompts
        .filter((item) => item.sessionId === id)
        .reduce((maximum, item) => Math.max(maximum, item.cycleIndex), 0) + 1;
      const priorTurns = database.orchestrationTurns.filter(
        (item) => item.sessionId === id,
      );
      const persistedStepOffset = priorTurns.reduce(
        (maximum, item) =>
          Math.max(maximum, item.stepIndex === undefined ? 0 : item.stepIndex + 1),
        priorTurns.length,
      );
      const stepOffset = Math.max(session.stepIndex, persistedStepOffset);
      const timestamp = now();
      const promptRecord: OrchestrationContinuationPrompt = {
        id: randomUUID(),
        sessionId: id,
        cycleIndex,
        prompt: normalizedPrompt,
        createdAt: timestamp,
      };
      database.orchestrationContinuationPrompts.push(promptRecord);

      // `stepIndex` is the persisted global dispatch count. The engine gets a
      // fresh zero-based counter; launch() carries this value as its offset.
      session.stepIndex = stepOffset;
      session.status = "queued";
      session.currentParticipantId = null;
      session.currentRunId = null;
      session.completionReason = null;
      session.errorCode = null;
      session.errorMessage = null;
      session.startedAt = timestamp;
      session.completedAt = null;
      session.updatedAt = timestamp;
      appendEvent(database, session, "orchestration_continued", {
        safeSummary: "Follow-up queued for cycle " + String(cycleIndex),
      });
      return {
        session: structuredClone(session),
        prompt: promptRecord.prompt,
        cycleIndex,
        stepOffset,
      };
    };
    if (this.checkpointsEnabledFor(current)) {
      // The cycle number is fixed from the snapshot; the reservation excludes
      // any competing continuation, and the commit recomputes it identically.
      const expectedCycleIndex = this.store
        .snapshot()
        .orchestrationContinuationPrompts.filter((item) => item.sessionId === id)
        .reduce((maximum, item) => Math.max(maximum, item.cycleIndex), 0) + 1;
      const context = this.acceptedContext(current);
      return this.acceptCheckpointedCycle(current, {
        kind: "continue",
        cyclePrompt: normalizedPrompt,
        cycleIndex: expectedCycleIndex,
        startStepIndex: 0,
        contextTurns: context.contextTurns,
        parentCheckpointId: context.parentCheckpointId,
        sourceCheckpointId: null,
        commit: (database) => {
          const queued = queueContinue(database);
          if (queued.cycleIndex !== expectedCycleIndex) {
            throw lifecycleConflict("Another follow-up was accepted first; retry");
          }
          return { stepOffset: queued.stepOffset };
        },
        audit: {
          type: "orchestration_continued",
          summary: "Orchestration continued",
          metadata: { cycleIndex: expectedCycleIndex },
        },
      });
    }
    const accepted = await this.store.mutate(queueContinue);

    await this.recordLifecycle(
      accepted.session.id,
      "orchestration_continued",
      "Orchestration continued",
      { metadata: { cycleIndex: accepted.cycleIndex, stepOffset: accepted.stepOffset } },
    );
    this.launch(accepted.session, {
      cyclePrompt: accepted.prompt,
      cycleIndex: accepted.cycleIndex,
      stepOffset: accepted.stepOffset,
    });
    return cloneSession(accepted.session);
  }

  /**
   * Re-run one recorded execution step and everything the roster owes after it.
   *
   * History is appended, never rewritten: the abandoned turns stay in the
   * journal, and the retry takes fresh global step indexes above every
   * recorded one. Only the historical context the engine is offered is
   * truncated, so the retried participant sees what it saw the first time.
   *
   * The shared Project workspace is NOT rewound. Files written by the turns
   * after the checkpoint are still on disk, because Project workspaces are
   * unversioned directories. Callers must say so before offering this.
   */
  async retryFromStep(
    id: string,
    fromStepIndex: number,
  ): Promise<OrchestrationSession> {
    const parsed = RetryOrchestrationSchema.safeParse({ fromStepIndex });
    if (!parsed.success) {
      throw new HttpError(422, "Invalid retry request");
    }
    const step = parsed.data.fromStepIndex;

    const current = this.findSession(id);
    this.assertActiveProject(current.projectId);
    if (!statusIsTerminal(current.status)) {
      throw lifecycleConflict(
        current.status === "draft"
          ? "Draft orchestrations cannot be retried"
          : "Stop the active orchestration before retrying it",
      );
    }
    if (this.activeSessions.has(id)) {
      // A terminal record can briefly coexist with its in-process cleanup.
      throw lifecycleConflict("Orchestration is still settling");
    }

    const checkpoint = this.journal.turnAtStep(id, step);
    if (!checkpoint) {
      throw new HttpError(404, "No recorded turn at that execution step");
    }
    const participant = current.participants.find(
      (item) => item.id === checkpoint.participantId,
    );
    if (!participant) {
      throw lifecycleConflict(
        "The roster occurrence that took this turn is no longer configured",
      );
    }

    await this.preflightRoster(current, { allowErroredAgentId: participant.agentId });
    const supervisorModel = await this.preflightSupervisor(current);

    const queueRetry = (database: Database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (session.projectId !== undefined && session.projectId !== null) {
        const project = database.projects.find((item) => item.id === session.projectId);
        if (!project || project.status !== "active") {
          throw lifecycleConflict("This Workspace is archived or no longer available");
        }
      }
      if (!statusIsTerminal(session.status)) {
        throw lifecycleConflict(
          session.status === "draft"
            ? "Draft orchestrations cannot be retried"
            : "Stop the active orchestration before retrying it",
        );
      }
      applySupervisorModel(session, supervisorModel);

      // The retry re-runs the newest user intent, which is the last follow-up
      // when one exists. A retry authors no prompt of its own, so the
      // continuation record and its cycle number are left untouched.
      const cycles = database.orchestrationContinuationPrompts
        .filter((item) => item.sessionId === id)
        .sort((left, right) => left.cycleIndex - right.cycleIndex);
      const latest = cycles.at(-1);
      const cyclePrompt = latest?.prompt ?? session.originalPrompt;
      const cycleIndex = latest?.cycleIndex ?? 0;

      // Deterministic routing maps the engine cursor onto a roster position,
      // so seeding it resumes at the chosen participant. Automatic turn
      // taking chooses freely, so seeding would only consume its budget.
      const deterministic = (session.mode ?? "sequential") !== "supervisor";
      const startStepIndex = deterministic ? participant.position : 0;
      const highest = database.orchestrationTurns
        .filter((item) => item.sessionId === id)
        .reduce(
          (maximum, item) =>
            Math.max(maximum, item.stepIndex === undefined ? 0 : item.stepIndex),
          0,
        );
      // Persisted index is stepOffset + engine step. This keeps the first new
      // turn above every recorded one, and may be negative when the seeded
      // cursor is itself above the highest recorded step.
      const stepOffset = highest + 1 - startStepIndex;
      const timestamp = now();

      session.stepIndex = highest + 1;
      session.status = "queued";
      session.currentParticipantId = null;
      session.currentRunId = null;
      session.completionReason = null;
      session.errorCode = null;
      session.errorMessage = null;
      session.startedAt = timestamp;
      session.completedAt = null;
      session.updatedAt = timestamp;
      appendEvent(database, session, "orchestration_retried", {
        participantId: participant.id,
        agentId: participant.agentId,
        safeSummary:
          "Retrying from step " + String(step + 1) + " with " + participant.role,
      });
      return {
        session: structuredClone(session),
        cyclePrompt,
        cycleIndex,
        stepOffset,
        startStepIndex,
      };
    };
    if (this.checkpointsEnabledFor(current)) {
      // A retry keeps its legacy meaning — rerun using the files as they are
      // now — but still runs as a checkpointed cycle, so its own baseline and
      // successful turns become recoverable boundaries.
      const snapshot = this.store.snapshot();
      const cycles = snapshot.orchestrationContinuationPrompts
        .filter((item) => item.sessionId === id)
        .sort((left, right) => left.cycleIndex - right.cycleIndex);
      const latest = cycles.at(-1);
      const deterministic = (current.mode ?? "sequential") !== "supervisor";
      const startStepIndex = deterministic ? participant.position : 0;
      const context = this.acceptedContext(current);
      return this.acceptCheckpointedCycle(current, {
        kind: "retry",
        cyclePrompt: latest?.prompt ?? current.originalPrompt,
        cycleIndex: latest?.cycleIndex ?? 0,
        startStepIndex,
        contextTurns: this.journal.contextTurns(id, current.maxSteps, step),
        parentCheckpointId: context.parentCheckpointId,
        sourceCheckpointId: null,
        contextBeforeStepIndex: step,
        retryAgentId: participant.agentId,
        ...(current.mode === "supervisor" ? { retryParticipantId: participant.id } : {}),
        commit: (database) => ({ stepOffset: queueRetry(database).stepOffset }),
        audit: {
          type: "orchestration_continued",
          summary: "Orchestration retried from a recorded step using current files",
          metadata: { retryFromStepIndex: step, cycleIndex: latest?.cycleIndex ?? 0 },
        },
      });
    }
    const accepted = await this.store.mutate(queueRetry);

    await this.recordLifecycle(
      accepted.session.id,
      // A retry is a continuation with a truncated context, and shares its
      // audit event so the audit vocabulary stays stable.
      "orchestration_continued",
      "Orchestration retried from a recorded step",
      {
        metadata: {
          retryFromStepIndex: step,
          cycleIndex: accepted.cycleIndex,
          stepOffset: accepted.stepOffset,
        },
      },
    );
    this.launch(accepted.session, {
      cyclePrompt: accepted.cyclePrompt,
      cycleIndex: accepted.cycleIndex,
      stepOffset: accepted.stepOffset,
      startStepIndex: accepted.startStepIndex,
      contextBeforeStepIndex: step,
      retryAgentId: participant.agentId,
      ...(current.mode === "supervisor"
        ? { retryParticipantId: participant.id }
        : {}),
    });
    return cloneSession(accepted.session);
  }

  /**
   * Stop every active conversation owned by one Project, retaining all of its
   * persisted history. Workspace archive uses this path: archiving must make
   * the workspace safe to move without turning a recoverable archive into a
   * conversation deletion.
   */
  async stopSessionsForProject(projectId: string): Promise<void> {
    const children = this.store
      .snapshot()
      .orchestrations.filter((session) => session.projectId === projectId);

    for (const child of children) {
      const active = this.activeSessions.get(child.id);
      if (statusIsActive(child.status) || active) {
        try {
          await this.stopSession(child.id);
        } catch (error) {
          if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
        }
      }
      // A terminal session can still have a tiny in-process cleanup tail. Wait
      // for it before the lifecycle caller moves or removes the workspace so
      // no runner can write a child record after that point.
      const settled = this.activeSessions.get(child.id)?.execution;
      if (settled) await settled.catch(() => undefined);
    }

    await this.store.mutate((database) => {
      const childIds = new Set(
        database.orchestrations
          .filter((session) => session.projectId === projectId)
          .map((session) => session.id),
      );
      for (const childId of childIds) {
        const session = database.orchestrations.find((item) => item.id === childId);
        if (session && (statusIsActive(session.status) || this.activeSessions.has(childId))) {
          throw lifecycleConflict("Stop the active orchestration before changing its Workspace");
        }
      }
    });
  }

  /**
   * Remove every conversation owned by one Project from active APIs.
   *
   * Active child runs are stopped first. The final mutation removes only the
   * orchestration records and leaves the Project/files for ProjectService to
   * archive or permanently delete. This is the Workspace-level counterpart to
   * `deleteSession`.
   */
  async removeSessionsForProject(
    projectId: string,
    options: { archiveOwned?: boolean } = {},
  ): Promise<void> {
    // ProjectService holds the archive guard while it asks orchestration to
    // remove child records as part of permanent deletion. That trusted path
    // is the one exception; ordinary callers must participate in the guard so
    // compensation cannot restore over an accepted Project mutation.
    const archiveOwned = options.archiveOwned === true;
    if (!archiveOwned) {
      this.projectBinding?.assertProjectMutationAllowed?.(projectId);
    }
    await this.stopSessionsForProject(projectId);

    await this.store.mutate((database) => {
      if (!archiveOwned) {
        this.projectBinding?.assertProjectMutationAllowed?.(projectId);
      }
      const childIds = new Set(
        database.orchestrations
          .filter((session) => session.projectId === projectId)
          .map((session) => session.id),
      );
      for (const childId of childIds) {
        const session = database.orchestrations.find((item) => item.id === childId);
        if (session && (statusIsActive(session.status) || this.activeSessions.has(childId))) {
          throw lifecycleConflict("Stop the active orchestration before deleting its Workspace");
        }
      }
      database.orchestrations = database.orchestrations.filter(
        (session) => !childIds.has(session.id),
      );
      database.orchestrationTurns = database.orchestrationTurns.filter(
        (turn) => !childIds.has(turn.sessionId),
      );
      database.orchestrationEvents = database.orchestrationEvents.filter(
        (event) => !childIds.has(event.sessionId),
      );
      database.orchestrationContinuationPrompts =
        database.orchestrationContinuationPrompts.filter(
          (prompt) => !childIds.has(prompt.sessionId),
        );
      for (const project of database.projects) {
        if (project.id === projectId && project.teamId !== null) {
          project.teamId = null;
          project.updatedAt = now();
        }
      }
    });
  }

  /**
   * Permanently remove one Team conversation's application-owned records.
   * Agent catalog entries, Agent messages/runs, workspaces, and private Codex
   * thread state are deliberately outside this mutation and remain intact.
   */
  /**
   * Change a Conversation's prompt policy.
   *
   * Only `clarifyFirst` is settable, and only because it grants nothing: it
   * adds rules to the participant prompt and is read fresh when each cycle is
   * dispatched. Editing it while a cycle is in flight would change the rules
   * halfway through a run the transcript already records, so an active session
   * is rejected and the change lands on the next start or continuation.
   */
  async updateSession(
    id: string,
    input: { clarifyFirst: boolean },
  ): Promise<OrchestrationSession> {
    const current = this.findSession(id);
    if (statusIsActive(current.status) || this.activeSessions.has(id)) {
      throw lifecycleConflict(
        "Stop the conversation before changing how its Agents work",
      );
    }
    return this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (statusIsActive(session.status) || this.activeSessions.has(id)) {
        throw lifecycleConflict(
          "Stop the conversation before changing how its Agents work",
        );
      }
      if (input.clarifyFirst) session.clarifyFirst = true;
      else delete session.clarifyFirst;
      session.updatedAt = now();
      return structuredClone(session);
    });
  }

  async deleteSession(id: string): Promise<{ deleted: boolean }> {
    const current = this.findSession(id);
    if (statusIsActive(current.status) || this.activeSessions.has(id)) {
      throw lifecycleConflict("Stop the active orchestration before deleting it");
    }
    if (current.projectId) {
      this.projectBinding?.assertProjectMutationAllowed?.(current.projectId);
    }

    await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (statusIsActive(session.status) || this.activeSessions.has(id)) {
        throw lifecycleConflict("Stop the active orchestration before deleting it");
      }

      // The legacy teamId pointer may identify Projects whose session record
      // is missing its projectId, so collect every affected Project while the
      // store is serialized and guard immediately before changing any of them.
      const affectedProjectIds = new Set<string>();
      if (session.projectId) affectedProjectIds.add(session.projectId);
      for (const project of database.projects) {
        if (project.teamId === id) affectedProjectIds.add(project.id);
      }
      for (const projectId of affectedProjectIds) {
        this.projectBinding?.assertProjectMutationAllowed?.(projectId);
      }

      database.orchestrations = database.orchestrations.filter(
        (item) => item.id !== id,
      );
      database.orchestrationTurns = database.orchestrationTurns.filter(
        (item) => item.sessionId !== id,
      );
      database.orchestrationEvents = database.orchestrationEvents.filter(
        (item) => item.sessionId !== id,
      );
      database.orchestrationContinuationPrompts =
        database.orchestrationContinuationPrompts.filter(
          (item) => item.sessionId !== id,
        );
      // A Project's `teamId` must never outlive the session it points at, or
      // the Project keeps claiming a Team that no longer exists.
      for (const project of database.projects) {
        if (project.teamId === id) {
          const replacement = database.orchestrations.find(
            (item) => item.projectId === project.id,
          );
          project.teamId = replacement?.id ?? null;
          project.updatedAt = now();
        }
      }
    });
    return { deleted: true };
  }

  async stopSession(id: string): Promise<OrchestrationSession> {
    const current = this.findSession(id);
    if (current.status === "draft") {
      throw lifecycleConflict("Draft orchestrations cannot be stopped");
    }
    if (statusIsTerminal(current.status)) return cloneSession(current);

    if (current.status !== "stopping") {
      await this.store.mutate((database) => {
        const session = database.orchestrations.find((item) => item.id === id);
        if (!session) throw new HttpError(404, "Orchestration not found");
        if (statusIsTerminal(session.status)) return;
        if (session.status !== "stopping") {
          session.status = "stopping";
          session.updatedAt = now();
          appendEvent(database, session, "stop_requested", {
            safeSummary: "Stop requested",
          });
        }
      });
    }

    const active = this.activeSessions.get(id);
    if (!active) {
      await this.finalizeStopped(id);
      return (await this.getSession(id)).session;
    }

    const runId = active.currentRunId;
    if (runId) {
      await this.cancelChildRun(active, runId);
    }
    // The child cancel path closes its approval fence first. Abort the parent
    // loop only after that fence and native cancellation request are queued.
    active.controller.abort();
    if (active.execution) {
      try {
        await active.execution;
      } catch {
        // runSession always attempts a terminal journal record.
      }
    }
    return (await this.getSession(id)).session;
  }


  // ------------------------------------------------- checkpointed cycles

  private checkpointsEnabledFor(session: OrchestrationSession): boolean {
    return (
      typeof session.projectId === "string" &&
      session.projectId.length > 0 &&
      this.workspaceRecovery?.enabled() === true
    );
  }

  private requireWorkspaceRecovery(): OrchestrationWorkspaceRecovery {
    if (!this.workspaceRecovery) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_UNAVAILABLE",
        "Workspace checkpoints are not configured on this server",
      );
    }
    return this.workspaceRecovery;
  }

  /**
   * The bounded shared context a new cycle inherits from the accepted branch
   * head. Abandoned turns are absent by construction; a legacy session with
   * no head falls back to the journal's numeric projection.
   */
  private acceptedContext(session: OrchestrationSession): {
    contextTurns: SharedConversationTurn[];
    parentCheckpointId: string | null;
  } {
    const headId = session.acceptedContextCheckpointId ?? null;
    const head = headId === null ? null : this.workspaceRecovery?.getCheckpoint(headId) ?? null;
    if (head && head.state === "ready" && head.resume !== null) {
      return {
        contextTurns: contextFromAcceptedCheckpoint(head.resume, (runId) =>
          this.journal.globalStepIndexByRunId(session.id, runId),
        ),
        parentCheckpointId: head.id,
      };
    }
    return {
      contextTurns: this.journal.contextTurns(session.id, session.maxSteps),
      parentCheckpointId: null,
    };
  }

  /**
   * Accept one checkpoint-enabled cycle: reserve the Project, silence every
   * other writer, record the cycle and its exact initial state, capture the
   * baseline, and only then queue the session. Any failure before launch
   * releases the reservation without dispatching anything.
   */
  private async acceptCheckpointedCycle(
    session: OrchestrationSession,
    plan: CheckpointedCyclePlan,
    reserve?: (cycleId: string) => Promise<WorkspaceOperation>,
  ): Promise<OrchestrationSession> {
    const recovery = this.requireWorkspaceRecovery();
    const projectId = session.projectId as string;
    recovery.assertRuntimeSupported();
    const epoch = recovery.workspaceEpoch(projectId);
    const cycleId = randomUUID();
    const expectDraft = plan.kind === "start";
    const guard = (database: Database): void => {
      const stored = database.orchestrations.find((item) => item.id === session.id);
      if (!stored) throw new HttpError(404, "Orchestration not found");
      if (expectDraft ? stored.status !== "draft" : !statusIsTerminal(stored.status)) {
        throw lifecycleConflict("Orchestration lifecycle changed; retry the request");
      }
      if (this.activeSessions.has(session.id)) {
        throw lifecycleConflict("Orchestration is still settling");
      }
    };
    const operation = reserve
      ? await reserve(cycleId)
      : await recovery.reserveCycle(
          {
            projectId,
            orchestrationId: session.id,
            actorPrincipalId: DEMO_HUMAN_PRINCIPAL.id,
            expectedEpoch: epoch,
          },
          guard,
        );
    const workspace: WorkspaceExecutionContext = {
      projectId,
      orchestrationId: session.id,
      workspaceOperationId: operation.id,
      executionCycleId: cycleId,
      workspaceEpoch: epoch,
    };
    try {
      await recovery.quiescePreviews(projectId);
      recovery.requireNoPhysicalWriter(projectId);
      const initialState = buildInitialResumeState(
        {
          sourceCycleId: cycleId,
          mode: session.mode ?? "sequential",
          originalPrompt: plan.cyclePrompt,
          cycleIndex: plan.cycleIndex,
          participants: session.participants.map(safeParticipant),
          clarifyFirst: session.clarifyFirst === true,
          perAgentTimeoutMs: session.perAgentTimeoutMs,
          maxSteps: session.maxSteps,
        },
        {
          startEngineStepIndex: plan.startStepIndex,
          contextTurns: plan.contextTurns,
          parentCheckpointId: plan.parentCheckpointId,
          ...(plan.seedTurns === undefined ? {} : { turns: plan.seedTurns }),
          lastRunId: plan.lastRunId ?? null,
          lastOutput: plan.lastOutput ?? null,
        },
      );
      const timestamp = now();
      await this.store.mutate((database) => {
        guard(database);
        database.workspaceExecutionCycles.push({
          id: cycleId,
          projectId,
          orchestrationId: session.id,
          operationId: operation.id,
          sourceCheckpointId: plan.sourceCheckpointId,
          baselineCheckpointId: null,
          initialState: structuredClone(initialState),
          acceptedTurnIds: [],
          status: "queued",
          createdAt: timestamp,
          completedAt: null,
        });
        recovery.transitionOperationIn(database, operation.id, "preparing", {
          executionCycleId: cycleId,
        });
      });
      const baseline = await recovery.captureBaseline({
        projectId,
        operationId: operation.id,
        workspaceEpoch: epoch,
        orchestrationId: session.id,
        executionCycleId: cycleId,
        parentCheckpointId: plan.parentCheckpointId,
        resume: initialState,
      });
      const accepted = await this.store.mutate((database) => {
        guard(database);
        const cycle = database.workspaceExecutionCycles.find((item) => item.id === cycleId);
        if (!cycle) throw lifecycleConflict("The execution cycle record disappeared");
        cycle.baselineCheckpointId = baseline.id;
        const { stepOffset } = plan.commit(database, cycleId);
        const stored = database.orchestrations.find((item) => item.id === session.id);
        if (!stored) throw new HttpError(404, "Orchestration not found");
        stored.activeExecutionCycleId = cycleId;
        stored.acceptedContextCheckpointId = baseline.id;
        appendEvent(database, stored, "workspace_checkpoint_created", {
          checkpointId: baseline.id,
          safeSummary: "Workspace checkpoint #" + String(baseline.ordinal) + " saved before the first turn",
        });
        return { session: structuredClone(stored), stepOffset };
      });
      await this.recordLifecycle(session.id, plan.audit.type, plan.audit.summary, {
        metadata: {
          ...plan.audit.metadata,
          executionCycleId: cycleId,
          baselineCheckpointId: baseline.id,
          stepOffset: accepted.stepOffset,
        },
      });
      this.launch(accepted.session, {
        cyclePrompt: plan.cyclePrompt,
        cycleIndex: plan.cycleIndex,
        stepOffset: accepted.stepOffset,
        startStepIndex: plan.startStepIndex,
        ...(plan.contextBeforeStepIndex === undefined
          ? {}
          : { contextBeforeStepIndex: plan.contextBeforeStepIndex }),
        ...(plan.retryAgentId === undefined ? {} : { retryAgentId: plan.retryAgentId }),
        ...(plan.retryParticipantId === undefined
          ? {}
          : { retryParticipantId: plan.retryParticipantId }),
        workspace: { context: workspace, cycleId },
        seed: initialState,
        allowErroredAgents: plan.allowErroredAgents === true,
      });
      return cloneSession(accepted.session);
    } catch (error) {
      const code = isWorkspaceCheckpointError(error) ? error.code : null;
      await this.store
        .mutate((database) => {
          const cycle = database.workspaceExecutionCycles.find((item) => item.id === cycleId);
          if (cycle && (cycle.status === "queued" || cycle.status === "running")) {
            cycle.status = "failed";
            cycle.completedAt = now();
          }
          const stored = database.orchestrations.find((item) => item.id === session.id);
          if (stored && stored.activeExecutionCycleId === cycleId) {
            stored.activeExecutionCycleId = null;
          }
          recovery.releaseOperationIn(database, operation.id, "failed", code);
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Close the cycle after execution settled. The reservation is released
   * only when no physical writer remains; a retained lease keeps the Project
   * gated and marks the operation as needing recovery.
   */
  private settleCycleIn(
    database: Database,
    context: ActiveOrchestrationSession,
    status: OrchestrationSession["status"],
  ): void {
    const workspace = context.workspace;
    const recovery = this.workspaceRecovery;
    if (!workspace || !recovery) return;
    context.cycleSettled = true;
    const cycle = database.workspaceExecutionCycles.find(
      (item) => item.id === workspace.cycleId,
    );
    if (cycle && (cycle.status === "queued" || cycle.status === "running")) {
      cycle.status =
        status === "completed" ? "completed"
          : status === "stopped" ? "stopped"
            : status === "interrupted" ? "interrupted"
              : "failed";
      cycle.completedAt = now();
    }
    const session = database.orchestrations.find((item) => item.id === context.id);
    if (session && session.activeExecutionCycleId === workspace.cycleId) {
      session.activeExecutionCycleId = null;
    }
    const operation = database.workspaceOperations.find(
      (item) => item.id === workspace.context.workspaceOperationId,
    );
    if (!operation || !operation.reservationHeld) return;
    const leaseHeld = database.projectLeases.some(
      (lease) => lease.projectId === workspace.context.projectId,
    );
    if (leaseHeld) {
      recovery.transitionOperationIn(database, operation.id, "recovery_required", {
        errorCode: "CHECKPOINT_WRITER_UNSETTLED",
      });
    } else {
      recovery.releaseOperationIn(database, operation.id, "settled");
    }
  }

  /** Fallback for a cycle whose terminal write happened outside finalize. */
  private async settleCycle(context: ActiveOrchestrationSession): Promise<void> {
    if (!context.workspace || !this.workspaceRecovery) return;
    let status: OrchestrationSession["status"];
    try {
      status = this.findSession(context.id).status;
    } catch {
      status = "failed";
    }
    await this.store
      .mutate((database) => this.settleCycleIn(database, context, status))
      .catch(() => undefined);
  }

  // ---------------------------------------------------------- recovery

  /**
   * Accept a source restore-and-resume from one ready checkpoint. The
   * response is returned once the durable intent exists; the physical
   * protocol continues in the background and stays observable by operation
   * ID. A repeated request with the same ID and body returns the original.
   */
  async recoverFromCheckpoint(
    id: string,
    input: RecoverOrchestrationInput,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<{ recovery: WorkspaceRecoveryView; duplicate: boolean }> {
    const parsed = RecoverOrchestrationSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "Invalid recovery request");
    }
    const recovery = this.requireWorkspaceRecovery();
    const session = this.findSession(id);
    if (!this.checkpointsEnabledFor(session)) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_UNAVAILABLE",
        "This conversation does not run on a checkpointed Workspace",
      );
    }
    const projectId = session.projectId as string;
    this.assertActiveProject(projectId);
    await recovery.authorizeRecovery(projectId, principal);
    const fingerprint = requestFingerprint({ action: "recover", checkpointId: parsed.data.checkpointId });
    // Dedup precedes the lifecycle check so a transport retry after the
    // original request queued execution still finds its operation.
    const existing = recovery.findRecoveryRequest(projectId, parsed.data.requestId);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new WorkspaceCheckpointError(
          "CHECKPOINT_IDEMPOTENCY_CONFLICT",
          "This request ID was already used for a different recovery action",
        );
      }
      return { recovery: toWorkspaceRecoveryView(existing), duplicate: true };
    }
    const target = recovery.getCheckpoint(parsed.data.checkpointId);
    if (!target || target.projectId !== projectId || target.orchestrationId !== id) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Checkpoint not found");
    }
    if (!recovery.checkpointView(target).recoverable || target.resume === null) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_NOT_READY",
        "This checkpoint cannot be restored: it is not a ready successful boundary",
      );
    }
    if (!statusIsTerminal(session.status) || this.activeSessions.has(id)) {
      throw lifecycleConflict("Stop the active orchestration before restoring a checkpoint");
    }
    this.assertResumable(session, target.resume);
    await this.preflightRoster(session, { allowErroredAgents: true });
    await this.preflightSupervisor(session);
    recovery.assertRuntimeSupported();
    const reserved = await recovery.reserveRecovery(
      {
        projectId,
        orchestrationId: id,
        actorPrincipalId: principal.id,
        expectedEpoch: recovery.workspaceEpoch(projectId),
        requestId: parsed.data.requestId,
        requestFingerprint: fingerprint,
        targetCheckpointId: target.id,
      },
      (database) => {
        const stored = database.orchestrations.find((item) => item.id === id);
        if (!stored || !statusIsTerminal(stored.status) || this.activeSessions.has(id)) {
          throw lifecycleConflict("Stop the active orchestration before restoring a checkpoint");
        }
        appendEvent(database, stored, "workspace_checkpoint_restore_started", {
          checkpointId: target.id,
          safeSummary: "Restore to workspace checkpoint #" + String(target.ordinal) + " accepted",
        });
      },
    );
    if (reserved.duplicate) {
      return { recovery: toWorkspaceRecoveryView(reserved.operation), duplicate: true };
    }
    await this.recordLifecycle(id, "workspace_checkpoint_restore_started", "Workspace restore accepted", {
      metadata: {
        checkpointId: target.id,
        checkpointOrdinal: target.ordinal,
        operationId: reserved.operation.id,
        requestId: parsed.data.requestId,
        eventKey: reserved.operation.id + ":reserved",
      },
    });
    this.startRecoveryTask(reserved.operation.id);
    return { recovery: toWorkspaceRecoveryView(reserved.operation), duplicate: false };
  }

  async getRecovery(id: string, operationId: string): Promise<WorkspaceRecoveryView> {
    const recovery = this.requireWorkspaceRecovery();
    this.findSession(id);
    const operation = recovery.getOperation(operationId);
    if (!operation || operation.orchestrationId !== id) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Recovery operation not found");
    }
    return toWorkspaceRecoveryView(operation);
  }

  /**
   * Explicit operator continuation of a gated recovery. It resumes the
   * physical protocol at its recorded stage; it never accepts a second
   * resume cycle for an operation that already accepted one.
   */
  async resumeRecovery(
    id: string,
    operationId: string,
    input: ResumeRecoveryInput,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<WorkspaceRecoveryView> {
    const parsed = ResumeRecoverySchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "Invalid resume request");
    }
    const recovery = this.requireWorkspaceRecovery();
    const session = this.findSession(id);
    const operation = recovery.getOperation(operationId);
    if (!operation || operation.orchestrationId !== id || operation.kind !== "recovery") {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Recovery operation not found");
    }
    await recovery.authorizeRecovery(operation.projectId, principal);
    const fingerprint = requestFingerprint({ action: "resume", operationId });
    if (operation.resumeRequestId === parsed.data.requestId) {
      if (operation.resumeRequestFingerprint !== fingerprint) {
        throw new WorkspaceCheckpointError("CHECKPOINT_IDEMPOTENCY_CONFLICT", "This request ID was already used");
      }
      return toWorkspaceRecoveryView(operation);
    }
    if (operation.resumeCycleId !== null) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_EXECUTION_ALREADY_ACCEPTED",
        "This recovery already accepted a resume cycle; start a new recovery after it settles",
      );
    }
    if (!operation.reservationHeld || !isRecoveryPending(operation.stage) || this.recoveryTasks.has(operationId)) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_OPERATION_STAGE_INVALID",
        "This recovery is not waiting for an operator",
      );
    }
    if (!statusIsTerminal(session.status) || this.activeSessions.has(id)) {
      throw lifecycleConflict("Stop the active orchestration before resuming a recovery");
    }
    const updated = await recovery.transitionOperation(operationId, operation.stage, {
      resumeRequestId: parsed.data.requestId,
      resumeRequestFingerprint: fingerprint,
    });
    this.startRecoveryTask(operationId);
    return toWorkspaceRecoveryView(updated);
  }

  /**
   * Operator escape hatch: put the eligible source back to the safety
   * checkpoint taken before the interrupted restore, reset Project threads,
   * and settle the operation without launching anything.
   */
  async restoreSafety(
    id: string,
    operationId: string,
    input: RestoreSafetyInput,
    principal: Principal = DEMO_HUMAN_PRINCIPAL,
  ): Promise<WorkspaceRecoveryView> {
    const parsed = RestoreSafetySchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "Invalid safety restore request");
    }
    const recovery = this.requireWorkspaceRecovery();
    const session = this.findSession(id);
    const operation = recovery.getOperation(operationId);
    if (!operation || operation.orchestrationId !== id || operation.kind !== "recovery") {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Recovery operation not found");
    }
    await recovery.authorizeRecovery(operation.projectId, principal);
    const fingerprint = requestFingerprint({ action: "restore-safety", operationId });
    if (operation.safetyRequestId === parsed.data.requestId) {
      if (operation.safetyRequestFingerprint !== fingerprint) {
        throw new WorkspaceCheckpointError("CHECKPOINT_IDEMPOTENCY_CONFLICT", "This request ID was already used");
      }
      return toWorkspaceRecoveryView(operation);
    }
    if (operation.resumeCycleId !== null) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_EXECUTION_ALREADY_ACCEPTED",
        "This recovery already accepted a resume cycle",
      );
    }
    if (
      !operation.reservationHeld ||
      operation.safetyCheckpointId === null ||
      !["recovery_required", "restoring", "backed_up", "restored"].includes(operation.stage) ||
      this.recoveryTasks.has(operationId)
    ) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_OPERATION_STAGE_INVALID",
        "This recovery has no ready safety checkpoint to fall back to",
      );
    }
    if (!statusIsTerminal(session.status) || this.activeSessions.has(id)) {
      throw lifecycleConflict("Stop the active orchestration first");
    }
    const updated = await recovery.transitionOperation(operationId, operation.stage, {
      safetyRequestId: parsed.data.requestId,
      safetyRequestFingerprint: fingerprint,
    });
    const task = this.executeSafetyRestore(operationId).finally(() => {
      if (this.recoveryTasks.get(operationId) === task) this.recoveryTasks.delete(operationId);
    });
    this.recoveryTasks.set(operationId, task);
    return toWorkspaceRecoveryView(updated);
  }

  /** Test and lifecycle helper: wait for a background recovery to settle. */
  async waitForRecovery(operationId: string): Promise<void> {
    const task = this.recoveryTasks.get(operationId);
    if (task) await task.catch(() => undefined);
  }

  private startRecoveryTask(operationId: string): void {
    if (this.recoveryTasks.has(operationId)) return;
    const task = this.executeRecovery(operationId).finally(() => {
      if (this.recoveryTasks.get(operationId) === task) this.recoveryTasks.delete(operationId);
    });
    this.recoveryTasks.set(operationId, task);
  }

  private assertResumable(session: OrchestrationSession, resume: CheckpointResumeState): void {
    if (!rosterMatches(resume.participants, session.participants) || resume.mode !== (session.mode ?? "sequential")) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_CONTEXT_MISMATCH",
        "The conversation's roster or mode no longer matches the one this checkpoint recorded",
      );
    }
    const budget = checkResumeBudget(resume);
    if (!budget.ok) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_NO_REMAINING_STEPS",
        "No participant work remains after this checkpoint; nothing would run",
      );
    }
  }

  /**
   * The physical protocol, resumable at every durable stage. Nothing here
   * dispatches an Agent until the source is verified and the epoch and
   * thread resets are committed; then exactly one resume cycle is accepted.
   */
  private async executeRecovery(operationId: string): Promise<void> {
    const recovery = this.requireWorkspaceRecovery();
    let operation = recovery.getOperation(operationId);
    if (!operation || operation.targetCheckpointId === null) return;
    const { projectId, orchestrationId } = operation;
    const targetId = operation.targetCheckpointId;
    let filesTouched = operation.stage === "restoring" || operation.stage === "restored" || operation.restoredEpoch !== undefined;
    try {
      if (operation.resumeCycleId !== null) {
        throw new WorkspaceCheckpointError("CHECKPOINT_EXECUTION_ALREADY_ACCEPTED", "Already resumed");
      }
      const target = recovery.getCheckpoint(targetId);
      if (!target || target.state !== "ready" || target.resume === null) {
        throw new WorkspaceCheckpointError("CHECKPOINT_NOT_READY", "The restore target is no longer ready");
      }
      if (operation.restoredEpoch === undefined) {
        if (operation.stage === "reserved") {
          operation = await recovery.transitionOperation(operationId, "preparing");
        }
        await recovery.quiescePreviews(projectId);
        recovery.requireNoPhysicalWriter(projectId);
        await recovery.validateCheckpoint(target.id);
        let safety = operation.safetyCheckpointId === null ? null : recovery.getCheckpoint(operation.safetyCheckpointId);
        if (!safety || safety.state !== "ready") {
          if (operation.stage === "restoring") {
            // Files may already be a mixture; a fresh safety snapshot would
            // preserve nothing meaningful and the original one is gone.
            throw new WorkspaceCheckpointError("CHECKPOINT_RESTORE_FAILED", "The safety checkpoint is missing");
          }
          const project = this.store.snapshot().projects.find((item) => item.id === projectId);
          safety = await recovery.captureSafety({
            projectId,
            operationId,
            workspaceEpoch: operation.expectedEpoch,
            orchestrationId,
            executionCycleId: null,
            parentCheckpointId: project?.currentCheckpointId ?? null,
          });
        }
        const resumingApply = operation.stage === "restoring";
        const plan = await recovery.prepareRestore(target.id, safety.id, undefined, {
          fromSafety: resumingApply,
        });
        if (resumingApply && operation.restorePlanHash !== undefined && operation.restorePlanHash !== plan.planHash) {
          throw new WorkspaceCheckpointError("CHECKPOINT_RESTORE_FAILED", "The interrupted restore plan cannot be reproduced");
        }
        if (!resumingApply) {
          operation = await recovery.transitionOperation(operationId, "backed_up", {
            safetyCheckpointId: safety.id,
            restorePlanHash: plan.planHash,
          });
          await this.recordLifecycle(orchestrationId, "workspace_checkpoint_created", "Safety checkpoint saved before restore", {
            metadata: {
              checkpointId: safety.id,
              checkpointOrdinal: safety.ordinal,
              checkpointKind: "safety",
              operationId,
              eventKey: operationId + ":backed_up",
            },
          });
          operation = await recovery.transitionOperation(operationId, "restoring");
        }
        filesTouched = true;
        await recovery.applyRestore(plan);
        const restoredEpoch = await this.store.mutate((database) => {
          const epoch = recovery.resetWorkspaceIn(database, projectId, target.id);
          recovery.transitionOperationIn(database, operationId, "restored", { restoredEpoch: epoch });
          const stored = database.orchestrations.find((item) => item.id === orchestrationId);
          if (stored) {
            appendEvent(database, stored, "workspace_checkpoint_restored", {
              checkpointId: target.id,
              recoveryOperationId: operationId,
              safeSummary:
                "Workspace source restored to checkpoint #" + String(target.ordinal) +
                "; safety checkpoint #" + String(safety.ordinal) + " kept",
            });
          }
          return epoch;
        });
        await this.recordLifecycle(orchestrationId, "workspace_checkpoint_restored", "Workspace source restored", {
          metadata: {
            checkpointId: target.id,
            safetyCheckpointId: safety.id,
            operationId,
            workspaceEpoch: restoredEpoch,
            eventKey: operationId + ":restored",
          },
        });
      }
      await this.acceptResume(operationId);
    } catch (error) {
      const code = isWorkspaceCheckpointError(error) ? error.code : "CHECKPOINT_RESTORE_FAILED";
      if (code === "CHECKPOINT_EXECUTION_ALREADY_ACCEPTED") return;
      await this.store
        .mutate((database) => {
          if (filesTouched) {
            recovery.transitionOperationIn(database, operationId, "recovery_required", { errorCode: code });
          } else {
            recovery.releaseOperationIn(database, operationId, "failed", code);
          }
          const stored = database.orchestrations.find((item) => item.id === orchestrationId);
          if (stored) {
            appendEvent(database, stored, "workspace_checkpoint_restore_failed", {
              checkpointId: targetId,
              recoveryOperationId: operationId,
              safeSummary: (filesTouched ? "Restore needs attention: " : "Restore could not start: ") + code,
            });
          }
        })
        .catch(() => undefined);
      await this.recordLifecycle(orchestrationId, "workspace_checkpoint_restore_failed", "Workspace restore failed", {
        status: "failure",
        metadata: {
          checkpointId: targetId,
          operationId,
          stage: filesTouched ? "recovery_required" : "failed",
          errorCode: code,
          eventKey: operationId + ":restore-failed",
        },
      });
    }
  }

  /** Put the eligible source back to the safety checkpoint and settle. */
  private async executeSafetyRestore(operationId: string): Promise<void> {
    const recovery = this.requireWorkspaceRecovery();
    const operation = recovery.getOperation(operationId);
    if (!operation || operation.safetyCheckpointId === null) return;
    const { projectId, orchestrationId } = operation;
    const safetyId = operation.safetyCheckpointId;
    try {
      const safety = recovery.getCheckpoint(safetyId);
      if (!safety || safety.state !== "ready") {
        throw new WorkspaceCheckpointError("CHECKPOINT_NOT_READY", "The safety checkpoint is not ready");
      }
      await recovery.quiescePreviews(projectId);
      recovery.requireNoPhysicalWriter(projectId);
      await recovery.validateCheckpoint(safety.id);
      await recovery.transitionOperation(operationId, "restoring");
      const plan = await recovery.prepareRestore(safety.id, null);
      await recovery.applyRestore(plan);
      await this.store.mutate((database) => {
        recovery.resetWorkspaceIn(database, projectId, safety.id);
        recovery.releaseOperationIn(database, operationId, "settled");
        const stored = database.orchestrations.find((item) => item.id === orchestrationId);
        if (stored) {
          appendEvent(database, stored, "workspace_checkpoint_restored", {
            checkpointId: safety.id,
            recoveryOperationId: operationId,
            safeSummary: "Workspace source restored to safety checkpoint #" + String(safety.ordinal),
          });
        }
      });
      await this.recordLifecycle(orchestrationId, "workspace_checkpoint_restored", "Safety checkpoint restored", {
        metadata: { checkpointId: safety.id, operationId, eventKey: operationId + ":safety-restored" },
      });
    } catch (error) {
      const code = isWorkspaceCheckpointError(error) ? error.code : "CHECKPOINT_RESTORE_FAILED";
      await recovery
        .transitionOperation(operationId, "recovery_required", { errorCode: code })
        .catch(() => undefined);
      await this.recordLifecycle(orchestrationId, "workspace_checkpoint_restore_failed", "Safety restore failed", {
        status: "failure",
        metadata: { checkpointId: safetyId, operationId, errorCode: code, eventKey: operationId + ":safety-failed" },
      });
    }
  }

  /**
   * Accept exactly one resume cycle from the target's recorded boundary. The
   * recovery reservation is transferred to the new cycle inside the same
   * mutation that records the accepted cycle ID, so a repeated request cannot
   * accept a second one.
   */
  private async acceptResume(operationId: string): Promise<void> {
    const recovery = this.requireWorkspaceRecovery();
    const operation = recovery.getOperation(operationId);
    if (!operation || operation.targetCheckpointId === null) return;
    if (operation.resumeCycleId !== null) {
      throw new WorkspaceCheckpointError("CHECKPOINT_EXECUTION_ALREADY_ACCEPTED", "Already resumed");
    }
    const target = recovery.getCheckpoint(operation.targetCheckpointId);
    if (!target || target.resume === null) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_READY", "The restore target is no longer ready");
    }
    const resume = target.resume;
    const session = this.findSession(operation.orchestrationId);
    if (!statusIsTerminal(session.status) || this.activeSessions.has(session.id)) {
      throw lifecycleConflict("Orchestration is not settled");
    }
    this.assertResumable(session, resume);
    await this.preflightRoster(session, { allowErroredAgents: true });
    const supervisorModel = await this.preflightSupervisor(session);
    const epoch = recovery.workspaceEpoch(operation.projectId);
    const plan: CheckpointedCyclePlan = {
      kind: "recovery",
      cyclePrompt: resume.originalPrompt,
      cycleIndex: resume.cycleIndex,
      startStepIndex: resume.nextEngineStepIndex,
      contextTurns: resume.contextTurns,
      parentCheckpointId: target.id,
      sourceCheckpointId: target.id,
      seedTurns: resume.turns,
      lastRunId: resume.lastRunId,
      lastOutput: resume.lastOutput,
      allowErroredAgents: true,
      commit: (database, cycleId) => {
        const stored = database.orchestrations.find((item) => item.id === session.id);
        if (!stored) throw new HttpError(404, "Orchestration not found");
        applySupervisorModel(stored, supervisorModel);
        const highest = database.orchestrationTurns
          .filter((item) => item.sessionId === session.id)
          .reduce((maximum, item) => Math.max(maximum, item.stepIndex === undefined ? 0 : item.stepIndex), -1);
        const stepOffset = highest + 1 - resume.nextEngineStepIndex;
        const timestamp = now();
        stored.stepIndex = highest + 1;
        stored.status = "queued";
        stored.currentParticipantId = null;
        stored.currentRunId = null;
        stored.completionReason = null;
        stored.errorCode = null;
        stored.errorMessage = null;
        stored.startedAt = timestamp;
        stored.completedAt = null;
        stored.updatedAt = timestamp;
        appendEvent(database, stored, "workspace_recovery_resumed", {
          checkpointId: target.id,
          recoveryOperationId: operationId,
          safeSummary:
            "Resuming after workspace checkpoint #" + String(target.ordinal) +
            " with fresh Project context (cycle " + cycleId.slice(0, 8) + ")",
        });
        return { stepOffset };
      },
      audit: {
        type: "workspace_recovery_resumed",
        summary: "Orchestration resumed from a restored checkpoint",
        metadata: {
          checkpointId: target.id,
          checkpointOrdinal: target.ordinal,
          operationId,
          nextEngineStepIndex: resume.nextEngineStepIndex,
          eventKey: operationId + ":resumed",
        },
      },
    };
    await this.acceptCheckpointedCycle(session, plan, (cycleId) =>
      this.store.mutate((database) => {
        const stored = database.orchestrations.find((item) => item.id === session.id);
        if (!stored || !statusIsTerminal(stored.status) || this.activeSessions.has(session.id)) {
          throw lifecycleConflict("Orchestration is not settled");
        }
        return structuredClone(
          recovery.transferToCycleIn(database, operationId, {
            orchestrationId: session.id,
            executionCycleId: cycleId,
            actorPrincipalId: operation.actorPrincipalId,
            expectedEpoch: epoch,
          }),
        );
      }),
    );
  }

  private findSession(id: string): OrchestrationSession {
    const session = this.store.snapshot().orchestrations.find((item) => item.id === id);
    if (!session) throw new HttpError(404, "Orchestration not found");
    return session;
  }

  private assertActiveProject(projectId: string | null | undefined): void {
    if (projectId === undefined || projectId === null) return;
    const project = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!project || project.status !== "active") {
      throw lifecycleConflict("This Workspace is archived or no longer available");
    }
  }

  /**
   * Choose a real Agent for supervisor routing. Roster order is authoritative;
   * Project membership is the safe fallback for an empty/legacy roster. A
   * ready Agent wins over a stopped/busy Agent, but the latter is retained so
   * startSession can return the precise lifecycle error for an explicit choice.
   */
  /** Materialize a Project roster before the first prompt starts a draft. */
  private async projectParticipants(
    projectId: string,
  ): Promise<OrchestrationParticipant[]> {
    const database = this.store.snapshot();
    const attachments = database.projectAgents
      .filter((attachment) => attachment.projectId === projectId)
      .sort((left, right) =>
        left.attachedAt.localeCompare(right.attachedAt) ||
        left.agentId.localeCompare(right.agentId),
      );
    const knownAgents = new Set((await this.listCurrentAgents()).map((agent) => agent.id));
    let position = 0;
    return attachments.flatMap((attachment) => {
      // A deleted Agent should not be reintroduced into a legacy draft from a
      // stale membership row. Current roster preflight still validates any
      // explicitly persisted participant IDs.
      if (!knownAgents.has(attachment.agentId)) return [];
      const participant: OrchestrationParticipant = {
        id: `project-member-${attachment.agentId}-${position}`,
        agentId: attachment.agentId,
        role: attachment.role ?? "Agent",
        position,
      };
      position += 1;
      return [safeParticipant(participant)];
    });
  }

  /**
   * Fill only draft-owned fields. The caller later commits these fields in
   * the same mutation that changes draft -> queued, preventing a first prompt
   * from racing another start or silently replacing an existing task.
   */
  private async prepareStartSession(
    current: OrchestrationSession,
    firstPrompt?: string,
  ): Promise<OrchestrationSession> {
    const prepared = structuredClone(current);
    if (firstPrompt !== undefined) {
      const parsed = StartOrchestrationSchema.safeParse({ prompt: firstPrompt });
      if (!parsed.success || parsed.data.prompt === undefined) {
        throw new HttpError(422, "Invalid orchestration start request");
      }
      if (prepared.originalPrompt.trim()) {
        throw lifecycleConflict(
          "This Conversation already has a task; use continue for another prompt",
        );
      }
      prepared.originalPrompt = boundedSafeText(
        parsed.data.prompt,
        ORCHESTRATION_LIMITS.maxPromptLength,
        "[TASK TRUNCATED]",
      );
    }
    if (prepared.participants.length === 0 && prepared.projectId) {
      prepared.participants = await this.projectParticipants(prepared.projectId);
    }
    return prepared;
  }

  private async listCurrentAgents(): Promise<Agent[]> {
    return Promise.resolve(this.agents.listAgents());
  }

  /**
   * Build runtime-only supervisor context from the current Agent catalog.
   * Profiles are passed through execution options/closures and are therefore
   * never serialized into Mastra state or persisted JSON records.
   */
  private async participantProfiles(
    session: OrchestrationSession,
  ): Promise<OrchestrationParticipantProfile[]> {
    const agents = await this.listCurrentAgents();
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    return session.participants.flatMap((participant) => {
      const agent = byId.get(participant.agentId);
      if (!agent) return [];
      return [
        {
          ...participant,
          name: boundedSafeText(
            agent.name,
            ORCHESTRATION_LIMITS.maxNameLength,
            "[NAME TRUNCATED]",
          ),
          description: boundedSafeText(
            agent.description,
            ORCHESTRATION_LIMITS.maxSafeSummaryLength,
            "[DESCRIPTION TRUNCATED]",
          ),
        },
      ];
    });
  }

  private async preflightRoster(
    session: OrchestrationSession,
    options: { allowErroredAgentId?: string; allowErroredAgents?: boolean } = {},
  ): Promise<void> {
    const agents = await this.listCurrentAgents();
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    for (const participant of session.participants) {
      const agent = byId.get(participant.agentId);
      if (!agent) {
        throw new HttpError(
          422,
          "Agent " + participant.agentId + " was not found",
        );
      }
      this.assertAgentAvailable(
        agent,
        true,
        options.allowErroredAgents === true || options.allowErroredAgentId === agent.id,
      );
      if (agent.modelRef === undefined) {
        throw new HttpError(
          422,
          "Agent " + participant.agentId + " has no worker model; edit it before starting this Conversation",
        );
      }
    }
  }

  /**
   * Resolve the supervisor model once per accepted cycle.
   *
   * Routing is a server-wide model, never an Agent: nothing in the roster
   * supervises, and no Agent is consumed by supervising. The resolver is the
   * model-catalog authority and must prove supervisor scope; this service only
   * carries its credential-free model snapshot forward.
   */
  private async preflightSupervisor(
    session: OrchestrationSession,
  ): Promise<SupervisorModelAssignment | undefined> {
    if ((session.mode ?? "sequential") !== "supervisor") return undefined;
    if (!this.resolveSupervisorModel) {
      throw new HttpError(
        503,
        "Supervisor model resolution is not configured",
      );
    }
    const assignment = await this.resolveSupervisorModel();
    if (
      !assignment ||
      typeof assignment.modelId !== "string" ||
      assignment.modelId.trim().length === 0 ||
      !assignment.modelRef ||
      typeof assignment.modelRef.providerId !== "string" ||
      typeof assignment.modelRef.modelId !== "string" ||
      assignment.modelRef.modelId !== assignment.modelId
    ) {
      throw new HttpError(
        503,
        "Supervisor model resolution returned an invalid assignment",
      );
    }
    return {
      modelRef: structuredClone(assignment.modelRef),
      modelId: assignment.modelId.trim(),
      ...(assignment.catalogRevision === undefined
        ? {}
        : { catalogRevision: assignment.catalogRevision }),
    };
  }

  private assertAgentAvailable(
    agent: Agent,
    preflight: boolean,
    allowErrored = false,
  ): void {
    if (agent.status === "ready") return;
    // A retry button is an explicit user action. Permit only the Agent that
    // owns the recorded checkpoint to re-enter the queue after a prior
    // runtime failure; ordinary starts/continues still require `ready`, and
    // stopped/busy Agents remain protected by their normal lifecycle rules.
    if (agent.status === "error" && allowErrored) return;
    const statusCode = 409;
    if (agent.status === "busy") {
      throw preflight
        ? new HttpError(statusCode, "Agent " + agent.id + " is busy")
        : new DispatchLifecycleError("AGENT_BUSY", "Agent " + agent.id + " is busy");
    }
    if (agent.status === "stopped") {
      throw preflight
        ? new HttpError(statusCode, "Agent " + agent.id + " is stopped")
        : new DispatchLifecycleError(
            "AGENT_STOPPED",
            "Agent " + agent.id + " is stopped",
          );
    }
    throw preflight
      ? new HttpError(statusCode, "Agent " + agent.id + " is unavailable")
      : new DispatchLifecycleError(
          "AGENT_UNAVAILABLE",
          "Agent " + agent.id + " is unavailable",
        );
  }

  private async validateParticipant(
    participant: OrchestrationParticipant,
    options: { allowErrored?: boolean } = {},
  ): Promise<void> {
    const agent = (await this.listCurrentAgents()).find(
      (candidate) => candidate.id === participant.agentId,
    );
    if (!agent) {
      throw new DispatchLifecycleError(
        "AGENT_NOT_FOUND",
        "Agent " + participant.agentId + " was not found",
      );
    }
    this.assertAgentAvailable(agent, false, options.allowErrored === true);
  }

  /**
   * Return only completed, safe application-owned turns from prior cycles.
   * The workflow receives this bounded projection separately from its fresh
   * cycle turns, so historical work informs handoffs without consuming the
   * new cycle's maxSteps budget.
   */
  private launch(
    session: OrchestrationSession,
    cycle: {
      cyclePrompt?: string;
      cycleIndex?: number;
      stepOffset?: number;
      startStepIndex?: number;
      contextBeforeStepIndex?: number;
      /** Supervisor retries pin the first dispatch to this occurrence. */
      retryParticipantId?: string;
      /** Any retry may recover the failed checkpoint Agent once. */
      retryAgentId?: string;
      /** Checkpoint-enabled cycle identity, when the Project is checkpointed. */
      workspace?: OrchestrationWorkspaceCycle;
      /** Exact engine input recorded for this cycle. */
      seed?: CheckpointResumeState;
      /** A recovered cycle may re-dispatch an Agent still in its error state. */
      allowErroredAgents?: boolean;
    } = {},
  ): void {
    let invoker: PlatformAgentInvokerContract;
    let selector: OrchestrationParticipantSelector | undefined;
    let orchestrator: Orchestrator;
    try {
      invoker = this.invokerFactory();
      // The configured selector is the supervisor provider. Sequential and
      // round-robin sessions route deterministically inside the engine and
      // must never consult it: the provider rejects non-supervisor input.
      const configuredSelector =
        (session.mode ?? "sequential") === "supervisor" ? this.selectorFactory() : undefined;
      const supervisorModel =
        (session.mode ?? "sequential") === "supervisor"
          ? session.supervisorModelRef?.modelId
          : undefined;
      selector =
        configuredSelector === undefined || supervisorModel === undefined
          ? configuredSelector
          : async (input, options) =>
              configuredSelector(
                { ...input, supervisorModel },
                options,
              );
      if (selector !== undefined && cycle.retryParticipantId !== undefined) {
        const normalSelector = selector;
        let checkpointPending = true;
        selector = async (input, options) => {
          if (checkpointPending && input.mode === "supervisor") {
            checkpointPending = false;
            const participant = input.participants.find(
              (candidate) => candidate.id === cycle.retryParticipantId,
            );
            if (!participant) {
              throw new Error("Retry checkpoint participant is not configured");
            }
            return {
              kind: "invoke",
              participant: { ...participant },
              stepIndex: input.stepIndex,
              reason: "Retrying from the recorded checkpoint",
            };
          }
          return normalSelector(input, options);
        };
      }
      if (
        selector !== undefined &&
        (cycle.cycleIndex ?? 0) > 0 &&
        cycle.retryParticipantId === undefined
      ) {
        const normalSelector = selector;
        let correctionUsed = false;
        selector = async (input, options) => {
          const configuredBudgetMs =
            options?.timeoutMs ?? this.supervisorTimeoutMs;
          const selectionBudgetMs =
            configuredBudgetMs !== undefined &&
            Number.isInteger(configuredBudgetMs) &&
            configuredBudgetMs > 0
              ? configuredBudgetMs
              : DEFAULT_SUPERVISOR_TIMEOUT_MS;
          const requestBudget =
            options?.requestBudget ??
            createSupervisorRequestBudget(Date.now() + selectionBudgetMs);
          const remainingTimeoutMs = requestBudget.deadlineAt - Date.now();
          if (!Number.isFinite(remainingTimeoutMs) || remainingTimeoutMs <= 0) {
            throw new SupervisorError(
              "SUPERVISOR_TIMED_OUT",
              "Supervisor did not make a routing decision before the routing deadline",
            );
          }
          const selectionOptions = {
            ...(options ?? {}),
            requestBudget,
          };
          const decision = await normalSelector(input, selectionOptions);
          if (
            input.mode !== "supervisor" ||
            (input.cycleIndex ?? 0) <= 0 ||
            (input.currentCycleTurnCount ?? input.turns.length) !== 0 ||
            decision.kind !== "end" ||
            decision.reason !== "supervisor_completed"
          ) {
            return decision;
          }

          if (correctionUsed) {
            throw new SupervisorError(
              "SUPERVISOR_INVALID_ROUTE",
              "Supervisor completed this follow-up before an Agent replied; retry the follow-up or review the Team roster",
            );
          }
          correctionUsed = true;
          if (options?.signal?.aborted) throw createAbortError();

          // A corrective provider call is still part of the same selection
          // deadline. It is side-effect free: no supervisor decision hook or
          // child Run is recorded until an eligible invoke is returned.
          const correctionTimeoutMs = requestBudget.deadlineAt - Date.now();
          if (correctionTimeoutMs <= 0) {
            throw new SupervisorError(
              "SUPERVISOR_TIMED_OUT",
              "Supervisor did not choose an Agent for this follow-up before the routing deadline",
            );
          }
          const corrected = await normalSelector(
            {
              ...input,
              requireCurrentCycleDispatch: true,
            },
            {
              ...selectionOptions,
              requestBudget,
              timeoutMs: correctionTimeoutMs,
            },
          );
          const participant =
            typeof corrected === "object" && corrected !== null &&
            "participant" in corrected
              ? (corrected as { participant?: unknown }).participant
              : undefined;
          const eligible =
            typeof participant === "object" &&
            participant !== null &&
            input.participants.some(
              (candidate) =>
                (participant as OrchestrationParticipant).id === candidate.id &&
                (participant as OrchestrationParticipant).agentId ===
                  candidate.agentId &&
                (participant as OrchestrationParticipant).position ===
                  candidate.position,
            );
          if (
            corrected.kind !== "invoke" ||
            !eligible ||
            corrected.stepIndex !== input.stepIndex
          ) {
            throw new SupervisorError(
              "SUPERVISOR_INVALID_ROUTE",
              "Supervisor did not select an eligible Agent for this follow-up; retry the follow-up or review the Team roster",
            );
          }
          return corrected;
        };
      }
      orchestrator = this.orchestratorFactory();
    } catch (error) {
      // Start is accepted before background execution begins. If dependency
      // construction fails, still publish a durable terminal outcome rather
      // than leaving the session queued forever.
      void this.finalizeFailure(session.id, error).catch(() => undefined);
      return;
    }
    const context: ActiveOrchestrationSession = {
      id: session.id,
      cyclePrompt: cycle.cyclePrompt ?? session.originalPrompt,
      stepOffset: cycle.stepOffset ?? 0,
      startStepIndex: cycle.startStepIndex ?? 0,
      contextBeforeStepIndex: cycle.contextBeforeStepIndex,
      cycleIndex: cycle.cycleIndex ?? 0,
      ...(session.supervisorModelRef?.modelId === undefined
        ? {}
        : { supervisorModel: session.supervisorModelRef.modelId }),
      ...(cycle.retryAgentId === undefined ? {} : { retryAgentId: cycle.retryAgentId }),
      retryAgentPending: cycle.retryAgentId !== undefined,
      ...(cycle.allowErroredAgents === undefined ? {} : { allowErroredAgents: cycle.allowErroredAgents }),
      ...(cycle.workspace === undefined ? {} : { workspace: cycle.workspace }),
      ...(cycle.seed === undefined ? {} : { seed: structuredClone(cycle.seed) }),
      controller: new AbortController(),
      invoker,
      ...(selector === undefined ? {} : { selector }),
      supervisorTimeoutMs: this.supervisorTimeoutMs,
      orchestrator,
      currentRunId: null,
      cancellationRequestedRunId: null,
      execution: null,
      participantSpan: null,
    };
    // Child Runs must parent under the participant span journaled just before
    // dispatch, which the engine never sees. Attach it at this seam instead.
    context.invoker = {
      invoke: (input) =>
        invoker.invoke({
          ...input,
          ...(context.participantSpan
            ? {
                parentSpan: {
                  traceId: context.participantSpan.traceId,
                  spanId: context.participantSpan.spanId,
                },
              }
              : {}),
        }),
      cancel: (runId) => invoker.cancel(runId),
      ...(invoker.cancelForStorageFailure === undefined
        ? {}
        : {
            cancelForStorageFailure: (runId: string) =>
              invoker.cancelForStorageFailure!(runId),
          }),
    };
    this.activeSessions.set(session.id, context);
    const execution = this.runSession(context);
    context.execution = execution;
    void execution.catch(() => undefined);
  }

  private async cancelChildRun(
    context: ActiveOrchestrationSession,
    runId: string,
  ): Promise<void> {
    // Abort, stop, and the accepted-run callback can all observe the same
    // cancellation. Keep the platform call idempotent at this boundary.
    if (context.cancellationRequestedRunId === runId) return;
    context.cancellationRequestedRunId = runId;
    // Close the application approval fence before asking the child runtime to
    // stop. AgentService normally performs the same operation, but retaining
    // the hook here covers injected invokers and keeps orchestration stop
    // ordered even when the child cancellation bridge is delayed.
    try {
      await this.toolApprovalInvalidator?.invalidateForRun?.(
        runId,
        "Orchestration was stopped",
      );
    } catch {
      // A failed fence cannot grant authorization back. Still request the
      // physical child cancellation so the lifecycle owner can settle.
    }
    try {
      await context.invoker.cancel(runId);
    } catch {
      // The engine's abort path and persisted terminal record remain
      // authoritative even if child cleanup fails.
    }
  }

  private async cancelChildRunForStorageFailure(
    context: ActiveOrchestrationSession,
    runId: string,
  ): Promise<void> {
    // The journal may already be unreadable. Prefer the dedicated physical
    // cancellation seam and never turn this fatal path into a Storage read.
    if (context.cancellationRequestedRunId === runId) return;
    context.cancellationRequestedRunId = runId;
    try {
      await this.toolApprovalInvalidator?.invalidateForRun?.(
        runId,
        "Storage failure cancelled the orchestration Run",
      );
    } catch {
      // Storage-fatal quiescence must remain bounded and proceed to the
      // memory-first physical cancellation path below.
    }
    try {
      if (context.invoker.cancelForStorageFailure) {
        await context.invoker.cancelForStorageFailure(runId);
      } else {
        // Compatibility for injected test/legacy invokers; production uses the
        // memory-first method above.
        await context.invoker.cancel(runId);
      }
    } catch {
      // The fatal shutdown observer is bounded; physical cancellation remains
      // best effort and must not mask the original storage failure.
    }
  }

  private executionHooks(
    context: ActiveOrchestrationSession,
  ): OrchestrationExecutionHooks {
    const journalHooks = createOrchestrationExecutionHooks(context, {
      store: this.store,
      validateParticipant: async (participant) => {
        const allowErrored =
          context.allowErroredAgents === true ||
          (context.retryAgentPending && context.retryAgentId === participant.agentId);
        await this.validateParticipant(participant, { allowErrored });
        if (context.retryAgentPending && context.retryAgentId === participant.agentId) {
          context.retryAgentPending = false;
        }
      },
      cancelChildRun: (runId) => this.cancelChildRun(context, runId),
      ...(this.workspaceRecovery === undefined ? {} : { workspaceRecovery: this.workspaceRecovery }),
    });
    if (!this.audit) return journalHooks;

    return {
      ...journalHooks,
      onSupervisorDecision: async (input) => {
        await journalHooks.onSupervisorDecision?.(input);
        const selectedAgentId = input.participantId
          ? this.findSession(context.id).participants.find(
              (participant) => participant.id === input.participantId,
            )?.agentId
          : undefined;
        await this.recordAudit({
          type: "supervisor_decision",
          status: "success",
          orchestrationId: context.id,
          ...(selectedAgentId === undefined ? {} : { agentId: selectedAgentId }),
          principal: systemPrincipal(),
          summary: "Supervisor chose the next step",
          span: this.orchestrationSpan(context.id),
          metadata: {
            action: input.action,
            stepIndex: input.stepIndex,
            ...(selectedAgentId === undefined ? {} : { selectedAgentId }),
          },
        });
      },
      onBeforeDispatch: async (input) => {
        await journalHooks.onBeforeDispatch?.(input);
        const root = this.orchestrationSpan(context.id);
        const participantSpan: AuditSpan = {
          traceId: root.traceId,
          spanId: newSpanId(),
          parentSpanId: root.spanId,
        };
        context.participantSpan = participantSpan;
        await this.recordAudit({
          type: "participant_dispatched",
          status: "success",
          orchestrationId: context.id,
          agentId: input.participant.agentId,
          principal: systemPrincipal(),
          summary: "Participant dispatched",
          span: participantSpan,
          metadata: {
            participantIndex: input.participant.position,
            role: input.participant.role,
            stepIndex: input.stepIndex,
          },
        });
      },
      onHandoffApplied: async (input) => {
        await journalHooks.onHandoffApplied?.(input);
        await this.recordAudit({
          type: "handoff_applied",
          status: "success",
          orchestrationId: context.id,
          agentId: input.participant.agentId,
          principal: systemPrincipal(),
          summary: "Handoff applied to the next participant",
          span: this.orchestrationSpan(context.id),
          metadata: {
            role: input.participant.role,
            stepIndex: input.stepIndex,
            truncated: input.envelope.truncated,
          },
        });
      },
    };
  }

  private async runSession(context: ActiveOrchestrationSession): Promise<void> {
    const execute = (span?: TelemetrySpan) => this.runSessionInternal(context, span);
    if (this.telemetry) {
      await this.telemetry.withSpan(
        "orchestration.run",
        correlationAttributes({ orchestrationId: context.id }),
        (span) => execute(span),
      );
      return;
    }
    await execute();
  }

  private async runSessionInternal(
    context: ActiveOrchestrationSession,
    span?: TelemetrySpan,
  ): Promise<void> {
    try {
      const session = await this.store.mutate((database) => {
        const current = database.orchestrations.find((item) => item.id === context.id);
        if (!current) throw new HttpError(404, "Orchestration not found");
        if (current.status === "stopping") return null;
        if (current.status !== "queued" && current.status !== "running") return null;
        if (current.status === "queued") current.status = "running";
        current.updatedAt = now();
        return structuredClone(current);
      });
      if (session === null || context.controller.signal.aborted) {
        await this.finalizeStopped(context.id, context);
        span?.setStatus("ok");
        return;
      }

      const participantProfiles = await this.participantProfiles(session);

      // A checkpointed cycle starts from the exact state recorded beside its
      // baseline; a legacy cycle reconstructs its context from the journal.
      const executionInput: OrchestrationExecutionInput = context.seed
        ? buildRecoveryExecutionInput(session.id, context.seed)
        : {
            sessionId: session.id,
            originalPrompt: context.cyclePrompt,
            participants: session.participants.map(safeParticipant),
            mode: session.mode ?? "sequential",
            cycleIndex: context.cycleIndex,
            maxSteps: session.maxSteps,
            // Each continuation is a fresh internal cycle. Persisted turn indexes
            // remain global through context.stepOffset in the lifecycle hooks.
            // A retry seeds the cursor so routing resumes at the chosen step.
            stepIndex: context.startStepIndex,
            lastRunId: null,
            lastOutput: null,
            turns: [],
            contextTurns: this.journal.contextTurns(
              session.id,
              session.maxSteps,
              context.contextBeforeStepIndex,
            ),
            status: "running",
            errorCode: null,
          };
      const result = await context.orchestrator.run(executionInput, {
        invoker: context.invoker,
        ...(context.selector === undefined
          ? {}
          : { selectNextParticipant: context.selector }),
        ...(context.supervisorTimeoutMs === undefined
          ? {}
          : { supervisorTimeoutMs: context.supervisorTimeoutMs }),
        participantProfiles,
        clarifyFirst: session.clarifyFirst === true,
        perAgentTimeoutMs: session.perAgentTimeoutMs,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        orchestrationId: session.id,
        ...(context.workspace === undefined ? {} : { workspace: context.workspace.context }),
        signal: context.controller.signal,
        hooks: this.executionHooks(context),
      });
      await this.finalizeExecution(context, result);
      span?.setStatus("ok");
    } catch (error) {
      span?.setStatus("error");
      if (context.controller.signal.aborted) {
        await this.finalizeStopped(context.id, context);
      } else {
        await this.finalizeFailure(context.id, error, context);
      }
    } finally {
      // Normally the cycle settled inside the terminal write above; this
      // covers a session that was already terminal when finalize ran.
      if (context.workspace !== undefined && context.cycleSettled !== true) {
        await this.settleCycle(context);
      }
      if (this.activeSessions.get(context.id) === context) {
        this.activeSessions.delete(context.id);
      }
    }
  }

  private async finalizeExecution(
    context: ActiveOrchestrationSession,
    result: OrchestrationExecutionResult,
  ): Promise<void> {
    const outcome = await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === context.id);
      if (!session || statusIsTerminal(session.status)) return null;
      const completedAt = now();
      // A bounded round-robin run is not a successful completion merely
      // because an injected engine returned `completed`. The service owns
      // the authoritative session guardrail, so coerce an engine result that
      // reaches the ceiling without the one natural completion reason into a
      // stable MAX_STEPS_EXCEEDED failure.
      const roundRobinCeilingExceeded =
        result.status === "completed" &&
        (session.mode ?? "sequential") === "round_robin" &&
        result.stepIndex >= session.maxSteps;
      const supervisorCompletionMissing =
        result.status === "completed" &&
        (session.mode ?? "sequential") === "supervisor" &&
        result.completionReason !== "supervisor_completed";
      const supervisorFollowUpWithoutReply =
        context.cycleIndex > 0 &&
        (session.mode ?? "sequential") === "supervisor" &&
        result.turns.length === 0 &&
        (result.status === "completed" ||
          result.errorCode === "SUPERVISOR_INVALID_RESPONSE" ||
          result.errorCode === "SUPERVISOR_INVALID_SELECTION" ||
          result.errorCode === "SUPERVISOR_FAILED");
      if (supervisorFollowUpWithoutReply && result.status === "completed") {
        // A continuation is a new user request. Historical turns may be
        // present in the supervisor context, but they cannot satisfy the
        // request without one current-cycle participant reply.
        result = {
          ...result,
          status: "failed",
          completionReason: null,
          errorCode: "SUPERVISOR_INVALID_SELECTION",
        };
      } else if (roundRobinCeilingExceeded) {
        result = {
          ...result,
          status: "failed",
          completionReason: null,
          errorCode: "MAX_STEPS_EXCEEDED",
        };
      } else if (supervisorCompletionMissing) {
        // Supervisor mode has no deterministic fallback completion. An
        // engine that reports success without the explicit supervisor signal
        // is malformed and must remain a visible failure.
        result = {
          ...result,
          status: "failed",
          completionReason: null,
          errorCode: "SUPERVISOR_INVALID_RESPONSE",
        };
      }
      const shouldStop =
        context.controller.signal.aborted ||
        session.status === "stopping" ||
        result.status === "stopped";
      if (shouldStop) {
        session.status = "stopped";
        session.completionReason = null;
        session.errorCode = "ORCHESTRATION_STOPPED";
        session.errorMessage = "Orchestration stopped";
        session.completedAt = completedAt;
        session.currentParticipantId = null;
        session.currentRunId = null;
        session.updatedAt = completedAt;
        appendEvent(database, session, "orchestration_stopped", {
          errorCode: "ORCHESTRATION_STOPPED",
          safeSummary: session.errorMessage,
        });
        this.settleCycleIn(database, context, session.status);
        return this.terminalOutcome(session, "orchestration_stopped", completedAt);
      }

      if (result.status === "completed") {
        const completionReason =
          result.completionReason ??
          ((session.mode ?? "sequential") === "sequential"
            ? "roster_exhausted"
            : null);
        session.status = "completed";
        session.completionReason = completionReason;
        session.errorCode = null;
        session.errorMessage = null;
        session.completedAt = completedAt;
        session.currentParticipantId = null;
        session.currentRunId = null;
        session.stepIndex = Math.max(
          session.stepIndex,
          context.stepOffset + result.stepIndex,
        );
        session.updatedAt = completedAt;
        const completionEventFields: OrchestrationEventFields = {
          safeSummary: "Orchestration completed",
        };
        if (completionReason !== null) {
          completionEventFields.completionReason = completionReason;
        }
        appendEvent(database, session, "orchestration_completed", completionEventFields);
        this.settleCycleIn(database, context, session.status);
        return this.terminalOutcome(session, "orchestration_completed", completedAt);
      }

      session.status = "failed";
      session.completionReason = null;
      session.errorCode = result.errorCode ?? "RUN_FAILED";
      session.errorMessage = supervisorFollowUpWithoutReply
        ? "The supervisor did not select an Agent to answer this follow-up. Retry the follow-up or review the Team roster."
        : this.executionErrorMessage(result.errorCode);
      session.completedAt = completedAt;
      session.currentParticipantId = null;
      session.currentRunId = null;
      session.updatedAt = completedAt;
      appendEvent(database, session, "orchestration_failed", {
        errorCode: session.errorCode,
        safeSummary: session.errorMessage,
      });
      this.settleCycleIn(database, context, session.status);
      return this.terminalOutcome(
        session,
        "orchestration_failed",
        completedAt,
        result.errorRule,
      );
    });
    await this.recordTerminal(context.id, outcome);
  }

  /**
   * Safe evidence about one terminal transition. Only the stable error code
   * and, when the engine reported one, the closed-enum rule behind it travel
   * here; the session's error message may quote runtime text.
   */
  private terminalOutcome(
    session: OrchestrationSession,
    type: "orchestration_completed" | "orchestration_failed" | "orchestration_stopped",
    completedAt: string,
    errorRule?: OrchestrationFailureRule | undefined,
  ): {
    type: "orchestration_completed" | "orchestration_failed" | "orchestration_stopped";
    durationMs: number;
    errorCode: string | null;
    errorRule: OrchestrationFailureRule | null;
    stepIndex: number;
  } {
    const startedAt = session.startedAt ?? session.createdAt;
    return {
      type,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      errorCode: session.errorCode,
      errorRule: errorRule ?? null,
      stepIndex: session.stepIndex,
    };
  }

  private async recordTerminal(
    id: string,
    outcome: ReturnType<OrchestrationService["terminalOutcome"]> | null,
  ): Promise<void> {
    if (outcome === null) return;
    await this.recordLifecycle(
      id,
      outcome.type,
      outcome.type === "orchestration_completed"
        ? "Orchestration completed"
        : outcome.type === "orchestration_stopped"
          ? "Orchestration stopped"
          : "Orchestration failed",
      {
        status: outcome.type === "orchestration_failed" ? "failure" : "success",
        durationMs: outcome.durationMs,
        metadata: {
          stepIndex: outcome.stepIndex,
          ...(outcome.errorCode === null ? {} : { errorCode: outcome.errorCode }),
          // Several rules roll up into one code. Without this, a supervisor
          // failure could not be told apart from the other two that report
          // SUPERVISOR_INVALID_SELECTION, and each needs a different fix.
          ...(outcome.errorRule === null ? {} : { failureRule: outcome.errorRule }),
        },
      },
    );
    this.orchestrationSpans.delete(id);
  }

  private executionErrorMessage(code: OrchestrationErrorCode | null): string {
    switch (code) {
      case "MAX_STEPS_EXCEEDED":
        return "The declared roster exceeded the orchestration step limit";
      case "AGENT_NOT_FOUND":
        return "A declared Agent was not found at dispatch time";
      case "AGENT_BUSY":
        return "A declared Agent became busy at dispatch time";
      case "AGENT_STOPPED":
        return "A declared Agent was stopped at dispatch time";
      case "AGENT_UNAVAILABLE":
        return "A declared Agent became unavailable at dispatch time";
      case "INVALID_OUTPUT":
        return "A participant returned no usable output";
      case "RUN_TIMED_OUT":
        return "A participant Run timed out";
      case "RUN_CANCELLED":
        return "A participant Run was cancelled";
      case "SUPERVISOR_INVALID_RESPONSE":
        return "Automatic turn taking returned an invalid response";
      case "SUPERVISOR_INVALID_SELECTION":
        return "Automatic turn taking selected a participant outside the configured roster";
      case "SUPERVISOR_TIMED_OUT":
        return "Choosing the next participant timed out";
      case "SUPERVISOR_UNAVAILABLE":
        return "Automatic turn taking is unavailable";
      case "SUPERVISOR_FAILED":
        return "The next participant could not be chosen";
      case "WEB_TOOL_PERMISSION_DENIED":
        return "A participant could not use a web tool because its Agent role lacks the required permission";
      case "MODEL_RATE_LIMITED":
        return MODEL_RATE_LIMITED_MESSAGE;
      case "MODEL_INFERENCE_LIMIT_EXCEEDED":
        return "This model is paused because its provider inference limit was reached. Review Safe Experience Mode in the provider's Model Activation settings, or choose another available model, then retry.";
      case "PROJECT_PERMISSION_DENIED":
        return "This Agent is not allowed to write to the Workspace. Add Allow Agent runs (agent.invoke) and Edit workspace files (project.write) to the Agent's role, make sure it has editable Workspace membership, then retry.";
      case "CHECKPOINT_CAPTURE_FAILED":
        return "The Agent finished, but its Workspace files could not be checkpointed. Its reply is kept; restore an earlier checkpoint or retry once the Workspace is settled.";
      case "CHECKPOINT_PUBLISH_FAILED":
        return "The Agent's checkpoint could not be recorded with its turn, so the conversation stopped before the next Agent.";
      case "CHECKPOINT_RUNTIME_UNSUPPORTED":
        return "Source checkpoints need the container runtime to prove that a worker has stopped writing.";
      default:
        return "Orchestration failed while running a participant";
    }
  }

  private async finalizeFailure(
    id: string,
    error: unknown,
    context?: ActiveOrchestrationSession,
  ): Promise<void> {
    const explicitCode =
      typeof error === "object" && error !== null && "orchestrationErrorCode" in error
        ? (error as { orchestrationErrorCode?: unknown }).orchestrationErrorCode
        : undefined;
    const code: OrchestrationErrorCode =
      error instanceof DispatchLifecycleError
        ? error.orchestrationErrorCode
        : typeof explicitCode === "string" &&
            OrchestrationErrorCodeSchema.safeParse(explicitCode).success
          ? (explicitCode as OrchestrationErrorCode)
          : "INTERNAL_ERROR";
    const outcome = await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session || statusIsTerminal(session.status)) return null;
      const completedAt = now();
      session.status = "failed";
      session.completionReason = null;
      session.errorCode = code;
      session.errorMessage = safeErrorMessage(error);
      session.completedAt = completedAt;
      session.currentParticipantId = null;
      session.currentRunId = null;
      session.updatedAt = completedAt;
      appendEvent(database, session, "orchestration_failed", {
        errorCode: code,
        safeSummary: session.errorMessage,
      });
      if (context) this.settleCycleIn(database, context, session.status);
      return this.terminalOutcome(session, "orchestration_failed", completedAt);
    });
    await this.recordTerminal(id, outcome);
  }

  private async finalizeStopped(
    id: string,
    context?: ActiveOrchestrationSession,
  ): Promise<void> {
    const outcome = await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session || statusIsTerminal(session.status)) return null;
      const completedAt = now();
      session.status = "stopped";
      session.completionReason = null;
      session.errorCode = "ORCHESTRATION_STOPPED";
      session.errorMessage = "Orchestration stopped";
      session.completedAt = completedAt;
      session.currentParticipantId = null;
      session.currentRunId = null;
      session.updatedAt = completedAt;
      appendEvent(database, session, "orchestration_stopped", {
        errorCode: "ORCHESTRATION_STOPPED",
        safeSummary: session.errorMessage,
      });
      if (context) this.settleCycleIn(database, context, session.status);
      return this.terminalOutcome(session, "orchestration_stopped", completedAt);
    });
    await this.recordTerminal(id, outcome);
  }
}
