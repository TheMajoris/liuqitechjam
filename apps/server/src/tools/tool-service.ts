import type { AuditEventType, AuditRecorder } from "../audit/audit-types.js";
import type { RuntimeTelemetry } from "../telemetry/telemetry-types.js";
import { correlationAttributes } from "../telemetry/telemetry-types.js";
import {
  DEMO_HUMAN_PRINCIPAL,
  agentPrincipal,
  type AuthorizationDecision,
  type AuthorizationService,
} from "../access/authorization-service.js";
import {
  PermitApprovalError,
  PermitApprovalService,
  type PermitApprovalRecord,
} from "../access/permit-approval-service.js";
import type { PermissionId } from "../access/permission-types.js";
import { redactSensitiveText } from "../orchestration/handoff.js";
import type { JsonStore } from "../store.js";
import type { ResourceRef } from "../access/access-types.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  ToolApprovalRequiredError,
  ToolError,
} from "./tool-errors.js";
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

export interface CreateCapabilityGrantInput {
  agentId: string;
  projectId: string;
  toolId: string;
  scope: "once" | "project";
}

export interface ProjectRoleToolResolver {
  /** Resolve the explicit Project override, then the Agent-global role. */
  getEffectiveRole(
    agentId: string,
    projectId?: string,
  ): { toolIds: string[] } | undefined;
}

export type ToolApprovalGateway = Pick<
  PermitApprovalService,
  | "isAvailable"
  | "requestOperationApproval"
  | "consumeOperationApproval"
  | "listApprovals"
  | "getApproval"
  | "approve"
  | "deny"
  | "grantProjectAccess"
  | "listProjectAccess"
  | "revokeProjectAccess"
>;

/**
 * Typed gateway for all registered executors. Permit remains the policy
 * authority for Project-scoped calls; an explicitly assigned Agent-global
 * role is the authority for direct network calls. The legacy store parameter
 * is retained for construction compatibility, but local approval/grant
 * collections are never read or written by this class.
 */
