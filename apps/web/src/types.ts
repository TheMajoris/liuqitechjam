export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentRunErrorCode =
  | "WEB_TOOL_PERMISSION_DENIED"
  | "MODEL_INFERENCE_LIMIT_EXCEEDED"
  | "MODEL_RATE_LIMITED"
  | "CHECKPOINT_CAPTURE_FAILED";

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

/**
 * Live endpoint state is intentionally separate from the model catalogue.
 * A descriptor says that a model can be selected; this says what the control
 * plane last observed about the deployed endpoint.
 */
export type ModelEndpointStatus =
  | "running"
  | "stopped"
  | "degraded"
  | "unavailable"
  | "unknown";

export type ModelResourceFreshness = "fresh" | "stale" | "unavailable";

/** Provider-reported counters from GetInferenceUsage. Missing means unknown. */
export interface ModelUsageSnapshot {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
  /** ModelArk GetInferenceUsage data count; it is not a token count. */
  dataCount?: number;
  /** Usage is provider-wide unless the backend explicitly scopes it to a model. */
  scope?: "provider" | "model";
  availability?: "available" | "partial" | "unavailable";
  queryInterval?: "Hour" | "Day";
  windowStart?: string | null;
  windowEnd?: string | null;
}

/** A quota is optional because many ModelArk responses expose usage only. */
export interface ModelQuotaSnapshot {
  usedTokens: number;
  totalTokens: number;
  remainingTokens: number;
}

/** Server-normalized endpoint projection from ListEndpoints. */
export interface ModelEndpointResource {
  providerId: string;
  modelId: string;
  name: string | null;
  foundationModel: { name: string; version: string } | null;
  status: "running" | "not_running" | "unknown";
  statusReason: string | null;
  rateLimit: { rpm: number | null; tpm: number | null };
  /** Usage for this endpoint only; null means ModelArk reported no row. */
  usage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    requests: number | null;
  } | null;
  /** Account free-token quota for the matching foundation model, when known. */
  quota?: ModelQuotaSnapshot | null;
  /** Configured context window for this model; null when none is set. */
  contextWindowTokens?: number | null;
  observedAt: string;
}

export interface ModelInferenceUsageRow {
  modelEndpoint: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
}

export interface ModelInferenceUsage {
  availability: "available" | "partial" | "unavailable";
  dataCount: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requests: number | null;
  queryInterval: "Hour" | "Day";
  startTime: string;
  endTime: string;
  observedAt: string | null;
  rows: ModelInferenceUsageRow[];
}

/** Current server-owned provider projection, when returned by the API. */
export interface ModelResourceView {
  providerId: string;
  availability: "available" | "partial" | "unavailable";
  stale: boolean;
  fetchedAt: string | null;
  revision: number;
  endpoints: ModelEndpointResource[];
  inferenceUsage: ModelInferenceUsage | null;
  error: string | null;
}

/** Normalized live state used by the workspace and Insights surfaces. */
export interface ModelResourceSnapshot {
  providerId: string;
  modelId: string;
  name?: string | null;
  foundationModel?: { name: string; version: string } | null;
  statusReason?: string | null;
  rateLimit?: { rpm: number | null; tpm: number | null };
  endpointStatus: ModelEndpointStatus;
  usage: ModelUsageSnapshot | null;
  quota?: ModelQuotaSnapshot | null;
  /** Configured context window for this model; null when none is set. */
  contextWindowTokens?: number | null;
  freshness: ModelResourceFreshness;
  observedAt: string | null;
}

