import { randomUUID } from "node:crypto";
import type { Context } from "@opentelemetry/api";
import {
  MCP_APPROVAL_DELIVERY_MARGIN_MS,
  MCP_APPROVAL_EXECUTION_RESERVE_MS,
} from "../config.js";
import type { AuditRecorder } from "../audit/audit-types.js";
import {
  correlationAttributes,
  type RuntimeTelemetry,
} from "../telemetry/telemetry-types.js";
import {
  approvalDecisionAuthorityForTool,
  type ToolExecutionContext,
  type PreparedToolInvocation,
} from "./tool-types.js";
import { ToolError } from "./tool-errors.js";
import {
  ToolApprovalStore,
  ToolApprovalStoreError,
  type ToolApprovalActor,
  type ToolApprovalBinding,
  type ToolApprovalCompletionHandle,
  type ToolApprovalDecisionResult,
  type ToolApprovalInvocationRecord,
  type ToolApprovalPublicDto,
  type ToolApprovalTraceRefs,
} from "./tool-approval-store.js";
import {
  ToolApprovalWorkflowService,
  type ToolApprovalWorkflowRunResult,
} from "./tool-approval-workflow.js";
import { ToolService } from "./tool-service.js";

/** Initial bounds for the in-process live MCP completion registry. */
export const DEFAULT_TOOL_APPROVAL_MAX_PENDING = 64;
export const DEFAULT_TOOL_APPROVAL_MAX_PENDING_PER_RUN = 8;
export const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 120_000;
/** Native cancellation is cooperative; it must never retain the live MCP slot. */
export const TOOL_APPROVAL_NATIVE_CANCEL_TIMEOUT_MS = 1_000;

type CompletionOutcome =
  | { readonly kind: "resolve"; readonly value: unknown }
  | { readonly kind: "reject"; readonly error: unknown };

interface CompletionEntry extends ToolApprovalCompletionHandle {
  readonly invocationId: string;
  readonly runId: string;
  readonly agentId?: string;
  readonly projectId?: string | null;
  readonly sessionId?: string | null;
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
  startPromise?: Promise<ToolApprovalWorkflowRunResult>;
  decisionPromise?: Promise<ToolApprovalWorkflowRunResult> | undefined;
  decision?: boolean | undefined;
  /** Business output retained only while the originating live call exists. */
  resultRef?: string;
  resultValue?: unknown;
  settled: boolean;
  suspended: boolean;
}

export interface ToolApprovalServiceDecisionInput {
  /** Durable approval ID; either this or invocationRef is required. */
  readonly approvalId?: string;
  /** Server-owned invocation reference returned by the pending projection. */
  readonly invocationRef?: string;
  /** Required CAS version from the trusted control-plane read. */
  readonly expectedVersion: number;
  readonly approved: boolean;
  /** Required actor resolved by the trusted control plane; never inferred here. */
  readonly actor: ToolApprovalActor;
  readonly reason?: string;
  /**
   * Optional only as an internal convenience: when omitted, the service
   * derives the complete binding from its server-owned record. If supplied by
   * an internal caller it must match every stored scope field exactly.
   */
  readonly binding?: ToolApprovalBinding;
}

export interface ToolApprovalServiceExecuteOptions {
  /** The originating MCP request uses this to fence a lost socket. */
  readonly signal?: AbortSignal;
  /** Trusted session deadline; never read from MCP tool arguments. */
  readonly expiresAt?: string;
  /** Optional trusted absolute Run/Codex deadline. */
  readonly deadlineAt?: number;
  /** Optional trusted session reference for the application projection. */
  readonly sessionId?: string | null;
  /** Optional trusted turn reference for the application projection. */
  readonly turnId?: string | null;
  /** Trusted W3C parent propagated by the authenticated MCP/session boundary. */
  readonly traceparent?: string;
}

export interface ToolApprovalServiceDependencies {
  readonly toolService: ToolService;
  readonly approvalStore: ToolApprovalStore;
  readonly workflowService: Pick<ToolApprovalWorkflowService, "start" | "resume" | "cancel"> &
    Partial<Pick<ToolApprovalWorkflowService, "close">>;
  readonly maxPending?: number;
  readonly maxPendingPerRun?: number;
  readonly approvalTimeoutMs?: number;
  readonly now?: () => number;
  /** Safe lifecycle sink; event writes happen after durable transitions. */
  readonly audit?: AuditRecorder;
  /** Optional tracing sink for native workflow bridge spans. */
  readonly telemetry?: RuntimeTelemetry;
  /** Called only after native start has returned suspended. */
  readonly onPending?: (pending: ToolApprovalPublicDto) => void | Promise<void>;
  /** Observability hook for a native cancel that rejects or exceeds its bound. */
  readonly onNativeCancelFailure?: (invocationRef: string) => void | Promise<void>;
  /** Composition-root hook used to remove sensitive tools after a storage fault. */
  readonly onAvailabilityChange?: (available: boolean) => void | Promise<void>;
}

export class ToolApprovalServiceConfigurationError extends Error {
  readonly name = "ToolApprovalServiceConfigurationError";
}

function positiveBound(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ToolApprovalServiceConfigurationError(field + " must be a positive safe integer");
  }
  return resolved;
}

function boundedDuration(value: number | undefined): number {
  const resolved = value ?? DEFAULT_TOOL_APPROVAL_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ToolApprovalServiceConfigurationError("approvalTimeoutMs must be a positive safe integer");
  }
  return resolved;
}

function isWorkflowResult(value: unknown): value is ToolApprovalWorkflowRunResult {
  return typeof value === "object" && value !== null && typeof (value as { status?: unknown }).status === "string";
}

function genericFailure(message = "The tool approval could not be completed safely"): ToolError {
  return new ToolError("TOOL_INVOCATION_INVALIDATED", 409, message);
}

