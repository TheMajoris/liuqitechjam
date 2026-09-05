import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { Agent } from "../types.js";
import type { ModelRef } from "../models/types.js";
import type { Storage } from "../store.js";
import {
  ContinueOrchestrationSchema,
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
  OrchestrationParticipant,
  OrchestrationSession,
  OrchestrationSessionDetail,
} from "./types.js";
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
  type OrchestrationGraphRunner,
  type OrchestrationInvokerFactory,
  type OrchestrationProjectBinding,
  type OrchestrationServiceDependencies,
  type SupervisorModelAssignment,
} from "./orchestration-runtime.js";

export type {
  OrchestrationAgentAccess,
  OrchestrationGraphRunner,
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

function lifecycleConflict(message: string): HttpError {
  return new HttpError(409, message);
}

function modelRefMatches(left: ModelRef | undefined, right: ModelRef): boolean {
  return (
    left?.providerId === right.providerId &&
    left?.modelId === right.modelId &&
    left?.reasoning?.effort === right.reasoning?.effort
  );
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
    | ((agent: Agent) => SupervisorModelAssignment | Promise<SupervisorModelAssignment>)
    | undefined;
  private readonly supervisorTimeoutMs: number | undefined;
  private readonly orchestratorFactory: () => Orchestrator;
  private readonly projectBinding: OrchestrationProjectBinding | undefined;
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
    graphRunner?: OrchestrationGraphRunner,
  );
  constructor(
    value: Storage | OrchestrationServiceDependencies,
    agents?: OrchestrationAgentAccess,
    invoker?: OrchestrationInvokerFactory,
    graphRunner?: OrchestrationGraphRunner,
  ) {
    const normalized = normalizeOrchestrationDependencies(
      value,
      agents,
      invoker,
      graphRunner,
    );
    this.store = normalized.store;
    this.journal = new OrchestrationJournal(this.store);
    this.agents = normalized.agents;
    this.invokerFactory = normalized.invokerFactory;
    this.selectorFactory = normalized.selectorFactory;
    this.resolveSupervisorModel = normalized.resolveSupervisorModel;
    this.supervisorTimeoutMs = normalized.supervisorTimeoutMs;
    this.orchestratorFactory = normalized.orchestratorFactory;
    this.projectBinding = normalized.projectBinding;
    this.audit = normalized.audit;
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

  /** Attach runtime telemetry after the application graph is assembled. */
  setTelemetry(telemetry: RuntimeTelemetry): void {
    this.telemetry = telemetry;
  }

  async initialize(): Promise<void> {
    await this.cancelActiveSessions();
    await this.journal.initialize();
  }

  /** Abort and settle every in-process child run before server shutdown. */
  async shutdown(): Promise<void> {
    await this.cancelActiveSessions();
  }

  private async cancelActiveSessions(): Promise<void> {
    const active = [...this.activeSessions.values()];
    for (const context of active) {
      context.controller.abort();
      if (context.currentRunId) {
        await this.cancelChildRun(context, context.currentRunId);
      }
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
    const supervisorAgentId =
      mode === "supervisor"
        ? await this.chooseSupervisorAgentId(
            participants,
            normalized.projectId,
            normalized.supervisorAgentId,
            true,
          )
        : undefined;
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
      ...(supervisorAgentId === undefined
        ? {}
        : { supervisorAgentId }),
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
    return this.journal.getSessionDetail(id);
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
    const accepted = await this.store.mutate((database) => {
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
        !participantsMatch(session.participants, current.participants) ||
        session.supervisorAgentId !== current.supervisorAgentId
      ) {
        throw lifecycleConflict("Orchestration draft changed; retry the start request");
      }
      session.originalPrompt = prepared.originalPrompt;
      session.participants = structuredClone(prepared.participants);
      if (prepared.supervisorAgentId === undefined) {
        delete session.supervisorAgentId;
      } else {
        session.supervisorAgentId = prepared.supervisorAgentId;
      }
      if (supervisorModel !== undefined) {
        const supervisorAgent = database.agents.find(
          (agent) => agent.id === session.supervisorAgentId,
        );
        if (
          !supervisorAgent ||
          !modelRefMatches(supervisorAgent.modelRef, supervisorModel.modelRef)
        ) {
          throw lifecycleConflict(
            "Supervisor Agent model assignment changed; retry the orchestration",
          );
        }
        session.supervisorModelRef = structuredClone(supervisorModel.modelRef);
        if (supervisorModel.catalogRevision === undefined) {
          delete session.supervisorModelCatalogRevision;
        } else {
          session.supervisorModelCatalogRevision = supervisorModel.catalogRevision;
        }
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
    });

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
    const accepted = await this.store.mutate((database) => {
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
      if (supervisorModel !== undefined) {
        const supervisorAgent = database.agents.find(
          (agent) => agent.id === session.supervisorAgentId,
        );
        if (
          !supervisorAgent ||
          !modelRefMatches(supervisorAgent.modelRef, supervisorModel.modelRef)
        ) {
          throw lifecycleConflict(
            "Supervisor Agent model assignment changed; retry the orchestration",
          );
        }
        session.supervisorModelRef = structuredClone(supervisorModel.modelRef);
        if (supervisorModel.catalogRevision === undefined) {
          delete session.supervisorModelCatalogRevision;
        } else {
          session.supervisorModelCatalogRevision = supervisorModel.catalogRevision;
        }
      }
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
    });

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
  async removeSessionsForProject(projectId: string): Promise<void> {
    await this.stopSessionsForProject(projectId);

    await this.store.mutate((database) => {
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
  async deleteSession(id: string): Promise<{ deleted: boolean }> {
    const current = this.findSession(id);
    if (statusIsActive(current.status) || this.activeSessions.has(id)) {
      throw lifecycleConflict("Stop the active orchestration before deleting it");
    }

    await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (statusIsActive(session.status) || this.activeSessions.has(id)) {
        throw lifecycleConflict("Stop the active orchestration before deleting it");
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

    active.controller.abort();
    const runId = active.currentRunId;
    if (runId) {
      await this.cancelChildRun(active, runId);
    }
    if (active.execution) {
      try {
        await active.execution;
      } catch {
        // runSession always attempts a terminal journal record.
      }
    }
    return (await this.getSession(id)).session;
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
  private async chooseSupervisorAgentId(
    participants: readonly OrchestrationParticipant[],
    projectId: string | null | undefined,
    explicitSupervisorAgentId?: string,
    required = false,
  ): Promise<string | undefined> {
    if (explicitSupervisorAgentId !== undefined) return explicitSupervisorAgentId;

    const database = this.store.snapshot();
    const rosterIds = [...participants]
      .sort((left, right) => left.position - right.position)
      .map((participant) => participant.agentId);
    const projectIds = projectId
      ? database.projectAgents
          .filter((attachment) => attachment.projectId === projectId)
          .sort((left, right) =>
            left.attachedAt.localeCompare(right.attachedAt) ||
            left.agentId.localeCompare(right.agentId),
          )
          .map((attachment) => attachment.agentId)
      : [];
    const candidates = [...new Set([...rosterIds, ...projectIds])];
    const agents = await this.listCurrentAgents();
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const known = candidates.filter((agentId) => byId.has(agentId));
    const selected =
      known.find((agentId) => byId.get(agentId)?.status === "ready") ?? known[0];
    if (selected !== undefined) return selected;
    if (required) {
      throw new HttpError(
        422,
        "A supervisor Agent is required for supervisor mode; add an Agent to the roster or Workspace",
      );
    }
    return undefined;
  }

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
    if (
      (prepared.mode ?? "sequential") === "supervisor" &&
      prepared.supervisorAgentId === undefined
    ) {
      prepared.supervisorAgentId = await this.chooseSupervisorAgentId(
        prepared.participants,
        prepared.projectId,
      );
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

  private async preflightRoster(session: OrchestrationSession): Promise<void> {
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
      this.assertAgentAvailable(agent, true);
    }
  }

  /**
   * Resolve the dedicated supervisor Agent once per accepted cycle. The
   * resolver is the model-catalog authority and must prove supervisor scope;
   * this service only carries its credential-free model snapshot forward.
   */
  private async preflightSupervisor(
    session: OrchestrationSession,
  ): Promise<SupervisorModelAssignment | undefined> {
    if ((session.mode ?? "sequential") !== "supervisor") return undefined;
    const supervisorAgentId = session.supervisorAgentId;
    if (supervisorAgentId === undefined) {
      throw new HttpError(
        422,
        "A supervisor Agent is required for supervisor mode",
      );
    }
    const agent = (await this.listCurrentAgents()).find(
      (candidate) => candidate.id === supervisorAgentId,
    );
    if (!agent) {
      throw new HttpError(
        422,
        "Supervisor Agent " + supervisorAgentId + " was not found",
      );
    }
    this.assertAgentAvailable(agent, true);
    if (!this.resolveSupervisorModel) {
      throw new HttpError(
        503,
        "Supervisor model resolution is not configured",
      );
    }
    const assignment = await this.resolveSupervisorModel(agent);
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

  private assertAgentAvailable(agent: Agent, preflight: boolean): void {
    if (agent.status === "ready") return;
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

  private async validateParticipant(participant: OrchestrationParticipant): Promise<void> {
    const agent = (await this.listCurrentAgents()).find(
      (candidate) => candidate.id === participant.agentId,
    );
    if (!agent) {
      throw new DispatchLifecycleError(
        "AGENT_NOT_FOUND",
        "Agent " + participant.agentId + " was not found",
      );
    }
    this.assertAgentAvailable(agent, false);
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
    } = {},
  ): void {
    let invoker: PlatformAgentInvokerContract;
    let selector: OrchestrationParticipantSelector | undefined;
    let orchestrator: Orchestrator;
    try {
      invoker = this.invokerFactory();
      const configuredSelector = this.selectorFactory();
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
      cycleIndex: cycle.cycleIndex ?? 0,
      ...(session.supervisorModelRef?.modelId === undefined
        ? {}
        : { supervisorModel: session.supervisorModelRef.modelId }),
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
    try {
      await context.invoker.cancel(runId);
    } catch {
      // The engine's abort path and persisted terminal record remain
      // authoritative even if child cleanup fails.
    }
  }

  private executionHooks(
    context: ActiveOrchestrationSession,
  ): OrchestrationExecutionHooks {
    const journalHooks = createOrchestrationExecutionHooks(context, {
      store: this.store,
      validateParticipant: (participant) => this.validateParticipant(participant),
      cancelChildRun: (runId) => this.cancelChildRun(context, runId),
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
        await this.finalizeStopped(context.id);
        span?.setStatus("ok");
        return;
      }

      const participantProfiles = await this.participantProfiles(session);

      const executionInput: OrchestrationExecutionInput = {
        sessionId: session.id,
        originalPrompt: context.cyclePrompt,
        participants: session.participants.map(safeParticipant),
        mode: session.mode ?? "sequential",
        maxSteps: session.maxSteps,
        // Each continuation is a fresh internal cycle. Persisted turn indexes
        // remain global through context.stepOffset in the lifecycle hooks.
        stepIndex: 0,
        lastRunId: null,
        lastOutput: null,
        turns: [],
        contextTurns: this.journal.contextTurns(session.id, session.maxSteps),
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
        perAgentTimeoutMs: session.perAgentTimeoutMs,
        ...(session.projectId ? { projectId: session.projectId } : {}),
        orchestrationId: session.id,
        signal: context.controller.signal,
        hooks: this.executionHooks(context),
      });
      await this.finalizeExecution(context, result);
      span?.setStatus("ok");
    } catch (error) {
      span?.setStatus("error");
      if (context.controller.signal.aborted) {
        await this.finalizeStopped(context.id);
      } else {
        await this.finalizeFailure(context.id, error);
      }
    } finally {
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
      if (roundRobinCeilingExceeded) {
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
        return this.terminalOutcome(session, "orchestration_completed", completedAt);
      }

      session.status = "failed";
      session.completionReason = null;
      session.errorCode = result.errorCode ?? "RUN_FAILED";
      session.errorMessage = this.executionErrorMessage(result.errorCode);
      session.completedAt = completedAt;
      session.currentParticipantId = null;
      session.currentRunId = null;
      session.updatedAt = completedAt;
      appendEvent(database, session, "orchestration_failed", {
        errorCode: session.errorCode,
        safeSummary: session.errorMessage,
      });
      return this.terminalOutcome(session, "orchestration_failed", completedAt);
    });
    await this.recordTerminal(context.id, outcome);
  }

  /**
   * Safe evidence about one terminal transition. Only the stable error code
   * travels here; the session's error message may quote runtime text.
   */
  private terminalOutcome(
    session: OrchestrationSession,
    type: "orchestration_completed" | "orchestration_failed" | "orchestration_stopped",
    completedAt: string,
  ): {
    type: "orchestration_completed" | "orchestration_failed" | "orchestration_stopped";
    durationMs: number;
    errorCode: string | null;
    stepIndex: number;
  } {
    const startedAt = session.startedAt ?? session.createdAt;
    return {
      type,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      errorCode: session.errorCode,
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
      default:
        return "Orchestration failed while running a participant";
    }
  }

  private async finalizeFailure(id: string, error: unknown): Promise<void> {
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
      return this.terminalOutcome(session, "orchestration_failed", completedAt);
    });
    await this.recordTerminal(id, outcome);
  }

  private async finalizeStopped(id: string): Promise<void> {
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
      return this.terminalOutcome(session, "orchestration_stopped", completedAt);
    });
    await this.recordTerminal(id, outcome);
  }
}

/** Retain the graph-builder seam for callers that want to inspect the graph. */
export { buildOrchestrationGraph } from "./graph.js";
