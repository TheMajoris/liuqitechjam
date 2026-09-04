export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type PreviewStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "interrupted";

export type PreviewErrorCode =
  | "PREVIEW_NOT_FOUND"
  | "PREVIEW_ALREADY_RUNNING"
  | "PREVIEW_NOT_RUNNING"
  | "PREVIEW_START_FAILED"
  | "PREVIEW_STOP_FAILED"
  | "PREVIEW_RUNTIME_UNAVAILABLE"
  | "PREVIEW_UNSUPPORTED_PROJECT"
  | "PREVIEW_COMMAND_NOT_FOUND"
  | "PREVIEW_PORT_ALLOCATION_FAILED"
  | "PREVIEW_WORKSPACE_INVALID"
  | "PREVIEW_LOGS_FAILED"
  | "PREVIEW_INTERRUPTED"
  | "PREVIEW_PERMISSION_DENIED";

export interface Preview {
  id: string;
  /** Exactly one of these is set, mirroring the preview's owner. */
  agentId: string | null;
  projectId: string | null;
  status: PreviewStatus;
  host: "127.0.0.1";
  hostPort: number | null;
  url: string | null;
  errorCode: PreviewErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  updatedAt: string;
}

/** Normalized reasoning values shared by the model catalog and Agent forms. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Runtime scope used when listing the Ark model catalog. */
export type ModelScope = "worker" | "supervisor";

export interface ModelRef {
  providerId: string;
  modelId: string;
  reasoning?: {
    effort?: ReasoningEffort;
  };
}

export interface ModelCapabilities {
  scopes: Array<"worker" | "supervisor">;
  reasoning: boolean;
  reasoningEfforts?: ReasoningEffort[];
}

export interface ModelDescriptor {
  id: string;
  label: string;
  providerId: string;
  capabilities: ModelCapabilities;
}

export interface ModelProviderCapabilities {
  worker: boolean;
  supervisor: boolean;
  dynamicModelListing: boolean;
}

export interface ModelProviderDescriptor {
  id: string;
  label: string;
  capabilities: ModelProviderCapabilities;
}

/** The provider catalog response never contains credentials or raw errors. */
export interface ModelProvidersResponse {
  providers: ModelProviderDescriptor[];
  defaultModelRef: ModelRef | null;
}

export interface ProviderModelsResponse {
  models: ModelDescriptor[];
}

/**
 * Operator-facing projection of the Ark model catalog. The provider/model
 * listing endpoints remain the source of truth for individual descriptors;
 * the optional aggregate fields let an operator settings surface render a
 * single response when the control plane supports it.
 */
export interface ModelCatalogResponse extends ModelProvidersResponse {
  models?: ModelDescriptor[];
  modelsByProvider?: Record<string, ModelDescriptor[]>;
  revision?: number;
}

/** Atomic operator catalog update. Credentials are never part of this shape. */
export interface ModelCatalogUpdate {
  defaultModelRef: ModelRef | null;
  modelIds: string[];
  revision?: number;
}

export type AgentAccessory = "none" | "glasses" | "headset" | "cap";

/** Cosmetic character choices for the 2D workspace. Never an authorization input. */
export interface AgentAppearance {
  hue?: number;
  hair?: number;
  skin?: number;
  accessory?: AgentAccessory;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  /** Omitted until someone customizes this Agent's character. */
  appearance?: AgentAppearance;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  skillIds?: string[];
  /** Optional Agent-wide role; Workspace memberships may override it. */
  globalRoleId?: string | null;
  /** Omitted on legacy persisted Agents, which use the runtime default. */
  modelRef?: ModelRef;
  /** Ordered fallback models attempted after the primary model fails. */
  fallbackModelRefs?: ModelRef[];
  createdAt: string;
  updatedAt: string;
}

export type ApprovalKind = "operation_approval" | "access_request";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed"
  | "revoked"
  | "unknown";

/**
 * Safe projection of one Permit approval. Permit owns the decision; this
 * record only mirrors it so the UI can show and act on what already exists.
 */
export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  scope: "once" | "project";
  agentId: string;
  projectId: string | null;
  runId: string | null;
  toolId: string;
  safeSummary: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
}

export type ToolRisk = "read" | "write" | "network" | "external_write" | "high_cost";
export type ToolAvailability = "available" | "approval_required" | "denied";

export interface ToolMetadata {
  id: string;
  title: string;
  description: string;
  risk: ToolRisk;
  requiredPermission: string;
}

export interface CapabilityGrantView {
  id: string;
  scope: "once" | "project";
  usesRemaining: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ToolCapabilityView {
  tool: ToolMetadata;
  availability: ToolAvailability;
  reason: string;
  grant: CapabilityGrantView | null;
}

export interface AgentCapabilities {
  agentId: string;
  projectId: string | null;
  tools: ToolCapabilityView[];
}

export type SkillSource = "built-in" | "user" | "installed";

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  requiredToolIds: string[];
  capabilityTags: string[];
  source: SkillSource;
  version: string;
}