function safeWorkflowError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof ToolApprovalStoreError) {
    return genericFailure();
  }
  return genericFailure();
}

/** Distinguish provider/storage faults from expected CAS/authorization races. */
function isDurableStorageFailure(error: unknown): boolean {
  return !(error instanceof ToolApprovalStoreError) || error.statusCode >= 500;
}

function outputError(result: ToolApprovalWorkflowRunResult): ToolError | undefined {
  const output = result.result;
  if (output?.status === "executed") return undefined;
  if (output?.status === "rejected") {
    return new ToolError(
      "PERMISSION_DENIED",
      403,
      "The tool invocation was rejected by the decision authority",
    );
  }
  if (output?.status === "failed_pre_execution") return genericFailure();
  if (result.status === "canceled") {
    return new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "The tool invocation was cancelled");
  }
  return genericFailure();
}

function decisionFor(approved: boolean): "approved" | "rejected" {
  return approved ? "approved" : "rejected";
}

function validDecisionActor(value: unknown): value is ToolApprovalActor {
  if (typeof value !== "object" || value === null) return false;
  const actor = value as { kind?: unknown; id?: unknown };
  return (actor.kind === "human" || actor.kind === "agent" || actor.kind === "system") &&
    typeof actor.id === "string" && actor.id.trim().length > 0;
}

function bindingForRecord(
  record: ToolApprovalInvocationRecord,
  inputBinding = record.inputBinding,
): ToolApprovalBinding {
  return {
    approvalId: record.approvalId,
    invocationId: record.invocationId,
    workflowRunId: record.workflowRunId,
    agentId: record.agentId,
    projectId: record.projectId,
    runId: record.runId,
    orchestrationId: record.orchestrationId,
    turnId: record.turnId,
    sessionId: record.sessionId,
    toolId: record.toolId,
    policyVersion: record.policyVersion,
    ownerEpoch: record.ownerEpoch,
    inputBinding,
  };
}

function terminalDecisionResult(
  record: ToolApprovalInvocationRecord,
): ToolApprovalWorkflowRunResult {
  if (record.decision === "rejected" || record.status === "rejected") {
    return {
      status: "success",
      runId: record.workflowRunId,
      result: {
        status: "rejected",
        invocationRef: record.invocationId,
        reason: record.terminalReason ?? "The tool invocation was rejected by the decision authority",
      },
    };
  }
  if (record.status === "succeeded") {
    // The business result is intentionally not retained in the approval
    // projection. A terminal duplicate is therefore an idempotent state
    // acknowledgement, never a second execution or a fabricated output.
    return {
      status: "success",
      runId: record.workflowRunId,
      result: {
        status: "executed",
        invocationRef: record.invocationId,
        resultRef: record.invocationId,
      },
    };
  }
  return {
    status: "success",
    runId: record.workflowRunId,
    result: {
      status: "failed_pre_execution",
      invocationRef: record.invocationId,
      reason: record.terminalReason ?? "The tool invocation is no longer executable",
    },
  };
}

function approvalRequired(invocation: PreparedToolInvocation): boolean {
  return invocation.context.principal.kind === "agent" && invocation.policy.mode === "required";
}

function recordProjectId(context: ToolExecutionContext): string | null {
  return context.projectId ?? null;
}

function recordOrchestrationId(context: ToolExecutionContext): string | null {
  return context.orchestrationId ?? null;
}

const W3C_TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;
const ZERO_TRACE_ID = /^0{32}$/;
const ZERO_SPAN_ID = /^0{16}$/;

/** Keep only a valid trace identity; arbitrary headers never enter the record. */
function traceRefsFor(traceparent: string | undefined): ToolApprovalTraceRefs | undefined {
  const value = traceparent?.trim();
  if (value === undefined || value.length === 0) return undefined;
  const match = W3C_TRACEPARENT.exec(value);
  if (match === null) return undefined;
  const [, version, traceId, parentSpanId] = match;
  if (
    version === undefined ||
    traceId === undefined ||
    parentSpanId === undefined ||
    version.toLowerCase() === "ff" ||
    ZERO_TRACE_ID.test(traceId) ||
    ZERO_SPAN_ID.test(parentSpanId)
  ) {
    return undefined;
  }
  return {
    traceId: traceId.toLowerCase(),
    parentSpanId: parentSpanId.toLowerCase(),
  };
}

function parentContextForRecord(
  record: ToolApprovalInvocationRecord,
  telemetry: RuntimeTelemetry,
): Context | undefined {
  const traceId = record.traceRefs.traceId;
  const parentSpanId = record.traceRefs.parentSpanId ?? record.traceRefs.spanId;
  if (
    traceId === undefined ||
    parentSpanId === undefined ||
    !/^[\da-f]{32}$/i.test(traceId) ||
    !/^[\da-f]{16}$/i.test(parentSpanId) ||
    ZERO_TRACE_ID.test(traceId) ||
    ZERO_SPAN_ID.test(parentSpanId)
  ) {
    return undefined;
  }
  return telemetry.extract({
    traceparent: `00-${traceId}-${parentSpanId}-01`,
  });
}