export interface ModelResourcesResponse {
  /** Flat response accepted for a future provider-neutral resource route. */
  resources?: ModelResourceSnapshot[];
  generatedAt?: string;
  /** Current server ModelArk projection may be returned directly or wrapped. */
  resource?: ModelResourceView;
  providerId?: string;
  availability?: "available" | "partial" | "unavailable";
  stale?: boolean;
  fetchedAt?: string | null;
  revision?: number;
  endpoints?: ModelEndpointResource[];
  inferenceUsage?: ModelInferenceUsage | null;
  error?: string | null;
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
 * Where the server-wide supervisor endpoint currently comes from. `override`
 * is an operator selection; `environment` is the SUPERVISOR_MODEL fallback.
 */
export type SupervisorModelSource = "override" | "environment" | "none";

export interface SupervisorModelResponse {
  /** The endpoint routing actually uses, from whichever source won. */
  modelRef: ModelRef | null;
  source: SupervisorModelSource;
  environmentModelId: string | null;
  revision: number;
}

/** Agents moved off the endpoint as a result of reserving it for routing. */
export interface SupervisorModelReassignment {
  agentId: string;
  agentName: string;
  movedPrimaryTo?: string;
  droppedFallbacks: number;
  skippedReason?: string;
}

export interface SupervisorModelUpdateResponse extends SupervisorModelResponse {
  reassignments: SupervisorModelReassignment[];
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

export type AgentAccessory = "none" | "glasses" | "headset" | "cap";

/**
 * The silhouette a character is drawn with. Presentation only: nothing about
 * an Agent's role, skills, or permissions is derived from it.
 */
export type AgentFigure = "neutral" | "feminine" | "masculine";

/** Cosmetic character choices for the 2D workspace. Never an authorization input. */
export interface AgentAppearance {
  hue?: number;
  hair?: number;
  skin?: number;
  accessory?: AgentAccessory;
  figure?: AgentFigure;
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

export type ToolRisk = "read" | "write" | "network" | "external_write" | "high_cost";
export type ToolAvailability = "available" | "denied";

export interface ToolMetadata {
  id: string;
  title: string;
  description: string;
  risk: ToolRisk;
  requiredPermission: string;
}

export interface ToolCapabilityView {
  tool: ToolMetadata;
  availability: ToolAvailability;
  reason: string;
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
  /** The Agent's name when the Run started; absent on legacy Runs. */
  agentName?: string;
  /** Set once the owning Agent is deleted; the Run itself is retained. */
  agentDeletedAt?: string;
  traceId?: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  /** Stable typed failure code for a terminal runtime failure. */
  errorCode?: AgentRunErrorCode;
  /** Shared Project scope for Team/Project-backed direct Runs, when present. */
  projectId?: string;
  /** Parent Team conversation for participant Runs, when present. */
  orchestrationId?: string;
  /** Safe approval projections may be embedded by newer Run endpoints. */
  approvals?: ToolApprovalPublicDto[];
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

/** Public projection returned by the native Mastra tool-approval routes. */
export const TOOL_APPROVAL_STATUSES = [
  "requested",
  "waiting",
  "approved",
  "resuming",
  "executing",
  "succeeded",
  "rejected",
  "failed_pre_execution",
  "failed",
  "expired",
  "cancelled",
  "revoked",
  "uncertain",
] as const;

export type ToolApprovalStatus = (typeof TOOL_APPROVAL_STATUSES)[number];
export type ToolApprovalDecision = "approved" | "rejected";

export interface ToolApprovalActor {
  kind: "human" | "agent" | "system";
  id: string;
}

export interface ToolApprovalTraceRefs {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  requestId?: string;
}

export interface ToolApprovalPublicDto {
  approvalId: string;
  invocationId: string;
  workflowRunId: string;
  agentId: string;
  projectId: string | null;
  runId: string;
  orchestrationId: string | null;
  turnId: string | null;
  sessionId: string | null;
  toolId: string;
  policyVersion: string;
  safeSummary: string;
  deadlineAt: string;
  status: ToolApprovalStatus;
  version: number;
  ownerEpoch: number;
  decision: ToolApprovalDecision | null;
  decisionActor: ToolApprovalActor | null;
  decisionAt: string | null;
  decisionReason: string | null;
  traceRefs: ToolApprovalTraceRefs;
  executionStartedAt: string | null;
  completedAt: string | null;
  terminalReason: string | null;
  cancellationRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Optional eligibility projection added by newer control-plane responses. */
  decisionEligible?: boolean;
  canDecide?: boolean;
  eligible?: boolean;
  eligibility?: { allowed: boolean; reason?: string | null } | null;
}

/** Shorter name for consumers that render the projection as an approval. */
export type ToolApproval = ToolApprovalPublicDto;

/**
 * A historical Run rollup from the observability API.
 *
 * It carries its own Agent identity, so a Run remains fully readable after
 * its Agent has been deleted.
 */
/**
 * Provider-reported token counters. `availability` stays explicit so a Run
 * that reported nothing is never displayed as zero tokens.
 */
export interface RunTokenTotals {
  availability: "available" | "partial" | "unavailable";
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Input processed fresh, with each Run's cache reads already removed. */
  netNewInputTokens: number;
  /** Fresh input plus output: what the model actually worked through. */
  netNewTokens: number;
  runsReporting: number;
  runsMissing: number;
}

/**
 * What a Run left occupied in its model's context window.
 *
 * Measured in billed tokens, not the net-new figure the rest of the surfaces
 * lead with: context is space, not price, so a prompt served from cache still
 * occupies the window it was read from.
 */
export interface RunContextWindow {
  windowTokens: number;
  usedTokens: number;
  remainingTokens: number;
  usedShare: number;
}

/** One named tool, command, or skill and how often a Run reached for it. */
export interface RunToolName {
  name: string;
  calls: number;
  failed: number;
}

/** What a Run called, named — not just how many events it produced. */
export interface RunToolUsage {
  /** Reconciled tool and skill invocations; a double-recorded call counted once. */
  calls: number;
  /** Commands the Run ran inside its sandbox. */
  sandboxCommands: number;
  /** The names behind those counts, busiest first. */
  names: RunToolName[];
}

export type RunConversationKind = "direct" | "team";

/** The thread a Run belongs to: a private conversation or a Team session. */
export interface RunConversation {
  id: string;
  kind: RunConversationKind;
  title: string;
  /** True when the title came from the Run's task rather than the thread. */
  derived: boolean;
}

export interface RunHistoryEntry {
  runId: string;
  agentId: string;
  agentName: string;
  agentDeleted: boolean;
  agentDeletedAt: string | null;
  status: RunStatus;
  title: string;
  traceId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  eventCount: number;
  errorCount: number;
  tokens: RunTokenTotals;
  /** Null when the model has no configured window or nothing was reported. */
  context: RunContextWindow | null;
  /** Null for a Run that belongs to no thread. */
  conversation: RunConversation | null;
  tools: RunToolUsage;
  failed: boolean;
  error: string | null;
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
  | "orchestration_retried"
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
  | "orchestration_completed"
  | "workspace_checkpoint_created"
  | "workspace_checkpoint_failed"
  | "workspace_checkpoint_restore_started"
  | "workspace_checkpoint_restored"
  | "workspace_checkpoint_restore_failed"
  | "workspace_recovery_resumed";

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
  | "WEB_TOOL_PERMISSION_DENIED"
  | "MODEL_INFERENCE_LIMIT_EXCEEDED"
  | "MODEL_RATE_LIMITED"
  | "PROJECT_PERMISSION_DENIED"
  | "INVALID_OUTPUT"
  | "MAX_STEPS_EXCEEDED"
  | "ORCHESTRATION_STOPPED"
  | "ORCHESTRATION_INTERRUPTED"
  | "SUPERVISOR_INVALID_RESPONSE"
  | "SUPERVISOR_INVALID_SELECTION"
  | "SUPERVISOR_FAILED"
  | "SUPERVISOR_TIMED_OUT"
  | "SUPERVISOR_UNAVAILABLE"
  | "CHECKPOINT_CAPTURE_FAILED"
  | "CHECKPOINT_PUBLISH_FAILED"
  | "CHECKPOINT_RUNTIME_UNSUPPORTED"
  | "INTERNAL_ERROR";

/* Workspace source checkpoints and restore-after-turn recovery. */

export type WorkspaceCheckpointKind = "baseline" | "turn_success" | "safety";

export type WorkspaceCheckpointState =
  | "preparing"
  | "captured"
  | "ready"
  | "failed"
  | "invalid";

export type WorkspaceCheckpointErrorCode =
  | "CHECKPOINT_NOT_FOUND"
  | "CHECKPOINT_NOT_READY"
  | "CHECKPOINT_CONTEXT_MISMATCH"
  | "CHECKPOINT_NO_REMAINING_STEPS"
  | "CHECKPOINT_IDEMPOTENCY_CONFLICT"
  | "CHECKPOINT_EXECUTION_ALREADY_ACCEPTED"
  | "CHECKPOINT_RESTORE_CONFLICT"
  | "CHECKPOINT_POLICY_MISMATCH"
  | "CHECKPOINT_INVALID_INPUT"
  | "CHECKPOINT_SECRET_DETECTED"
  | "CHECKPOINT_LIMIT_EXCEEDED"
  | "CHECKPOINT_UNAVAILABLE"
  | "CHECKPOINT_DIRECT_PROJECT_RUN_UNSUPPORTED"
  | "CHECKPOINT_RUNTIME_UNSUPPORTED"
  | "CHECKPOINT_WRITER_UNSETTLED"
  | "CHECKPOINT_CORRUPT"
  | "CHECKPOINT_CAPTURE_FAILED"
  | "CHECKPOINT_RESTORE_FAILED"
  | "CHECKPOINT_OPERATION_STAGE_INVALID";

export type WorkspaceOperationStage =
  | "reserved"
  | "preparing"
  | "backed_up"
  | "restoring"
  | "restored"
  | "resume_accepted"
  | "settled"
  | "failed"
  | "recovery_required";

/** One private source snapshot of a Project workspace. Carries no paths or SHAs. */
export interface WorkspaceCheckpointView {
  checkpointId: string;
  projectId: string;
  ordinal: number;
  kind: WorkspaceCheckpointKind;
  state: WorkspaceCheckpointState;
  orchestrationId: string | null;
  turnId: string | null;
  runId: string | null;
  stepIndex: number | null;
  createdAt: string;
  fileCount: number;
  byteCount: number;
  excludedFileCount: number;
  recoverable: boolean;
  unavailableReason: WorkspaceCheckpointErrorCode | null;
}

/** The durable record of one restore-and-resume; its stage is the truth. */
export interface WorkspaceRecoveryView {
  operationId: string;
  projectId: string;
  orchestrationId: string;
  kind: "cycle" | "recovery";
  checkpointId: string | null;
  safetyCheckpointId: string | null;
  stage: WorkspaceOperationStage;
  resumeCycleId: string | null;
  errorCode: WorkspaceCheckpointErrorCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCheckpointStatus {
  enabled: boolean;
  available: boolean;
  scope: "source-v1";
  busy: boolean;
  recoveryRequired: boolean;
  errorCode: WorkspaceCheckpointErrorCode | null;
}

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
  /**
   * Legacy only: supervisor routing used to designate an Agent. It is now a
   * server-wide model, and only records written before that change carry this.
   */
  supervisorAgentId?: string | null;
  /** Supervisor model captured when the current cycle was accepted. */
  supervisorModelRef?: ModelRef | null;
  completionReason?: OrchestrationCompletionReason | null;
  /**
   * Ask before acting. Adds a clarification rule to every participant prompt.
   * Prompt policy only: it grants nothing and changes no routing, so it can be
   * toggled on a settled Conversation and applies from the next cycle.
   */
  clarifyFirst?: boolean;
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
  /** The cycle currently executing, when checkpoints are recorded. */
  activeExecutionCycleId?: string | null;
  /** The checkpoint whose files the current cycle started from. */
  acceptedContextCheckpointId?: string | null;
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
  /** The model this turn ran on; recorded only when the turn failed. */
  modelId?: string;
  createdAt: string;
  completedAt: string | null;
  executionCycleId?: string;
  /** The source checkpoint saved after this turn succeeded, when one exists. */
  workspaceCheckpointId?: string;
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
  checkpointId?: string;
  recoveryOperationId?: string;
  createdAt: string;
}

export interface OrchestrationSessionDetail {
  session: OrchestrationSession;
  turns: OrchestrationTurn[];
  events: OrchestrationEvent[];
  continuationPrompts: OrchestrationContinuationPrompt[];
  /** Optional safe approval projections from newer orchestration responses. */
  approvals?: ToolApprovalPublicDto[];
  /** Absent when checkpoints are disabled or the Conversation has no Project. */
  checkpoints?: WorkspaceCheckpointView[];
  /** The latest recovery operation, when checkpoints are enabled. */
  recovery?: WorkspaceRecoveryView | null;
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
  /** Ask before acting; see OrchestrationSession.clarifyFirst. */
  clarifyFirst?: boolean;
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
  workspaceCheckpoints?: {
    enabled: boolean;
    available: boolean;
    busy: boolean;
    recoveryRequired: boolean;
    workspaceEpoch: number;
  };
  recoveryRequired?: true;
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
  /** Input processed fresh, with each Run's cache reads already removed. */
  netNewInputTokens: number;
  /** Fresh input plus output: what the model actually worked through. */
  netNewTokens: number;
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
    /** Null means the runtime has not reported that counter yet. */
    session: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null };
    /** Provider truth for the session counters; never infer unknown as zero. */
    sessionAvailability?: "available" | "partial" | "unavailable";
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
/** USD per 1K tokens, by model. A cache read is priced apart from a miss. */
export interface ModelRates {
  inputMiss: number;
  inputHit: number;
  output: number;
}

export type ModelPrices = Readonly<Record<string, ModelRates>>;

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
  /** Who or what performed the action; the attribution half of the record. */
  principal?: { kind: string; id: string };
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
  /** Tokens summed across every Run this trace covers. */
  tokens: RunTokenTotals;
  failingStep: { spanId: string; eventId: string; type: string } | null;
  agentIds: string[];
  runIds: string[];
}

export type AuditTraceSummary = Omit<AuditTrace, "root" | "orphans"> & {
  rootType: string | null;
  rootSummary: string;
};
