import type { AuditEventType, AuditRecorder } from "../audit/audit-types.js";
import type { RuntimeTelemetry } from "../telemetry/telemetry-types.js";
import { correlationAttributes } from "../telemetry/telemetry-types.js";
import {
  agentPrincipal,
  type AuthorizationDecision,
  type AuthorizationService,
} from "../access/authorization-service.js";
import type { PermissionId } from "../access/permission-types.js";
import { redactSensitiveText } from "../orchestration/handoff.js";
import type { Storage } from "../store.js";
import type { ResourceRef } from "../access/access-types.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolError } from "./tool-errors.js";
import type {
  ToolCapabilitiesView,
  ToolCapabilityView,
  ToolDefinition,
  ToolExecutionContext,
  ToolMetadata,
} from "./tool-types.js";

const MAX_SAFE_REASON_LENGTH = 512;
const DIRECT_AGENT_TOOL_IDS = new Set(["web.search", "web.fetch"]);

function isDirectAgentTool(toolId: string): boolean {
  return DIRECT_AGENT_TOOL_IDS.has(toolId);
}

function safeReason(value: string): string {
  const redacted = redactSensitiveText(value).trim();
  if (redacted.length <= MAX_SAFE_REASON_LENGTH) return redacted;
  return redacted.slice(0, MAX_SAFE_REASON_LENGTH - 14).trimEnd() + " [TRUNCATED]";
}

function contextForAuthorization(context: ToolExecutionContext): {
  projectId?: string;
  agentId: string;
  runId: string;
  orchestrationId?: string;
  toolId: string;
} {
  return {
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    agentId: context.agentId,
    runId: context.runId,
    ...(context.orchestrationId === undefined ? {} : { orchestrationId: context.orchestrationId }),
    toolId: context.toolId ?? "",
  };
}

function toolResource(toolId: string): ResourceRef {
  return { kind: "tool", id: toolId };
}

export interface ProjectRoleToolResolver {
  /** Resolve the explicit Project override, then the Agent-global role. */
  getEffectiveRole(
    agentId: string,
    projectId?: string,
  ): { toolIds: string[] } | undefined;
}

/**
 * Typed gateway for all registered executors. Repository authorization is the
 * policy authority for Project-scoped calls; an explicitly assigned
 * Agent-global role is the authority for direct network calls. The store is
 * used only to resolve trusted Agent roles and never grants capabilities.
 */
export class ToolService {
  private roleTools?: ProjectRoleToolResolver;
  constructor(
    private readonly registry: ToolRegistry,
    private readonly authorization: AuthorizationService,
    private readonly _store: Storage,
    private readonly audit?: AuditRecorder,
    private readonly telemetry?: RuntimeTelemetry,
  ) {}

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /** Attach reusable role tools after RoleService has been constructed. */
  setProjectRoleToolResolver(resolver: ProjectRoleToolResolver): void {
    this.roleTools = resolver;
  }

  private roleAllowsTool(
    agentId: string,
    projectId: string | undefined,
    toolId: string,
    requireRole = false,
    requiredPermission?: PermissionId,
  ): boolean {
    if (
      projectId === undefined &&
      requireRole &&
      (requiredPermission === undefined ||
        !this.directGlobalRoleAllowsTool(agentId, toolId, requiredPermission))
    ) {
      return false;
    }
    // The global-role check above is authoritative for direct network runs;
    // no Project resolver is needed for that scope. This also keeps isolated
    // ToolService consumers safe when RoleService is not wired in.
    if (projectId === undefined && requireRole) return true;
    if (!this.roleTools) return !requireRole;
    // Outside a Project, an Agent-global role is the only role scope. A
    // roleless Agent keeps the existing Project membership baseline, while a
    // direct network tool requires an explicit global role assignment.
    const role = this.roleTools.getEffectiveRole(agentId, projectId);
    if (!role) return !requireRole;
    return role?.toolIds.includes(toolId) ?? false;
  }

