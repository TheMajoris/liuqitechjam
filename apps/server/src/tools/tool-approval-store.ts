import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { redactSensitiveText } from "../orchestration/handoff.js";
import type { Storage } from "../store.js";
import type { AuditRecorder } from "../audit/audit-types.js";
import { approvalLifecycleEvent } from "../audit/approval-audit.js";

/**
 * Application projection for the native Mastra approval workflow.
 *
 * This is intentionally a different record from the legacy access approval
 * tables.  An approval is a decision about one already-authorized invocation;
 * it is never a capability grant.  The durable record contains only an
 * opaque input binding and an opaque private-state handle.  The parsed input
 * and the live MCP completion handle stay in this process-owned store.
 */
export const TOOL_APPROVAL_INVOCATION_KIND = "native-workflow-tool-approval" as const;
export const TOOL_APPROVAL_RECORD_VERSION = 1 as const;
export const DEFAULT_TOOL_APPROVAL_OWNER_EPOCH = 1;

/**
 * Entropy-backed epoch for a newly constructed process owner.  Bootstrap
 * normally calls initializeOwnerEpoch() after storage opens, which advances
 * beyond every durable record; this helper is useful for a fresh store or an
 * owner that wants a non-default epoch before its first record is written.
 */
export function createToolApprovalOwnerEpoch(): number {
  return randomBytes(6).readUIntBE(0, 6) + 1;
}

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
export type ToolApprovalTerminalStatus =
  | "succeeded"
  | "rejected"
  | "failed_pre_execution"
  | "failed"
  | "expired"
  | "cancelled"
  | "revoked"
  | "uncertain";

export interface ToolApprovalActor {
  readonly kind: "human" | "agent" | "system";
  readonly id: string;
}

/** Trace identifiers only; arbitrary request headers never enter this record. */
export interface ToolApprovalTraceRefs {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly requestId?: string;
}

export interface ToolApprovalInvocationRecord {
  readonly kind: typeof TOOL_APPROVAL_INVOCATION_KIND;
  readonly recordVersion: typeof TOOL_APPROVAL_RECORD_VERSION;
  readonly approvalId: string;
  readonly invocationId: string;
  /** Deliberately not the same identifier as invocationId or approvalId. */
  readonly workflowRunId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly runId: string;
  readonly orchestrationId: string | null;
  readonly turnId: string | null;
  readonly sessionId: string | null;
  readonly toolId: string;
  readonly policyVersion: string;
  /** HMAC-like opaque value; the original ToolService binding is private. */
  readonly inputBinding: string;
  /** Random handle for private in-process input/completion state. */
  readonly privateInputHandle: string;
  readonly safeSummary: string;
  readonly deadlineAt: string;
  readonly status: ToolApprovalStatus;
  readonly version: number;
  readonly ownerEpoch: number;
  readonly decision: ToolApprovalDecision | null;
  readonly decisionActor: ToolApprovalActor | null;
  readonly decisionAt: string | null;
  readonly decisionReason: string | null;
  readonly traceRefs: ToolApprovalTraceRefs;
  readonly executionStartedAt: string | null;
  readonly completedAt: string | null;
  readonly terminalReason: string | null;
  /** Set when cancellation arrives after an execution claim won the race. */
  readonly cancellationRequestedAt: string | null;
  readonly cancellationReason: string | null;
  readonly uncertainReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public projection safe for HTTP/UI/activity consumers. */
export interface ToolApprovalPublicDto {
  readonly approvalId: string;
  readonly invocationId: string;
  readonly workflowRunId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly runId: string;
  readonly orchestrationId: string | null;
  readonly turnId: string | null;
  readonly sessionId: string | null;
  readonly toolId: string;
  readonly policyVersion: string;
  readonly safeSummary: string;
  readonly deadlineAt: string;
  readonly status: ToolApprovalStatus;
  readonly version: number;
  readonly ownerEpoch: number;
  readonly decision: ToolApprovalDecision | null;
  readonly decisionActor: ToolApprovalActor | null;
  readonly decisionAt: string | null;
  readonly decisionReason: string | null;
  readonly traceRefs: ToolApprovalTraceRefs;
  readonly executionStartedAt: string | null;
  readonly completedAt: string | null;
  readonly terminalReason: string | null;
  readonly cancellationRequestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** State that is usable only by the server-owned workflow bridge. */
export interface ToolApprovalPrivateState {
  readonly input: unknown;
  /** Original (usually canonical JSON) ToolService binding, never persisted. */
  readonly inputBinding: string;
  /** Live completion handle; intentionally never persisted or returned publicly. */
  readonly completionHandle?: unknown;
}

/**
 * Server-private result sink used by a live MCP completion bridge. A native
 * workflow may retain only the returned opaque reference; the business value
 * never crosses the workflow snapshot boundary.
 */
export interface ToolApprovalCompletionHandle {
  publishResult(value: unknown): string;
  takeResult(reference: string): { found: boolean; value?: unknown };
}

export interface ToolApprovalPrivateStateInput {
  readonly input: unknown;
  readonly inputBinding?: string;
  readonly completionHandle?: unknown;
}

/**
 * Lifecycle invalidation seam used by Agent/Project deletion owners.  Keeping
 * this structural and type-only avoids making either lifecycle service depend
 * on the concrete persistence implementation.
 */
export interface ToolApprovalInvalidator {
  invalidateForAgent(agentId: string, reason?: string): Promise<number>;
  invalidateForProject(projectId: string, reason?: string): Promise<number>;
  /** Optional while older lifecycle owners only know Agent/Project scope. */
  invalidateForRun?(runId: string, reason?: string): Promise<number>;
  /** Optional while older lifecycle owners only know Agent/Project scope. */
  invalidateForSession?(sessionId: string, reason?: string): Promise<number>;
}

export interface ToolApprovalCreateInput {
  readonly approvalId?: string;
  readonly invocationId?: string;
  readonly workflowRunId: string;
  readonly agentId: string;
  readonly projectId?: string | null;
  readonly runId: string;
  readonly orchestrationId?: string | null;
  readonly turnId?: string | null;
  readonly sessionId?: string | null;
  readonly toolId: string;
  readonly policyVersion: string;
  /** The private binding produced by ToolService, not a client value. */
  readonly inputBinding: string;
  /** Parsed validated input. It is retained in memory, not in Database. */
  readonly privateInput?: unknown;
  readonly privateState?: ToolApprovalPrivateStateInput;
  readonly safeSummary: string;
  readonly deadlineAt: string | number | Date;
  readonly ownerEpoch?: number;
  readonly traceRefs?: ToolApprovalTraceRefs;
  readonly createdAt?: string | number | Date;
  readonly initialStatus?: "requested" | "waiting";
}

/** Every identity/scope field is checked before private state is returned. */
export interface ToolApprovalBinding {
  readonly approvalId?: string;
  readonly invocationId: string;
  readonly workflowRunId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly runId: string;
  readonly orchestrationId: string | null;
  readonly turnId: string | null;
  readonly sessionId: string | null;
  readonly toolId: string;
  readonly policyVersion: string;
  readonly ownerEpoch: number;
  /** Original private ToolService input binding. */
  readonly inputBinding: string;
}

export interface ToolApprovalDecisionInput {
  readonly approvalId: string;
  readonly expectedVersion: number;
  readonly approved: boolean;
  readonly actor: ToolApprovalActor;
  readonly reason?: string;
  readonly binding?: ToolApprovalBinding;
}

export interface ToolApprovalDecisionResult {
  readonly outcome: "claimed" | "idempotent";
  readonly record: ToolApprovalInvocationRecord;
}

export interface ToolApprovalExecutionStartInput {
  readonly approvalId: string;
  readonly expectedVersion: number;
  readonly binding?: ToolApprovalBinding;
}

export interface ToolApprovalExecutionClaim {
  readonly kind: "tool-approval-execution-claim";
  readonly claimId: string;
  readonly approvalId: string;
  readonly invocationId: string;
  readonly workflowRunId: string;
  readonly ownerEpoch: number;
  readonly version: number;
}

export interface ToolApprovalExecutionStartResult {
  readonly claimed: boolean;
  readonly record: ToolApprovalInvocationRecord;
  readonly claim?: ToolApprovalExecutionClaim;
  readonly reason:
    | "claimed"
    | "already_started"
    | "cancelled"
    | "expired"
    | "stale"
    | "invalidated"
    | "terminal";
}

export interface ToolApprovalExecutionSettlementInput {
  readonly approvalId: string;
  readonly claim: ToolApprovalExecutionClaim;
  readonly outcome: "succeeded" | "failed" | "uncertain";
  readonly reason?: string;
}

export interface ToolApprovalCloseInput {
  readonly approvalId: string;
  readonly expectedVersion?: number;
  readonly reason?: string;
  readonly binding?: ToolApprovalBinding;
}

export interface ToolApprovalConditionalUpdate {
  readonly approvalId: string;
  readonly expectedVersion: number;
  readonly expectedOwnerEpoch: number;
  readonly expectedStatuses: readonly ToolApprovalStatus[];
  readonly next: ToolApprovalInvocationRecord;
}

/** Optional fast path implemented by PostgresStore with a SQL CAS update. */
export interface ToolApprovalConditionalStorage {
  conditionalUpdateToolApproval(
    input: ToolApprovalConditionalUpdate,
  ): Promise<ToolApprovalInvocationRecord | null>;
}

export interface ToolApprovalStoreOptions {
  readonly ownerEpoch?: number;
  readonly now?: () => number;
  /** Optional post-transition audit sink; failures never reopen a fence. */
  readonly audit?: AuditRecorder;
}

export type ToolApprovalStoreErrorCode =
  | "NOT_FOUND"
  | "INVALID_RECORD"
  | "FOREIGN_BINDING"
  | "PRIVATE_STATE_UNAVAILABLE"
  | "OWNER_EPOCH_MISMATCH"
  | "STALE_VERSION"
  | "CONFLICTING_DECISION"
  | "INVALID_TRANSITION"
  | "EXPIRED"
  | "EXECUTION_CLAIM_INVALID";

export class ToolApprovalStoreError extends Error {
  readonly name = "ToolApprovalStoreError";
  constructor(
    readonly code: ToolApprovalStoreErrorCode,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

const MAX_SAFE_SUMMARY_LENGTH = 512;
const MAX_REASON_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const BINDING_SECRET = randomBytes(32);
const TERMINAL_STATUSES = new Set<ToolApprovalStatus>([
  "succeeded",
  "rejected",
  "failed_pre_execution",
  "failed",
  "expired",
  "cancelled",
  "revoked",
  "uncertain",
]);
const PRE_EXECUTION_STATUSES = new Set<ToolApprovalStatus>([
  "requested",
  "waiting",
  "approved",
  "resuming",
]);

type MutableRecord = {
  -readonly [Key in keyof ToolApprovalInvocationRecord]: ToolApprovalInvocationRecord[Key];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new ToolApprovalStoreError("INVALID_RECORD", `Approval ${field} must be a non-empty string`, 422);
  }
  return value;
}

function safeText(value: unknown, field: string, maxLength = MAX_REASON_LENGTH): string {
  if (typeof value !== "string") {
    throw new ToolApprovalStoreError("INVALID_RECORD", `Approval ${field} must be a string`, 422);
  }
  const redacted = redactSensitiveText(value).trim();
  if (redacted.length <= maxLength) return redacted;
  return redacted.slice(0, maxLength - 14).trimEnd() + " [TRUNCATED]";
}

function nullableText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field);
}

function asTimestamp(value: string | number | Date, field: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ToolApprovalStoreError("INVALID_RECORD", `Approval ${field} must be a valid timestamp`, 422);
  }
  return date.toISOString();
}

