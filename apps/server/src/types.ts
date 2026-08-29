import type {
  OrchestrationContinuationPrompt,
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationTurn,
} from "./orchestration/types.js";
import type { ModelRef, WorkerRuntimeModelConfig } from "./models/types.js";
import type { PreviewRecord } from "./preview/preview-types.js";

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

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
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
  messages: Message[];
  runs: AgentRun[];
  orchestrations: OrchestrationSession[];
  orchestrationTurns: OrchestrationTurn[];
  orchestrationEvents: OrchestrationEvent[];
  orchestrationContinuationPrompts: OrchestrationContinuationPrompt[];
  /** Additive Wave 7 collection; absent in legacy v1 stores. */
  previews: PreviewRecord[];
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