export interface SkillCatalogEntry extends SkillMetadata {
  installed: boolean;
  installable: boolean;
}

/** A bounded web candidate returned by the backend discovery adapter. */
export interface SkillDiscoveryResult {
  title: string;
  url: string;
  /** Derived by the client when the provider only returns title/url/description. */
  domain?: string;
  description: string;
}

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  toolIds: string[];
  permissionIds: string[];
  source: "system" | "user";
  createdAt: string;
  updatedAt: string;
  assignedAgentCount: number;
  assignedProjectCount: number;
}

export interface SkillToolCapability {
  tool: ToolMetadata | null;
  toolId: string;
  availability: ToolAvailability;
  reason: string;
  grant: CapabilityGrantView | null;
}

export interface AssignedSkill extends SkillMetadata {
  instructions: string;
  capabilities: SkillToolCapability[];
}

export interface AgentSkills {
  agentId: string;
  projectId: string | null;
  skillIds: string[];
  skills: AssignedSkill[];
}

/** One private conversation with an Agent; each owns its own Codex session. */
export interface AgentConversation {
  id: string;
  agentId: string;
  title: string;
  codexThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  /** Set on direct messages; Team turns never belong to a conversation. */
  conversationId?: string | null;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export type OrchestrationStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "interrupted";

export type OrchestrationActiveStatus = "queued" | "running" | "stopping";

export type OrchestrationTerminalStatus =
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type OrchestrationTurnStatus =
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type OrchestrationMode = "supervisor" | "sequential" | "round_robin";

export type OrchestrationCompletionReason =
  | "roster_exhausted"
  | "supervisor_completed";

export type OrchestrationEventType =
  | "orchestration_created"
  | "orchestration_started"
  | "orchestration_continued"
  | "supervisor_decision"
  | "participant_dispatched"
  | "run_completed"
  | "handoff_applied"
  | "participant_failed"
  | "stop_requested"
  | "child_run_cancelled"
  | "orchestration_stopped"
  | "orchestration_failed"
  | "orchestration_interrupted"
  | "orchestration_completed";

export type OrchestrationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_LIFECYCLE"
  | "SESSION_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_UNAVAILABLE"
  | "AGENT_BUSY"
  | "AGENT_STOPPED"
  | "RUN_NOT_FOUND"
  | "RUN_FAILED"
  | "RUN_CANCELLED"
  | "RUN_TIMED_OUT"
  | "INVALID_OUTPUT"
  | "MAX_STEPS_EXCEEDED"
  | "ORCHESTRATION_STOPPED"
  | "ORCHESTRATION_INTERRUPTED"
  | "SUPERVISOR_INVALID_RESPONSE"
  | "SUPERVISOR_INVALID_SELECTION"
  | "SUPERVISOR_FAILED"
  | "SUPERVISOR_TIMED_OUT"
  | "SUPERVISOR_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface OrchestrationParticipant {
  id: string;
  agentId: string;
  role: string;
  position: number;
}

export interface OrchestrationSession {
  id: string;
  name: string;
  originalPrompt: string;
  /** Shared Project this Team collaborates on; absent for text-only Teams. */
  projectId?: string | null;
  participants: OrchestrationParticipant[];
  /** Omitted only by legacy persisted sessions; those run sequentially. */
  mode?: OrchestrationMode;
  /** Agent used for supervisor routing; participants remain a separate roster. */
  supervisorAgentId?: string | null;
  completionReason?: OrchestrationCompletionReason | null;
  status: OrchestrationStatus;
  currentParticipantId: string | null;
  currentRunId: string | null;
  stepIndex: number;
  maxSteps: number;
  perAgentTimeoutMs: number;
  errorCode: OrchestrationErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationTurn {
  id: string;
  sessionId: string;
  participantId: string;
  agentId: string;
  runId: string;
  /** Present on newer runs; legacy detail responses use array order. */
  stepIndex?: number;
  position: number;
  status: OrchestrationTurnStatus;
  safeInputSummary: string;
  safeOutput: string | null;
  outputTruncated: boolean;
  errorCode: OrchestrationErrorCode | null;
  createdAt: string;
  completedAt: string | null;
}

export interface OrchestrationEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: OrchestrationEventType;
  participantId?: string;
  agentId?: string;
  runId?: string;
  status: string;
  durationMs?: number;
  safeSummary?: string;
  errorCode?: OrchestrationErrorCode;
  completionReason?: OrchestrationCompletionReason;
  createdAt: string;
}

export interface OrchestrationSessionDetail {
  session: OrchestrationSession;
  turns: OrchestrationTurn[];
  events: OrchestrationEvent[];
  continuationPrompts: OrchestrationContinuationPrompt[];
}

export interface OrchestrationContinuationPrompt {
  id: string;
  sessionId: string;
  cycleIndex: number;
  prompt: string;
  createdAt: string;
}

export interface CreateOrchestrationInput {
  name: string;
  originalPrompt: string;
  participants: OrchestrationParticipant[];
  mode: OrchestrationMode;
  /** Required by supervisor mode; omitted for deterministic routing modes. */
  supervisorAgentId?: string;
  projectId?: string;
  maxSteps: number;
  perAgentTimeoutMs: number;
}