function nowTimestamp(now: () => number): string {
  return new Date(now()).toISOString();
}

function positiveInteger(value: unknown, field: string, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new ToolApprovalStoreError("INVALID_RECORD", `Approval ${field} must be an integer`, 422);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class PrivateInputSnapshotError extends Error {}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/**
 * Private workflow input is normally a ToolService-owned prepared envelope.
 * That envelope must retain object identity so ToolService's nominal
 * ownership check remains effective.  Test/adapter callers may provide a
 * plain JSON value; snapshot and deeply freeze those values so a caller cannot
 * mutate the executable input after its binding has been recorded.
 */
function snapshotPrivateInput(
  value: unknown,
  path = "$",
  active = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PrivateInputSnapshotError("Unsupported non-finite private input at " + path);
    }
    return value;
  }
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") {
    throw new PrivateInputSnapshotError("Unsupported private input at " + path);
  }

  /*
   * PreparedToolInvocation is a nominal capability owned by ToolService.
   * Cloning it would remove that identity and make every legitimate resumed
   * execution fail closed.  Its root is frozen by ToolService; retain exactly
   * that object and let the final ToolService revalidation re-check the raw
   * input/policy before the executor is reached.
   */
  if (
    isObjectLike(value) &&
    Object.isFrozen(value) &&
    (value as { kind?: unknown }).kind === "prepared-tool-invocation"
  ) {
    return value;
  }

  if (active.has(value)) {
    throw new PrivateInputSnapshotError("Cyclic private input at " + path);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new PrivateInputSnapshotError("Symbol properties are not supported at " + path);
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        copy[index] = snapshotPrivateInput(value[index], path + "[" + index + "]", active);
      }
      for (const key of Object.keys(value)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new PrivateInputSnapshotError("Custom array properties are not supported at " + path);
        }
      }
      return Object.freeze(copy);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PrivateInputSnapshotError("Unsupported private input type at " + path);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PrivateInputSnapshotError("Symbol properties are not supported at " + path);
    }
    const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
    for (const key of Object.keys(value)) {
      copy[key] = snapshotPrivateInput(
        (value as Record<string, unknown>)[key],
        path + "." + key,
        active,
      );
    }
    return Object.freeze(copy);
  } finally {
    active.delete(value);
  }
}

function opaqueBinding(value: string): string {
  // A process-random key prevents a durable binding from becoming a
  // dictionary-testable hash of a sensitive input. Rotation also naturally
  // makes old records unusable after a restart.
  return createHmac("sha256", BINDING_SECRET).update(value).digest("base64url");
}

function safeTraceRefs(value: unknown): ToolApprovalTraceRefs {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new ToolApprovalStoreError("INVALID_RECORD", "Approval traceRefs must be an object", 422);
  }
  const result: Record<string, string> = {};
  for (const key of ["traceId", "spanId", "parentSpanId", "requestId"] as const) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_ID_LENGTH) {
      throw new ToolApprovalStoreError("INVALID_RECORD", `Approval traceRefs.${key} is invalid`, 422);
    }
    result[key] = candidate;
  }
  return result;
}

function safeActor(value: unknown, field = "decisionActor"): ToolApprovalActor | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || (value.kind !== "human" && value.kind !== "agent" && value.kind !== "system")) {
    throw new ToolApprovalStoreError("INVALID_RECORD", `Approval ${field} is invalid`, 422);
  }
  return Object.freeze({ kind: value.kind, id: text(value.id, `${field}.id`) });
}

function status(value: unknown): ToolApprovalStatus {
  if (typeof value !== "string" || !(TOOL_APPROVAL_STATUSES as readonly string[]).includes(value)) {
    throw new ToolApprovalStoreError("INVALID_RECORD", "Approval status is invalid", 422);
  }
  return value as ToolApprovalStatus;
}

function decision(value: unknown): ToolApprovalDecision | null {
  if (value === undefined || value === null) return null;
  if (value !== "approved" && value !== "rejected") {
    throw new ToolApprovalStoreError("INVALID_RECORD", "Approval decision is invalid", 422);
  }
  return value;
}