  /**
   * Direct runs have no Project policy resource. For the two public network
   * tools, the human-assigned Agent-global role is the complete authority:
   * both the executable tool and its corresponding permission must be
   * present. Project-only tools never reach this path.
   */
  private directGlobalRoleAllowsTool(
    agentId: string,
    toolId: string,
    requiredPermission: PermissionId,
  ): boolean {
    const snapshot = this._store.snapshot();
    const agent = snapshot.agents.find((item) => item.id === agentId);
    if (!agent?.globalRoleId) return false;
    const role = snapshot.roles.find((item) => item.id === agent.globalRoleId);
    return role?.toolIds.includes(toolId) === true &&
      role.permissionIds.includes(requiredPermission);
  }

  listMetadata(): ToolMetadata[] {
    return this.registry.metadata();
  }

  async execute(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
  ): Promise<unknown> {
    const definition = this.registry.get(toolId);
    if (!definition) {
      throw new ToolError("TOOL_NOT_FOUND", 404, "The requested tool is not available");
    }
    if (context.principal.kind === "agent" && context.principal.id !== context.agentId) {
      throw new ToolError("PERMISSION_DENIED", 403, "Tool identity does not match the run");
    }
    if (
      context.principal.kind === "agent" &&
      context.projectId === undefined &&
      !isDirectAgentTool(toolId)
    ) {
      throw new ToolError(
        "PERMISSION_DENIED",
        403,
        "A Project-scoped Agent run is required for this tool",
      );
    }
    if (
      context.principal.kind === "agent" &&
      !this.roleAllowsTool(
        context.agentId,
        context.projectId,
        toolId,
        context.projectId === undefined,
        definition.requiredPermission,
      )
    ) {
      throw new ToolError("PERMISSION_DENIED", 403, "The assigned Agent role does not include this tool");
    }
    // Check the raw payload before Zod object parsing (which may strip
    // unknown keys), so a caller cannot smuggle a different Project selector
    // into an otherwise empty Project-tool input schema.
    if (
      input !== null &&
      typeof input === "object" &&
      "projectId" in input &&
      (input as { projectId?: unknown }).projectId !== context.projectId
    ) {
      throw new ToolError("PERMISSION_DENIED", 403, "Tool input cannot change the run Project");
    }
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolError("TOOL_INVALID_INPUT", 422, "Invalid input for " + toolId);
    }
    if (
      parsed.data !== null &&
      typeof parsed.data === "object" &&
      "projectId" in parsed.data &&
      (parsed.data as { projectId?: unknown }).projectId !== context.projectId
    ) {
      throw new ToolError("PERMISSION_DENIED", 403, "Tool input cannot change the run Project");
    }

    const directGlobalRole =
      context.principal.kind === "agent" &&
      context.projectId === undefined &&
      isDirectAgentTool(toolId) &&
      this.directGlobalRoleAllowsTool(
        context.agentId,
        toolId,
        definition.requiredPermission,
      );
    // A direct Agent has no Project membership resource. Once the explicit
    // global role/tool/permission gate above succeeds, do not ask a
    // Project-oriented policy adapter to invent one.
    const decision: AuthorizationDecision = directGlobalRole
      ? { result: "allow", reason: "Agent global role authorized " + toolId }
      : await this.authorization.decide({
          principal: context.principal,
          permission: definition.requiredPermission,
          resource: toolResource(toolId),
          context: { ...contextForAuthorization(context), toolId },
        });
    if (decision.result !== "allow") {
      await this.recordToolEvent(
        "tool_failed",
        context,
        definition,
        "Tool authorization denied: " + toolId,
        "failure",
        { phase: "authorization", decision: decision.result },
      );
      throw new ToolError(
        "PERMISSION_DENIED",
        403,
        safeReason(decision.reason),
      );
    }

    await this.recordToolEvent(
      "tool_started",
      context,
      definition,
      "Tool execution started: " + toolId,
      "success",
      { risk: definition.risk },
    );