export class ToolService {
  private roleTools?: ProjectRoleToolResolver;
  constructor(
    private readonly registry: ToolRegistry,
    private readonly authorization: AuthorizationService,
    private readonly _store: JsonStore,
    private readonly approvals?: ToolApprovalGateway,
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
    // Project-oriented policy adapter to invent one. The normal approval
    // consumption gate below still runs with projectId omitted.
    const decision: AuthorizationDecision = directGlobalRole
      ? { result: "allow", reason: "Agent global role authorized " + toolId }
      : await this.authorization.decide({
          principal: context.principal,
          permission: definition.requiredPermission,
          resource: toolResource(toolId),
          context: { ...contextForAuthorization(context), toolId },
        });
    if (decision.result !== "allow") {
      // Network research tools are approval-eligible when a Permit policy
      // requires a temporary grant. Their baseline
      // Project read permission is checked independently, so an approval can
      // never elevate an Agent without the underlying role.
      if (
        context.principal.kind === "agent" &&
        (toolId === "web.search" || toolId === "web.fetch") &&
        context.projectId !== undefined
      ) {
        const baseline = await this.authorization.decide({
          principal: context.principal,
          permission: "project.read",
          resource: { kind: "project", id: context.projectId },
          context: contextForAuthorization(context),
        });
        if (baseline.result === "allow") {
          try {
            const approval = await this.requestOperationApproval(context, toolId);
            await this.recordToolEvent(
              "tool_approval_required",
              context,
              definition,
              "Permit approval required for " + toolId,
              "failure",
              { decision: "approval_required", permitRequestId: approval.id },
              approval.id,
            );
            throw new ToolApprovalRequiredError(
              approval.id,
              safeReason("Permit approval required for " + toolId),
            );
          } catch (error) {
            if (error instanceof ToolApprovalRequiredError) throw error;
            await this.recordToolEvent(
              "tool_failed",
              context,
              definition,
              "Tool authorization failed: " + toolId,
              "failure",
              { phase: "authorization", errorCode: "PERMISSION_DENIED" },
            );
            throw error;
          }
        }
        await this.recordToolEvent(
          "tool_failed",
          context,
          definition,
          "Tool authorization denied: " + toolId,
          "failure",
          { phase: "authorization", decision: "deny" },
        );
        throw new ToolError("PERMISSION_DENIED", 403, safeReason(baseline.reason));
      }
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

    // Permit Operation Approval grants the temporary `_Approved_` role.
    // Consume that external role before the executor starts; if revocation
    // is unavailable the tool must not run. This is deliberately not based
    // on a local grant flag, and a normal standing Permit allow has no
    // matching correlation so it is left untouched.
    if (context.principal.kind === "agent") {
      let approvalsAvailable = false;
      try {
        approvalsAvailable = this.approvals?.isAvailable() === true;
      } catch {
        // A broken gateway is indistinguishable from an unavailable Permit
        // approval service at this enforcement seam.
      }
      if (!approvalsAvailable || !this.approvals) {
        await this.recordToolEvent(
          "tool_failed",
          context,
          definition,
          "Permit approval unavailable for: " + toolId,
          "failure",
          { phase: "approval", errorCode: "PERMISSION_DENIED" },
        );
        throw new ToolError(
          "PERMISSION_DENIED",
          503,
          "Permit approval is unavailable",
        );
      }
      try {
        const mayExecute = await this.approvals.consumeOperationApproval({
          agentId: context.agentId,
          ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
          runId: context.runId,
          toolId,
        });
        if (!mayExecute) {
          await this.recordToolEvent(
            "tool_failed",
            context,
            definition,
            "Permit approval was already consumed: " + toolId,
            "failure",
            { phase: "approval", errorCode: "PERMISSION_DENIED" },
          );
          throw new ToolError(
            "PERMISSION_DENIED",
            403,
            "Permit approval has already been consumed",
          );
        }
      } catch (error) {
        if (error instanceof ToolError) throw error;
        await this.recordToolEvent(
          "tool_failed",
          context,
          definition,
          "Permit approval unavailable for: " + toolId,
          "failure",
          { phase: "approval", errorCode: "PERMISSION_DENIED" },
        );
        throw new ToolError(
          "PERMISSION_DENIED",
          503,
          "Permit approval is unavailable",
        );
      }
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
            grant: null,
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
            grant: null,
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
        if (decision.result === "approval_required") {
          return {
            tool,
            availability: "approval_required",
            reason: safeReason(decision.reason),
            grant: null,
          } satisfies ToolCapabilityView;
        }
        if (decision.result === "deny") {
          if (
            (tool.id === "web.search" || tool.id === "web.fetch") &&
            projectId !== undefined &&
            this.approvals?.isAvailable()
          ) {
            const baseline = await this.authorization.decide({
              principal: agentPrincipal(agentId),
              permission: "project.read",
              resource: { kind: "project", id: projectId },
              context: { agentId, projectId, runId: "capability-preview", toolId: tool.id },
            });
            if (baseline.result === "allow") {
              return {
                tool,
                availability: "approval_required",
                reason: "Permit approval is required",
                grant: null,
              } satisfies ToolCapabilityView;
            }
          }
          return {
            tool,
            availability: "denied",
            reason: safeReason(decision.reason),
            grant: null,
          } satisfies ToolCapabilityView;
        }
        if (agentId.length === 0) {
          return {
            tool,
            availability: "denied",
            reason: "An Agent identity is required",
            grant: null,
          } satisfies ToolCapabilityView;
        }
        return {
          tool,
          availability: "available",
          reason: safeReason(decision.reason),
          grant: null,
        } satisfies ToolCapabilityView;
      }),
    );
    return {
      agentId,
      projectId: projectId ?? null,
      tools,
    };
  }

  async listGrants(agentId: string, projectId?: string): Promise<PermitApprovalRecord[]> {
    if (!this.approvals) return [];
    return this.approvals.listProjectAccess(agentId, projectId);
  }

  async createGrant(
    input: CreateCapabilityGrantInput,
  ): Promise<PermitApprovalRecord> {
    if (!this.registry.has(input.toolId)) {
      throw new ToolError("TOOL_NOT_FOUND", 404, "The requested tool is not available");
    }
    await this.authorization.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "project.members.manage",
      projectId: input.projectId,
      agentId: input.agentId,
      resource: { kind: "project", id: input.projectId },
    });
    if (!this.approvals) throw new PermitApprovalError();
    if (input.scope === "project") {
      return this.approvals.grantProjectAccess({
        agentId: input.agentId,
        projectId: input.projectId,
        toolId: input.toolId,
      });
    }
    const approval = await this.approvals.requestOperationApproval({
      agentId: input.agentId,
      projectId: input.projectId,
      toolId: input.toolId,
    });
    return this.approvals.approve(approval.id, "once");
  }

  async revokeGrant(
    grantId: string,
  ): Promise<PermitApprovalRecord> {
    if (!this.approvals) throw new PermitApprovalError();
    const current = await this.approvals.getApproval(grantId);
    if (current.kind !== "access_request") {
      throw new ToolError("TOOL_NOT_FOUND", 404, "Capability grant not found");
    }
    await this.authorization.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "project.members.manage",
      projectId: current.projectId ?? undefined,
      agentId: current.agentId,
      ...(current.projectId === null ? {} : { resource: { kind: "project", id: current.projectId } }),
    });
    return this.approvals.revokeProjectAccess(grantId);
  }

  private async requestOperationApproval(
    context: ToolExecutionContext,
    toolId: string,
  ): Promise<PermitApprovalRecord> {
    if (!this.approvals || !this.approvals.isAvailable()) {
      throw new ToolError(
        "PERMISSION_DENIED",
        503,
        "Permit approval is unavailable",
      );
    }
    return this.approvals.requestOperationApproval({
      agentId: context.agentId,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      runId: context.runId,
      toolId,
      safeSummary: "Agent requested approval for " + toolId,
    });
  }

  private async recordToolEvent(
    type: AuditEventType,
    context: ToolExecutionContext,
    definition: ToolDefinition,
    summary: string,
    status: "success" | "failure",
    metadata: Readonly<Record<string, unknown>>,
    permitRequestId?: string,
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
      ...(permitRequestId === undefined ? {} : { permitRequestId }),
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