function forbiddenPrivateFields(value: Record<string, unknown>): void {
  for (const key of ["input", "rawInput", "privateInput", "completionHandle", "bearerToken", "token"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ToolApprovalStoreError(
        "INVALID_RECORD",
        `Approval projection cannot persist private field ${key}`,
        422,
      );
    }
  }
}

/**
 * Normalize imported JSON using an explicit durable projection allowlist.
 * Unknown keys are intentionally dropped: this collection is security
 * sensitive and must never carry an additive bearer token/header/raw-input
 * field into the JSON or PostgreSQL `record` column.
 */
export function normalizeToolApprovalInvocations(value: unknown): ToolApprovalInvocationRecord[] {
  if (!Array.isArray(value)) throw new Error("Unsupported database format");
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error("Unsupported database format");
    try {
      forbiddenPrivateFields(candidate);
      const normalized: MutableRecord = {
        kind: candidate.kind === undefined ? TOOL_APPROVAL_INVOCATION_KIND : text(candidate.kind, "kind") as typeof TOOL_APPROVAL_INVOCATION_KIND,
        recordVersion: candidate.recordVersion === undefined
          ? TOOL_APPROVAL_RECORD_VERSION
          : positiveInteger(candidate.recordVersion, "recordVersion") as typeof TOOL_APPROVAL_RECORD_VERSION,
        approvalId: text(candidate.approvalId, "approvalId"),
        invocationId: text(candidate.invocationId, "invocationId"),
        workflowRunId: text(candidate.workflowRunId, "workflowRunId"),
        agentId: text(candidate.agentId, "agentId"),
        projectId: nullableText(candidate.projectId, "projectId"),
        runId: text(candidate.runId, "runId"),
        orchestrationId: nullableText(candidate.orchestrationId, "orchestrationId"),
        turnId: nullableText(candidate.turnId, "turnId"),
        sessionId: nullableText(candidate.sessionId, "sessionId"),
        toolId: text(candidate.toolId, "toolId"),
        policyVersion: text(candidate.policyVersion, "policyVersion"),
        inputBinding: text(candidate.inputBinding, "inputBinding"),
        privateInputHandle: text(candidate.privateInputHandle, "privateInputHandle"),
        safeSummary: safeText(candidate.safeSummary, "safeSummary", MAX_SAFE_SUMMARY_LENGTH),
        deadlineAt: asTimestamp(text(candidate.deadlineAt, "deadlineAt"), "deadlineAt"),
        status: status(candidate.status),
        version: positiveInteger(candidate.version, "version"),
        ownerEpoch: positiveInteger(candidate.ownerEpoch, "ownerEpoch", true),
        decision: decision(candidate.decision),
        decisionActor: safeActor(candidate.decisionActor),
        decisionAt: candidate.decisionAt === undefined || candidate.decisionAt === null
          ? null
          : asTimestamp(text(candidate.decisionAt, "decisionAt"), "decisionAt"),
        decisionReason: candidate.decisionReason === undefined || candidate.decisionReason === null
          ? null
          : safeText(candidate.decisionReason, "decisionReason"),
        traceRefs: safeTraceRefs(candidate.traceRefs),
        executionStartedAt: candidate.executionStartedAt === undefined || candidate.executionStartedAt === null
          ? null
          : asTimestamp(text(candidate.executionStartedAt, "executionStartedAt"), "executionStartedAt"),
        completedAt: candidate.completedAt === undefined || candidate.completedAt === null
          ? null
          : asTimestamp(text(candidate.completedAt, "completedAt"), "completedAt"),
        terminalReason: candidate.terminalReason === undefined || candidate.terminalReason === null
          ? null
          : safeText(candidate.terminalReason, "terminalReason"),
        cancellationRequestedAt: candidate.cancellationRequestedAt === undefined || candidate.cancellationRequestedAt === null
          ? null
          : asTimestamp(text(candidate.cancellationRequestedAt, "cancellationRequestedAt"), "cancellationRequestedAt"),
        cancellationReason: candidate.cancellationReason === undefined || candidate.cancellationReason === null
          ? null
          : safeText(candidate.cancellationReason, "cancellationReason"),
        uncertainReason: candidate.uncertainReason === undefined || candidate.uncertainReason === null
          ? null
          : safeText(candidate.uncertainReason, "uncertainReason"),
        createdAt: asTimestamp(text(candidate.createdAt, "createdAt"), "createdAt"),
        updatedAt: asTimestamp(text(candidate.updatedAt, "updatedAt"), "updatedAt"),
      };
      if (normalized.kind !== TOOL_APPROVAL_INVOCATION_KIND || normalized.recordVersion !== TOOL_APPROVAL_RECORD_VERSION) {
        throw new ToolApprovalStoreError("INVALID_RECORD", "Approval projection version is unsupported", 422);
      }
      if (
        normalized.approvalId === normalized.invocationId ||
        normalized.approvalId === normalized.workflowRunId ||
        normalized.invocationId === normalized.workflowRunId
      ) {
        throw new ToolApprovalStoreError("INVALID_RECORD", "Approval identifiers must be distinct", 422);
      }
      const hasDecision = normalized.decision !== null;
      const hasDecisionMetadata = normalized.decisionActor !== null && normalized.decisionAt !== null;
      if (hasDecision !== hasDecisionMetadata) {
        throw new ToolApprovalStoreError(
          "INVALID_RECORD",
          "Decision, actor, and decisionAt must be present together",
          422,
        );
      }
      if (
        (normalized.status === "requested" || normalized.status === "waiting") &&
        normalized.decision !== null
      ) {
        throw new ToolApprovalStoreError(
          "INVALID_RECORD",
          `${normalized.status} state cannot have a decision`,
          422,
        );
      }
      if (
        ["approved", "resuming", "executing", "succeeded", "failed_pre_execution", "failed", "uncertain"]
          .includes(normalized.status) &&
        normalized.decision !== "approved"
      ) {
        throw new ToolApprovalStoreError(
          "INVALID_RECORD",
          `${normalized.status} state requires an approval decision`,
          422,
        );
      }
      if (normalized.status === "rejected" && normalized.decision !== "rejected") {
        throw new ToolApprovalStoreError("INVALID_RECORD", "Rejected state requires a rejection decision", 422);
      }
      if (normalized.decision === "rejected" && normalized.status !== "rejected") {
        throw new ToolApprovalStoreError("INVALID_RECORD", "A rejected decision requires a rejected state", 422);
      }
      return Object.freeze(normalized);
    } catch (error) {
      if (error instanceof ToolApprovalStoreError) {
        throw new Error(`Unsupported database format at toolApprovalInvocations[${index}]: ${error.message}`);
      }
      throw error;
    }
  });
}

function publicDto(record: ToolApprovalInvocationRecord): ToolApprovalPublicDto {
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
    safeSummary: record.safeSummary,
    deadlineAt: record.deadlineAt,
    status: record.status,
    version: record.version,
    ownerEpoch: record.ownerEpoch,
    decision: record.decision,
    decisionActor: record.decisionActor === null ? null : clone(record.decisionActor),
    decisionAt: record.decisionAt,
    decisionReason: record.decisionReason,
    traceRefs: clone(record.traceRefs),
    executionStartedAt: record.executionStartedAt,
    completedAt: record.completedAt,
    terminalReason: record.terminalReason,
    cancellationRequestedAt: record.cancellationRequestedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function sameNullable(left: string | null, right: string | null | undefined): boolean {
  return left === (right ?? null);
}

function statusIs(value: ToolApprovalStatus, values: readonly ToolApprovalStatus[]): boolean {
  return values.includes(value);
}

function assertExpectedVersion(record: ToolApprovalInvocationRecord, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    throw new ToolApprovalStoreError("STALE_VERSION", "A positive expected approval version is required");
  }
  if (record.version !== expectedVersion) {
    throw new ToolApprovalStoreError(
      "STALE_VERSION",
      `Approval ${record.approvalId} is at version ${record.version}, not ${expectedVersion}`,
    );
  }
}

