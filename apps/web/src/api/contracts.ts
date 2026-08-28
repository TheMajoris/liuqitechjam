// Transport DTOs for the control-plane HTTP surface.
// The web app owns these shapes; it never imports server persistence types.

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type OrchestrationStage = "planner" | "builder" | "reviewer";

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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface Run extends Correlation {
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

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

// --- projects ------------------------------------------------------------

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

// --- providers ---------------------------------------------------------

export interface Provider {
  id: string;
  protocol: "responses";
  models: string[];
  credentialMode: "gateway-managed";
  health: "ok" | "degraded" | "unknown";
  live: boolean;
}

// --- orchestrations --------------------------------------------------

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

export interface Orchestration {
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

export type HandoffSender = OrchestrationStage | "user";
export type HandoffContentType = "task" | "plan" | "build-summary" | "review";

export interface Handoff {
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

export interface OrchestrationView {
  orchestration: Orchestration;
  queuePosition: number | null;
  messages: Handoff[];
}

export interface OrchestrationPage {
  items: Orchestration[];
  nextCursor: string | null;
}

// --- runs / observability --------------------------------------------

export type SpanStatus = "ok" | "error" | "in_progress";

export interface Span {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: string;
  name: string;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  runId?: string;
  agentId?: string;
  orchestrationId?: string;
  stage?: OrchestrationStage;
  attempt?: number;
  code?: string;
  preview?: string;
  usage?: RunUsage;
  sequence: number;
}

export interface RunObservability {
  runId: string;
  spans: Span[];
  usage: RunUsage;
  counts: { total: number; errors: number; denied: number };
  truncated: boolean;
}

export interface RunsPage {
  items: Run[];
  nextCursor: string | null;
}

// --- security --------------------------------------------------------

export interface SecurityControl {
  id: string;
  label: string;
  active: boolean;
}

export interface SecurityEvent {
  at: string;
  kind: string;
  status: SpanStatus;
  code: string | null;
  runId: string | null;
  orchestrationId: string | null;
}

export interface SecurityPosture {
  protectedAsset: string;
  track: string;
  profile: string;
  controls: SecurityControl[];
  gateway: { mode: string; url: string | null };
  recentEvents: SecurityEvent[];
}
