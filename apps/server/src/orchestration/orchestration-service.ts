import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { Agent, AgentRun, Message } from "../types.js";
import { JsonStore } from "../store.js";
import { redactSensitiveText } from "./handoff.js";
import {
  LangGraphOrchestrator,
  type LangGraphOrchestrationRunner,
} from "./langgraph-orchestrator.js";
import { MastraOrchestrator } from "./mastra/mastra-orchestrator.js";
import {
  ContinueOrchestrationSchema,
  CreateOrchestrationSchema,
  ORCHESTRATION_LIMITS,
  OrchestrationErrorCodeSchema,
} from "./schemas.js";
import {
  PlatformAgentInvoker,
  type PlatformAgentInvokerContract,
} from "./platform-agent-invoker.js";
import type {
  CreateOrchestrationInput,
  OrchestrationCompletionReason,
  OrchestrationContinuationPrompt,
  OrchestrationErrorCode,
  OrchestrationEvent,
  OrchestrationParticipant,
  OrchestrationSession,
  OrchestrationSessionDetail,
  OrchestrationTurn,
} from "./types.js";
import type {
  OrchestrationExecutionHooks,
  OrchestrationExecutionInput,
  OrchestrationExecutionOptions,
  OrchestrationExecutionResult,
  OrchestrationExecutionTurn,
  OrchestrationParticipantProfile,
  OrchestrationParticipantSelector,
  Orchestrator,
} from "./orchestrator.js";

const now = (): string => new Date().toISOString();

/** Maximum number of sessions returned by a default or bounded listing. */
export const DEFAULT_ORCHESTRATION_LIST_LIMIT = 100;

