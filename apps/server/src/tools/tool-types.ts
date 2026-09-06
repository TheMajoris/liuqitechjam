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

export interface ToolExecutionContext extends AuthorizationContext {
  /** Resolved at a trusted Agent run or human control-plane boundary. */
  principal: Principal;
  /** The selected Agent, even when the acting principal is the demo human. */
  agentId: string;
  /** Project scope is bound by McpSessionService for Agent runs. */
  projectId?: string;
  runId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  title: string;
  description: string;
  risk: ToolRisk;
  requiredPermission: PermissionId;
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
