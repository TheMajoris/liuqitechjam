import { Permit, type IPermitClient } from "permitio";
import type { AppConfig } from "../config.js";
import { isPermitConfigured } from "../config.js";
import type { AuditRecorder } from "../audit/audit-types.js";
import { correlationAttributes, type RuntimeTelemetry } from "../telemetry/telemetry-types.js";
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  AuthorizationService,
} from "./authorization-service.js";
import { AuthorizationError } from "./authorization-service.js";
import type { PermitSynchronizationGateLike } from "./permit-synchronization-gate.js";
import {
  mapAuthorizationRequestToPermitCheck,
  type PermitAuthorizationCheck,
  type PermitContext,
  type PermitResource,
} from "./permit-policy.js";

/**
 * The only Permit surface required by authorization. Keeping this interface
 * narrower than the SDK client makes the policy boundary straightforward to
 * fake and prevents service code from reaching Permit management APIs.
 */
export interface PermitCheckClient {
  check(
    user: string,
    action: string,
    resource: PermitResource,
    context?: PermitContext,
  ): Promise<unknown>;
}

export interface PermitAuthorizationConfig {
  apiKey?: string;
  pdpUrl?: string;
  projectId?: string;
  environmentId?: string;
  tenantKey?: string;
  operationApprovalConfigId?: string;
}

export interface PermitAuthorizationAdapterOptions
  extends PermitAuthorizationConfig {
  client?: PermitCheckClient | null;
  synchronizationGate?: PermitSynchronizationGateLike;
  timeoutMs?: number;
  audit?: AuditRecorder;
  telemetry?: RuntimeTelemetry;
  /** Factories set this for production; direct fakes may omit configuration. */
  requireConfiguration?: boolean;
}

const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

const DENY_REASONS = {
  invalidRequest: "Authorization request is invalid",
  notConfigured: "Permit authorization is not configured",
  unavailable: "Permit authorization is unavailable",
  timedOut: "Permit authorization timed out",
  malformed: "Permit returned an invalid authorization decision",
  denied: "Permit policy denied the operation",
  synchronizationUnavailable: "Permit authorization is not synchronized",
} as const;

function safeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.min(Math.floor(value), 120_000)
    : DEFAULT_CHECK_TIMEOUT_MS;
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.startsWith("replace-");
}

function isCompleteConfiguration(config: PermitAuthorizationConfig): boolean {
  return (
    hasText(config.apiKey) &&
    hasText(config.pdpUrl) &&
    hasText(config.projectId) &&
    hasText(config.environmentId) &&
    hasText(config.tenantKey) &&
    hasText(config.operationApprovalConfigId)
  );
}

class PermitCheckTimeoutError extends Error {
  constructor() {
    super(DENY_REASONS.timedOut);
    this.name = "PermitCheckTimeoutError";
  }
}

class PermitSynchronizationUnavailableError extends Error {
  constructor() {
    super(DENY_REASONS.synchronizationUnavailable);
    this.name = "PermitSynchronizationUnavailableError";
  }
}

function permitCheckWithTimeout(
  client: PermitCheckClient,
  check: PermitAuthorizationCheck,
  timeoutMs: number,
  beforeCheck?: () => boolean,
): Promise<unknown> {
  const pending = Promise.resolve().then(() => {
    if (beforeCheck !== undefined && !beforeCheck()) {
      throw new PermitSynchronizationUnavailableError();
    }
    return client.check(check.user, check.action, check.resource, check.context);
  });
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PermitCheckTimeoutError()), timeoutMs);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function deny(reason: string): AuthorizationDecision {
  return { result: "deny", reason, errorCode: "PERMISSION_DENIED" };
}

/**
 * Production authorization adapter. Permit is the sole decision authority;
 * this class deliberately has no repository role evaluation or fallback.
 */
export class PermitAuthorizationAdapter implements AuthorizationService {
  private readonly client: PermitCheckClient | null;
  private readonly config: PermitAuthorizationConfig;
  private readonly timeoutMs: number;
  private readonly requireConfiguration: boolean;
  private readonly synchronizationGate: PermitSynchronizationGateLike | undefined;
  private readonly audit: AuditRecorder | undefined;
  private readonly telemetry: RuntimeTelemetry | undefined;