const terminalStatuses = new Set<OrchestrationSession["status"]>([
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);

const activeStatuses = new Set<OrchestrationSession["status"]>([
  "queued",
  "running",
  "stopping",
]);

/** Keep historical context within the workflow state/schema budget. */
const MAX_CONTEXT_TURNS = 8;

export interface OrchestrationAgentAccess {
  listAgents(): Agent[] | Promise<Agent[]>;
}

export type OrchestrationInvokerFactory =
  | PlatformAgentInvokerContract
  | (() => PlatformAgentInvokerContract);

export type OrchestrationSelectorFactory =
  | OrchestrationParticipantSelector
  | (() => OrchestrationParticipantSelector);

/**
 * Backward-compatible alias for callers that injected the former graph
 * runner. New callers should provide an Orchestrator instead.
 */
export type OrchestrationGraphRunner = LangGraphOrchestrationRunner;

export interface OrchestrationServiceDependencies {
  store: JsonStore;
  agents?: OrchestrationAgentAccess;
  /** Descriptive alias for callers wiring the concrete AgentService. */
  agentService?: OrchestrationAgentAccess;
  invoker?: PlatformAgentInvokerContract;
  invokerFactory?: () => PlatformAgentInvokerContract;
  /** Optional supervisor selector; omitted means deterministic defaults. */
  selectNextParticipant?: OrchestrationParticipantSelector;
  selectorFactory?: () => OrchestrationParticipantSelector;
  supervisorTimeoutMs?: number;
  orchestrator?: Orchestrator;
  orchestratorFactory?: () => Orchestrator;
  graphRunner?: OrchestrationGraphRunner;
}

interface ActiveSession {
  id: string;
  /** Prompt for this internal cycle; the persisted session task is immutable. */
  cyclePrompt: string;
  /** Number added to internal step indexes before persistence. */
  stepOffset: number;
  /** One-based continuation number; zero identifies the initial cycle. */
  cycleIndex: number;
  controller: AbortController;
  invoker: PlatformAgentInvokerContract;
  selector?: OrchestrationParticipantSelector;
  supervisorTimeoutMs: number | undefined;
  orchestrator: Orchestrator;
  currentRunId: string | null;
  cancellationRequestedRunId: string | null;
  execution: Promise<void> | null;
}

interface EventFields {
  participantId?: string;
  agentId?: string;
  runId?: string;
  durationMs?: number;
  safeSummary?: string;
  errorCode?: OrchestrationErrorCode;
  completionReason?: OrchestrationCompletionReason;
}

interface PlatformAgentServiceBridge extends OrchestrationAgentAccess {
  sendMessage: (
    agentId: string,
    content: string,
  ) => Promise<{ run: AgentRun; message: Message }>;
  waitForRun: (
    runId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<AgentRun>;
  cancelRun: (runId: string) => Promise<AgentRun>;
}

class DispatchLifecycleError extends Error {
  readonly orchestrationErrorCode: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode, message: string) {
    super(message);
    this.name = "DispatchLifecycleError";
    this.orchestrationErrorCode = code;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function boundedSafeText(
  value: unknown,
  maxLength: number,
  marker: string,
): string {
  const safe = redactSensitiveText(asText(value));
  if (safe.length <= maxLength) return safe;
  if (maxLength <= marker.length) return marker.slice(0, maxLength);
  return safe.slice(0, maxLength - marker.length - 1).trimEnd() + "\n" + marker;
}

function safeErrorMessage(error: unknown): string {
  return boundedSafeText(
    error instanceof Error ? error.message : error,
    ORCHESTRATION_LIMITS.maxErrorMessageLength,
    "[ERROR TRUNCATED]",
  );
}

function safeSummary(value: unknown): string {
  return boundedSafeText(
    value,
    ORCHESTRATION_LIMITS.maxSafeSummaryLength,
    "[SUMMARY TRUNCATED]",
  );
}

function safeInputSummary(value: unknown): string {
  return boundedSafeText(
    value,
    ORCHESTRATION_LIMITS.maxSafeInputSummaryLength,
    "[INPUT TRUNCATED]",
  );
}

function statusIsTerminal(status: OrchestrationSession["status"]): boolean {
  return terminalStatuses.has(status);
}

function statusIsActive(status: OrchestrationSession["status"]): boolean {
  return activeStatuses.has(status);
}

function eventStatus(status: OrchestrationSession["status"]): string {
  return boundedSafeText(status, ORCHESTRATION_LIMITS.maxEventStatusLength, "[STATUS]");
}

function safeParticipant(
  participant: OrchestrationParticipant,
): OrchestrationParticipant {
  return {
    ...participant,
    // Occurrence IDs are routing keys, not free-form text. Preserve their
    // opaque value so distinct IDs cannot collide after redaction/truncation.
    id: participant.id.trim(),
    role: boundedSafeText(
      participant.role.trim(),
      ORCHESTRATION_LIMITS.maxRoleLength,
      "[ROLE TRUNCATED]",
    ),
  };
}

function maxEventSequence(
  events: readonly OrchestrationEvent[],
  sessionId: string,
): number {
  let maximum = -1;
  for (const event of events) {
    if (event.sessionId === sessionId && event.sequence > maximum) {
      maximum = event.sequence;
    }
  }
  return maximum;
}

function appendEvent(
  database: Parameters<Parameters<JsonStore["mutate"]>[0]>[0],
  session: OrchestrationSession,
  type: OrchestrationEvent["type"],
  fields: EventFields = {},
): OrchestrationEvent {
  const existingCount = database.orchestrationEvents.filter(
    (event) => event.sessionId === session.id,
  ).length;
  if (existingCount >= ORCHESTRATION_LIMITS.maxEventsPerSession) {
    throw new Error("Orchestration event limit reached");
  }

  const event: OrchestrationEvent = {
    id: randomUUID(),
    sessionId: session.id,
    sequence: maxEventSequence(database.orchestrationEvents, session.id) + 1,
    type,
    status: eventStatus(session.status),
    createdAt: now(),
  };
  if (fields.participantId !== undefined) event.participantId = fields.participantId;
  if (fields.agentId !== undefined) event.agentId = fields.agentId;
  if (fields.runId !== undefined) event.runId = fields.runId;
  if (fields.durationMs !== undefined) event.durationMs = fields.durationMs;
  if (fields.safeSummary !== undefined) event.safeSummary = safeSummary(fields.safeSummary);
  if (fields.errorCode !== undefined) event.errorCode = fields.errorCode;
  if (fields.completionReason !== undefined) {
    event.completionReason = fields.completionReason;
  }
  database.orchestrationEvents.push(event);
  return event;
}

function cloneSession(session: OrchestrationSession): OrchestrationSession {
  const copy = structuredClone(session);
  copy.name = boundedSafeText(copy.name, ORCHESTRATION_LIMITS.maxNameLength, "[NAME TRUNCATED]");
  copy.originalPrompt = boundedSafeText(
    copy.originalPrompt,
    ORCHESTRATION_LIMITS.maxPromptLength,
    "[TASK TRUNCATED]",
  );
  copy.participants = copy.participants.map(safeParticipant);
  if (copy.errorMessage !== null) {
    copy.errorMessage = safeErrorMessage(copy.errorMessage);
  }
  return copy;
}

function cloneTurn(turn: OrchestrationTurn): OrchestrationTurn {
  const copy = structuredClone(turn);
  copy.safeInputSummary = safeInputSummary(copy.safeInputSummary);
  if (copy.safeOutput !== null) {
    copy.safeOutput = boundedSafeText(
      copy.safeOutput,
      ORCHESTRATION_LIMITS.maxSafeOutputLength,
      "[OUTPUT TRUNCATED]",
    );
  }
  return copy;
}

function cloneContinuationPrompt(
  prompt: OrchestrationContinuationPrompt,
): OrchestrationContinuationPrompt {
  const copy = structuredClone(prompt);
  copy.prompt = boundedSafeText(
    copy.prompt,
    ORCHESTRATION_LIMITS.maxPromptLength,
    "[PROMPT TRUNCATED]",
  );
  return copy;
}

function compareTurns(
  left: OrchestrationTurn,
  right: OrchestrationTurn,
): number {
  // New turns carry the globally monotonic execution step. Legacy turns do
  // not, so retain the old deterministic timestamp/position fallback.
  if (left.stepIndex !== undefined && right.stepIndex !== undefined) {
    const byStep = left.stepIndex - right.stepIndex;
    if (byStep !== 0) return byStep;
  }
  if (left.stepIndex !== undefined && right.stepIndex === undefined) return -1;
  if (left.stepIndex === undefined && right.stepIndex !== undefined) return 1;
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.position - right.position ||
    left.id.localeCompare(right.id)
  );
}

function cloneEvent(event: OrchestrationEvent): OrchestrationEvent {
  const copy = structuredClone(event);
  if (copy.safeSummary !== undefined) copy.safeSummary = safeSummary(copy.safeSummary);
  return copy;
}

function lifecycleConflict(message: string): HttpError {
  return new HttpError(409, message);
}

function normalizeConstructor(
  value: JsonStore | OrchestrationServiceDependencies,
  agents?: OrchestrationAgentAccess,
  invoker?: OrchestrationInvokerFactory,
  graphRunner?: OrchestrationGraphRunner,
): {
  store: JsonStore;
  agents: OrchestrationAgentAccess;
  invokerFactory: () => PlatformAgentInvokerContract;
  selectorFactory: () => OrchestrationParticipantSelector | undefined;
  supervisorTimeoutMs: number | undefined;
  orchestratorFactory: () => Orchestrator;
} {
  if (!(value instanceof JsonStore)) {
    const configured = value;
    const agentAccess = configured.agents ?? configured.agentService;
    if (!agentAccess) {
      throw new TypeError("OrchestrationService requires Agent access");
    }
    const factory = configured.invokerFactory
      ? configured.invokerFactory
      : configured.invoker
        ? () => configured.invoker as PlatformAgentInvokerContract
        : undefined;
    const orchestratorFactory = configured.orchestratorFactory
      ? configured.orchestratorFactory
      : configured.orchestrator
        ? () => configured.orchestrator as Orchestrator
        : configured.graphRunner
          ? () => new LangGraphOrchestrator(configured.graphRunner)
        : () => new MastraOrchestrator();
    const selectorFactory = configured.selectorFactory
      ? configured.selectorFactory
      : configured.selectNextParticipant
        ? () => configured.selectNextParticipant as OrchestrationParticipantSelector
        : () => undefined;
    return {
      store: configured.store,
      agents: agentAccess,
      invokerFactory:
        factory ?? (() => createPlatformInvoker(agentAccess)),
      selectorFactory,
      supervisorTimeoutMs: configured.supervisorTimeoutMs,
      orchestratorFactory,
    };
  }

  if (!agents) {
    throw new TypeError("OrchestrationService requires Agent access");
  }
  const factory =
    typeof invoker === "function"
      ? invoker
      : invoker
        ? () => invoker
        : () => createPlatformInvoker(agents);
  return {
    store: value,
    agents,
    invokerFactory: factory,
    selectorFactory: () => undefined,
    supervisorTimeoutMs: undefined,
    orchestratorFactory: graphRunner
      ? () => new LangGraphOrchestrator(graphRunner)
      : () => new MastraOrchestrator(),
  };
}

function createPlatformInvoker(
  agents: OrchestrationAgentAccess,
): PlatformAgentInvokerContract {
  const bridge = agents as unknown as PlatformAgentServiceBridge;
  if (
    typeof bridge.sendMessage !== "function" ||
    typeof bridge.waitForRun !== "function" ||
    typeof bridge.cancelRun !== "function"
  ) {
    throw new TypeError(
      "OrchestrationService requires an invoker or AgentService run methods",
    );
  }
  return new PlatformAgentInvoker(bridge);
}

/**
 * Owns orchestration lifecycle and persistence around the selected
 * orchestration engine. Engine state stays behind the repository-owned seam;
 * this module owns all Agent lookups, child Run cancellation, event journaling,
 * and recovery.
 */
export class OrchestrationService {
  private readonly store: JsonStore;
  private readonly agents: OrchestrationAgentAccess;
  private readonly invokerFactory: () => PlatformAgentInvokerContract;
  private readonly selectorFactory: () => OrchestrationParticipantSelector | undefined;
  private readonly supervisorTimeoutMs: number | undefined;
  private readonly orchestratorFactory: () => Orchestrator;
  private readonly activeSessions = new Map<string, ActiveSession>();

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
    const normalized = normalizeConstructor(value, agents, invoker, graphRunner);
    this.store = normalized.store;
    this.agents = normalized.agents;
    this.invokerFactory = normalized.invokerFactory;
    this.selectorFactory = normalized.selectorFactory;
    this.supervisorTimeoutMs = normalized.supervisorTimeoutMs;
    this.orchestratorFactory = normalized.orchestratorFactory;
  }

  async initialize(): Promise<void> {
    await this.cancelActiveSessions();

    await this.store.initialize();
    await this.store.mutate((database) => {
      const interruptedAt = now();
      for (const session of database.orchestrations) {
        if (!statusIsActive(session.status)) continue;
        session.status = "interrupted";
        session.currentParticipantId = null;
        session.currentRunId = null;
        session.completionReason = null;
        session.errorCode = "ORCHESTRATION_INTERRUPTED";
        session.errorMessage =
          "Orchestration was interrupted because the server restarted";
        session.completedAt = interruptedAt;
        session.updatedAt = interruptedAt;
        appendEvent(database, session, "orchestration_interrupted", {
          errorCode: "ORCHESTRATION_INTERRUPTED",
          safeSummary: session.errorMessage,
        });
      }
    });
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

    await this.store.mutate((database) => {
      database.orchestrations.push(session);
      appendEvent(database, session, "orchestration_created", {
        safeSummary: "Orchestration created",
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
    const database = this.store.snapshot();
    const session = database.orchestrations.find((item) => item.id === id);
    if (!session) throw new HttpError(404, "Orchestration not found");
    return {
      session: cloneSession(session),
      turns: database.orchestrationTurns
        .filter((turn) => turn.sessionId === id)
        .sort(compareTurns)
        .map(cloneTurn),
      events: database.orchestrationEvents
        .filter((event) => event.sessionId === id)
        .sort((left, right) => left.sequence - right.sequence)
        .map(cloneEvent),
      continuationPrompts: database.orchestrationContinuationPrompts
        .filter((prompt) => prompt.sessionId === id)
        .sort(
          (left, right) =>
            left.cycleIndex - right.cycleIndex ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        )
        .map(cloneContinuationPrompt),
    };
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
  private contextTurns(
    sessionId: string,
    maxSteps: number,
  ): OrchestrationExecutionTurn[] {
    const snapshot = this.store.snapshot();
    return snapshot.orchestrationTurns
      .filter(
        (turn) =>
          turn.sessionId === sessionId &&
          turn.status === "completed" &&
          turn.safeOutput !== null,
      )
      .sort(compareTurns)
      .slice(-Math.min(MAX_CONTEXT_TURNS, Math.max(0, maxSteps)))
      .map((turn) => {
        const safe = cloneTurn(turn);
        return {
          participantId: safe.participantId,
          agentId: safe.agentId,
          runId: safe.runId,
          position: safe.position,
          ...(safe.stepIndex === undefined ? {} : { stepIndex: safe.stepIndex }),
          output: safe.safeOutput ?? "",
          outputTruncated: safe.outputTruncated,
        };
      });
  }

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
    const context: ActiveSession = {
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

  private executionHooks(context: ActiveSession): OrchestrationExecutionHooks {
    return {
      onSupervisorDecision: async ({ action, participantId, stepIndex, reason }) => {
        if (context.controller.signal.aborted) {
          throw new DispatchLifecycleError(
            "ORCHESTRATION_STOPPED",
            "Orchestration stop requested",
          );
        }
        await this.store.mutate((database) => {
          const session = database.orchestrations.find(
            (item) => item.id === context.id,
          );
          if (!session) throw new HttpError(404, "Orchestration not found");
          if (statusIsTerminal(session.status)) return;
          if (session.status === "stopping" || context.controller.signal.aborted) {
            throw new DispatchLifecycleError(
              "ORCHESTRATION_STOPPED",
              "Orchestration stop requested",
            );
          }

          const participant = participantId
            ? session.participants.find((item) => item.id === participantId)
            : undefined;
          if (action === "invoke" && !participant) {
            throw new DispatchLifecycleError(
              "SUPERVISOR_INVALID_SELECTION",
              "Supervisor selected an unconfigured participant",
            );
          }
          session.updatedAt = now();
          appendEvent(database, session, "supervisor_decision", {
            ...(participant
              ? { participantId: participant.id, agentId: participant.agentId }
              : {}),
            ...(action === "complete"
              ? { completionReason: "supervisor_completed" }
              : {}),
            safeSummary:
              reason !== undefined && reason.trim().length > 0
                ? reason
                : action === "complete"
                  ? "Conversation completed at step " + String(stepIndex)
                  : (participant?.role ?? "Configured participant") +
                    " selected as next participant",
          });
        });
      },
      onBeforeDispatch: async ({ participant, prompt }) => {
        if (context.controller.signal.aborted) {
          throw new DispatchLifecycleError(
            "ORCHESTRATION_STOPPED",
            "Orchestration stop requested",
          );
        }
        await this.validateParticipant(participant);
        await this.store.mutate((database) => {
          const session = database.orchestrations.find((item) => item.id === context.id);
          if (!session) throw new HttpError(404, "Orchestration not found");
          if (session.status === "stopping" || context.controller.signal.aborted) {
            throw new DispatchLifecycleError(
              "ORCHESTRATION_STOPPED",
              "Orchestration stop requested",
            );
          }
          session.currentParticipantId = participant.id;
          session.updatedAt = now();
        });
        void prompt;
      },
      onHandoffApplied: async ({ participant, envelope }) => {
        await this.store.mutate((database) => {
          const session = database.orchestrations.find((item) => item.id === context.id);
          if (!session || statusIsTerminal(session.status)) return;
          session.updatedAt = now();
          appendEvent(database, session, "handoff_applied", {
            participantId: participant.id,
            agentId: participant.agentId,
            safeSummary:
              "Applied the previous participant result to " + participant.role,
          });
          void envelope;
        });
      },
      onRunAccepted: async ({ participant, prompt, runId, stepIndex }) => {
        // Set this before awaiting persistence so stopSession can cancel a Run
        // accepted in the same turn, even if its event write is still queued.
        context.currentRunId = runId;
        await this.store.mutate((database) => {
          const session = database.orchestrations.find((item) => item.id === context.id);
          if (!session) throw new HttpError(404, "Orchestration not found");
          if (statusIsTerminal(session.status)) return;
          const createdAt = now();
          session.currentParticipantId = participant.id;
          session.currentRunId = runId;
          session.updatedAt = createdAt;
          if (!database.orchestrationTurns.some((turn) => turn.runId === runId)) {
            database.orchestrationTurns.push({
              id: randomUUID(),
              sessionId: context.id,
              participantId: participant.id,
              agentId: participant.agentId,
              runId,
              position: participant.position,
              stepIndex: context.stepOffset + stepIndex,
              status: "dispatched",
              safeInputSummary: safeInputSummary(prompt),
              safeOutput: null,
              outputTruncated: false,
              errorCode: null,
              createdAt,
              completedAt: null,
            });
          }
          appendEvent(database, session, "participant_dispatched", {
            participantId: participant.id,
            agentId: participant.agentId,
            runId,
            safeSummary: "Participant dispatched at step " + String(stepIndex + 1),
          });
        });
        if (context.controller.signal.aborted) {
          await this.cancelChildRun(context, runId);
          throw new DispatchLifecycleError(
            "ORCHESTRATION_STOPPED",
            "Orchestration stop requested",
          );
        }
      },
      onRunCompleted: async ({
        participant,
        runId,
        envelope,
        stepIndex,
      }) => {
        context.currentRunId = null;
        await this.store.mutate((database) => {
          const session = database.orchestrations.find((item) => item.id === context.id);
          if (!session || statusIsTerminal(session.status)) return;
          const completedAt = now();
          const turn = database.orchestrationTurns.find(
            (candidate) => candidate.runId === runId && candidate.sessionId === context.id,
          );
          if (turn && turn.status === "dispatched") {
            turn.status = "completed";
            turn.safeOutput = boundedSafeText(
              envelope.content,
              ORCHESTRATION_LIMITS.maxSafeOutputLength,
              "[OUTPUT TRUNCATED]",
            );
            turn.outputTruncated = envelope.truncated;
            turn.completedAt = completedAt;
          }
          session.currentParticipantId = null;
          session.currentRunId = null;
          session.stepIndex = Math.max(
            session.stepIndex,
            context.stepOffset + stepIndex + 1,
          );
          session.updatedAt = completedAt;
          const fields: EventFields = {
            participantId: participant.id,
            agentId: participant.agentId,
            runId,
            safeSummary: "Participant completed",
          };
          if (turn?.createdAt) {
            fields.durationMs = Math.max(
              0,
              Date.parse(completedAt) - Date.parse(turn.createdAt),
            );
          }
          appendEvent(database, session, "run_completed", fields);
        });
      },
      onParticipantFailed: async ({
        participant,
        runId,
        error,
        errorCode,
      }) => {
        if (runId === null || context.currentRunId === runId) {
          context.currentRunId = null;
        }
        await this.store.mutate((database) => {
          const session = database.orchestrations.find((item) => item.id === context.id);
          if (!session || statusIsTerminal(session.status)) return;
          const failedAt = now();
          const turn = runId
            ? database.orchestrationTurns.find(
                (candidate) =>
                  candidate.runId === runId && candidate.sessionId === context.id,
              )
            : undefined;
          if (turn && turn.status === "dispatched") {
            turn.status =
              errorCode === "RUN_TIMED_OUT"
                ? "timed_out"
                : errorCode === "ORCHESTRATION_STOPPED" ||
                    errorCode === "RUN_CANCELLED"
                  ? "cancelled"
                  : "failed";
            turn.errorCode = errorCode;
            turn.completedAt = failedAt;
          }
          session.currentParticipantId = null;
          session.currentRunId = null;
          session.errorCode = errorCode;
          session.errorMessage = safeErrorMessage(error);
          session.updatedAt = failedAt;
          if (
            runId !== null &&
            (errorCode === "ORCHESTRATION_STOPPED" || errorCode === "RUN_CANCELLED")
          ) {
            appendEvent(database, session, "child_run_cancelled", {
              participantId: participant.id,
              agentId: participant.agentId,
              runId,
              safeSummary: "Accepted child Run was cancelled",
              errorCode,
            });
          }
          appendEvent(database, session, "participant_failed", {
            participantId: participant.id,
            agentId: participant.agentId,
            ...(runId === null ? {} : { runId }),
            safeSummary: safeErrorMessage(error),
            errorCode,
          });
        });
      },
    };
  }

  private async cancelChildRun(
    context: ActiveSession,
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

  private async runSession(context: ActiveSession): Promise<void> {
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
        contextTurns: this.contextTurns(session.id, session.maxSteps),
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
        signal: context.controller.signal,
        hooks: this.executionHooks(context),
      });
      await this.finalizeExecution(context, result);
    } catch (error) {
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
    context: ActiveSession,
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
        const completionEventFields: EventFields = {
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