function deadlineFor(
  context: ToolExecutionContext,
  now: number,
  timeoutMs: number,
  expiresAt?: string,
  deadlineAt?: number,
): string {
  const configured = now + timeoutMs;
  const sessionDeadline = Date.parse(
    // McpSessionContext is intentionally narrower than ToolExecutionContext;
    // this optional value is only consulted when a trusted caller supplies it.
    expiresAt ?? (context as ToolExecutionContext & { expiresAt?: string }).expiresAt ?? "",
  );
  const contextDeadline =
    typeof (context as ToolExecutionContext & { deadlineAt?: unknown }).deadlineAt === "number" &&
    Number.isFinite((context as ToolExecutionContext & { deadlineAt?: number }).deadlineAt)
      ? (context as ToolExecutionContext & { deadlineAt: number }).deadlineAt
      : undefined;
  const trustedDeadline =
    typeof deadlineAt === "number" && Number.isFinite(deadlineAt)
      ? deadlineAt
      : contextDeadline;
  const outerDeadline = Number.isFinite(sessionDeadline)
    ? trustedDeadline === undefined
      ? sessionDeadline
      : Math.min(sessionDeadline, trustedDeadline)
    : trustedDeadline;
  const budgetedOuterDeadline = outerDeadline === undefined
    ? undefined
    : outerDeadline - MCP_APPROVAL_EXECUTION_RESERVE_MS - MCP_APPROVAL_DELIVERY_MARGIN_MS;
  const deadline = budgetedOuterDeadline === undefined
    ? configured
    : Math.min(configured, budgetedOuterDeadline);
  return new Date(deadline).toISOString();
}

function approvalSpanAttributes(
  record: ToolApprovalInvocationRecord,
  phase: "start" | "resume",
): Record<string, string | number | boolean> {
  return {
    ...correlationAttributes({
      principalKind: "agent",
      principalId: record.agentId,
      agentId: record.agentId,
      ...(record.projectId === null ? {} : { projectId: record.projectId }),
      runId: record.runId,
      ...(record.orchestrationId === null ? {} : { orchestrationId: record.orchestrationId }),
      ...(record.turnId === null ? {} : { turnId: record.turnId }),
    ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
      invocationId: record.invocationId,
      approvalId: record.approvalId,
      workflowRunId: record.workflowRunId,
    }),
    "approval.phase": phase,
    "approval.status": record.status,
    ...(record.traceRefs.traceId === undefined ? {} : { "trace.id": record.traceRefs.traceId }),
    ...(record.traceRefs.parentSpanId === undefined ? {} : { "trace.parent.id": record.traceRefs.parentSpanId }),
  };
}

/**
 * TechJam's live bridge around the deterministic Mastra approval workflow.
 * The durable store fences authorization and execution; this service owns the
 * bounded in-process completion handles that let the original MCP request
 * remain pending until the workflow reaches a terminal result.
 */
export class ToolApprovalService {
  private readonly maxPending: number;
  private readonly maxPendingPerRun: number;
  private readonly approvalTimeoutMs: number;
  private readonly now: () => number;
  private readonly onPending: ((pending: ToolApprovalPublicDto) => void | Promise<void>) | undefined;
  private readonly onNativeCancelFailure:
    ((invocationRef: string) => void | Promise<void>) | undefined;
  private readonly pending = new Map<string, CompletionEntry>();
  private readonly pendingByRun = new Map<string, number>();
  /** Same-process admission fences close the gap after a durable scope fence. */
  private readonly fencedRuns = new Set<string>();
  private readonly fencedSessions = new Set<string>();
  private admissionsEnabled = true;
  private available = true;

  constructor(private readonly dependencies: ToolApprovalServiceDependencies) {
    this.maxPending = positiveBound(
      dependencies.maxPending,
      DEFAULT_TOOL_APPROVAL_MAX_PENDING,
      "maxPending",
    );
    this.maxPendingPerRun = positiveBound(
      dependencies.maxPendingPerRun,
      DEFAULT_TOOL_APPROVAL_MAX_PENDING_PER_RUN,
      "maxPendingPerRun",
    );
    this.approvalTimeoutMs = boundedDuration(dependencies.approvalTimeoutMs);
    this.now = dependencies.now ?? Date.now;
    this.onPending = dependencies.onPending;
    this.onNativeCancelFailure = dependencies.onNativeCancelFailure;
    dependencies.approvalStore.setAuditRecorder(dependencies.audit);
  }

  get approvalStore(): ToolApprovalStore {
    return this.dependencies.approvalStore;
  }

  get workflowService(): ToolApprovalServiceDependencies["workflowService"] {
    return this.dependencies.workflowService;
  }

  /**
   * Establish the process owner epoch before approval routes are exposed.
   * Startup callers should await this once storage and the native workflow
   * provider are ready; createInvocation repeats the guard for late or test
   * composition paths.
   */
  async initialize(): Promise<void> {
    await this.dependencies.approvalStore.initializeOwnerEpoch();
  }

  /** Whether new approval-required invocations may enter the bridge. */
  isAdmissionEnabled(): boolean {
    return this.admissionsEnabled && this.available;
  }

  /** Whether native/durable approval dependencies are currently usable. */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Stop new sensitive admissions without changing the behavior of safe tools.
   * Existing pending invocations are drained separately so callers can apply a
   * bounded shutdown deadline around the whole operation.
   */
  disableAdmissions(): void {
    if (!this.admissionsEnabled) return;
    this.admissionsEnabled = false;
    this.available = false;
    void Promise.resolve(this.dependencies.onAvailabilityChange?.(false)).catch(() => undefined);
  }

  private markUnavailable(): void {
    this.disableAdmissions();
  }

