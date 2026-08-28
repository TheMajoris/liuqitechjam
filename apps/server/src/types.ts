export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/** Fixed pipeline roles. A Project assigns one distinct Agent to each. */
export type OrchestrationStage = "planner" | "builder" | "reviewer";

/**
 * Additive correlation fields. Present only on records produced by an
 * orchestration; direct Playground records leave them undefined.
 */
export interface Correlation {
  projectId?: string;
  orchestrationId?: string;
  traceId?: string;
  stage?: OrchestrationStage;
  attempt?: number;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message extends Correlation {
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

export interface AgentRun extends Correlation {
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

// --- v2 domain records -----------------------------------------------------

export interface ProjectRoles {
  plannerAgentId: string;
  builderAgentId: string;
  reviewerAgentId: string;
}

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  name: string;
  description: string;
  workspacePath: string;
  roles: ProjectRoles;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export type OrchestrationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type StageStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface StageState {
  stage: OrchestrationStage;
  status: StageStatus;
  runId: string | null;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface OrchestrationRecord {
  id: string;
  projectId: string;
  prompt: string;
  providerId: string;
  status: OrchestrationStatus;
  traceId: string;
  sequence: number;
  idempotencyKey: string | null;
  stages: StageState[];
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type QueueJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface QueueJob {
  id: string;
  orchestrationId: string;
  stage: OrchestrationStage;
  sequence: number;
  status: QueueJobStatus;
  attempt: number;
  runId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export type HandoffSender = OrchestrationStage | "user";
export type HandoffContentType = "task" | "plan" | "build-summary" | "review";

export interface HandoffMessage {
  id: string;
  orchestrationId: string;
  projectId: string;
  traceId: string;
  fromStage: HandoffSender;
  toStage: OrchestrationStage;
  fromAgentId: string | null;
  toAgentId: string | null;
  contentType: HandoffContentType;
  content: string;
  createdAt: string;
}

export type SpanKind =
  | "orchestration"
  | "queue.wait"
  | "stage.planner"
  | "stage.builder"
  | "stage.reviewer"
  | "runtime.launch"
  | "runtime.execute"
  | "runtime.cleanup"
  | "gateway.lease"
  | "gateway.request"
  | "gateway.revoke"
  | "provider.responses"
  | "security.deny"
  | "security.kill";

export type SpanStatus = "ok" | "error" | "in_progress";

export interface TelemetryRecord extends Correlation {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  runId?: string;
  agentId?: string;
  code?: string;
  preview?: string;
  usage?: RunUsage;
  /** Monotonic per-record ordinal, assigned on append. */
  sequence: number;
}

// --- persistence ---------------------------------------------------------

/** Legacy on-disk shape. Read-only: only the migrator consumes it. */
export interface DatabaseV1 {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface DatabaseV2 {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  projects: Project[];
  orchestrations: OrchestrationRecord[];
  queueJobs: QueueJob[];
  handoffMessages: HandoffMessage[];
  telemetry: TelemetryRecord[];
  nextQueueSequence: number;
}

/** Current database shape. */
export type Database = DatabaseV2;

export const ORCHESTRATION_STAGES: readonly OrchestrationStage[] = [
  "planner",
  "builder",
  "reviewer",
];

export const TERMINAL_ORCHESTRATION_STATUSES: readonly OrchestrationStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export const CURRENT_DB_VERSION = 2 as const;

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

/**
 * Ephemeral gateway wiring for one secretless Runtime turn. Carries an opaque
 * run lease and the gateway address — never a provider credential.
 */
export interface GatewayRuntimeContext {
  /** Data-plane base URL the Runtime uses to reach the gateway. */
  gatewayUrl: string;
  /** Opaque run lease, presented by Codex as `Authorization: Bearer`. */
  leaseToken: string;
  providerId: string;
  model: string;
  /** Per-run sanitized CODEX_HOME whose config.toml points at the gateway. */
  codexHome: string;
}

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /** Optional correlation id for gateway lease scoping and telemetry. */
  runId?: string;
  /** Per-run sandbox override. Falls back to the configured default. */
  sandboxMode?: SandboxMode;
  /** Present only on the secretless container path. */
  gateway?: GatewayRuntimeContext;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