  constructor(
    client: PermitCheckClient | null | undefined,
    config?: PermitAuthorizationConfig & {
      synchronizationGate?: PermitSynchronizationGateLike;
      timeoutMs?: number;
      requireConfiguration?: boolean;
      audit?: AuditRecorder;
      telemetry?: RuntimeTelemetry;
    },
  );
  constructor(options: PermitAuthorizationAdapterOptions);
  constructor(
    clientOrOptions: PermitCheckClient | PermitAuthorizationAdapterOptions | null | undefined,
    config: PermitAuthorizationConfig & {
      synchronizationGate?: PermitSynchronizationGateLike;
      timeoutMs?: number;
      requireConfiguration?: boolean;
      audit?: AuditRecorder;
      telemetry?: RuntimeTelemetry;
    } = {},
  ) {
    const isOptions =
      clientOrOptions !== null &&
      typeof clientOrOptions === "object" &&
      ("client" in clientOrOptions || "apiKey" in clientOrOptions || "requireConfiguration" in clientOrOptions);
    if (isOptions) {
      const options = clientOrOptions as PermitAuthorizationAdapterOptions;
      this.client = options.client ?? null;
      this.config = options;
      this.timeoutMs = safeTimeout(options.timeoutMs);
      this.requireConfiguration = options.requireConfiguration ?? false;
      this.synchronizationGate = options.synchronizationGate;
      this.audit = options.audit;
      this.telemetry = options.telemetry;
      return;
    }
    this.client = (clientOrOptions as PermitCheckClient | null | undefined) ?? null;
    this.config = config;
    this.timeoutMs = safeTimeout(config.timeoutMs);
    this.requireConfiguration = config.requireConfiguration ?? false;
    this.synchronizationGate = config.synchronizationGate;
    this.audit = config.audit;
    this.telemetry = config.telemetry;
  }

  /** Exposed for startup diagnostics without exposing any secret values. */
  isConfigured(): boolean {
    return (
      this.client !== null &&
      (!this.requireConfiguration || isCompleteConfiguration(this.config))
    );
  }

  async decide(input: AuthorizationRequest): Promise<AuthorizationDecision> {
    const startedAt = Date.now();
    const decision = await this.decideInternal(input);
    await this.recordDecision(input, decision, Date.now() - startedAt);
    return decision;
  }

  private async decideInternal(input: AuthorizationRequest): Promise<AuthorizationDecision> {
    if (this.requireConfiguration && !isCompleteConfiguration(this.config)) {
      return deny(DENY_REASONS.notConfigured);
    }
    if (this.synchronizationGate && !this.synchronizationGate.isReady()) {
      return deny(DENY_REASONS.synchronizationUnavailable);
    }
    if (this.client === null) return deny(DENY_REASONS.unavailable);

    let check: PermitAuthorizationCheck | null;
    try {
      check = mapAuthorizationRequestToPermitCheck(input, {
        ...(this.config.tenantKey === undefined ? {} : { tenantKey: this.config.tenantKey }),
      });
    } catch {
      check = null;
    }
    if (check === null) return deny(DENY_REASONS.invalidRequest);

    try {
      const checkPermit = () => permitCheckWithTimeout(
        this.client!,
        check!,
        this.timeoutMs,
        this.synchronizationGate === undefined
          ? undefined
          : () => this.synchronizationGate!.isReady(),
      );
      const result = this.telemetry
        ? await this.telemetry.withSpan(
            "authorization.check",
            {
              ...correlationAttributes({
                principalKind: input.principal?.kind,
                principalId: input.principal?.id,
                agentId: input.context?.agentId ?? input.agentId,
                projectId: input.context?.projectId ?? input.projectId,
                runId: input.context?.runId,
                orchestrationId: input.context?.orchestrationId,
              }),
              "authorization.permission": input.permission,
            },
            checkPermit,
          )
        : await checkPermit();
      if (this.synchronizationGate && !this.synchronizationGate.isReady()) {
        return deny(DENY_REASONS.synchronizationUnavailable);
      }
      if (typeof result !== "boolean") return deny(DENY_REASONS.malformed);
      return result
        ? { result: "allow", reason: "Permit policy allowed the operation" }
        : deny(DENY_REASONS.denied);
    } catch (error) {
      if (error instanceof PermitCheckTimeoutError) return deny(DENY_REASONS.timedOut);
      if (error instanceof PermitSynchronizationUnavailableError) {
        return deny(DENY_REASONS.synchronizationUnavailable);
      }
      // Provider exceptions are intentionally not included in the decision:
      // SDK bodies, URLs, headers, and credentials must never cross the app
      // boundary or be persisted by callers.
      return deny(DENY_REASONS.unavailable);
    }
  }