    let output: unknown;
    const executionStartedAt = Date.now();
    try {
      const execute = () => definition.execute(context, parsed.data);
      output = this.telemetry
        ? await this.telemetry.withSpan(
            "tool.execute",
            {
              ...correlationAttributes({
                principalKind: context.principal.kind,
                principalId: context.principal.id,
                agentId: context.agentId,
                ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
                runId: context.runId,
                ...(context.orchestrationId === undefined
                  ? {}
                  : { orchestrationId: context.orchestrationId }),
              }),
              "tool.id": definition.id,
              "tool.risk": definition.risk,
            },
            execute,
          )
        : await execute();
      const validatedOutput = definition.outputSchema.safeParse(output);
      if (!validatedOutput.success) {
        throw new ToolError(
          "TOOL_OUTPUT_INVALID",
          502,
          "The " + toolId + " tool returned invalid data",
        );
      }
      await this.recordToolEvent(
        "tool_succeeded",
        context,
        definition,
        "Tool execution succeeded: " + toolId,
        "success",
        { risk: definition.risk, durationMs: Date.now() - executionStartedAt },
      );
      return validatedOutput.data;
    } catch (error) {
      await this.recordToolEvent(
        "tool_failed",
        context,
        definition,
        "Tool execution failed: " + toolId,
        "failure",
        {
          phase: "execution",
          errorCode: error instanceof ToolError ? error.code : "TOOL_EXECUTION_FAILED",
          durationMs: Date.now() - executionStartedAt,
        },
      );
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "TOOL_EXECUTION_FAILED",
        502,
        "The " + toolId + " tool could not complete",
        { cause: error },
      );
    }
  }

  async listCapabilities(
    agentId: string,
    projectId?: string,
  ): Promise<ToolCapabilitiesView> {
    const tools = await Promise.all(
      this.registry.metadata().map(async (tool) => {
        if (
          projectId === undefined &&
          !isDirectAgentTool(tool.id)
        ) {
          return {
            tool,
            availability: "denied",
            reason: "A Project-scoped Agent capability is required",
          } satisfies ToolCapabilityView;
        }
        if (
          !this.roleAllowsTool(
            agentId,
            projectId,
            tool.id,
            projectId === undefined,
            tool.requiredPermission,
          )
        ) {
          return {
            tool,
            availability: "denied",
            reason: "The assigned Agent role does not include this tool",
          } satisfies ToolCapabilityView;
        }
        const directGlobalRole =
          projectId === undefined &&
          isDirectAgentTool(tool.id) &&
          this.directGlobalRoleAllowsTool(agentId, tool.id, tool.requiredPermission);
        let decision: AuthorizationDecision = directGlobalRole
          ? { result: "allow", reason: "Agent global role authorized " + tool.id }
          : {
              result: "deny",
              reason: "Capability state is unavailable",
              errorCode: "PERMISSION_DENIED",
            };
        if (!directGlobalRole) {
          try {
            decision = await this.authorization.decide({
              principal: agentPrincipal(agentId),
              permission: tool.requiredPermission,
              resource: toolResource(tool.id),
              context: {
                agentId,
                runId: "capability-preview",
                toolId: tool.id,
                ...(projectId === undefined ? {} : { projectId }),
              },
            });
          } catch {
            // Keep the fail-closed decision above.
          }
        }
        if (decision.result === "deny") {
          return {
            tool,
            availability: "denied",
            reason: safeReason(decision.reason),
          } satisfies ToolCapabilityView;
        }
        if (agentId.length === 0) {
          return {
            tool,
            availability: "denied",
            reason: "An Agent identity is required",
          } satisfies ToolCapabilityView;
        }
        return {
          tool,
          availability: "available",
          reason: safeReason(decision.reason),
        } satisfies ToolCapabilityView;
      }),
    );
    return {
      agentId,
      projectId: projectId ?? null,
      tools,
    };
  }

  private async recordToolEvent(
    type: AuditEventType,
    context: ToolExecutionContext,
    definition: ToolDefinition,
    summary: string,
    status: "success" | "failure",
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit?.record({
      type,
      status,
      summary,
      principal: context.principal,
      agentId: context.agentId,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      runId: context.runId,
      ...(context.orchestrationId === undefined ? {} : { orchestrationId: context.orchestrationId }),
      permission: definition.requiredPermission,
      resource: { kind: "tool", id: definition.id },
      metadata,
    }).catch(() => undefined);
  }
}

export type { BraveSearchResult } from "./brave-search-adapter.js";
export type { SearchResult } from "./search-provider.js";
// Compatibility exports keep existing composition roots stable while the
// code-owned definitions live in their focused module.
export {
  createBuiltInToolDefinitions,
  createBuiltInToolRegistry,
  createToolRegistry,
} from "./built-in-tools.js";
export type {
  BuiltInToolDependencies,
  ToolFetchService,
  ToolPreviewService,
  ToolSearchService,
} from "./built-in-tools.js";