function copyRecord(record: ToolApprovalInvocationRecord): MutableRecord {
  return clone(record) as MutableRecord;
}

function recordHasExpired(record: ToolApprovalInvocationRecord, now: number): boolean {
  const deadline = Date.parse(record.deadlineAt);
  return !Number.isFinite(deadline) || now >= deadline;
}

function decisionFor(approved: boolean): ToolApprovalDecision {
  return approved ? "approved" : "rejected";
}

export class ToolApprovalStore {
  /** The durable random handle is the private-envelope map key. */
  private readonly privateState = new Map<string, ToolApprovalPrivateState>();
  private readonly executionClaims = new WeakSet<object>();
  private currentOwnerEpoch: number;
  private ownerEpochReady = false;
  private ownerEpochInitialization: Promise<number> | undefined;
  private readonly now: () => number;
  private audit: AuditRecorder | undefined;

  constructor(
    private readonly storage: Storage,
    options: ToolApprovalStoreOptions = {},
  ) {
    this.currentOwnerEpoch = positiveInteger(
      options.ownerEpoch ?? DEFAULT_TOOL_APPROVAL_OWNER_EPOCH,
      "ownerEpoch",
      true,
    );
    this.now = options.now ?? (() => Date.now());
    this.audit = options.audit;
  }

  /** Attach the central audit sink after the composition root is assembled. */
  setAuditRecorder(audit: AuditRecorder | undefined): void {
    if (audit !== undefined) this.audit = audit;
  }

  /**
   * Publish one safe lifecycle event after a durable state transition. Audit
   * failures are intentionally swallowed: they cannot reopen a closed
   * authorization or make an uncertain external effect look successful.
   */
  private async emitTransition(
    previous: ToolApprovalInvocationRecord | null,
    next: ToolApprovalInvocationRecord,
  ): Promise<void> {
    const event = approvalLifecycleEvent(previous, next);
    if (event === null || this.audit === undefined) return;
    try {
      await this.audit.record(event);
    } catch {
      // The durable transition remains authoritative; observability is best effort.
    }
  }

  get ownerEpoch(): number {
    return this.currentOwnerEpoch;
  }

  /**
   * Establish a fresh owner epoch before approval routes are registered.
   * Epochs are persisted on every invocation, so the next owner can advance
   * beyond the highest durable value without adding a second metadata table.
   * The subsequent reconciliation fences all non-terminal records from the
   * previous owner and removes their process-private state.
   */
  async initializeOwnerEpoch(): Promise<number> {
    if (this.ownerEpochReady) return this.currentOwnerEpoch;
    if (this.ownerEpochInitialization !== undefined) return this.ownerEpochInitialization;
    const initialization = (async () => {
      const highestPersistedEpoch = this.storage
        .snapshot()
        .toolApprovalInvocations
        .reduce((highest, record) => Math.max(highest, record.ownerEpoch), 0);
      if (highestPersistedEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new ToolApprovalStoreError(
          "OWNER_EPOCH_MISMATCH",
          "No safe owner epoch remains for approval reconciliation",
          503,
        );
      }
      this.currentOwnerEpoch = Math.max(this.currentOwnerEpoch, highestPersistedEpoch + 1);
      await this.invalidateOldOwnerEpochs();
      this.ownerEpochReady = true;
      return this.currentOwnerEpoch;
    })();
    this.ownerEpochInitialization = initialization.catch((error: unknown) => {
      this.ownerEpochInitialization = undefined;
      throw error;
    });
    return this.ownerEpochInitialization;
  }

  /** Explicit bootstrap synonym for composition roots. */
  async bootstrapOwnerEpoch(): Promise<number> {
    return this.initializeOwnerEpoch();
  }

  /** Add an epoch after a process restart; old executable state is fenced. */
  async rotateOwnerEpoch(nextEpoch = this.currentOwnerEpoch + 1): Promise<number> {
    const epoch = positiveInteger(nextEpoch, "ownerEpoch", true);
    if (epoch <= this.currentOwnerEpoch) {
      throw new ToolApprovalStoreError("OWNER_EPOCH_MISMATCH", "Owner epoch must increase");
    }
    this.currentOwnerEpoch = epoch;
    return this.invalidateOldOwnerEpochs();
  }

  async createInvocation(input: ToolApprovalCreateInput): Promise<ToolApprovalInvocationRecord> {
    // Admission itself is the last safe fallback if a composition root has
    // not explicitly initialized the owner epoch yet. A restarted process
    // therefore fences old active records before it can create a new one.
    await this.initializeOwnerEpoch();
    const approvalId = text(input.approvalId ?? randomUUID(), "approvalId");
    const invocationId = text(input.invocationId ?? randomUUID(), "invocationId");
    const workflowRunId = text(input.workflowRunId, "workflowRunId");
    if (approvalId === invocationId || approvalId === workflowRunId || invocationId === workflowRunId) {
      throw new ToolApprovalStoreError("INVALID_RECORD", "Approval identifiers must be distinct", 422);
    }
    const agentId = text(input.agentId, "agentId");
    const projectId = input.projectId ?? null;
    const runId = text(input.runId, "runId");
    const orchestrationId = input.orchestrationId ?? null;
    const turnId = input.turnId ?? null;
    const sessionId = input.sessionId ?? null;
    const toolId = text(input.toolId, "toolId");
    const policyVersion = text(input.policyVersion, "policyVersion");
    const sourceBinding = text(input.inputBinding, "inputBinding");
    const safeSummary = safeText(input.safeSummary, "safeSummary", MAX_SAFE_SUMMARY_LENGTH);
    const createdAt = asTimestamp(input.createdAt ?? new Date(this.now()), "createdAt");
    const deadlineAt = asTimestamp(input.deadlineAt, "deadlineAt");
    const ownerEpoch = positiveInteger(input.ownerEpoch ?? this.currentOwnerEpoch, "ownerEpoch", true);
    if (ownerEpoch !== this.currentOwnerEpoch) {
      throw new ToolApprovalStoreError(
        "OWNER_EPOCH_MISMATCH",
        "Approval must be created by the current owner epoch",
      );
    }
    const privateInputHandle = randomUUID();
    const record: ToolApprovalInvocationRecord = Object.freeze({
      kind: TOOL_APPROVAL_INVOCATION_KIND,
      recordVersion: TOOL_APPROVAL_RECORD_VERSION,
      approvalId,
      invocationId,
      workflowRunId,
      agentId,
      projectId,
      runId,
      orchestrationId,
      turnId,
      sessionId,
      toolId,
      policyVersion,
      inputBinding: opaqueBinding(sourceBinding),
      privateInputHandle,
      safeSummary,
      deadlineAt,
      status: input.initialStatus ?? "requested",
      version: 1,
      ownerEpoch,
      decision: null,
      decisionActor: null,
      decisionAt: null,
      decisionReason: null,
      traceRefs: Object.freeze(safeTraceRefs(input.traceRefs)),
      executionStartedAt: null,
      completedAt: null,
      terminalReason: null,
      cancellationRequestedAt: null,
      cancellationReason: null,
      uncertainReason: null,
      createdAt,
      updatedAt: createdAt,
    });

    const privateInput = input.privateState?.input ?? input.privateInput;
    const privateBinding = input.privateState?.inputBinding ?? sourceBinding;
    if (privateBinding !== sourceBinding) {
      throw new ToolApprovalStoreError(
        "INVALID_RECORD",
        "Private approval input binding must match the durable invocation binding",
        422,
      );
    }
    let immutablePrivateInput: unknown;
    try {
      immutablePrivateInput = snapshotPrivateInput(privateInput);
    } catch (error) {
      throw new ToolApprovalStoreError(
        "INVALID_RECORD",
        error instanceof Error ? error.message : "Private approval input is not supported",
        422,
      );
    }

    await this.storage.mutate((database) => {
      const records = database.toolApprovalInvocations;
      if (!Array.isArray(records)) throw new ToolApprovalStoreError("INVALID_RECORD", "Approval collection is unavailable", 500);
      if (
        records.some(
          (existing) =>
            existing.approvalId === approvalId ||
            existing.invocationId === invocationId ||
            existing.workflowRunId === workflowRunId ||
            existing.approvalId === invocationId ||
            existing.approvalId === workflowRunId ||
            existing.invocationId === workflowRunId,
        )
      ) {
        throw new ToolApprovalStoreError("INVALID_RECORD", "Approval identifier is already in use", 409);
      }
      records.push(record);
    });

    const state: ToolApprovalPrivateState = input.privateState?.completionHandle === undefined
      ? Object.freeze({ input: immutablePrivateInput, inputBinding: privateBinding })
      : Object.freeze({
          input: immutablePrivateInput,
          inputBinding: privateBinding,
          completionHandle: input.privateState.completionHandle,
    });
    this.privateState.set(record.privateInputHandle, state);
    await this.emitTransition(null, record);
    return clone(record);
  }

