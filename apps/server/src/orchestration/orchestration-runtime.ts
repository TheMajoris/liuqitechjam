import type { Agent, AgentRun, Message } from "../types.js";
import type { ModelRef } from "../models/types.js";
import type { AuditRecorder, AuditSpan } from "../audit/audit-types.js";
import { JsonStore } from "../store.js";
import {
  LangGraphOrchestrator,
  type LangGraphOrchestrationRunner,
} from "./langgraph-orchestrator.js";
import { MastraOrchestrator } from "./mastra/mastra-orchestrator.js";
import {
  PlatformAgentInvoker,
  type PlatformAgentInvokerContract,
} from "./platform-agent-invoker.js";
import type {
  OrchestrationParticipantSelector,
  Orchestrator,
} from "./orchestrator.js";

export interface OrchestrationAgentAccess {
  listAgents(): Agent[] | Promise<Agent[]>;
}

/**
 * Server-owned proof that one Agent model is valid for supervisor routing.
 * The resolver is responsible for checking the live model catalog/scope; the
 * orchestration service only persists this credential-free snapshot.
 */
export interface SupervisorModelAssignment {
  modelRef: ModelRef;
  modelId: string;
  catalogRevision?: string | number | undefined;
}

export type OrchestrationSupervisorModelResolver = (
  agent: Agent,
) => SupervisorModelAssignment | Promise<SupervisorModelAssignment>;

export type OrchestrationInvokerFactory =
  | PlatformAgentInvokerContract
  | (() => PlatformAgentInvokerContract);

export type OrchestrationSelectorFactory =
  | OrchestrationParticipantSelector
  | (() => OrchestrationParticipantSelector);

/** Backward-compatible alias for callers that injected the former graph runner. */
export type OrchestrationGraphRunner = LangGraphOrchestrationRunner;

/** The Project association seam used by shared Team workspaces. */
export interface OrchestrationProjectBinding {
  /** Preferred binding path: one Project may own many conversations. */
  bindConversation?(
    projectId: string,
    conversationId: string,
    agentIds: string[],
  ): Promise<void>;
  /** Legacy alias retained for callers created before Workspace support. */
  bindTeam?(projectId: string, teamId: string, agentIds: string[]): Promise<void>;
  /**
   * Legacy lifecycle hook retained for source compatibility. Conversation
   * deletion no longer invokes it; Workspace archive owns Project lifecycle.
   *
   * @deprecated use ProjectService's Workspace archive lifecycle instead.
   */
  archiveProject?(projectId: string): Promise<void>;
}

export interface OrchestrationServiceDependencies {
  store: JsonStore;
  /** Required only for Teams that collaborate on a shared Project. */
  projectBinding?: OrchestrationProjectBinding;
  agents?: OrchestrationAgentAccess;
  /** Descriptive alias for callers wiring the concrete AgentService. */
  agentService?: OrchestrationAgentAccess;
  invoker?: PlatformAgentInvokerContract;
  invokerFactory?: () => PlatformAgentInvokerContract;
  /** Optional supervisor selector; omitted means deterministic defaults. */
  selectNextParticipant?: OrchestrationParticipantSelector;
  selectorFactory?: () => OrchestrationParticipantSelector;
  /** Resolves an Agent's explicit model against the supervisor model scope. */
  resolveSupervisorModel?: OrchestrationSupervisorModelResolver;
  supervisorTimeoutMs?: number;
  orchestrator?: Orchestrator;
  orchestratorFactory?: () => Orchestrator;
  graphRunner?: OrchestrationGraphRunner;
  /** Server-owned audit sink for orchestration lifecycle spans. */
  audit?: AuditRecorder;
}

/** Runtime state for one queued or running orchestration cycle. */
export interface ActiveOrchestrationSession {
  id: string;
  /** Prompt for this internal cycle; the persisted session task is immutable. */
  cyclePrompt: string;
  /** Number added to internal step indexes before persistence. */
  stepOffset: number;
  /** One-based continuation number; zero identifies the initial cycle. */
  cycleIndex: number;
  /** Runtime-only model selected from the session's supervisor Agent. */
  supervisorModel?: string | undefined;
  controller: AbortController;
  invoker: PlatformAgentInvokerContract;
  selector?: OrchestrationParticipantSelector;
  supervisorTimeoutMs: number | undefined;
  orchestrator: Orchestrator;
  currentRunId: string | null;
  cancellationRequestedRunId: string | null;
  execution: Promise<void> | null;
  /** Audit span of the participant currently being dispatched. */
  participantSpan?: AuditSpan | null;
}

interface PlatformAgentServiceBridge extends OrchestrationAgentAccess {
  sendMessage(
    agentId: string,
    content: string,
  ): Promise<{ run: AgentRun; message: Message }>;
  waitForRun(
    runId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<AgentRun>;
  cancelRun(runId: string): Promise<AgentRun>;
}

export interface NormalizedOrchestrationDependencies {
  store: JsonStore;
  agents: OrchestrationAgentAccess;
  invokerFactory: () => PlatformAgentInvokerContract;
  selectorFactory: () => OrchestrationParticipantSelector | undefined;
  resolveSupervisorModel: OrchestrationSupervisorModelResolver | undefined;
  supervisorTimeoutMs: number | undefined;
  orchestratorFactory: () => Orchestrator;
  projectBinding: OrchestrationProjectBinding | undefined;
  audit: AuditRecorder | undefined;
}

/**
 * Resolve both supported constructor forms in one place. Keeping this
 * compatibility logic outside the lifecycle module makes the public service
 * small without changing the legacy injection seam.
 */
export function normalizeOrchestrationDependencies(
  value: JsonStore | OrchestrationServiceDependencies,
  agents?: OrchestrationAgentAccess,
  invoker?: OrchestrationInvokerFactory,
  graphRunner?: OrchestrationGraphRunner,
): NormalizedOrchestrationDependencies {
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
      invokerFactory: factory ?? (() => createPlatformInvoker(agentAccess)),
      selectorFactory,
      resolveSupervisorModel: configured.resolveSupervisorModel,
      supervisorTimeoutMs: configured.supervisorTimeoutMs,
      orchestratorFactory,
      projectBinding: configured.projectBinding,
      audit: configured.audit,
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
    resolveSupervisorModel: undefined,
    supervisorTimeoutMs: undefined,
    orchestratorFactory: graphRunner
      ? () => new LangGraphOrchestrator(graphRunner)
      : () => new MastraOrchestrator(),
    projectBinding: undefined,
    audit: undefined,
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
