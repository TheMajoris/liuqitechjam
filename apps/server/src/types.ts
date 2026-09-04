import type {
  OrchestrationContinuationPrompt,
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationTurn,
} from "./orchestration/types.js";
import type { ModelRef, WorkerRuntimeModelConfig } from "./models/types.js";
import type { ArkModelCatalogRecord } from "./models/catalog.js";
import type { PreviewRecord } from "./preview/preview-types.js";
import type {
  ApprovalRequest,
  AuditEvent,
  CapabilityGrant,
  PermitApprovalCorrelation,
} from "./access/access-types.js";
export type {
  AuthorizationContext,
  AuthorizationDecision,
  Principal,
  ResourceRef,
} from "./access/access-types.js";
import type {
  Project,
  ProjectAgentAttachment,
  ProjectWriteLease,
} from "./projects/project-types.js";
import type { AgentRole } from "./roles/role-types.js";
import type { InstalledSkillRecord } from "./skills/skill-types.js";

export type {
  AgentRole,
  AgentRoleSource,
  AgentRoleView,
  CreateRoleInput,
  ProjectRoleAssignmentView,
  UpdateRoleInput,
} from "./roles/role-types.js";

export type { ModelRef, WorkerRuntimeModelConfig } from "./models/types.js";
export type {
  AgentSkillsView,
  AssignedSkillView,
  InstalledSkillRecord,
  SkillCatalogEntry,
  SkillDefinition,
  SkillMetadata,
  SkillRuntimeContext,
  SkillSource,
  SkillToolCapability,
} from "./skills/skill-types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/**
 * Cosmetic character choices for the 2D workspace.
 *
 * Purely presentational: nothing here is an input to authorization, routing,
 * or a run. Every field is optional, and an absent field falls back to the
 * deterministic look derived from the Agent's ID, so records written before
 * appearance existed keep the exact character they already had.
 */
export interface AgentAppearance {
  /** Shirt hue in degrees; absent means the ID-derived product hue. */
  hue?: number | undefined;
  /** Index into the client's hair palette. */
  hair?: number | undefined;
  /** Index into the client's skin palette. */
  skin?: number | undefined;
  accessory?: AgentAccessory | undefined;
}

export type AgentAccessory = "none" | "glasses" | "headset" | "cap";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Omitted on legacy records; normalized stores expose an empty list. */
  skillIds?: string[];
  /** Optional role preset used outside a Workspace and as the Workspace fallback. */
  globalRoleId?: string;
  /** Omitted until someone customizes this Agent's character. */
  appearance?: AgentAppearance;
  status: AgentStatus;
  /** Omitted on legacy records; those resolve to the configured default. */
  modelRef?: ModelRef;
  /** Ordered fallback models attempted when the primary model cannot run. */
  fallbackModelRefs?: ModelRef[];
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Immutable model assignment captured when a Run is accepted.
 *
 * Agent records may be edited and the server-owned model catalog may be
 * refreshed while a Run is in flight. Keeping this snapshot on the Run makes
 * the execution auditable and ensures those changes affect only later Runs.
 */
export interface AgentModelSnapshot {
  modelRef: ModelRef;
  fallbackModelRefs: ModelRef[];
  /** Optional catalog revision supplied by a runtime model resolver. */
  catalogRevision?: string | number;
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
  /** Assignment captured before execution; omitted on legacy Run records. */
  modelSnapshot?: AgentModelSnapshot;
  /** Model that produced the terminal result, including a fallback model. */
  modelUsed?: ModelRef;
  /** Present when a configured fallback produced the terminal result. */
  fallbackUsed?: {
    index: number;
    modelRef: ModelRef;
  };
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  /** Runtime-editable Ark model metadata; credentials remain in env only. */
  modelCatalog: ArkModelCatalogRecord | null;
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
  /** Additive Wave 8+ collections; absent in legacy v1 stores. */
  approvalRequests: ApprovalRequest[];
  capabilityGrants: CapabilityGrant[];
  auditEvents: AuditEvent[];
  /** Permit request IDs and safe local correlation only; never authorization. */
  permitApprovalCorrelations: PermitApprovalCorrelation[];
  /** Additive role-template collection; absent in pre-role stores. */
  roles: AgentRole[];
  /** Additive instruction-only skill installation collection. */
  installedSkills: InstalledSkillRecord[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  modelRef?: ModelRef | undefined;
  /** Ordered fallback models attempted after the primary model fails. */
  fallbackModelRefs?: ModelRef[] | undefined;
  /** Agent-global declarative skills; skills never grant tools. */
  skillIds?: string[] | undefined;
  /** Optional Agent-global role; null explicitly means no role. */
  globalRoleId?: string | null | undefined;
  appearance?: AgentAppearance | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  modelRef?: ModelRef | undefined;
  /** Replaces the ordered fallback model list when supplied. */
  fallbackModelRefs?: ModelRef[] | undefined;
  /** Replaces Agent-global skill assignment when supplied. */
  skillIds?: string[] | undefined;
  /** Replaces the Agent-global role when supplied; null clears it. */
  globalRoleId?: string | null | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

/** Per-run MCP settings. The bearer token is consumed only by the child env. */
export interface RunnerMcpConfig {
  url: string;
  token: string;
  /** W3C trace context propagated across the worker process boundary. */
  traceparent?: string;
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
  /** The accepted assignment snapshot for runtime observability. */
  modelSnapshot?: AgentModelSnapshot;
  /** Omitted for isolated/test runs where MCP is disabled. */
  mcp?: RunnerMcpConfig;
  /** Host-side tap over the worker's stdout events; never passed to the child. */
  observer?: import("./audit/runtime-action-audit.js").RuntimeActionObserver;
  /** Sandbox lifecycle witness; ignored by runners without a container. */
  sandboxAudit?: import("./audit/sandbox-audit.js").SandboxAuditSink;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
