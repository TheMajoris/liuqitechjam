import { z } from "zod";
import { HttpError } from "../errors.js";
import {
  CheckpointResumeStateSchema,
  type CheckpointResumeState,
} from "../orchestration/checkpoint-resume-state.js";

/** The source inclusion policy every checkpoint in this build is captured under. */
export const CHECKPOINT_POLICY_VERSION = "source-v1" as const;
export type CheckpointPolicyVersion = typeof CHECKPOINT_POLICY_VERSION;

export type WorkspaceCheckpointKind = "baseline" | "turn_success" | "safety";
export type WorkspaceCheckpointState =
  | "preparing"
  | "captured"
  | "ready"
  | "failed"
  | "invalid";

export const WORKSPACE_CHECKPOINT_ERROR_CODES = [
  "CHECKPOINT_NOT_FOUND",
  "CHECKPOINT_NOT_READY",
  "CHECKPOINT_CONTEXT_MISMATCH",
  "CHECKPOINT_NO_REMAINING_STEPS",
  "CHECKPOINT_IDEMPOTENCY_CONFLICT",
  "CHECKPOINT_EXECUTION_ALREADY_ACCEPTED",
  "CHECKPOINT_RESTORE_CONFLICT",
  "CHECKPOINT_POLICY_MISMATCH",
  "CHECKPOINT_INVALID_INPUT",
  "CHECKPOINT_SECRET_DETECTED",
  "CHECKPOINT_LIMIT_EXCEEDED",
  "CHECKPOINT_UNAVAILABLE",
  "CHECKPOINT_DIRECT_PROJECT_RUN_UNSUPPORTED",
  "CHECKPOINT_RUNTIME_UNSUPPORTED",
  "CHECKPOINT_WRITER_UNSETTLED",
  "CHECKPOINT_CORRUPT",
  "CHECKPOINT_CAPTURE_FAILED",
  "CHECKPOINT_RESTORE_FAILED",
  "CHECKPOINT_OPERATION_STAGE_INVALID",
] as const;
export const WorkspaceCheckpointErrorCodeSchema = z.enum(WORKSPACE_CHECKPOINT_ERROR_CODES);
export type WorkspaceCheckpointErrorCode = (typeof WORKSPACE_CHECKPOINT_ERROR_CODES)[number];

export function workspaceCheckpointErrorStatus(code: WorkspaceCheckpointErrorCode): number {
  switch (code) {
    case "CHECKPOINT_NOT_FOUND":
      return 404;
    case "CHECKPOINT_NOT_READY":
    case "CHECKPOINT_CONTEXT_MISMATCH":
    case "CHECKPOINT_NO_REMAINING_STEPS":
    case "CHECKPOINT_IDEMPOTENCY_CONFLICT":
    case "CHECKPOINT_EXECUTION_ALREADY_ACCEPTED":
    case "CHECKPOINT_RESTORE_CONFLICT":
    case "CHECKPOINT_POLICY_MISMATCH":
    case "CHECKPOINT_DIRECT_PROJECT_RUN_UNSUPPORTED":
    case "CHECKPOINT_WRITER_UNSETTLED":
    case "CHECKPOINT_OPERATION_STAGE_INVALID":
      return 409;
    case "CHECKPOINT_INVALID_INPUT":
    case "CHECKPOINT_SECRET_DETECTED":
    case "CHECKPOINT_LIMIT_EXCEEDED":
      return 422;
    case "CHECKPOINT_UNAVAILABLE":
    case "CHECKPOINT_RUNTIME_UNSUPPORTED":
      return 503;
    default:
      return 500;
  }
}

/**
 * Typed checkpoint failure. The message is always a fixed safe sentence: no
 * Git stderr, host path, secret value, or prompt fragment crosses this class.
 */
export class WorkspaceCheckpointError extends HttpError {
  readonly errorCode: WorkspaceCheckpointErrorCode;

