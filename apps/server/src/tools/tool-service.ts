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
  PreparedToolInvocation,
  ToolApprovalPolicy,
  ToolCapabilitiesView,
  ToolCapabilityView,
  ToolDefinition,
  ToolExecutionCorrelation,
  ToolExecutionContext,
  ToolMetadata,
} from "./tool-types.js";
import {
  NO_TOOL_APPROVAL_POLICY as DEFAULT_TOOL_APPROVAL_POLICY,
  approvalDecisionAuthorityForTool,
} from "./tool-types.js";
import { SUPPORTED_PERMISSION_IDS } from "../access/permission-types.js";

const MAX_SAFE_REASON_LENGTH = 512;
const TOOL_EXECUTION_CLAIM_CONSTRUCTOR: unique symbol = Symbol("tool-execution-claim");

/**
 * A nominal execution capability. The constructor requires a module-private
 * token and ToolService additionally verifies object identity in a WeakMap
 * before it can reach a business executor. In particular, a structural object
 * containing a callback or a truthy boolean is not a capability.
 */
export class ToolExecutionClaim {
  constructor(token: typeof TOOL_EXECUTION_CLAIM_CONSTRUCTOR) {
    if (token !== TOOL_EXECUTION_CLAIM_CONSTRUCTOR) {
      throw new TypeError("ToolExecutionClaim is server-owned");
    }
  }
}

/** Optional server-owned controls for a prepared executor invocation. */
export interface ToolExecutionOptions {
  /** Signal propagated from the native approval workflow cancellation path. */
  readonly abortSignal?: AbortSignal;
  /**
   * Final server-owned fence run after async audit/revalidation and before the
   * one-shot execution claim is consumed. Approval workflows use this to CAS
   * cancellation against the executor boundary.
   */
  readonly beforeExecute?: () => void | Promise<void>;
}

function normalizeExecutionCorrelation(
  correlation: ToolExecutionCorrelation | undefined,
): ToolExecutionCorrelation | undefined {
  if (correlation === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const key of ["traceId", "parentSpanId", "turnId", "sessionId", "invocationId", "approvalId", "workflowRunId"] as const) {
    const value = correlation[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new ToolError(
        "TOOL_EXECUTION_CLAIM_FAILED",
        409,
        "The approval execution correlation is invalid",
      );
    }
    result[key] = value.trim();
  }
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result);
}

function directAgentToolPermission(toolId: string): PermissionId | undefined {
  if (toolId === "web.search") return "tool.execute:web.search";
  if (toolId === "web.fetch") return "tool.execute:web.fetch";
  return undefined;
}

function isDirectAgentTool(toolId: string): boolean {
  return directAgentToolPermission(toolId) !== undefined;
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

function approvalPolicyFor(definition: ToolDefinition): ToolApprovalPolicy {
  const policy = definition.approvalPolicy;
  if (policy === undefined) return DEFAULT_TOOL_APPROVAL_POLICY;
  if (
    (policy.mode !== "none" && policy.mode !== "required") ||
    typeof policy.version !== "string" ||
    policy.version.trim().length === 0
  ) {
    // A malformed code-owned policy must fail closed. In particular, it must
    // never be normalized to `none` and accidentally bypass a pending gate.
    throw new ToolError(
      "TOOL_INVOCATION_INVALIDATED",
      409,
      "The " + definition.id + " tool has an invalid approval policy",
    );
  }
  if (policy.decisionAuthority !== undefined) {
    const authority = policy.decisionAuthority;
    if (
      authority.kind !== "project-owner" ||
      typeof authority.permission !== "string" ||
      !SUPPORTED_PERMISSION_IDS.includes(authority.permission)
    ) {
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "The " + definition.id + " tool has an invalid approval decision authority",
      );
    }
  }
  return Object.freeze({
    mode: policy.mode,
    version: policy.version,
    ...(policy.decisionAuthority === undefined
      ? {}
      : {
          decisionAuthority: Object.freeze({
            kind: policy.decisionAuthority.kind,
            permission: policy.decisionAuthority.permission,
          }),
        }),
  });
}