  /** Short aliases used by workflow/bridge callers. */
  async create(input: ToolApprovalCreateInput): Promise<ToolApprovalInvocationRecord> {
    return this.createInvocation(input);
  }

  get(approvalId: string): ToolApprovalInvocationRecord | null {
    const value = this.storage.snapshot().toolApprovalInvocations.find(
      (record) => record.approvalId === approvalId,
    );
    return value === undefined ? null : clone(value);
  }

  getByInvocationId(invocationId: string): ToolApprovalInvocationRecord | null {
    const value = this.storage.snapshot().toolApprovalInvocations.find(
      (record) => record.invocationId === invocationId,
    );
    return value === undefined ? null : clone(value);
  }

  getByWorkflowRunId(workflowRunId: string): ToolApprovalInvocationRecord | null {
    const value = this.storage.snapshot().toolApprovalInvocations.find(
      (record) => record.workflowRunId === workflowRunId,
    );
    return value === undefined ? null : clone(value);
  }

  list(): ToolApprovalInvocationRecord[] {
    return this.storage.snapshot().toolApprovalInvocations.map((record) => clone(record));
  }

  listPublic(): ToolApprovalPublicDto[] {
    return this.list().map((record) => publicDto(record));
  }

  getPublic(approvalId: string): ToolApprovalPublicDto | null {
    const record = this.get(approvalId);
    return record === null ? null : publicDto(record);
  }

  getPublicByInvocationId(invocationId: string): ToolApprovalPublicDto | null {
    const record = this.getByInvocationId(invocationId);
    return record === null ? null : publicDto(record);
  }

  /**
   * Retrieve the private envelope only after every trusted binding matches.
   * An old owner epoch or a recreated process has no usable private state,
   * even if a durable record and workflow snapshot are still present.
   */
  getPrivateState(approvalId: string, binding: ToolApprovalBinding): ToolApprovalPrivateState {
    const record = this.requireRecord(approvalId);
    if (TERMINAL_STATUSES.has(record.status)) {
      throw new ToolApprovalStoreError(
        "PRIVATE_STATE_UNAVAILABLE",
        "Private approval state is unavailable after the invocation reached a terminal state",
      );
    }
    this.assertBinding(record, binding, true);
    const state = this.privateState.get(record.privateInputHandle);
    if (state === undefined || state.inputBinding !== binding.inputBinding) {
      throw new ToolApprovalStoreError(
        "PRIVATE_STATE_UNAVAILABLE",
        "The private approval input is unavailable for this owner epoch",
      );
    }
    return state;
  }

  /** Resolve the same private envelope by the opaque invocation reference. */
  getPrivateStateByInvocationId(
    invocationId: string,
    binding: ToolApprovalBinding,
  ): ToolApprovalPrivateState {
    const record = this.getByInvocationId(invocationId);
    if (record === null) {
      throw new ToolApprovalStoreError("NOT_FOUND", "Approval invocation was not found", 404);
    }
    return this.getPrivateState(record.approvalId, binding);
  }

  getPrivateEnvelope(
    invocationId: string,
    binding: ToolApprovalBinding,
  ): ToolApprovalPrivateState {
    return this.getPrivateStateByInvocationId(invocationId, binding);
  }

  /**
   * Resolve the private workflow envelope from the server-owned invocation
   * reference.  This seam is deliberately separate from the public DTO and
   * does not accept a client-provided binding: the workflow input contains
   * only this opaque reference, while the returned state remains process
   * private and is still fenced by the current owner epoch.
   *
   * Callers must be server-owned workflow code.  Human/HTTP callers should
   * continue using getPrivateState(..., binding), which verifies every
   * identity and scope field before returning private state.
   */
  getPrivateStateForWorkflow(invocationId: string): ToolApprovalPrivateState {
    const record = this.getByInvocationId(invocationId);
    if (record === null) {
      throw new ToolApprovalStoreError("NOT_FOUND", "Approval invocation was not found", 404);
    }
    this.assertCurrentOwner(record);
    if (TERMINAL_STATUSES.has(record.status)) {
      throw new ToolApprovalStoreError(
        "PRIVATE_STATE_UNAVAILABLE",
        "Private approval state is unavailable after the invocation reached a terminal state",
      );
    }
    const state = this.privateState.get(record.privateInputHandle);
    if (state === undefined) {
      throw new ToolApprovalStoreError(
        "PRIVATE_STATE_UNAVAILABLE",
        "The private approval input is unavailable for this owner epoch",
      );
    }
    return state;
  }

  /** Alias for workflow bridges that use the invocation-reference wording. */
  getPrivateStateByInvocationReference(invocationRef: string): ToolApprovalPrivateState {
    return this.getPrivateStateForWorkflow(invocationRef);
  }

  /** Completion handles are never returned through the public DTO. */
  getCompletionHandle(approvalId: string, binding: ToolApprovalBinding): unknown {
    const state = this.getPrivateState(approvalId, binding);
    return state.completionHandle;
  }

  async markWaiting(
    approvalId: string,
    expectedVersion?: number,
    ownerEpoch = this.currentOwnerEpoch,
  ): Promise<ToolApprovalInvocationRecord> {
    const record = this.requireRecord(approvalId);
    const expected = expectedVersion ?? record.version;
    if (record.ownerEpoch !== ownerEpoch || ownerEpoch !== this.currentOwnerEpoch) {
      throw new ToolApprovalStoreError("OWNER_EPOCH_MISMATCH", "Approval belongs to an old owner epoch");
    }
    assertExpectedVersion(record, expected);
    if (record.status === "waiting") return record;
    if (record.status !== "requested") {
      throw new ToolApprovalStoreError("INVALID_TRANSITION", `Approval cannot enter waiting from ${record.status}`);
    }
    return this.transition(
      record,
      ["requested"],
      (current) => this.withUpdate(current, { status: "waiting" }),
    );
  }

