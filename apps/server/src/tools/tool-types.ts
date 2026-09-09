import type { z } from "zod";
import type {
  AuthorizationContext,
  Principal,
  ResourceRef,
} from "../access/access-types.js";
import type { PermissionId } from "../access/permission-types.js";

/** Risk is metadata for policy/UI; the service remains the enforcement point. */
export type ToolRisk =
  | "read"
  | "write"
  | "network"
  | "external_write"
  | "high_cost";

/**
 * Server-owned approval behavior for one registered tool.  This is deliberately
 * separate from `risk`: a tool can be risky without requiring a human decision,
 * and a policy change must invalidate any invocation prepared under an older
 * version.
 */
export type ToolApprovalMode = "none" | "required";

/**
 * Server-owned authority used to decide an approval.  This is deliberately
 * not part of any request DTO: a caller can identify an approval, but cannot
 * choose which permission or owner is allowed to decide it.
 */
export type ToolApprovalDecisionAuthority = {
  readonly kind: "project-owner";
  readonly permission: PermissionId;
};

export interface ToolApprovalPolicy {
  readonly mode: ToolApprovalMode;
  readonly version: string;
  /** Required for built-in approval policies; omitted for legacy test/tools. */
  readonly decisionAuthority?: ToolApprovalDecisionAuthority;
}

/**
 * Compatibility mapping for persisted approval records and isolated route
 * fixtures that do not have a live registry resolver.  The application
 * composition root still resolves the current registered policy first.
 */
export const TOOL_APPROVAL_DECISION_AUTHORITIES: Readonly<
  Record<string, ToolApprovalDecisionAuthority>
> = Object.freeze({
  "project.preview.restart": Object.freeze({
    kind: "project-owner",
    permission: "project.preview.restart",
  }),
  "web.search": Object.freeze({
    kind: "project-owner",
    permission: "tool.execute:web.search",
  }),
});

export function approvalDecisionAuthorityForTool(
  toolId: string,
  policy?: ToolApprovalPolicy,
): ToolApprovalDecisionAuthority | null {
  if (policy?.mode === "none") return null;
  return policy?.decisionAuthority ?? TOOL_APPROVAL_DECISION_AUTHORITIES[toolId] ?? null;
}

/**
 * Correlation facts attached only after the durable approval fence wins.
 * These are intentionally separate from the inbound execution context so an
 * MCP caller cannot choose an approval, workflow, or session identity.
 */
export interface ToolExecutionCorrelation {
  readonly traceId?: string;
  readonly parentSpanId?: string;
  readonly turnId?: string;
  readonly sessionId?: string;
  readonly invocationId?: string;
  readonly approvalId?: string;
  readonly workflowRunId?: string;
}

/** The policy version used by the initial built-in tool catalogue. */
export const TOOL_APPROVAL_POLICY_VERSION = "tool-approval-v1" as const;
/** Policy revision for web.search's transition to fresh human approval. */
export const WEB_SEARCH_TOOL_APPROVAL_POLICY_VERSION = "tool-approval-v2" as const;

export const NO_TOOL_APPROVAL_POLICY: ToolApprovalPolicy = Object.freeze({
  mode: "none",
  version: TOOL_APPROVAL_POLICY_VERSION,
});

/**
 * The immutable, server-owned authorization result passed from preparation to
 * a workflow or guarded executor.  The raw request and parsed executor input
 * are deliberately separate: a schema transform may be one-way, so a later
 * authorization recheck must start from the original request while execution
 * continues to use the value that was authorized at preparation time.
 */
export interface PreparedToolInvocation {
  readonly kind: "prepared-tool-invocation";
  readonly toolId: string;
  readonly definition: ToolDefinition<unknown, unknown>;
  readonly context: ToolExecutionContext;
  /** Binding for the raw request snapshot used during revalidation. */
  readonly rawInputBinding: string;
  /** Binding for the actual immutable value supplied to the executor. */
  readonly inputBinding: string;
  readonly principalBinding: string;
  readonly policy: ToolApprovalPolicy;
  readonly preparedAt: number;
}

export interface ToolExecutionContext extends AuthorizationContext {
  /** Resolved at a trusted Agent run or human control-plane boundary. */
  principal: Principal;
  /** The selected Agent, even when the acting principal is the demo human. */
  agentId: string;
  /** Project scope is bound by McpSessionService for Agent runs. */
  projectId?: string;
  runId: string;
  /** Trusted absolute outer Run/Codex deadline, when one is known. */
  deadlineAt?: number;
  /** Native workflow cancellation signal, injected only by trusted server code. */
  abortSignal?: AbortSignal;
  /** Trusted trace identity, injected from the approval record after admission. */
  traceId?: string;
  /** Trusted parent span identity, injected from the approval record after admission. */
  parentSpanId?: string;
  /** Trusted team-turn correlation, injected after approval admission. */
  turnId?: string;
  /** Trusted authenticated session correlation, injected after approval admission. */
  sessionId?: string;
  /** Trusted native approval invocation correlation, injected after admission. */
  invocationId?: string;
  /** Trusted durable approval correlation, injected after the decision fence. */
  approvalId?: string;
  /** Trusted native workflow-run correlation, injected after approval admission. */
  workflowRunId?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  title: string;
  description: string;
  risk: ToolRisk;
  requiredPermission: PermissionId;
  /** Code-owned policy; omitted legacy definitions are treated as `none`. */
  approvalPolicy?: ToolApprovalPolicy;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute(context: ToolExecutionContext, input: TInput): Promise<TOutput>;
}

/** Safe metadata exposed to HTTP/MCP clients; schemas and executors stay code-owned. */
export interface ToolMetadata {
  id: string;
  title: string;
  description: string;
  risk: ToolRisk;
  requiredPermission: PermissionId;
  /** Read-only projection of the code-owned approval policy. */
  approvalPolicy?: ToolApprovalPolicy;
}

export type ToolAvailability = "available" | "denied";

export interface ToolCapabilityView {
  tool: ToolMetadata;
  availability: ToolAvailability;
  reason: string;
}

export interface ToolCapabilitiesView {
  agentId: string;
  projectId: string | null;
  tools: ToolCapabilityView[];
}

/** Explicit target metadata for human-only capability test actions. */
export interface HumanToolTestContext {
  agentId: string;
  projectId?: string;
}

export type ToolResource = ResourceRef & { kind: "tool" };