  constructor(
    public readonly code: WorkspaceCheckpointErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(workspaceCheckpointErrorStatus(code), message);
    this.name = "WorkspaceCheckpointError";
    this.errorCode = code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function isWorkspaceCheckpointError(error: unknown): error is WorkspaceCheckpointError {
  return error instanceof WorkspaceCheckpointError;
}

/**
 * One physical source snapshot plus the logical boundary it belongs to.
 *
 * The Git identities are private implementation metadata and never leave the
 * server. A checkpoint is offered for recovery only while `state === "ready"`
 * and, for a successful turn, only once its saved continuation exists.
 */
export interface WorkspaceCheckpoint {
  id: string;
  projectId: string;
  /** Monotonically allocated per Project; gaps are allowed. */
  ordinal: number;
  kind: WorkspaceCheckpointKind;
  state: WorkspaceCheckpointState;
  /** The cycle or recovery reservation that authorized this capture. */
  operationId: string;
  workspaceEpoch: number;
  executionCycleId: string | null;
  orchestrationId: string | null;
  /** Filled when the completion hook links the persisted turn; not a roster position. */
  turnId: string | null;
  runId: string | null;
  /** Historical scalar; survives Agent deletion. */
  agentId: string | null;
  participantId: string | null;
  /** Global journal step index. */
  stepIndex: number | null;
  parentCheckpointId: string | null;
  policyVersion: CheckpointPolicyVersion;
  gitSha: string | null;
  treeSha: string | null;
  /** SHA-256 over the sorted path/mode/blob manifest. */
  manifestHash: string | null;
  fileCount: number;
  byteCount: number;
  excludedFileCount: number;
  resume: CheckpointResumeState | null;
  errorCode: WorkspaceCheckpointErrorCode | null;
  createdAt: string;
  readyAt: string | null;
}

export type WorkspaceExecutionCycleStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

/** One accepted execution cycle of a checkpoint-enabled Project session. */
export interface WorkspaceExecutionCycle {
  id: string;
  projectId: string;
  orchestrationId: string;
  operationId: string;
  /** The checkpoint a recovery cycle resumed from; null for ordinary cycles. */
  sourceCheckpointId: string | null;
  baselineCheckpointId: string | null;
  initialState: CheckpointResumeState;
  /** Accepted branch only, bounded by maxSteps. */
  acceptedTurnIds: string[];
  status: WorkspaceExecutionCycleStatus;
  createdAt: string;
  completedAt: string | null;
}

export type WorkspaceOperationKind = "cycle" | "recovery";
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

/**
 * Durable Project reservation and recovery journal.
 *
 * A held reservation excludes every other platform writer from the Project.
 * Its ID is a correlation identifier: only trusted server execution options
 * can assert ownership, and a client can only look one up.
 */
export interface WorkspaceOperation {
  id: string;
  projectId: string;
  kind: WorkspaceOperationKind;
  orchestrationId: string;
  executionCycleId: string | null;
  /** Client recovery UUID for idempotency; never dispatch authorization. */
  requestId: string | null;
  requestFingerprint: string | null;
  actorPrincipalId: string;
  stage: WorkspaceOperationStage;
  reservationHeld: boolean;
  targetCheckpointId: string | null;
  safetyCheckpointId: string | null;
  resumeCycleId: string | null;
  expectedEpoch: number;
  errorCode: WorkspaceCheckpointErrorCode | null;
  /** Immutable apply plan derived from the safety and target manifests. */
  restorePlanHash?: string | undefined;
  /** Proves the epoch reset committed; never increment twice. */
  restoredEpoch?: number | undefined;
  resumeRequestId?: string | undefined;
  resumeRequestFingerprint?: string | undefined;
  safetyRequestId?: string | undefined;
  safetyRequestFingerprint?: string | undefined;
  lastAuditStage: string | null;
  createdAt: string;
  updatedAt: string;
}

const idSchema = z.string().min(1);
const timestampSchema = z.string().min(1);
const countSchema = z.number().int().nonnegative();

export const WorkspaceCheckpointKindSchema = z.enum(["baseline", "turn_success", "safety"]);
export const WorkspaceCheckpointStateSchema = z.enum([
  "preparing",
  "captured",
  "ready",
  "failed",
  "invalid",
]);
export const WorkspaceOperationStageSchema = z.enum([
  "reserved",
  "preparing",
  "backed_up",
  "restoring",
  "restored",
  "resume_accepted",
  "settled",
  "failed",
  "recovery_required",
]);

export const WorkspaceCheckpointSchema: z.ZodType<WorkspaceCheckpoint> = z
  .object({
    id: idSchema,
    projectId: idSchema,
    ordinal: z.number().int().positive(),
    kind: WorkspaceCheckpointKindSchema,
    state: WorkspaceCheckpointStateSchema,
    operationId: idSchema,
    workspaceEpoch: countSchema,
    executionCycleId: idSchema.nullable(),
    orchestrationId: idSchema.nullable(),
    turnId: idSchema.nullable(),
    runId: idSchema.nullable(),
    agentId: idSchema.nullable(),
    participantId: idSchema.nullable(),
    stepIndex: countSchema.nullable(),
    parentCheckpointId: idSchema.nullable(),
    policyVersion: z.literal(CHECKPOINT_POLICY_VERSION),
    gitSha: z.string().regex(/^[0-9a-f]{40,64}$/u).nullable(),
    treeSha: z.string().regex(/^[0-9a-f]{40,64}$/u).nullable(),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
    fileCount: countSchema,
    byteCount: countSchema,
    excludedFileCount: countSchema,
    resume: CheckpointResumeStateSchema.nullable(),
    errorCode: WorkspaceCheckpointErrorCodeSchema.nullable(),
    createdAt: timestampSchema,
    readyAt: timestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    // A ready record without its physical identity, or a ready successful
    // turn without its logical continuation, is impossible and must never be
    // offered as recoverable.
    if (value.state === "ready" || value.state === "captured") {
      if (value.gitSha === null || value.treeSha === null || value.manifestHash === null) {
        context.addIssue({
          code: "custom",
          path: ["state"],
          message: "A captured checkpoint needs its commit, tree, and manifest identity",
        });
      }
    }
    if (value.state === "ready" && value.kind !== "safety" && value.resume === null) {
      context.addIssue({
        code: "custom",
        path: ["resume"],
        message: "A ready recoverable checkpoint needs its saved continuation",
      });
    }
    if (value.kind === "safety" && value.resume !== null) {
      context.addIssue({
        code: "custom",
        path: ["resume"],
        message: "A safety checkpoint is physically restorable only",
      });
    }
  });

export const WorkspaceExecutionCycleSchema: z.ZodType<WorkspaceExecutionCycle> = z.object({
  id: idSchema,
  projectId: idSchema,
  orchestrationId: idSchema,
  operationId: idSchema,
  sourceCheckpointId: idSchema.nullable(),
  baselineCheckpointId: idSchema.nullable(),
  initialState: CheckpointResumeStateSchema,
  acceptedTurnIds: z.array(idSchema).max(1_000),
  status: z.enum(["queued", "running", "completed", "failed", "stopped", "interrupted"]),
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});

export const WorkspaceOperationSchema: z.ZodType<WorkspaceOperation> = z.object({
  id: idSchema,
  projectId: idSchema,
  kind: z.enum(["cycle", "recovery"]),
  orchestrationId: idSchema,
  executionCycleId: idSchema.nullable(),
  requestId: idSchema.nullable(),
  requestFingerprint: z.string().nullable(),
  actorPrincipalId: idSchema,
  stage: WorkspaceOperationStageSchema,
  reservationHeld: z.boolean(),
  targetCheckpointId: idSchema.nullable(),
  safetyCheckpointId: idSchema.nullable(),
  resumeCycleId: idSchema.nullable(),
  expectedEpoch: countSchema,
  errorCode: WorkspaceCheckpointErrorCodeSchema.nullable(),
  restorePlanHash: z.string().optional(),
  restoredEpoch: countSchema.optional(),
  resumeRequestId: idSchema.optional(),
  resumeRequestFingerprint: z.string().optional(),
  safetyRequestId: idSchema.optional(),
  safetyRequestFingerprint: z.string().optional(),
  lastAuditStage: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

// ------------------------------------------------------------- public views

/**
 * Safe HTTP projection. No SHA, host path, manifest, prompt, saved context,
 * execution ownership assertion, or thread ID crosses this boundary.
 */
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
  /** Server-derived affordance; the recovery route revalidates it. */
  recoverable: boolean;
  unavailableReason: WorkspaceCheckpointErrorCode | null;
}

export interface WorkspaceRecoveryView {
  operationId: string;
  projectId: string;
  orchestrationId: string;
  kind: WorkspaceOperationKind;
  checkpointId: string | null;
  safetyCheckpointId: string | null;
  stage: WorkspaceOperationStage;
  resumeCycleId: string | null;
  errorCode: WorkspaceCheckpointErrorCode | null;
  createdAt: string;
  updatedAt: string;
}

/** Capability and gate summary shown beside a checkpoint listing. */
export interface WorkspaceCheckpointStatusView {
  enabled: boolean;
  available: boolean;
  scope: CheckpointPolicyVersion;
  busy: boolean;
  recoveryRequired: boolean;
  errorCode: WorkspaceCheckpointErrorCode | null;
}

export function toWorkspaceCheckpointView(
  checkpoint: WorkspaceCheckpoint,
  options: { recoverable: boolean; unavailableReason?: WorkspaceCheckpointErrorCode | null },
): WorkspaceCheckpointView {
  return {
    checkpointId: checkpoint.id,
    projectId: checkpoint.projectId,
    ordinal: checkpoint.ordinal,
    kind: checkpoint.kind,
    state: checkpoint.state,
    orchestrationId: checkpoint.orchestrationId,
    turnId: checkpoint.turnId,
    runId: checkpoint.runId,
    stepIndex: checkpoint.stepIndex,
    createdAt: checkpoint.createdAt,
    fileCount: checkpoint.fileCount,
    byteCount: checkpoint.byteCount,
    excludedFileCount: checkpoint.excludedFileCount,
    recoverable: options.recoverable,
    unavailableReason: options.unavailableReason ?? checkpoint.errorCode ?? null,
  };
}

export function toWorkspaceRecoveryView(operation: WorkspaceOperation): WorkspaceRecoveryView {
  return {
    operationId: operation.id,
    projectId: operation.projectId,
    orchestrationId: operation.orchestrationId,
    kind: operation.kind,
    checkpointId: operation.targetCheckpointId,
    safetyCheckpointId: operation.safetyCheckpointId,
    stage: operation.stage,
    resumeCycleId: operation.resumeCycleId,
    errorCode: operation.errorCode,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

/** Stages during which a recovery is still working or waiting on an operator. */
export function isRecoveryPending(stage: WorkspaceOperationStage): boolean {
  return (
    stage === "reserved" ||
    stage === "preparing" ||
    stage === "backed_up" ||
    stage === "restoring" ||
    stage === "restored" ||
    stage === "recovery_required"
  );
}

/** Internal execution identity carried only through trusted server options. */
export interface WorkspaceExecutionContext {
  projectId: string;
  orchestrationId: string;
  workspaceOperationId: string;
  executionCycleId: string;
  workspaceEpoch: number;
}