  private async recordDecision(
    input: AuthorizationRequest,
    decision: AuthorizationDecision,
    durationMs?: number,
  ): Promise<void> {
    if (!this.audit) return;
    const principal = input.principal ??
      (input.agentId === undefined
        ? { kind: "human" as const, id: "demo-owner" as const }
        : { kind: "agent" as const, id: input.agentId });
    const context = input.context;
    const agentId = context?.agentId ?? input.agentId;
    const projectId = context?.projectId ?? input.projectId;
    await this.audit.record({
      type: "authorization_decision",
      status: decision.result === "allow" ? "success" : "failure",
      summary: decision.result === "allow"
        ? "Permit authorization allowed " + input.permission
        : decision.result === "approval_required"
          ? "Permit authorization requires approval for " + input.permission
          : "Permit authorization denied " + input.permission,
      principal,
      ...(agentId === undefined ? {} : { agentId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(context?.runId === undefined ? {} : { runId: context.runId }),
      ...(context?.orchestrationId === undefined ? {} : { orchestrationId: context.orchestrationId }),
      ...(decision.result === "approval_required"
        ? { permitRequestId: decision.approvalRequestId }
        : {}),
      permission: input.permission,
      ...(input.resource === undefined ? {} : { resource: input.resource }),
      metadata: {
        decision: decision.result,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(decision.result === "deny" ? { errorCode: decision.errorCode } : {}),
      },
    }).catch(() => undefined);
  }

  async require(input: AuthorizationRequest): Promise<void> {
    const decision = await this.decide(input);
    if (decision.result === "allow") return;
    throw new AuthorizationError(
      "You are not authorized to perform this operation",
      decision.reason,
    );
  }
}

/** Construct the narrow check client around the official Permit SDK. */
export function createPermitCheckClient(
  permit: Pick<IPermitClient, "check">,
): PermitCheckClient {
  return {
    check(user, action, resource, context) {
      return permit.check(user, action, resource, context);
    },
  };
}

/** Build the production adapter. Missing config remains fail-closed. */
export function createPermitAuthorizationAdapter(
  config: AppConfig,
  synchronizationGate?: PermitSynchronizationGateLike,
  audit?: AuditRecorder,
  telemetry?: RuntimeTelemetry,
): PermitAuthorizationAdapter {
  const settings: PermitAuthorizationConfig = {
    apiKey: config.permitApiKey,
    pdpUrl: config.permitPdpUrl,
    projectId: config.permitProjectId,
    environmentId: config.permitEnvironmentId,
    tenantKey: config.permitTenantKey,
    operationApprovalConfigId: config.permitOperationApprovalConfigId,
  };
  let client: PermitCheckClient | null = null;
  if (isPermitConfigured(config)) {
    try {
      const permit = new Permit({
        token: config.permitApiKey,
        pdp: config.permitPdpUrl,
        timeout: config.permitCheckTimeoutMs,
        throwOnError: true,
        retry: false,
        pdpRetry: false,
        // The SDK can include provider response bodies in error logs; callers
        // receive only our stable denial and the SDK must stay silent here.
        log: { level: "silent", label: "launchpad-permit", json: false },
      });
      client = createPermitCheckClient(permit);
    } catch {
      // A malformed SDK setup is indistinguishable from an unavailable PDP to
      // callers and therefore remains a stable fail-closed denial.
      client = null;
    }
  }
  return new PermitAuthorizationAdapter({
    ...settings,
    client,
    ...(synchronizationGate === undefined ? {} : { synchronizationGate }),
    ...(audit === undefined ? {} : { audit }),
    ...(telemetry === undefined ? {} : { telemetry }),
    timeoutMs: config.permitCheckTimeoutMs,
    requireConfiguration: true,
  });
}