  async claimDecision(input: ToolApprovalDecisionInput): Promise<ToolApprovalDecisionResult> {
    const record = this.requireRecord(input.approvalId);
    const desired = decisionFor(input.approved);
    // Binding and owner checks precede idempotence.  Knowing an approval ID
    // and repeating the same boolean must not make a foreign Run/Agent/Project
    // look like an authorized duplicate.
    if (input.binding !== undefined) {
      // Once a decision exists (including a terminal rejection/completion),
      // the private envelope has deliberately been purged.  The durable
      // binding is still required for a safe idempotent retry, but requiring
      // the private map entry here would turn harmless retries into a state
      // leak and would make terminal cleanup impossible.
      this.assertBinding(record, input.binding, record.decision === null && !TERMINAL_STATUSES.has(record.status));
    }
    else this.assertCurrentOwner(record);
    if (record.decision !== null) {
      // The decision is immutable even while the approved invocation moves
      // through resuming/executing and its eventual terminal outcome.  A
      // retry of the same decision must therefore return the current record,
      // rather than being mistaken for a stale or invalid transition.
      if (record.decision === desired) {
        return { outcome: "idempotent", record };
      }
      throw new ToolApprovalStoreError("CONFLICTING_DECISION", "A conflicting approval decision already exists");
    }
    assertExpectedVersion(record, input.expectedVersion);
    if (record.status !== "waiting") {
      if (record.status === "requested") {
        throw new ToolApprovalStoreError("INVALID_TRANSITION", "Approval is not suspended yet");
      }
      throw new ToolApprovalStoreError("INVALID_TRANSITION", `Approval cannot be decided from ${record.status}`);
    }
    if (recordHasExpired(record, this.now())) {
      const expiry: ToolApprovalCloseInput = {
        approvalId: record.approvalId,
        expectedVersion: record.version,
        ...(input.binding === undefined ? {} : { binding: input.binding }),
      };
      await this.expire(expiry);
      throw new ToolApprovalStoreError("EXPIRED", "Approval deadline has elapsed");
    }
    const actor = safeActor(input.actor, "actor");
    if (actor === null) throw new ToolApprovalStoreError("INVALID_RECORD", "A decision actor is required", 422);
    const reason = input.reason === undefined ? null : safeText(input.reason, "decisionReason");
    const next = await this.transition(
      record,
      ["waiting"],
      (current) => this.withUpdate(current, {
        status: input.approved ? "approved" : "rejected",
        decision: desired,
        decisionActor: actor,
        decisionAt: nowTimestamp(this.now),
        decisionReason: reason,
        ...(input.approved ? {} : { completedAt: nowTimestamp(this.now), terminalReason: reason ?? "Rejected by the decision actor" }),
      }),
    );
    return { outcome: "claimed", record: next };
  }

  async decide(input: ToolApprovalDecisionInput): Promise<ToolApprovalDecisionResult> {
    return this.claimDecision(input);
  }

  async claimExecutionStart(input: ToolApprovalExecutionStartInput): Promise<ToolApprovalExecutionStartResult> {
    const record = this.requireRecord(input.approvalId);
    if (input.binding !== undefined) {
      this.assertBinding(record, input.binding, !TERMINAL_STATUSES.has(record.status));
    }
    else this.assertCurrentOwner(record);
    if (record.status === "executing") {
      return { claimed: false, record, reason: "already_started" };
    }
    if (record.status === "cancelled" || record.status === "revoked") {
      return { claimed: false, record, reason: "cancelled" };
    }
    if (record.status === "expired") return { claimed: false, record, reason: "expired" };
    if (TERMINAL_STATUSES.has(record.status)) {
      return { claimed: false, record, reason: "terminal" };
    }
    if (recordHasExpired(record, this.now())) {
      const expired = await this.transition(
        record,
        ["approved", "resuming"],
        (current) => this.withUpdate(current, {
          status: "expired",
          completedAt: nowTimestamp(this.now),
          terminalReason: "Approval deadline has elapsed",
        }),
      ).catch((error: unknown) => {
        if (error instanceof ToolApprovalStoreError && error.code === "STALE_VERSION") return this.get(input.approvalId)!;
        throw error;
      });
      return { claimed: false, record: expired, reason: "expired" };
    }
    if (!statusIs(record.status, ["approved", "resuming"])) {
      return { claimed: false, record, reason: "invalidated" };
    }
    if (record.version !== input.expectedVersion) {
      return { claimed: false, record, reason: "stale" };
    }
    const startedAt = nowTimestamp(this.now);
    let next: ToolApprovalInvocationRecord;
    try {
      next = await this.transition(
        record,
        ["approved", "resuming"],
        (current) => this.withUpdate(current, {
          status: "executing",
          executionStartedAt: startedAt,
        }),
      );
    } catch (error: unknown) {
      if (!(error instanceof ToolApprovalStoreError) || error.code !== "STALE_VERSION") throw error;
      // A conditional-update loser must never mint a second execution
      // claim.  JSON sees the winner in its serialized snapshot; a separate
      // PostgreSQL connection may only see its stale local snapshot, so both
      // paths deliberately return a non-claiming result.
      const latest = this.get(input.approvalId);
      if (latest === null) throw error;
      if (latest.status === "executing") {
        return { claimed: false, record: latest, reason: "already_started" };
      }
      if (latest.status === "cancelled" || latest.status === "revoked") {
        return { claimed: false, record: latest, reason: "cancelled" };
      }
      if (latest.status === "expired") {
        return { claimed: false, record: latest, reason: "expired" };
      }
      if (TERMINAL_STATUSES.has(latest.status)) {
        return { claimed: false, record: latest, reason: "terminal" };
      }
      return { claimed: false, record: latest, reason: "stale" };
    }
    if (next.status !== "executing" || next.executionStartedAt === null) {
      return { claimed: false, record: next, reason: next.status === "cancelled" ? "cancelled" : "stale" };
    }
    const claim: ToolApprovalExecutionClaim = Object.freeze({
      kind: "tool-approval-execution-claim",
      claimId: randomUUID(),
      approvalId: next.approvalId,
      invocationId: next.invocationId,
      workflowRunId: next.workflowRunId,
      ownerEpoch: next.ownerEpoch,
      version: next.version,
    });
    this.executionClaims.add(claim);
    return { claimed: true, record: next, claim, reason: "claimed" };
  }

  async claimExecution(input: ToolApprovalExecutionStartInput): Promise<ToolApprovalExecutionStartResult> {
    return this.claimExecutionStart(input);
  }

  /**
   * Linearize the last pre-executor fence.  `claimExecutionStart` moves an
   * approved invocation to `executing`, but cancellation is still allowed to
   * request a stop in that state.  This second CAS is performed immediately
   * before the ToolService consumes its one-shot object claim, after any
   * asynchronous audit/revalidation work.  If cancellation won the race, the
   * version or cancellation marker differs and no executor claim may start.
   */
  async confirmExecutionStart(
    input: ToolApprovalExecutionStartInput,
  ): Promise<ToolApprovalInvocationRecord> {
    const record = this.requireRecord(input.approvalId);
    if (input.binding !== undefined) {
      this.assertBinding(record, input.binding, !TERMINAL_STATUSES.has(record.status));
    } else {
      this.assertCurrentOwner(record);
    }
    if (
      record.status !== "executing" ||
      record.executionStartedAt === null ||
      record.cancellationRequestedAt !== null ||
      record.version !== input.expectedVersion
    ) {
      throw new ToolApprovalStoreError(
        "EXECUTION_CLAIM_INVALID",
        "The approval execution claim was cancelled before execution started",
      );
    }
    return this.transition(record, ["executing"], (current) => {
      // The JSON adapter checks this inside its serialized mutation and the
      // PostgreSQL adapter checks the expected version in its conditional
      // update. Both paths therefore choose one linearization point against a
      // concurrent cancellation request.
      if (
        current.status !== "executing" ||
        current.executionStartedAt === null ||
        current.cancellationRequestedAt !== null
      ) {
        throw new ToolApprovalStoreError(
          "EXECUTION_CLAIM_INVALID",
          "The approval execution claim was cancelled before execution started",
        );
      }
      return this.withUpdate(current, {
        status: "executing",
        executionStartedAt: current.executionStartedAt,
      });
    });
  }

  /** Alias used by workflow bridges that call the boundary a launch claim. */
  async confirmExecution(input: ToolApprovalExecutionStartInput): Promise<ToolApprovalInvocationRecord> {
    return this.confirmExecutionStart(input);
  }