  /** Current live completion count, useful for bounded-admission health checks. */
  size(): number {
    return this.pending.size;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  pendingCountForRun(runId: string): number {
    return this.pendingByRun.get(runId) ?? 0;
  }

  hasPending(invocationRef: string): boolean {
    return this.pending.has(invocationRef);
  }

  getPending(invocationRef: string): ToolApprovalPublicDto | null {
    if (!this.pending.has(invocationRef)) return null;
    return this.dependencies.approvalStore.getPublicByInvocationId(invocationRef);
  }

  private incrementPending(runId: string): void {
    this.pendingByRun.set(runId, (this.pendingByRun.get(runId) ?? 0) + 1);
  }

  private decrementPending(runId: string): void {
    const count = this.pendingByRun.get(runId) ?? 0;
    if (count <= 1) this.pendingByRun.delete(runId);
    else this.pendingByRun.set(runId, count - 1);
  }

  private assertAdmission(runId: string): void {
    if (!this.isAdmissionEnabled()) {
      throw new ToolError(
        "APPROVAL_REQUIRED",
        503,
        "The approval bridge is unavailable for this Agent tool",
      );
    }
    if (this.pending.size >= this.maxPending || this.pendingCountForRun(runId) >= this.maxPendingPerRun) {
      throw new ToolError(
        "TOOL_EXECUTION_FAILED",
        409,
        "The tool approval queue is full",
      );
    }
  }

  private assertDecisionAvailability(): void {
    if (!this.isAvailable() || !this.admissionsEnabled) {
      throw new ToolError(
        "APPROVAL_REQUIRED",
        503,
        "The approval bridge is unavailable for this decision",
      );
    }
  }

  private scopeIsFenced(runId: string, sessionId: string | null | undefined): boolean {
    return this.fencedRuns.has(runId) ||
      (sessionId !== undefined && sessionId !== null && this.fencedSessions.has(sessionId));
  }

  /**
   * Reserve a live slot before the first asynchronous storage/workflow call.
   * `pending` contains reservations as well as suspended invocations, so two
   * concurrent callers cannot both pass a check against the same capacity.
   */
  private reserveAdmission(
    invocationId: string,
    scope: {
      runId: string;
      agentId?: string;
      projectId?: string | null;
      sessionId?: string | null;
    },
    signal: AbortSignal | undefined,
  ): CompletionEntry {
    this.assertAdmission(scope.runId);
    const entry = this.createCompletion(invocationId, scope, signal);
    this.pending.set(invocationId, entry);
    this.incrementPending(scope.runId);
    return entry;
  }

  private createCompletion(
    invocationId: string,
    scope: {
      runId: string;
      agentId?: string;
      projectId?: string | null;
      sessionId?: string | null;
    },
    signal: AbortSignal | undefined,
  ): CompletionEntry {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const entry: CompletionEntry = {
      invocationId,
      runId: scope.runId,
      ...(scope.agentId === undefined ? {} : { agentId: scope.agentId }),
      ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
      ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
      promise,
      resolve,
      reject,
      ...(signal === undefined ? {} : { signal }),
      publishResult(value: unknown): string {
        if (entry.resultRef === undefined) {
          entry.resultRef = randomUUID();
          entry.resultValue = value;
        }
        return entry.resultRef;
      },
      takeResult(reference: string): { found: boolean; value?: unknown } {
        if (entry.resultRef === undefined || entry.resultRef !== reference) {
          return { found: false };
        }
        const value = entry.resultValue;
        entry.resultValue = undefined;
        return { found: true, value };
      },
      settled: false,
      suspended: false,
    };
    if (signal !== undefined) {
      const onAbort = () => {
        void this.cancel(invocationId, "The originating MCP request was closed");
      };
      entry.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    return entry;
  }

  /** Release a reservation when no durable invocation exists yet. */
  private releaseUnstarted(entry: CompletionEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    this.removeEntry(entry);
  }

  private removeEntry(entry: CompletionEntry): void {
    if (this.pending.get(entry.invocationId) === entry) {
      this.pending.delete(entry.invocationId);
      this.decrementPending(entry.runId);
    }
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
  }

  private settle(entry: CompletionEntry, outcome: CompletionOutcome): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    this.removeEntry(entry);
    if (outcome.kind === "resolve") entry.resolve(outcome.value);
    else entry.reject(outcome.error);
    return true;
  }

  private settleWorkflow(entry: CompletionEntry, result: ToolApprovalWorkflowRunResult): void {
    if (result.nativeFailure === true) this.markUnavailable();
    if (entry.settled) return;
    if (result.status === "suspended") {
      entry.suspended = true;
      const pending = this.dependencies.approvalStore.getPublicByInvocationId(entry.invocationId);
      if (pending !== null && this.onPending !== undefined) {
        // Publication is best effort and happens only after suspension. A
        // failed observer cannot reopen the invocation or bypass the fence.
        // Defer invocation by one microtask so a synchronous observer throw is
        // captured by the promise rejection handler as well.
        void Promise.resolve().then(() => this.onPending?.(pending)).catch(() => undefined);
      }
      return;
    }
    const error = outputError(result);
    if (error !== undefined) {
      this.settle(entry, { kind: "reject", error });
      return;
    }
    const output = result.result;
    if (output?.status !== "executed" || typeof output.resultRef !== "string") {
      // A successful native workflow without a protected result reference is
      // not a deliverable MCP result. Never trust/forward arbitrary native
      // snapshot output as a substitute for the live completion registry.
      this.settle(entry, { kind: "reject", error: genericFailure() });
      return;
    }
    const delivered = entry.takeResult(output.resultRef);
    if (!delivered.found) {
      this.settle(entry, { kind: "reject", error: genericFailure() });
      return;
    }
    this.settle(entry, { kind: "resolve", value: delivered.value });
  }

  private settleStartFailure(entry: CompletionEntry, error: unknown): void {
    this.markUnavailable();
    if (entry.settled) return;
    // A native start failure must not leave a requested projection behind. The
    // live response is settled immediately; durable/native cleanup proceeds
    // independently and cannot hold the request or admission slot hostage.
    this.settle(entry, { kind: "reject", error: safeWorkflowError(error) });
    void this.cancel(entry.invocationId, "The approval workflow could not be started");
  }

  private attachStart(entry: CompletionEntry, startPromise: Promise<ToolApprovalWorkflowRunResult>): void {
    entry.startPromise = startPromise;
    void startPromise.then(
      (result) => {
        if (!isWorkflowResult(result)) {
          this.settleStartFailure(entry, undefined);
          return;
        }
        this.settleWorkflow(entry, result);
      },
      (error) => this.settleStartFailure(entry, error),
    );
  }

  private scheduleExpiry(entry: CompletionEntry, deadlineAt: string): void {
    const delay = Math.max(1, Date.parse(deadlineAt) - this.now());
    entry.timer = setTimeout(() => {
      void this.expire(entry.invocationId, "The tool approval deadline has elapsed");
    }, delay);
    entry.timer.unref();
  }

  private summaryFor(invocation: PreparedToolInvocation): string {
    const title = invocation.definition.title.trim();
    return title.length > 0 ? "Approval required for " + title : "Approval required for " + invocation.toolId;
  }

  private async startApproval(
    context: ToolExecutionContext,
    prepared: PreparedToolInvocation,
    options: ToolApprovalServiceExecuteOptions,
  ): Promise<unknown> {
    const workflowRunId = randomUUID();
    const now = this.now();
    if (this.scopeIsFenced(context.runId, options.sessionId)) {
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "The owning Run or MCP session is no longer active",
      );
    }
    const deadlineAt = deadlineFor(
      context,
      now,
      this.approvalTimeoutMs,
      options.expiresAt,
      options.deadlineAt,
    );
    if (Date.parse(deadlineAt) <= now) {
      throw new ToolError("TOOL_EXECUTION_EXPIRED", 409, "The MCP session is no longer active");
    }

    // The completion object is created before the workflow is started, and is
    // passed only through server-private state. It is never serialized.
    const provisionalInvocationId = randomUUID();
    const completion = this.reserveAdmission(
      provisionalInvocationId,
      {
        runId: context.runId,
        agentId: context.agentId,
        projectId: recordProjectId(context),
        sessionId: options.sessionId ?? null,
      },
      options.signal,
    );
    // AbortSignal does not invoke a listener added after it was already
    // aborted. Release the reservation synchronously before touching storage.
    if (options.signal?.aborted) {
      this.releaseUnstarted(completion);
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "The originating MCP request was closed");
    }