export type ProjectStatus = "active" | "archived";

/** Safe Project projection; the host workspace path never reaches the client. */
export interface Project {
  id: string;
  name: string;
  description: string;
  teamId: string | null;
  agentIds: string[];
  /** Added in Wave 8; older API fixtures may still only expose agentIds. */
  memberships?: ProjectMembership[];
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export type ProjectRole = "owner" | "editor" | "viewer";

export interface ProjectMembership {
  agentId: string;
  role: ProjectRole;
  roleId?: string;
}

export interface ContinueOrchestrationInput {
  prompt: string;
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

export type UsageAvailability = "available" | "partial" | "unavailable";

export interface UsageTokenTotals {
  availability: UsageAvailability;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runsReporting: number;
}

export interface UsageRunTotals {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
}

export interface UsageActivityTotals {
  toolCalls: number;
  toolFailures: number;
  approvalsRequired: number;
  skillInvocations: number;
  authorizationDenials: number;
}

export interface UsageLatency {
  samples: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface UsageTotals {
  runs: UsageRunTotals;
  tokens: UsageTokenTotals;
  activity: UsageActivityTotals;
  latency: UsageLatency;
  messages: number;
}

export interface UsageAgentBreakdown extends UsageTotals {
  agentId: string;
  name: string | null;
  status: string | null;
  modelLabel: string | null;
  lastActiveAt: string | null;
}

export interface UsageWorkspaceBreakdown extends UsageTotals {
  orchestrationId: string;
  name: string | null;
  status: string | null;
  projectId: string | null;
  participants: number;
  lastActiveAt: string | null;
}

export interface UsageProjectBreakdown extends UsageTotals {
  projectId: string;
  name: string | null;
  /** Kept for response compatibility; named rows are always live. */
  archived: boolean;
  lastActiveAt: string | null;
}

export interface UsageDailyPoint {
  date: string;
  runs: number;
  completed: number;
  failed: number;
  totalTokens: number;
  toolCalls: number;
}

export interface UsageRetiredSummary extends UsageTotals {
  subjects: number;
}

export interface UsageRetired {
  agents: UsageRetiredSummary | null;
  workspaces: UsageRetiredSummary | null;
  projects: UsageRetiredSummary | null;
}

export interface UsageReport {
  since: string | null;
  generatedAt: string;
  totals: UsageTotals;
  agents: UsageAgentBreakdown[];
  workspaces: UsageWorkspaceBreakdown[];
  projects: UsageProjectBreakdown[];
  retired: UsageRetired;
  daily: UsageDailyPoint[];
}

/** Live runtime/telemetry snapshot for one Agent, polled by the workspace. */
export interface AgentMetrics {
  agentId: string;
  lifecycle: "ready" | "busy" | "stopped" | "error";
  currentRun: { id: string; elapsedMs: number; model: string | null } | null;
  tokens: {
    lastRun: {
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
    } | null;
    session: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    tokensPerSecondLastRun: number | null;
    tokensPerSecondAvg: number | null;
  };
  tools: { calls: number; denied: number; sandboxCommands: number; filesChanged: number };
  container: {
    cpuPct: number;
    memBytes: number;
    memLimitBytes: number | null;
    pids: number | null;
    sampledAt: string;
    oomKilled: boolean | null;
    uptimeMs: number | null;
  } | null;
  lastError: string | null;
  model: string | null;
  fallbackUsed: boolean;
}

/** Safe audit projection the workspace polls to see live tool activity. */
export interface AuditEventRecord {
  id: string;
  type: string;
  status: "success" | "failure";
  summary: string;
  createdAt: string;
  agentId?: string;
  projectId?: string;
  runId?: string;
  orchestrationId?: string;
  permission?: string;
  resource?: { kind: string; id: string };
  /** Redacted, allow-listed evidence for the event (e.g. sandbox_command, workspace_file_change). */
  metadata?: Record<string, string | number | boolean | null>;
  category?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  actorType?: string;
  durationMs?: number;
  sequence?: number;
}

export type AuditCategory =
  | "orchestration"
  | "model_call"
  | "tool_call"
  | "sandbox_execution"
  | "workspace"
  | "policy_decision"
  | "human_approval"
  | "session"
  | "system"
  | "cloud_operation";

export interface AuditTraceNode {
  event: AuditEventRecord;
  events: AuditEventRecord[];
  children: AuditTraceNode[];
}

export interface AuditTrace {
  traceId: string;
  root: AuditTraceNode | null;
  orphans: AuditTraceNode[];
  status: "success" | "failure";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  eventCount: number;
  countsByCategory: Record<AuditCategory, number>;
  failingStep: { spanId: string; eventId: string; type: string } | null;
  agentIds: string[];
  runIds: string[];
}

export type AuditTraceSummary = Omit<AuditTrace, "root" | "orphans"> & {
  rootType: string | null;
  rootSummary: string;
};