  async markResuming(
    approvalId: string,
    expectedVersion: number,
    binding?: ToolApprovalBinding,
  ): Promise<ToolApprovalInvocationRecord> {
    const record = this.requireRecord(approvalId);
    if (binding !== undefined) this.assertBinding(record, binding, true);
    else this.assertCurrentOwner(record);
    assertExpectedVersion(record, expectedVersion);
    if (record.status === "resuming") return record;
    if (record.status !== "approved") throw new ToolApprovalStoreError("INVALID_TRANSITION", `Approval cannot resume from ${record.status}`);
    return this.transition(record, ["approved"], (current) => this.withUpdate(current, { status: "resuming" }));
  }

  async markPreExecutionFailure(
    approvalId: string,
    expectedVersion: number,
    reason: string,
    binding?: ToolApprovalBinding,
  ): Promise<ToolApprovalInvocationRecord> {
    const record = this.requireRecord(approvalId);
    if (binding !== undefined) this.assertBinding(record, binding, true);
    else this.assertCurrentOwner(record);
    assertExpectedVersion(record, expectedVersion);
    if (!statusIs(record.status, ["approved", "resuming"])) {
      throw new ToolApprovalStoreError("INVALID_TRANSITION", `Pre-execution failure cannot close ${record.status}`);
    }
    const terminalReason = safeText(reason, "terminalReason");
    return this.transition(record, ["approved", "resuming"], (current) => this.withUpdate(current, {
      status: "failed_pre_execution",
      completedAt: nowTimestamp(this.now),
      terminalReason,
    }));
  }

  async settleExecution(input: ToolApprovalExecutionSettlementInput): Promise<ToolApprovalInvocationRecord> {
    if (!isRecord(input.claim) || !this.executionClaims.has(input.claim)) {
      throw new ToolApprovalStoreError("EXECUTION_CLAIM_INVALID", "The execution claim is not owned by this store");
    }
    const record = this.requireRecord(input.approvalId);
    if (
      input.claim.approvalId !== record.approvalId ||
      input.claim.invocationId !== record.invocationId ||
      input.claim.workflowRunId !== record.workflowRunId ||
      record.status !== "executing"
    ) {
      throw new ToolApprovalStoreError("EXECUTION_CLAIM_INVALID", "The execution claim no longer matches the invocation");
    }
    const terminalReason = input.reason === undefined ? null : safeText(input.reason, "terminalReason");
    const next = await this.transition(record, ["executing"], (current) => this.withUpdate(current, {
      status: input.outcome,
      completedAt: nowTimestamp(this.now),
      terminalReason,
      ...(input.outcome === "uncertain" ? { uncertainReason: terminalReason ?? "Execution outcome is uncertain" } : {}),
    }));
    return next;
  }

  async completeExecution(input: ToolApprovalExecutionSettlementInput): Promise<ToolApprovalInvocationRecord> {
    return this.settleExecution(input);
  }

  async cancel(input: ToolApprovalCloseInput): Promise<ToolApprovalInvocationRecord> {
    return this.close(input, "cancelled");
  }

  async revoke(input: ToolApprovalCloseInput): Promise<ToolApprovalInvocationRecord> {
    return this.close(input, "revoked");
  }

  async expire(input: ToolApprovalCloseInput): Promise<ToolApprovalInvocationRecord> {
    return this.close(input, "expired");
  }

  /** Invalidate a pending invocation without ever making it executable. */
  async invalidate(input: ToolApprovalCloseInput): Promise<ToolApprovalInvocationRecord> {
    return this.close(input, "cancelled");
  }

  private async close(
    input: ToolApprovalCloseInput,
    target: "cancelled" | "revoked" | "expired",
  ): Promise<ToolApprovalInvocationRecord> {
    const record = this.requireRecord(input.approvalId);
    if (input.binding !== undefined) {
      this.assertBinding(record, input.binding, !TERMINAL_STATUSES.has(record.status));
    }
    else this.assertCurrentOwner(record);
    if (record.status === target) {
      this.privateState.delete(record.privateInputHandle);
      return record;
    }
    if (TERMINAL_STATUSES.has(record.status)) {
      if (record.status === "executing" && target === "cancelled") {
        const requestedAt = nowTimestamp(this.now);
        const expectedVersion = input.expectedVersion ?? record.version;
        assertExpectedVersion(record, expectedVersion);
        return this.transition(record, ["executing"], (current) => this.withUpdate(current, {
          cancellationRequestedAt: requestedAt,
          cancellationReason: input.reason === undefined ? "Cancellation requested after execution started" : safeText(input.reason, "cancellationReason"),
        }));
      }
      throw new ToolApprovalStoreError("INVALID_TRANSITION", `Approval is already ${record.status}`);
    }
    if (record.status === "executing") {
      const expectedVersion = input.expectedVersion ?? record.version;
      assertExpectedVersion(record, expectedVersion);
      if (target !== "cancelled") throw new ToolApprovalStoreError("INVALID_TRANSITION", "An executing invocation cannot expire or revoke safely");
      return this.transition(record, ["executing"], (current) => this.withUpdate(current, {
        cancellationRequestedAt: nowTimestamp(this.now),
        cancellationReason: input.reason === undefined ? "Cancellation requested after execution started" : safeText(input.reason, "cancellationReason"),
      }));
    }
    if (!PRE_EXECUTION_STATUSES.has(record.status)) {
      throw new ToolApprovalStoreError("INVALID_TRANSITION", `Approval cannot close from ${record.status}`);
    }
    const expectedVersion = input.expectedVersion ?? record.version;
    assertExpectedVersion(record, expectedVersion);
    const terminalReason = input.reason === undefined
      ? target === "expired" ? "Approval deadline has elapsed" : target === "revoked" ? "Approval revoked" : "Approval cancelled"
      : safeText(input.reason, "terminalReason");
    return this.transition(record, [record.status], (current) => this.withUpdate(current, {
      status: target,
      completedAt: nowTimestamp(this.now),
      terminalReason,
    })).catch((error: unknown) => {
      // If execution won the same approved -> executing race, cancellation
      // becomes a post-start cancellation request.  It must not report a
      // false pre-start cancellation or reopen the execution fence.
      if (error instanceof ToolApprovalStoreError && error.code === "STALE_VERSION" && target === "cancelled") {
        const latest = this.get(input.approvalId);
        if (latest?.status === "executing") {
          return this.transition(latest, ["executing"], (current) => this.withUpdate(current, {
            cancellationRequestedAt: nowTimestamp(this.now),
            cancellationReason: input.reason === undefined
              ? "Cancellation requested after execution started"
              : safeText(input.reason, "cancellationReason"),
          }));
        }
      }
      throw error;
    });
  }

  /**
   * Startup reconciliation: pre-execution records are fenced/closed, while a
   * record that may already have caused an external effect is retained as
   * uncertain. No native workflow or private input is reattached.
   */
  async invalidateOldOwnerEpochs(): Promise<number> {
    let changed = 0;
    const fencedPrivateInputHandles: string[] = [];
    const transitions: Array<[
      ToolApprovalInvocationRecord,
      ToolApprovalInvocationRecord,
    ]> = [];
    await this.storage.mutate((database) => {
      for (let index = 0; index < database.toolApprovalInvocations.length; index += 1) {
        const current = database.toolApprovalInvocations[index]!;
        if (TERMINAL_STATUSES.has(current.status)) {
          // Defensive cleanup for records created by an older process version
          // that may have left a private handle behind after terminalization.
          fencedPrivateInputHandles.push(current.privateInputHandle);
          continue;
        }
        if (current.ownerEpoch === this.currentOwnerEpoch) continue;
        const next = copyRecord(current);
        next.version += 1;
        next.updatedAt = nowTimestamp(this.now);
        if (current.status === "executing") {
          next.status = "uncertain";
          next.completedAt = next.updatedAt;
          next.uncertainReason = "Owning process epoch ended while execution was in flight";
          next.terminalReason = next.uncertainReason;
        } else {
          next.status = "cancelled";
          next.completedAt = next.updatedAt;
          next.terminalReason = "Owning process epoch ended before execution started";
        }
        database.toolApprovalInvocations[index] = Object.freeze(next);
        transitions.push([current, next]);
        fencedPrivateInputHandles.push(current.privateInputHandle);
        changed += 1;
      }
    });
    for (const privateInputHandle of fencedPrivateInputHandles) this.privateState.delete(privateInputHandle);
    for (const [previous, next] of transitions) await this.emitTransition(previous, next);
    return changed;
  }