function metadataFor(definition: ToolDefinition): ToolMetadata {
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    risk: definition.risk,
    requiredPermission: definition.requiredPermission,
    approvalPolicy: approvalPolicyFor(definition),
  };
}

class ToolInputSnapshotError extends Error {}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/**
 * Clone the input boundary before checking or parsing it. MCP inputs are
 * JSON-like, so mutable/exotic objects (including Date, Map and Set) are
 * rejected rather than pretending Object.freeze makes their internal state
 * immutable.
 */
function cloneInputValue(
  value: unknown,
  path = "$",
  active = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ToolInputSnapshotError("Unsupported non-finite number at " + path);
    }
    return value;
  }
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") {
    throw new ToolInputSnapshotError("Unsupported input value at " + path);
  }

  if (active.has(value)) {
    throw new ToolInputSnapshotError("Cyclic input at " + path);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new ToolInputSnapshotError("Symbol properties are not supported at " + path);
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        copy[index] = cloneInputValue(value[index], path + "[" + index + "]", active);
      }
      // Sparse arrays and custom enumerable properties are not JSON input and
      // would otherwise be absent from the binding.
      for (const key of Object.keys(value)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new ToolInputSnapshotError("Custom array properties are not supported at " + path);
        }
      }
      return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ToolInputSnapshotError("Unsupported object type at " + path);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ToolInputSnapshotError("Symbol properties are not supported at " + path);
    }
    const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
    for (const key of Object.keys(value)) {
      copy[key] = cloneInputValue(
        (value as Record<string, unknown>)[key],
        path + "." + key,
        active,
      );
    }
    return copy;
  } finally {
    active.delete(value);
  }
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isObjectLike(value) || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeSnapshot(item, seen);
  } else {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeSnapshot(nested, seen);
    }
  }
  return Object.freeze(value);
}

function protectedSnapshot(value: unknown): unknown {
  return freezeSnapshot(cloneInputValue(value));
}

function freezeContext(context: ToolExecutionContext): ToolExecutionContext {
  const principal = Object.freeze({ ...context.principal });
  return Object.freeze({ ...context, principal });
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null;";
  if (typeof value === "undefined") return "undefined;";
  if (typeof value === "string") return "string:" + JSON.stringify(value) + ";";
  if (typeof value === "boolean") return value ? "true;" : "false;";
  if (typeof value === "number") return "number:" + String(value) + ";";
  if (Array.isArray(value)) {
    return "array[" + value.map((item) => canonicalValue(item)).join("") + "];";
  }
  if (isObjectLike(value)) {
    return (
      "object{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalValue((value as Record<string, unknown>)[key]))
        .join("") +
      "};"
    );
  }
  // protectedSnapshot rejects this branch. Keep a deterministic fallback for
  // defensive callers rather than silently returning an empty binding.
  return typeof value + ":" + String(value) + ";";
}

function inputBinding(value: unknown): string {
  return canonicalValue(value);
}

function principalBinding(context: ToolExecutionContext): string {
  return JSON.stringify({
    principal: context.principal,
    agentId: context.agentId,
    projectId: context.projectId ?? null,
    runId: context.runId,
    orchestrationId: context.orchestrationId ?? null,
    toolId: context.toolId ?? null,
  });
}

function samePolicy(left: ToolApprovalPolicy, right: ToolApprovalPolicy): boolean {
  return left.mode === right.mode && left.version === right.version;
}

type PreparationFailure = {
  ok: false;
  error: ToolError;
  definition?: ToolDefinition;
  auditMetadata?: Readonly<Record<string, unknown>>;
};

interface PreparedInvocationState {
  /** Server-private clone of the request before schema parsing. */
  readonly rawInput: unknown;
  /** Server-private parsed (and potentially transformed) executor value. */
  readonly input: unknown;
}

type PreparationSuccess = {
  ok: true;
  invocation: PreparedToolInvocation;
  state: PreparedInvocationState;
};

type PreparationResult = PreparationFailure | PreparationSuccess;

