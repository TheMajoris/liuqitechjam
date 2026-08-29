import type {
  OrchestrationContinuationPrompt,
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationTurn,
} from "./orchestration/types.js";
import type { ModelRef, WorkerRuntimeModelConfig } from "./models/types.js";
import type { PreviewRecord } from "./preview/preview-types.js";
import type {
  Project,
  ProjectAgentAttachment,
  ProjectWriteLease,
} from "./projects/project-types.js";

export type { ModelRef, WorkerRuntimeModelConfig } from "./models/types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  /** Omitted on legacy records; those resolve to the configured default. */
  modelRef?: ModelRef;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a message came from.
 *
 * `direct` is a person talking to this Agent in the Playground. `orchestration`
 * is a Team turn: it is persisted for audit and continuity, but the Playground
 * never shows it, because the user never wrote it. Absent on legacy records,
 * which are all direct.
 */
export type MessageOrigin = "direct" | "orchestration";

/**
 * One private conversation with an Agent.
 *
 * Conversations are the unit of Codex session continuity for direct work: each
 * owns its own resumable thread so two conversations never resume each other.
 * They deliberately share the Agent's single private workspace, so files
 * created in one conversation are visible from the next.
 */
export interface AgentConversation {
  id: string;
  agentId: string;
  title: string;
  /** Resumable Codex thread for this conversation only. */
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  /** Omitted on records persisted before Team turns were distinguished. */
  origin?: MessageOrigin | undefined;
  /** Set on direct messages only; Team turns never belong to a conversation. */
  conversationId?: string | undefined;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  /** Set on direct runs only, mirroring the message that started them. */
  conversationId?: string | undefined;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  /** Additive Wave 7.2 collection; absent in pre-conversation stores. */
  agentConversations: AgentConversation[];
  messages: Message[];
  runs: AgentRun[];
  orchestrations: OrchestrationSession[];
  orchestrationTurns: OrchestrationTurn[];
  orchestrationEvents: OrchestrationEvent[];
  orchestrationContinuationPrompts: OrchestrationContinuationPrompt[];
  /** Additive Wave 7 collection; absent in legacy v1 stores. */
  previews: PreviewRecord[];
  /** Additive Wave 7.1 collections; absent in pre-Project stores. */
  projects: Project[];
  projectAgents: ProjectAgentAttachment[];
  projectLeases: ProjectWriteLease[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  modelRef?: ModelRef | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  modelRef?: ModelRef | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  /** Set when the run executes against a shared Project workspace. */
  projectId?: string | undefined;
  prompt: string;
  threadId: string | null;
  /** Resolved worker settings; never contains credentials. */
  model?: WorkerRuntimeModelConfig;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