    let record: ToolApprovalInvocationRecord;
    try {
      const traceRefs = traceRefsFor(options.traceparent);
      record = await this.dependencies.approvalStore.createInvocation({
        invocationId: provisionalInvocationId,
        workflowRunId,
        agentId: context.agentId,
        projectId: recordProjectId(context),
        runId: context.runId,
        orchestrationId: recordOrchestrationId(context),
        turnId: options.turnId ?? null,
        sessionId: options.sessionId ?? null,
        toolId: prepared.toolId,
        policyVersion: prepared.policy.version,
        inputBinding: prepared.rawInputBinding,
        privateState: {
          input: prepared,
          inputBinding: prepared.rawInputBinding,
          completionHandle: completion,
        },
        safeSummary: this.summaryFor(prepared),
        deadlineAt,
        ...(traceRefs === undefined
          ? {}
          : { traceRefs }),
      });
    } catch (error) {
      this.releaseUnstarted(completion);
      // A failed durable write is a bridge health failure.  The distinction
      // between an invalid request and a provider outage is intentionally not
      // exposed to the MCP caller; either way, no new sensitive admission is
      // safe until the process is restarted/recomposed.
      if (isDurableStorageFailure(error)) this.markUnavailable();
      throw safeWorkflowError(error);
    }

    // An abort can arrive while storage is persisting the record. The live
    // reservation may already be settled; close the newly durable record and
    // never start a native workflow for that lost request.
    if (
      completion.settled ||
      this.pending.get(provisionalInvocationId) !== completion ||
      this.scopeIsFenced(context.runId, options.sessionId)
    ) {
      // The durable fence wins before releasing the live handle/native run.
      await this.closeFence(record, "The owning Run or MCP session is no longer active", false);
      this.settle(completion, {
        kind: "reject",
        error: new ToolError(
          "TOOL_INVOCATION_INVALIDATED",
          409,
          "The owning Run or MCP session is no longer active",
        ),
      });
      await this.closeNative(record.invocationId);
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "The originating MCP request was closed");
    }

    const entry = completion;
    this.scheduleExpiry(entry, record.deadlineAt);

    let startPromise: Promise<ToolApprovalWorkflowRunResult>;
    try {
      const start = () => this.dependencies.workflowService.start(record.invocationId);
      startPromise = this.dependencies.telemetry
        ? this.dependencies.telemetry.withSpan(
            "tool.approval.start",
            approvalSpanAttributes(record, "start"),
            start,
            parentContextForRecord(record, this.dependencies.telemetry),
          )
        : Promise.resolve().then(start);
    } catch (error) {
      this.settleStartFailure(entry, error);
      throw safeWorkflowError(error);
    }
    this.attachStart(entry, startPromise);
    // A pre-aborted originating call must close the durable fence even if the
    // native start is still waiting to establish suspension.
    if (options.signal?.aborted) void this.cancel(record.invocationId, "The originating MCP request was closed");
    return entry.promise;
  }

  /**
   * Prepare once, then take either the unchanged safe direct path or the
   * bounded approval bridge. No approval/workflow record is created before
   * ToolService completes all authorization and input checks.
   */
  async execute(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
    options: ToolApprovalServiceExecuteOptions = {},
  ): Promise<unknown> {
    const prepared = await this.dependencies.toolService.prepareInvocation(context, toolId, input);
    if (!approvalRequired(prepared)) {
      return this.dependencies.toolService.executePrepared(
        prepared,
        undefined,
        options.signal === undefined ? {} : { abortSignal: options.signal },
      );
    }
    if (!this.isAdmissionEnabled()) {
      throw new ToolError(
        "APPROVAL_REQUIRED",
        503,
        "The approval bridge is unavailable for this Agent tool",
      );
    }
    // A project-owner approval cannot exist for a project-less Agent call.
    // Keep the trusted human test path direct (it never enters this method's
    // approval branch) while ensuring global web.search cannot wait for an
    // owner that does not exist.
    const authority = approvalDecisionAuthorityForTool(prepared.toolId, prepared.policy);
    if (authority?.kind === "project-owner" && context.projectId === undefined) {
      throw new ToolError(
        "PERMISSION_DENIED",
        403,
        "A Project-scoped Agent run is required for this approval",
      );
    }
    return this.startApproval(context, prepared, options);
  }

  async executeMcp(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
    options: ToolApprovalServiceExecuteOptions = {},
  ): Promise<unknown> {
    return this.execute(context, toolId, input, options);
  }

  async dispatch(
    context: ToolExecutionContext,
    toolId: string,
    input: unknown,
    options: ToolApprovalServiceExecuteOptions = {},
  ): Promise<unknown> {
    return this.execute(context, toolId, input, options);
  }

  private recordForDecision(input: ToolApprovalServiceDecisionInput): ToolApprovalInvocationRecord {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new ToolError(
        "TOOL_INVOCATION_INVALIDATED",
        409,
        "A positive expected approval version is required",
      );
    }
    if (!validDecisionActor(input.actor)) {
      throw new ToolError(
        "PERMISSION_DENIED",
        403,
        "A trusted decision actor is required",
      );
    }
    if (typeof input.approvalId !== "string" && typeof input.invocationRef !== "string") {
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "An approval reference is required");
    }
    const byApproval = typeof input.approvalId === "string"
      ? this.dependencies.approvalStore.get(input.approvalId)
      : null;
    const byInvocation = typeof input.invocationRef === "string"
      ? this.dependencies.approvalStore.getByInvocationId(input.invocationRef)
      : null;
    if (byApproval !== null && byInvocation !== null && byApproval.invocationId !== byInvocation.invocationId) {
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "Approval references do not match");
    }
    const record = byApproval ?? byInvocation;
    if (record === null || record === undefined) {
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "The approval invocation is no longer available");
    }
    if (input.invocationRef !== undefined && input.invocationRef !== record.invocationId) {
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "Approval references do not match");
    }
    // The HTTP/control-plane input never gets to define identity or scope.
    // When an internal caller supplies a binding, require it to match the
    // complete server-owned context; otherwise use that context directly.
    if (input.binding !== undefined && !this.bindingMatchesRecord(input.binding, record)) {
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "Approval binding does not match the stored invocation");
    }
    return record;
  }

  private bindingMatchesRecord(
    binding: ToolApprovalBinding,
    record: ToolApprovalInvocationRecord,
  ): boolean {
    const expected = bindingForRecord(record);
    return (
      (binding.approvalId ?? null) === expected.approvalId &&
      binding.invocationId === expected.invocationId &&
      binding.workflowRunId === expected.workflowRunId &&
      binding.agentId === expected.agentId &&
      binding.projectId === expected.projectId &&
      binding.runId === expected.runId &&
      binding.orchestrationId === expected.orchestrationId &&
      binding.turnId === expected.turnId &&
      binding.sessionId === expected.sessionId &&
      binding.toolId === expected.toolId &&
      binding.policyVersion === expected.policyVersion &&
      binding.ownerEpoch === expected.ownerEpoch
    );
  }

  private claimBinding(record: ToolApprovalInvocationRecord): ToolApprovalBinding {
    // ToolApprovalStore deliberately keeps the original ToolService binding
    // private. The durable record contains only its opaque digest, so recover
    // the raw binding from the server-private envelope and never from a
    // decision request.
    const privateState = this.dependencies.approvalStore.getPrivateStateForWorkflow(record.invocationId);
    return bindingForRecord(record, privateState.inputBinding);
  }

  private async waitForStart(entry: CompletionEntry): Promise<void> {
    if (entry.startPromise === undefined) return;
    const result = await entry.startPromise;
    if (result.nativeFailure === true) this.markUnavailable();
    if (result.status !== "suspended") {
      throw outputError(result) ?? genericFailure();
    }
  }

  private async decideInternal(input: ToolApprovalServiceDecisionInput): Promise<ToolApprovalWorkflowRunResult> {
    this.assertDecisionAvailability();
    const record = this.recordForDecision(input);
    const desired = decisionFor(input.approved);
    if (record.decision !== null) {
      if (record.decision === desired) return terminalDecisionResult(record);
      throw new ToolApprovalStoreError("CONFLICTING_DECISION", "A conflicting approval decision already exists");
    }
    const entry = this.pending.get(record.invocationId);
    if (entry === undefined) {
      // A durable pending record without a live completion belongs to a lost
      // call or a previous owner epoch. It must never be resumed into a new
      // executor invocation.
      if (record.status === "succeeded" || record.status === "rejected" || record.status === "failed_pre_execution" || record.status === "failed" || record.status === "expired" || record.status === "cancelled" || record.status === "revoked" || record.status === "uncertain") {
        throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "The original MCP call is no longer pending");
      }
      await this.cancel(record.invocationId, "The original MCP call is no longer pending");
      throw new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "The original MCP call is no longer pending");
    }
    await this.waitForStart(entry);

    const latest = this.dependencies.approvalStore.get(record.approvalId) ?? record;
    let latestBinding: ToolApprovalBinding;
    try {
      latestBinding = this.claimBinding(latest);
    } catch (error) {
      const safe = safeWorkflowError(error);
      this.settle(entry, { kind: "reject", error: safe });
      void this.closeFence(latest, "The private approval state is unavailable", false);
      throw safe;
    }
    let claim: ToolApprovalDecisionResult;
    try {
      claim = await this.dependencies.approvalStore.claimDecision({
        approvalId: latest.approvalId,
        expectedVersion: input.expectedVersion,
        approved: input.approved,
        actor: input.actor,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        binding: latestBinding,
      });
    } catch (error) {
      // A failed decision write is a durable bridge failure.  Do not permit a
      // later request to advertise or consume the same sensitive capability.
      if (isDurableStorageFailure(error)) this.markUnavailable();
      throw error;
    }
    // Even a newly claimed rejection must resume the already-suspended native
    // run so the exact originating MCP response is settled. Terminal duplicate
    // acknowledgements are handled before this branch when no live entry is
    // present; never short-circuit the first local rejection here.
    let result: ToolApprovalWorkflowRunResult;
    try {
      const resume = () => this.dependencies.workflowService.resume({
        invocationRef: latest.invocationId,
        approved: input.approved,
      });
      result = await (this.dependencies.telemetry
        ? this.dependencies.telemetry.withSpan(
            "tool.approval.resume",
            approvalSpanAttributes(latest, "resume"),
            resume,
            parentContextForRecord(latest, this.dependencies.telemetry),
          )
        : resume());
    } catch (error) {
      this.markUnavailable();
      const current = this.dependencies.approvalStore.getByInvocationId(latest.invocationId) ?? latest;
      // Keep the application fence ahead of live/native cleanup even when the
      // native resume itself fails. A late callback must not race this path.
      await this.closeFence(current, "The approval workflow could not be resumed", false);
      this.settle(entry, { kind: "reject", error: safeWorkflowError(error) });
      await this.closeNative(latest.invocationId);
      throw safeWorkflowError(error);
    }
    if (!isWorkflowResult(result)) {
      this.settleStartFailure(entry, undefined);
      throw genericFailure();
    }
    this.settleWorkflow(entry, result);
    return result;
  }

  /** Claim and resume one established pending invocation. */
  async resume(input: ToolApprovalServiceDecisionInput): Promise<ToolApprovalWorkflowRunResult> {
    this.assertDecisionAvailability();
    const record = this.recordForDecision(input);
    const existing = this.pending.get(record.invocationId);
    if (existing?.decisionPromise !== undefined) {
      if (existing.decision !== input.approved) {
        throw new ToolApprovalStoreError("CONFLICTING_DECISION", "A conflicting approval decision already exists");
      }
      return existing.decisionPromise;
    }
    const entry = existing;
    if (entry !== undefined) {
      entry.decision = input.approved;
      const promise = this.decideInternal(input);
      entry.decisionPromise = promise;
      // A stale/foreign decision is an unsuccessful attempt, not ownership of
      // the live continuation. Clear the dedupe latch so a later legitimate
      // decision can proceed, while concurrent identical calls above still
      // share this in-flight promise.
      void promise.catch(() => {
        if (entry.decisionPromise === promise) {
          entry.decisionPromise = undefined;
          entry.decision = undefined;
        }
      });
      return promise;
    }
    return this.decideInternal(input);
  }

  async decide(input: ToolApprovalServiceDecisionInput): Promise<ToolApprovalWorkflowRunResult> {
    this.assertDecisionAvailability();
    return this.resume(input);
  }

  async approve(input: Omit<ToolApprovalServiceDecisionInput, "approved">): Promise<ToolApprovalWorkflowRunResult> {
    this.assertDecisionAvailability();
    return this.resume({ ...input, approved: true });
  }

  async reject(input: Omit<ToolApprovalServiceDecisionInput, "approved">): Promise<ToolApprovalWorkflowRunResult> {
    this.assertDecisionAvailability();
    return this.resume({ ...input, approved: false });
  }

  private async closeNative(invocationRef: string): Promise<void> {
    let cancellation: Promise<unknown>;
    try {
      cancellation = Promise.resolve(this.dependencies.workflowService.cancel(invocationRef));
    } catch {
      await this.reportNativeCancelFailure(invocationRef);
      return;
    }
    let nativeFailed = false;
    cancellation = cancellation.then(
      (result) => {
        if (
          typeof result === "object" &&
          result !== null &&
          (result as { nativeCancelFailed?: unknown }).nativeCancelFailed === true
        ) {
          nativeFailed = true;
        }
        return result;
      },
      () => {
        nativeFailed = true;
        return undefined;
      },
    );
    let timeout!: NodeJS.Timeout;
    const timedOut = await Promise.race([
      cancellation.then(() => false),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, TOOL_APPROVAL_NATIVE_CANCEL_TIMEOUT_MS);
        timeout.unref();
      }).then(() => true),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (nativeFailed || timedOut) {
      await this.reportNativeCancelFailure(invocationRef);
    }
  }

  private async reportNativeCancelFailure(invocationRef: string): Promise<void> {
    try {
      await this.onNativeCancelFailure?.(invocationRef);
    } catch {
      // Observability must not reopen a fenced invocation or block cleanup.
    }
  }

  private async closeFence(record: ToolApprovalInvocationRecord, reason: string, expired: boolean): Promise<void> {
    try {
      if (
        !expired &&
        (record.status === "approved" || record.status === "resuming")
      ) {
        await this.dependencies.approvalStore.markPreExecutionFailure(
          record.approvalId,
          record.version,
          reason,
        );
      } else {
        await (expired
          ? this.dependencies.approvalStore.expire({
              approvalId: record.approvalId,
              expectedVersion: record.version,
              reason,
            })
          : this.dependencies.approvalStore.cancel({
              approvalId: record.approvalId,
              expectedVersion: record.version,
              reason,
            }));
      }
    } catch {
      // A competing terminal transition already owns the fence.
    }
  }

  /**
   * Fence one lifecycle scope in durable storage before touching any live
   * response/native run. A local admission fence closes the small interval in
   * which a new MCP request could otherwise be prepared after the transaction.
   */
  private async invalidateScope(
    scope: "agent" | "project" | "run" | "session",
    value: string,
    reason: string,
  ): Promise<number> {
    if (!value) return 0;
    // Close the process-local admission fence before the durable operation
    // begins. A concurrent MCP request may otherwise prepare and persist a
    // new invocation in the interval while the storage transition is queued.
    // The durable invalidation below remains authoritative; this local fence
    // only prevents new admissions and is never cleared during this process.
    if (scope === "run") this.fencedRuns.add(value);
    if (scope === "session") this.fencedSessions.add(value);
    const matches = (record: ToolApprovalInvocationRecord): boolean =>
      scope === "agent"
        ? record.agentId === value
        : scope === "project"
          ? record.projectId === value
          : scope === "run"
            ? record.runId === value
            : record.sessionId === value;
    // Take a best-effort reference snapshot before the transaction so native
    // handles can still be settled if a storage adapter fails during fencing.
    let before: ToolApprovalInvocationRecord[] = [];
    try {
      before = this.dependencies.approvalStore.list().filter(matches);
    } catch {
      // The storage mutation below remains the authoritative attempt.
    }
    let changed = 0;
    try {
      const invalidator =
        scope === "agent"
          ? this.dependencies.approvalStore.invalidateForAgent.bind(this.dependencies.approvalStore)
          : scope === "project"
            ? this.dependencies.approvalStore.invalidateForProject.bind(this.dependencies.approvalStore)
            : scope === "run"
              ? this.dependencies.approvalStore.invalidateForRun.bind(this.dependencies.approvalStore)
              : this.dependencies.approvalStore.invalidateForSession.bind(this.dependencies.approvalStore);
      changed = await invalidator(value, reason);
    } catch {
      // A storage failure cannot reopen an authorization. Continue to close
      // process-local handles/native runs and let the owner report its own
      // persistence failure through the normal lifecycle sink.
    }
    let after: ToolApprovalInvocationRecord[] = [];
    try {
      after = this.dependencies.approvalStore.list().filter(matches);
    } catch {
      // Fall back to the pre-transaction references when the adapter is down.
    }
    const invocationRefs = new Set([
      ...before.map((record) => record.invocationId),
      ...after.map((record) => record.invocationId),
    ]);
    const entryMatches = (entry: CompletionEntry): boolean =>
      scope === "agent"
        ? entry.agentId === value
        : scope === "project"
          ? entry.projectId === value
          : scope === "run"
            ? entry.runId === value
            : entry.sessionId === value;
    const liveEntries = [...this.pending.values()].filter(
      (entry) => invocationRefs.has(entry.invocationId) || entryMatches(entry),
    );
    await Promise.all(
      liveEntries.map(async (entry) => {
        this.settle(entry, {
          kind: "reject",
          error: new ToolError(
            "TOOL_INVOCATION_INVALIDATED",
            409,
            "The tool invocation was cancelled",
          ),
        });
        await this.closeNative(entry.invocationId);
      }),
    );
    return changed;
  }

  async invalidateForAgent(agentId: string, reason = "Agent was deleted"): Promise<number> {
    return this.invalidateScope("agent", agentId, reason);
  }

  async invalidateForProject(projectId: string, reason = "Project was deleted"): Promise<number> {
    return this.invalidateScope("project", projectId, reason);
  }

  async invalidateForRun(runId: string, reason = "Agent Run was cancelled"): Promise<number> {
    return this.invalidateScope("run", runId, reason);
  }

  async invalidateForSession(
    sessionId: string,
    reason = "Owning MCP session was cancelled",
  ): Promise<number> {
    return this.invalidateScope("session", sessionId, reason);
  }

  async cancel(invocationRef: string, reason = "The tool invocation was cancelled"): Promise<void> {
    const record = this.dependencies.approvalStore.getByInvocationId(invocationRef);
    const entry = this.pending.get(invocationRef);
    // Durable cancellation wins before releasing the live response/native run.
    if (record !== null) await this.closeFence(record, reason, false);
    if (entry !== undefined) {
      this.settle(entry, {
        kind: "reject",
        error: new ToolError("TOOL_INVOCATION_INVALIDATED", 409, "The tool invocation was cancelled"),
      });
    }
    if (record !== null) await this.closeNative(invocationRef);
  }

  async expire(invocationRef: string, reason = "The tool approval deadline has elapsed"): Promise<void> {
    const record = this.dependencies.approvalStore.getByInvocationId(invocationRef);
    const entry = this.pending.get(invocationRef);
    // Expiry follows the same durable-fence-first ordering as cancellation.
    if (record !== null) await this.closeFence(record, reason, true);
    if (entry !== undefined) {
      this.settle(entry, {
        kind: "reject",
        error: new ToolError("TOOL_EXECUTION_EXPIRED", 409, "The tool approval deadline has elapsed"),
      });
    }
    if (record !== null) await this.closeNative(invocationRef);
  }

  /**
   * Fence and settle every live MCP completion before native storage closes.
   * The caller owns the outer timeout; each cancellation is independently
   * best-effort and can never reopen an application approval.
   */
  async drain(reason = "Tool approvals were closed during server shutdown"): Promise<void> {
    this.disableAdmissions();
    const invocationRefs = [...this.pending.keys()];
    await Promise.all(
      invocationRefs.map(async (invocationRef) => {
        await this.cancel(invocationRef, reason).catch(() => undefined);
      }),
    );
  }

  /** Drain application handles, then release native workflow resources. */
  async shutdown(reason = "Tool approvals were closed during server shutdown"): Promise<void> {
    await this.drain(reason);
    await this.dependencies.workflowService.close?.();
  }

  /** Alias used by generic lifecycle owners. */
  async close(reason?: string): Promise<void> {
    await this.shutdown(reason);
  }
}

export function createToolApprovalService(
  dependencies: ToolApprovalServiceDependencies,
): ToolApprovalService {
  return new ToolApprovalService(dependencies);
}