export interface ProjectRoleToolResolver {
  /** Resolve the Agent-global role for the execution scope. */
  getEffectiveRole(
    agentId: string,
    projectId?: string,
  ): { toolIds: string[] } | undefined;
}

/** Server-owned facts used for a side-effect-free authorization recheck. */
export interface CurrentAgentToolAuthorizationInput {
  readonly agentId: string;
  readonly projectId?: string;
  readonly runId: string;
  readonly orchestrationId?: string;
  readonly toolId: string;
}

/**
 * Typed gateway for all registered executors. Repository authorization is the
 * policy authority for Project-scoped calls; an explicitly assigned
 * Agent-global role is required for network calls in every scope. The store
 * is used only to resolve trusted Agent roles and never grants capabilities.
 */
export class ToolService {
  private roleTools?: ProjectRoleToolResolver;
  /** Envelopes and their raw/parsed values are owned by this service instance. */
  private readonly preparedInvocations = new WeakMap<object, PreparedInvocationState>();
  /** Claims are one-shot object capabilities bound to one prepared envelope. */
  private readonly executionClaims = new WeakMap<object, PreparedToolInvocation>();
  /** Correlation is bound to the same server-owned one-shot claim. */
  private readonly executionClaimCorrelation = new WeakMap<object, ToolExecutionCorrelation>();
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