  /** Fence active records tied to a deleted Agent/Project; retain history. */
  async invalidateForAgent(agentId: string, reason = "Agent was deleted"): Promise<number> {
    return this.invalidateMatching((record) => record.agentId === agentId, reason);
  }

  async invalidateForProject(projectId: string, reason = "Project was deleted"): Promise<number> {
    return this.invalidateMatching((record) => record.projectId === projectId, reason);
  }

  /** Fence all active approval records owned by one Agent Run. */
  async invalidateForRun(runId: string, reason = "Agent Run was cancelled"): Promise<number> {
    return this.invalidateMatching((record) => record.runId === runId, reason);
  }

  /** Fence all active approval records owned by one orchestration/session. */
  async invalidateForSession(
    sessionId: string,
    reason = "Owning session was cancelled",
  ): Promise<number> {
    return this.invalidateMatching((record) => record.sessionId === sessionId, reason);
  }

  private async invalidateMatching(
    matches: (record: ToolApprovalInvocationRecord) => boolean,
    reason: string,
  ): Promise<number> {
    let changed = 0;
    const fencedPrivateInputHandles: string[] = [];
    const transitions: Array<[
      ToolApprovalInvocationRecord,
      ToolApprovalInvocationRecord,
    ]> = [];
    const terminalReason = safeText(reason, "terminalReason");
    await this.storage.mutate((database) => {
      for (let index = 0; index < database.toolApprovalInvocations.length; index += 1) {
        const current = database.toolApprovalInvocations[index]!;
        if (TERMINAL_STATUSES.has(current.status)) {
          if (matches(current)) fencedPrivateInputHandles.push(current.privateInputHandle);
          continue;
        }
        if (!matches(current)) continue;
        const next = copyRecord(current);
        next.version += 1;
        next.updatedAt = nowTimestamp(this.now);
        if (current.status === "executing") {
          // Repeated lifecycle notifications are expected (for example, a
          // Run cancel followed by session revoke). Keep cancellation
          // idempotent so observers do not manufacture new versions.
          if (current.cancellationRequestedAt !== null) {
            fencedPrivateInputHandles.push(current.privateInputHandle);
            continue;
          }
          next.cancellationRequestedAt = next.updatedAt;
          next.cancellationReason = terminalReason;
        } else {
          next.status = "cancelled";
          next.completedAt = next.updatedAt;
          next.terminalReason = terminalReason;
        }
        database.toolApprovalInvocations[index] = Object.freeze(next);
        transitions.push([current, next]);
        fencedPrivateInputHandles.push(current.privateInputHandle);
        changed += 1;
      }
    });
    for (const privateInputHandle of fencedPrivateInputHandles) this.privateState.delete(privateInputHandle);
    for (const [previous, next] of transitions) await this.emitTransition(previous, next);
    return changed;
  }

  private requireRecord(approvalId: string): ToolApprovalInvocationRecord {
    const record = this.get(approvalId);
    if (record === null) throw new ToolApprovalStoreError("NOT_FOUND", "Approval invocation was not found", 404);
    return record;
  }

  private assertCurrentOwner(record: ToolApprovalInvocationRecord): void {
    if (record.ownerEpoch !== this.currentOwnerEpoch) {
      throw new ToolApprovalStoreError("OWNER_EPOCH_MISMATCH", "Approval belongs to an old owner epoch");
    }
  }

  private assertBinding(record: ToolApprovalInvocationRecord, binding: ToolApprovalBinding, requirePrivateState: boolean): void {
    this.assertCurrentOwner(record);
    const matches =
      (binding.approvalId === undefined || binding.approvalId === record.approvalId) &&
      binding.invocationId === record.invocationId &&
      binding.workflowRunId === record.workflowRunId &&
      binding.agentId === record.agentId &&
      sameNullable(record.projectId, binding.projectId) &&
      binding.runId === record.runId &&
      sameNullable(record.orchestrationId, binding.orchestrationId) &&
      sameNullable(record.turnId, binding.turnId) &&
      sameNullable(record.sessionId, binding.sessionId) &&
      binding.toolId === record.toolId &&
      binding.policyVersion === record.policyVersion &&
      binding.ownerEpoch === record.ownerEpoch &&
      opaqueBinding(binding.inputBinding) === record.inputBinding;
    if (!matches) {
      throw new ToolApprovalStoreError("FOREIGN_BINDING", "Approval binding does not match the stored invocation");
    }
    if (requirePrivateState) {
      const state = this.privateState.get(record.privateInputHandle);
      if (state === undefined || state.inputBinding !== binding.inputBinding) {
        throw new ToolApprovalStoreError("PRIVATE_STATE_UNAVAILABLE", "Private approval state is unavailable");
      }
    }
  }

  private withUpdate(
    current: ToolApprovalInvocationRecord,
    update: Partial<MutableRecord>,
  ): ToolApprovalInvocationRecord {
    const next: MutableRecord = {
      ...copyRecord(current),
      ...update,
      version: current.version + 1,
      updatedAt: nowTimestamp(this.now),
    };
    return Object.freeze(next);
  }

  private purgePrivateState(record: ToolApprovalInvocationRecord): void {
    if (TERMINAL_STATUSES.has(record.status)) {
      this.privateState.delete(record.privateInputHandle);
    }
  }

  private async transition(
    record: ToolApprovalInvocationRecord,
    expectedStatuses: readonly ToolApprovalStatus[],
    build: (current: ToolApprovalInvocationRecord) => ToolApprovalInvocationRecord,
  ): Promise<ToolApprovalInvocationRecord> {
    const candidate = build(record);
    const conditional = this.storage as Storage & Partial<ToolApprovalConditionalStorage>;
    if (typeof conditional.conditionalUpdateToolApproval === "function") {
      const updated = await conditional.conditionalUpdateToolApproval({
        approvalId: record.approvalId,
        expectedVersion: record.version,
        expectedOwnerEpoch: record.ownerEpoch,
        expectedStatuses,
        next: candidate,
      });
      if (updated !== null) {
        this.purgePrivateState(updated);
        const result = clone(updated);
        await this.emitTransition(record, result);
        return result;
      }
      const latest = this.get(record.approvalId);
      if (latest === null) throw new ToolApprovalStoreError("NOT_FOUND", "Approval invocation was removed", 404);
      throw new ToolApprovalStoreError("STALE_VERSION", "Approval transition lost its compare-and-set race");
    }

    let applied: ToolApprovalInvocationRecord | null = null;
    await this.storage.mutate((database) => {
      const index = database.toolApprovalInvocations.findIndex((value) => value.approvalId === record.approvalId);
      const current = index < 0 ? undefined : database.toolApprovalInvocations[index];
      if (
        current === undefined ||
        current.version !== record.version ||
        current.ownerEpoch !== record.ownerEpoch ||
        !expectedStatuses.includes(current.status)
      ) {
        return;
      }
      const next = build(current);
      database.toolApprovalInvocations[index] = next;
      applied = next;
    });
    if (applied === null) throw new ToolApprovalStoreError("STALE_VERSION", "Approval transition lost its compare-and-set race");
    this.purgePrivateState(applied);
    const result = clone(applied);
    await this.emitTransition(record, result);
    return result;
  }
}

/**
 * Stable non-secret digest helper for diagnostics/tests.  It deliberately
 * does not expose the process binding key or the original private input.
 */
export function toolApprovalBindingFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
