import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { Agent } from "../types.js";
import { JsonStore } from "../store.js";
import {
  ContinueOrchestrationSchema,
  CreateOrchestrationSchema,
  ORCHESTRATION_LIMITS,
  OrchestrationErrorCodeSchema,
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
} from "./orchestration-runtime.js";

export type {
  OrchestrationAgentAccess,
  OrchestrationGraphRunner,
  OrchestrationInvokerFactory,
  OrchestrationProjectBinding,
  OrchestrationServiceDependencies,
} from "./orchestration-runtime.js";

/** Maximum number of sessions returned by a default or bounded listing. */
export const DEFAULT_ORCHESTRATION_LIST_LIMIT = 100;
function lifecycleConflict(message: string): HttpError {
  return new HttpError(409, message);
}

/**
 * Owns orchestration lifecycle and persistence around the selected
 * orchestration engine. Engine state stays behind the repository-owned seam;
 * this module owns all Agent lookups, child Run cancellation, event journaling,
 * and recovery.
 */
export class OrchestrationService {
  private readonly store: JsonStore;
  private readonly journal: OrchestrationJournal;
  private readonly agents: OrchestrationAgentAccess;
  private readonly invokerFactory: () => PlatformAgentInvokerContract;
  private readonly selectorFactory: () => OrchestrationParticipantSelector | undefined;
  private readonly supervisorTimeoutMs: number | undefined;
  private readonly orchestratorFactory: () => Orchestrator;
  private readonly projectBinding: OrchestrationProjectBinding | undefined;
  private telemetry: RuntimeTelemetry | undefined;
  private readonly activeSessions = new Map<string, ActiveOrchestrationSession>();

  constructor(dependencies: OrchestrationServiceDependencies);
  constructor(
    store: JsonStore,
    agents: OrchestrationAgentAccess,
    invoker?: OrchestrationInvokerFactory,
    graphRunner?: OrchestrationGraphRunner,
  );
  constructor(
    value: JsonStore | OrchestrationServiceDependencies,
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
    this.supervisorTimeoutMs = normalized.supervisorTimeoutMs;
    this.orchestratorFactory = normalized.orchestratorFactory;
    this.projectBinding = normalized.projectBinding;
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
      mode: normalized.mode ?? "sequential",
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
    return this.store
      .snapshot()
      .orchestrations.sort((left, right) => {
        const updated = right.updatedAt.localeCompare(left.updatedAt);
        return updated || right.createdAt.localeCompare(left.createdAt);
      })
      .slice(0, boundedLimit)
      .map(cloneSession);
  }

  async getSession(id: string): Promise<OrchestrationSessionDetail> {
    return this.journal.getSessionDetail(id);
  }

  async startSession(id: string): Promise<OrchestrationSession> {
    const current = this.findSession(id);
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

    await this.preflightRoster(current);
    const accepted = await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (session.status !== "draft") {
        throw lifecycleConflict("Orchestration is already active");
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
    const normalizedPrompt = boundedSafeText(
      parsed.data.prompt.trim(),
      ORCHESTRATION_LIMITS.maxPromptLength,
      "[PROMPT TRUNCATED]",
    );
    const accepted = await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session) throw new HttpError(404, "Orchestration not found");
      if (!statusIsTerminal(session.status)) {
        throw lifecycleConflict(
          session.status === "draft"
            ? "Draft orchestrations cannot be continued"
            : "Stop the active orchestration before continuing it",
        );
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

    this.launch(accepted.session, {
      cyclePrompt: accepted.prompt,
      cycleIndex: accepted.cycleIndex,
      stepOffset: accepted.stepOffset,
    });
    return cloneSession(accepted.session);
  }

  /**
   * Remove every conversation owned by one Project from active APIs.
   *
   * Active child runs are stopped first. The final mutation removes only the
   * orchestration records and leaves the Project/files for ProjectService to
   * archive. This is the Workspace-level counterpart to `deleteSession`.
   */
  async removeSessionsForProject(projectId: string): Promise<void> {
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
      // for it before the deletion mutation so no runner can write a child
      // record after it has been removed from the store.
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
          throw lifecycleConflict("Stop the active orchestration before archiving its Workspace");
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
      selector = this.selectorFactory();
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
      controller: new AbortController(),
      invoker,
      ...(selector === undefined ? {} : { selector }),
      supervisorTimeoutMs: this.supervisorTimeoutMs,
      orchestrator,
      currentRunId: null,
      cancellationRequestedRunId: null,
      execution: null,
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
    return createOrchestrationExecutionHooks(context, {
      store: this.store,
      validateParticipant: (participant) => this.validateParticipant(participant),
      cancelChildRun: (runId) => this.cancelChildRun(context, runId),
    });
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
    await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === context.id);
      if (!session || statusIsTerminal(session.status)) return;
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
        return;
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
        return;
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
    });
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
    await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session || statusIsTerminal(session.status)) return;
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
    });
  }

  private async finalizeStopped(id: string): Promise<void> {
    await this.store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === id);
      if (!session || statusIsTerminal(session.status)) return;
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
    });
  }
}

/** Retain the graph-builder seam for callers that want to inspect the graph. */
export { buildOrchestrationGraph } from "./graph.js";