  private assertOwnedPrepared(
    prepared: PreparedToolInvocation,
  ): asserts prepared is PreparedToolInvocation {
    if (
      prepared === null ||
      typeof prepared !== "object" ||
      !this.preparedInvocations.has(prepared)
    ) {
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "The prepared tool invocation is not owned by this ToolService",
      );
    }
  }

  private async recordAuthorizationRejection(
    context: ToolExecutionContext,
    definition: ToolDefinition,
    summary: string,
    errorCode: string,
  ): Promise<void> {
    // A pre-execution fence is a policy/approval outcome, not a tool failure:
    // there is no tool_started event and therefore no business execution to
    // count. Keep it in the authorization stream for audit/usage consumers.
    await this.recordToolEvent(
      "authorization_decision",
      context,
      definition,
      summary,
      "failure",
      {
        phase: "execution_guard",
        decision: "denied",
        errorCode,
      },
    );
  }

  private ownsExecutionClaim(
    prepared: PreparedToolInvocation,
    claim: unknown,
  ): claim is ToolExecutionClaim {
    return (
      claim !== null &&
      typeof claim === "object" &&
      this.executionClaims.get(claim) === prepared
    );
  }

  /**
   * Mint the capability handed to the trusted approval bridge after its
   * durable execution claim wins.  This method is intentionally not a
   * boolean/callback guard: the returned nominal object is checked by identity
   * and is bound to this exact prepared invocation.  HTTP/MCP payloads cannot
   * manufacture one.  The bridge must perform its own storage/liveness fence
   * before calling this server-owned issuance seam.
   */
  issueExecutionClaim(
    prepared: PreparedToolInvocation,
    correlation?: ToolExecutionCorrelation,
  ): ToolExecutionClaim {
    this.assertOwnedPrepared(prepared);
    if (
      prepared.policy.mode !== "required" ||
      prepared.context.principal.kind !== "agent"
    ) {
      throw new ToolError(
        "TOOL_EXECUTION_CLAIM_FAILED",
        409,
        "An execution claim is only valid for an approval-required Agent tool",
      );
    }
    const normalizedCorrelation = normalizeExecutionCorrelation(correlation);
    const claim = new ToolExecutionClaim(TOOL_EXECUTION_CLAIM_CONSTRUCTOR);
    this.executionClaims.set(claim, prepared);
    if (normalizedCorrelation !== undefined) {
      this.executionClaimCorrelation.set(claim, normalizedCorrelation);
    }
    return claim;
  }

  private roleAllowsTool(
    agentId: string,
    projectId: string | undefined,
    toolId: string,
    requireRole = false,
    requiredPermission?: PermissionId,
  ): boolean {
    if (requireRole) {
      // Network tools are Agent capabilities in every scope. A Project
      // membership can narrow that capability, but it cannot supply either
      // half of the Agent-global tool grant when RoleService is absent.
      const correspondingPermission = directAgentToolPermission(toolId);
      if (
        requiredPermission === undefined ||
        correspondingPermission !== requiredPermission ||
        !this.globalRoleAllowsTool(agentId, toolId, correspondingPermission)
      ) {
        return false;
      }
      // The Project authorization decision below remains authoritative for a
      // Project-scoped run. Returning here only records that the Agent role
      // gate has passed; it does not bypass membership policy.
      return true;
    }
    if (!this.roleTools) return !requireRole;
    // Project-scoped tools retain the existing membership baseline when no
    // explicit Agent role is configured. If a resolver is present, its tool
    // list can further narrow that baseline.
    const role = this.roleTools.getEffectiveRole(agentId, projectId);
    if (!role) return !requireRole;
    return role?.toolIds.includes(toolId) ?? false;
  }

  /**
   * For the two public network tools, the human-assigned Agent-global role
   * must contain both the executable tool and its corresponding permission.
   * Project authorization still narrows Project-scoped calls.
   */
  private globalRoleAllowsTool(
    agentId: string,
    toolId: string,
    requiredPermission: PermissionId,
  ): boolean {
    const snapshot = this._store.snapshot();
    const agent = snapshot.agents.find((item) => item.id === agentId);
    if (!agent?.globalRoleId) return false;
    const role = snapshot.roles.find((item) => item.id === agent.globalRoleId);
    if (!role || !Array.isArray(role.toolIds) || !Array.isArray(role.permissionIds)) {
      return false;
    }
    return role.toolIds.includes(toolId) && role.permissionIds.includes(requiredPermission);
  }

  /**
   * Recheck the current Agent role/tool grant and repository policy without
   * preparing input or invoking an executor.  Approval routes use this as a
   * narrow liveness witness; final execution still runs the complete
   * prepareInternal/executePrepared revalidation against the original input.
   */
  async assertCurrentAgentToolAuthorized(
    input: CurrentAgentToolAuthorizationInput,
  ): Promise<void> {
    const definition = this.registry.get(input.toolId);
    if (definition === undefined) {
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "The approval tool is no longer registered",
      );
    }
    const requiresGlobalRole = isDirectAgentTool(input.toolId);
    if (
      !this.roleAllowsTool(
        input.agentId,
        input.projectId,
        input.toolId,
        requiresGlobalRole,
        definition.requiredPermission,
      )
    ) {
      throw new ToolError(
        "PERMISSION_DENIED",
        403,
        "The assigned Agent role does not include this tool",
      );
    }

    const directGlobalRole =
      input.projectId === undefined &&
      requiresGlobalRole &&
      this.globalRoleAllowsTool(input.agentId, input.toolId, definition.requiredPermission);
    const decision: AuthorizationDecision = directGlobalRole
      ? { result: "allow", reason: "Agent global role authorized " + input.toolId }
      : await this.authorization.decide({
          principal: agentPrincipal(input.agentId),
          permission: definition.requiredPermission,
          resource: toolResource(input.toolId),
          context: {
            agentId: input.agentId,
            runId: input.runId,
            toolId: input.toolId,
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            ...(input.orchestrationId === undefined
              ? {}
              : { orchestrationId: input.orchestrationId }),
          },
        });
    if (decision.result !== "allow") {
      throw new ToolError(
        "PERMISSION_DENIED",
        403,
        safeReason(decision.reason),
      );
    }
  }

  listMetadata(): ToolMetadata[] {
    return this.registry.list().map((definition) => metadataFor(definition));
  }

  /**
   * Run the shared authorization/input preparation without starting a tool.
   * This is the only preparation seam the approval workflow may consume. It
   * never accepts an approval boolean or creates an approval/workflow record;
   * a denied request still emits the existing authorization audit event.
   */
  async prepareInvocation(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
  ): Promise<PreparedToolInvocation> {
    const result = await this.prepareInternal(context, toolId, input);
    if (!result.ok) {
      await this.recordPreparationFailure(context, result);
      throw result.error;
    }
    this.preparedInvocations.set(result.invocation, result.state);
    return result.invocation;
  }

  /** Short alias for workflow/bridge callers that prefer a verb-first name. */
  async prepare(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
  ): Promise<PreparedToolInvocation> {
    return this.prepareInvocation(context, toolId, input);
  }

  async execute(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
  ): Promise<unknown> {
    const result = await this.prepareInternal(context, toolId, input);
    if (!result.ok) {
      await this.recordPreparationFailure(context, result);
      throw result.error;
    }
    const invocation = result.invocation;
    // `executePrepared` is intentionally an ownership-checked seam. Register
    // this invocation before delegating so ordinary safe calls and the trusted
    // human test route use the same final-execution path without being rejected
    // as forged envelopes.
    this.preparedInvocations.set(invocation, result.state);
    if (
      invocation.policy.mode === "required" &&
      invocation.context.principal.kind === "agent"
    ) {
      await this.recordToolEvent(
        "tool_approval_required",
        invocation.context,
        invocation.definition,
        "Human approval is required for " + toolId,
        "success",
        {
          phase: "approval",
          policyVersion: invocation.policy.version,
          approvalMode: invocation.policy.mode,
        },
      );
      throw new ToolError(
        "APPROVAL_REQUIRED",
        409,
        "Human approval is required before the Agent can use this tool",
      );
    }
    // The human control-plane route is an intentional, trusted path. It is
    // selected by the server-created principal, never by tool input. Agent
    // callers of this method cannot opt into it.
    return this.executePrepared(invocation);
  }

  /**
   * Revalidate and execute a prepared invocation. Approval-required Agent
   * invocations must supply the one-shot claim issued by the trusted approval
   * bridge; without it this method fails closed before invoking the executor.
   */
  async executePrepared(
    prepared: PreparedToolInvocation,
    claim?: ToolExecutionClaim,
    options: ToolExecutionOptions = {},
  ): Promise<unknown> {
    this.assertOwnedPrepared(prepared);
    const preparedState = this.preparedInvocations.get(prepared);
    if (preparedState === undefined) {
      // Keep the ownership check and private input lookup coupled. This is
      // defensive for unusual WeakMap/proxy behavior and avoids ever asking a
      // caller-provided envelope for executable input.
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "The prepared tool invocation has no protected input state",
      );
    }
    const currentDefinition = this.registry.get(prepared.toolId);
    if (currentDefinition === undefined || currentDefinition !== prepared.definition) {
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "The prepared tool invocation is no longer valid",
      );
    }

    const preparedApprovalRequired =
      prepared.policy.mode === "required" &&
      prepared.context.principal.kind === "agent";
    if (preparedApprovalRequired) {
      if (!this.ownsExecutionClaim(prepared, claim)) {
        const errorCode = claim === undefined
          ? "APPROVAL_REQUIRED"
          : "TOOL_EXECUTION_CLAIM_FAILED";
        await this.recordAuthorizationRejection(
          prepared.context,
          prepared.definition,
          "The approval execution claim is missing or invalid",
          errorCode,
        );
        throw new ToolError(
          claim === undefined ? "APPROVAL_REQUIRED" : "TOOL_EXECUTION_CLAIM_FAILED",
          409,
          claim === undefined
            ? "The approval execution claim is required for this Agent tool"
            : "The approval execution claim is no longer available",
        );
      }
    } else if (claim !== undefined) {
      // A claim cannot turn a safe or trusted-human invocation into a special
      // path. It is accepted only when the prepared policy requires it.
      await this.recordAuthorizationRejection(
        prepared.context,
        prepared.definition,
        "The execution claim does not match this tool invocation",
        "TOOL_EXECUTION_CLAIM_FAILED",
      );
      throw new ToolError(
        "TOOL_EXECUTION_CLAIM_FAILED",
        409,
        "The execution claim does not match this tool invocation",
      );
    }

    const current = await this.prepareInternal(
      prepared.context,
      prepared.toolId,
      preparedState.rawInput,
    );
    if (!current.ok) {
      await this.recordPreparationFailure(prepared.context, current, prepared.definition);
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "Authorization for the prepared tool invocation changed",
      );
    }
    const currentInvocation = current.invocation;
    if (
      currentInvocation.rawInputBinding !== prepared.rawInputBinding ||
      currentInvocation.inputBinding !== prepared.inputBinding ||
      currentInvocation.principalBinding !== prepared.principalBinding ||
      !samePolicy(currentInvocation.policy, prepared.policy)
    ) {
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "The prepared tool invocation no longer matches its authorized request",
      );
    }

    const approvalRequired =
      currentInvocation.policy.mode === "required" &&
      currentInvocation.context.principal.kind === "agent";
    if (approvalRequired && !this.ownsExecutionClaim(prepared, claim)) {
      await this.recordAuthorizationRejection(
        currentInvocation.context,
        currentInvocation.definition,
        "The approval execution claim is required for this Agent tool",
        "APPROVAL_REQUIRED",
      );
      throw new ToolError(
        "APPROVAL_REQUIRED",
        409,
        "The approval execution claim is required for this Agent tool",
      );
    }
    let executionCorrelation: ToolExecutionCorrelation | undefined;
    if (approvalRequired) {
      // Read the correlation while the claim is still server-owned. It is
      // carried into the execution context before the started event is
      // emitted; the claim and its correlation are consumed together at the
      // final executor boundary below.
      executionCorrelation = this.executionClaimCorrelation.get(claim as ToolExecutionClaim);
    }
    // Use the original protected parsed input, not the value returned by a
    // second schema parse. This preserves one-way transforms and keeps the
    // executor bound to exactly what was authorized at preparation time.
    return this.runPreparedExecutor(
      prepared,
      preparedState,
      options.abortSignal,
      executionCorrelation,
      approvalRequired ? claim : undefined,
      options.beforeExecute,
    );
  }

  /**
   * Authorization/input preparation. Storage and policy reads are consulted,
   * but this method does not create approvals, workflows, claims or business
   * side effects. Its caller owns the denial audit decision.
   */
  private async prepareInternal(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
  ): Promise<PreparationResult> {
    const definition = this.registry.get(toolId);
    if (!definition) {
      return {
        ok: false,
        error: new ToolError("TOOL_NOT_FOUND", 404, "The requested tool is not available"),
      };
    }

    // Snapshot the caller's request before any authorization check or Zod
    // parsing. This prevents a caller from mutating a shared object while the
    // request is being prepared and keeps the raw value available for a later
    // revalidation even when parsing applies a one-way transform.
    let rawInput: unknown;
    try {
      rawInput = protectedSnapshot(input);
    } catch {
      return {
        ok: false,
        error: new ToolError("TOOL_INVALID_INPUT", 422, "Invalid input for " + toolId),
        definition,
      };
    }

    let policy: ToolApprovalPolicy;
    try {
      policy = approvalPolicyFor(definition);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof ToolError
          ? error
          : new ToolError(
              "TOOL_INVOCATION_INVALIDATED",
              409,
              "The " + toolId + " tool has an invalid approval policy",
              { cause: error },
            ),
        definition,
        auditMetadata: {
          phase: "authorization",
          decision: "invalid_policy",
          errorCode: "TOOL_INVOCATION_INVALIDATED",
        },
      };
    }

    const denied = (
      error: ToolError,
      decision: string,
    ): PreparationFailure => ({
      ok: false,
      error,
      definition,
      auditMetadata: {
        phase: "authorization",
        decision,
        errorCode: error.code,
      },
    });

    if (context.principal.kind === "agent" && context.principal.id !== context.agentId) {
      return denied(
        new ToolError("PERMISSION_DENIED", 403, "Tool identity does not match the run"),
        "identity_mismatch",
      );
    }
    if (
      context.principal.kind === "agent" &&
      context.projectId === undefined &&
      !isDirectAgentTool(toolId)
    ) {
      return denied(
        new ToolError(
          "PERMISSION_DENIED",
          403,
          "A Project-scoped Agent run is required for this tool",
        ),
        "project_required",
      );
    }
    if (
      context.principal.kind === "agent" &&
      !this.roleAllowsTool(
        context.agentId,
        context.projectId,
        toolId,
        isDirectAgentTool(toolId),
        definition.requiredPermission,
      )
    ) {
      return denied(
        new ToolError(
          "PERMISSION_DENIED",
          403,
          "The assigned Agent role does not include this tool",
        ),
        "agent_role",
      );
    }

    // Check the raw payload before Zod object parsing (which may strip
    // unknown keys), so a caller cannot smuggle a different Project selector
    // into an otherwise empty Project-tool input schema.
    if (
      rawInput !== null &&
      typeof rawInput === "object" &&
      "projectId" in rawInput &&
      (rawInput as { projectId?: unknown }).projectId !== context.projectId
    ) {
      return denied(
        new ToolError("PERMISSION_DENIED", 403, "Tool input cannot change the run Project"),
        "project_input_raw",
      );
    }
    const parsed = definition.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: new ToolError("TOOL_INVALID_INPUT", 422, "Invalid input for " + toolId),
        definition,
      };
    }
    if (
      parsed.data !== null &&
      typeof parsed.data === "object" &&
      "projectId" in parsed.data &&
      (parsed.data as { projectId?: unknown }).projectId !== context.projectId
    ) {
      return denied(
        new ToolError("PERMISSION_DENIED", 403, "Tool input cannot change the run Project"),
        "project_input_parsed",
      );
    }

    const directGlobalRole =
      context.principal.kind === "agent" &&
      context.projectId === undefined &&
      isDirectAgentTool(toolId) &&
      this.globalRoleAllowsTool(
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
      return denied(
        new ToolError("PERMISSION_DENIED", 403, safeReason(decision.reason)),
        decision.result,
      );
    }

    const frozenContext = freezeContext(context);
    let frozenInput: unknown;
    try {
      // Zod transforms can return the original input or introduce a new
      // mutable object. Always snapshot the parsed result independently so
      // rawInput and executor input cannot alias one another.
      frozenInput = protectedSnapshot(parsed.data);
    } catch {
      return {
        ok: false,
        error: new ToolError("TOOL_INVALID_INPUT", 422, "Invalid input for " + toolId),
        definition,
      };
    }
    const invocation = Object.freeze({
      kind: "prepared-tool-invocation" as const,
      toolId: definition.id,
      definition,
      context: frozenContext,
      rawInputBinding: inputBinding(rawInput),
      inputBinding: inputBinding(frozenInput),
      principalBinding: principalBinding(frozenContext),
      policy,
      preparedAt: Date.now(),
    });
    return {
      ok: true,
      invocation,
      state: Object.freeze({
        rawInput,
        input: frozenInput,
      }),
    };
  }

  private async recordPreparationFailure(
    context: ToolExecutionContext,
    failure: PreparationFailure,
    definitionOverride?: ToolDefinition,
  ): Promise<void> {
    const definition = failure.definition ?? definitionOverride;
    if (!definition || failure.error.code === "TOOL_INVALID_INPUT") return;
    await this.recordToolEvent(
      "tool_failed",
      context,
      definition,
      "Tool authorization denied: " + definition.id,
      "failure",
      failure.auditMetadata ?? {
        phase: "authorization",
        decision: "denied",
        errorCode: failure.error.code,
      },
    );
  }

  private async runPreparedExecutor(
    invocation: PreparedToolInvocation,
    state: PreparedInvocationState,
    abortSignal?: AbortSignal,
    executionCorrelation?: ToolExecutionCorrelation,
    executionClaim?: ToolExecutionClaim,
    beforeExecute?: () => void | Promise<void>,
  ): Promise<unknown> {
    const { context, toolId, definition } = invocation;
    const { input } = state;
    // Do not emit a business-execution event or call an executor after a
    // trusted workflow has already been cancelled. The durable approval claim
    // is settled by the workflow caller when this guard throws.
    if (abortSignal?.aborted) {
      throw new ToolError(
        "TOOL_EXECUTION_EXPIRED",
        409,
        "The tool execution was cancelled before it started",
      );
    }
    const executionContext = freezeContext({
      ...context,
      ...(executionCorrelation === undefined ? {} : executionCorrelation),
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    await this.recordToolEvent(
      "tool_started",
      executionContext,
      definition,
      "Tool execution started: " + toolId,
      "success",
      {
        risk: definition.risk,
        ...(invocation.policy.mode === "required"
          ? { policyVersion: invocation.policy.version }
          : {}),
      },
    );

    // Audit is intentionally awaited before business execution. Re-check the
    // transport fence after that await, then run the server-owned durable
    // approval CAS. No asynchronous work remains between this check, claim
    // consumption, and invoking the executor.
    if (abortSignal?.aborted) {
      throw new ToolError(
        "TOOL_EXECUTION_EXPIRED",
        409,
        "The tool execution was cancelled before it started",
      );
    }
    await beforeExecute?.();
    if (abortSignal?.aborted) {
      throw new ToolError(
        "TOOL_EXECUTION_EXPIRED",
        409,
        "The tool execution was cancelled before it started",
      );
    }
    if (invocation.policy.mode === "required" && invocation.context.principal.kind === "agent") {
      // Delete synchronously at the final boundary. A cancellation that wins
      // the durable CAS above leaves this claim untouched and therefore
      // cannot reach the executor.
      if (!this.executionClaims.delete(executionClaim as ToolExecutionClaim)) {
        await this.recordAuthorizationRejection(
          invocation.context,
          invocation.definition,
          "The approval execution claim is no longer available",
          "TOOL_EXECUTION_CLAIM_FAILED",
        );
        throw new ToolError(
          "TOOL_EXECUTION_CLAIM_FAILED",
          409,
          "The approval execution claim is no longer available",
        );
      }
      this.executionClaimCorrelation.delete(executionClaim as ToolExecutionClaim);
    }

    let output: unknown;
    const executionStartedAt = Date.now();
    try {
      const execute = () => definition.execute(executionContext, input);
      output = this.telemetry
        ? await this.telemetry.withSpan(
            "tool.execute",
            {
              ...correlationAttributes({
                principalKind: executionContext.principal.kind,
                principalId: executionContext.principal.id,
                agentId: executionContext.agentId,
                ...(executionContext.projectId === undefined ? {} : { projectId: executionContext.projectId }),
                runId: executionContext.runId,
                ...(executionContext.orchestrationId === undefined
                  ? {}
                  : { orchestrationId: executionContext.orchestrationId }),
                ...(executionContext.traceId === undefined ? {} : { "trace.id": executionContext.traceId }),
                ...(executionContext.parentSpanId === undefined
                  ? {}
                  : { "trace.parent.id": executionContext.parentSpanId }),
                ...(executionContext.turnId === undefined ? {} : { turnId: executionContext.turnId }),
                ...(executionContext.sessionId === undefined ? {} : { sessionId: executionContext.sessionId }),
                ...(executionContext.invocationId === undefined ? {} : { invocationId: executionContext.invocationId }),
                ...(executionContext.approvalId === undefined ? {} : { approvalId: executionContext.approvalId }),
                ...(executionContext.workflowRunId === undefined ? {} : { workflowRunId: executionContext.workflowRunId }),
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
        executionContext,
        definition,
        "Tool execution succeeded: " + toolId,
        "success",
        { risk: definition.risk, durationMs: Date.now() - executionStartedAt },
      );
      return validatedOutput.data;
    } catch (error) {
      await this.recordToolEvent(
        "tool_failed",
        executionContext,
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
      this.registry.list().map(async (definition) => {
        const tool = metadataFor(definition);
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
            isDirectAgentTool(tool.id),
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
          this.globalRoleAllowsTool(agentId, tool.id, tool.requiredPermission);
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
      ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.invocationId === undefined ? {} : { invocationId: context.invocationId }),
      ...(context.approvalId === undefined ? {} : { approvalId: context.approvalId }),
      ...(context.workflowRunId === undefined ? {} : { workflowRunId: context.workflowRunId }),
      permission: definition.requiredPermission,
      resource: { kind: "tool", id: definition.id },
      metadata,
      ...(context.traceId === undefined
        ? {}
        : {
            span: {
              traceId: context.traceId,
              ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }),
            },
          }),
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
