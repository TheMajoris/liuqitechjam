import { Mastra } from "@mastra/core";
import { RequestContext } from "@mastra/core/request-context";
import { InMemoryStore } from "@mastra/core/storage";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { WorkflowResult, WorkflowState } from "@mastra/core/workflows";
import { z } from "zod";
import {
  ToolApprovalStore,
  ToolApprovalStoreError,
  type ToolApprovalBinding,
  type ToolApprovalCompletionHandle,
  type ToolApprovalInvocationRecord,
  type ToolApprovalPrivateState,
} from "./tool-approval-store.js";
import {
  ToolExecutionClaim,
  ToolService,
} from "./tool-service.js";
import { ToolError } from "./tool-errors.js";
import type { PreparedToolInvocation } from "./tool-types.js";

/** Stable registry identifiers for the single generic approval workflow. */
export const TOOL_APPROVAL_WORKFLOW_ID = "tool-approval-workflow" as const;
export const TOOL_APPROVAL_STEP_ID = "approval" as const;

const MAX_INVOCATION_REFERENCE_LENGTH = 256;
const MAX_SAFE_SUMMARY_LENGTH = 512;
const MAX_RESULT_REFERENCE_LENGTH = 256;
const DEFAULT_FAILURE_REASON = "The tool approval could not be completed safely";

/**
 * The workflow carries only this server-created reference.  Prepared inputs,
 * principals and completion handles never cross the native workflow input
 * boundary.
 */
export const toolApprovalWorkflowInputSchema = z
  .object({
    invocationRef: z.string().min(1).max(MAX_INVOCATION_REFERENCE_LENGTH),
  })
  .strict();

/** Safe payload shown while the native workflow is suspended. */
export const toolApprovalSuspendSchema = z
  .object({
    invocationRef: z.string().min(1).max(MAX_INVOCATION_REFERENCE_LENGTH),
    summary: z.string().min(1).max(MAX_SAFE_SUMMARY_LENGTH),
  })
  .strict();

/** Human decision data accepted by native resume. */
export const toolApprovalResumeSchema = z
  .object({
    approved: z.boolean(),
  })
  .strict();

/** Strict service request shape; invocationRef remains the only reference. */
const toolApprovalResumeRequestSchema = z
  .object({
    invocationRef: z.string().min(1).max(MAX_INVOCATION_REFERENCE_LENGTH),
    approved: z.boolean(),
  })
  .strict();

const toolApprovalWorkflowOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("rejected"),
    invocationRef: z.string().min(1).max(MAX_INVOCATION_REFERENCE_LENGTH),
    reason: z.string().min(1).max(MAX_SAFE_SUMMARY_LENGTH),
  }),
  z.object({
    status: z.literal("failed_pre_execution"),
    invocationRef: z.string().min(1).max(MAX_INVOCATION_REFERENCE_LENGTH),
    reason: z.string().min(1).max(MAX_SAFE_SUMMARY_LENGTH),
  }),
  z.object({
    status: z.literal("executed"),
    invocationRef: z.string().min(1).max(MAX_INVOCATION_REFERENCE_LENGTH),
    /** Opaque live-completion reference; the business result stays in memory. */
    resultRef: z.string().min(1).max(MAX_RESULT_REFERENCE_LENGTH),
  }),
]);

export type ToolApprovalWorkflowInput = z.infer<typeof toolApprovalWorkflowInputSchema>;
export type ToolApprovalSuspendPayload = z.infer<typeof toolApprovalSuspendSchema>;
export type ToolApprovalResumeData = z.infer<typeof toolApprovalResumeSchema>;
export type ToolApprovalWorkflowOutput = z.infer<typeof toolApprovalWorkflowOutputSchema>;

export type ToolApprovalNativeWorkflowStatus =
  | "pending"
  | "running"
  | "suspended"
  | "success"
  | "failed"
  | "canceled"
  | "paused"
  | "tripwire";

/** The native result shape used by start/resume, kept intentionally small. */
export type ToolApprovalWorkflowRunResult = {
  readonly status: ToolApprovalNativeWorkflowStatus;
  readonly result?: ToolApprovalWorkflowOutput;
  readonly suspendPayload?: ToolApprovalSuspendPayload;
  readonly error?: unknown;
  readonly input?: ToolApprovalWorkflowInput;
  readonly suspended?: string[][];
  readonly runId?: string;
  /** Internal lifecycle evidence; never changes the application fence. */
  readonly nativeCancelFailed?: boolean;
  /** True when a native/provider failure, rather than a user denial, occurred. */
  readonly nativeFailure?: boolean;
  readonly workflowId?: string;
  readonly [key: string]: unknown;
};

function isTerminalNativeWorkflowStatus(status: unknown): boolean {
  return status === "success" || status === "failed" || status === "canceled" || status === "tripwire";
}

// Upper-case aliases make the native contract easy to discover from a
// composition root without duplicating schema instances.
export const TOOL_APPROVAL_WORKFLOW_INPUT_SCHEMA = toolApprovalWorkflowInputSchema;
export const TOOL_APPROVAL_SUSPEND_SCHEMA = toolApprovalSuspendSchema;
export const TOOL_APPROVAL_RESUME_SCHEMA = toolApprovalResumeSchema;
export const TOOL_APPROVAL_OUTPUT_SCHEMA = toolApprovalWorkflowOutputSchema;

export interface ToolApprovalWorkflowView {
  readonly workflowId: string;
  readonly stepId: string;
  readonly invocation: ReturnType<ToolApprovalStore["getPublicByInvocationId"]>;
  readonly workflow: WorkflowState | null;
}

export interface ToolApprovalWorkflowStorageOptions {
  /** Native Mastra workflow storage. This is required; no implicit default. */
  readonly storage?: MastraCompositeStore;
  /** Alias accepted by composition roots that name this dependency explicitly. */
  readonly workflowStorage?: MastraCompositeStore;
  /** Explicit opt-in for InMemoryStore in tests/local development only. */
  readonly allowInMemoryStore?: boolean;
  /** Alias for allowInMemoryStore. */
  readonly allowInMemoryStorage?: boolean;
  /** Defaults to NODE_ENV, then development. */
  readonly environment?: string;
}

export interface ToolApprovalWorkflowDependencies extends ToolApprovalWorkflowStorageOptions {
  readonly approvalStore: ToolApprovalStore;
  readonly toolService: ToolService;
  readonly workflowId?: string;
  readonly stepId?: string;
  /** Optional hook for cooperative cancellation observers. */
  readonly onAbort?: (invocationRef: string) => void | Promise<void>;
  /**
   * Development/test convenience only. Production callers must claim the
   * decision in ToolApprovalStore before asking this service to resume.
   */
  readonly allowDirectDecision?: boolean;
  readonly decisionActorId?: string;
}

export interface ToolApprovalWorkflowStartInput {
  readonly invocationRef: string;
}

export interface ToolApprovalWorkflowResumeInput {
  readonly invocationRef: string;
  readonly approved: boolean;
}

export interface ToolApprovalWorkflowCancelInput {
  readonly invocationRef: string;
  readonly reason?: string;
}

export class ToolApprovalWorkflowConfigurationError extends Error {
  readonly name = "ToolApprovalWorkflowConfigurationError";
}

/**
 * A deterministic workflow definition.  The only workflow input is an
 * opaque invocation reference; all authorization and execution dependencies
 * are server-owned closures.
 */
export interface ToolApprovalWorkflowDefinitionOptions {
  readonly approvalStore: ToolApprovalStore;
  readonly toolService: ToolService;
  readonly workflowId?: string;
  readonly stepId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function publishProtectedResult(
  completionHandle: unknown,
  value: unknown,
  fallbackReference: string,
): string {
  if (isRecord(completionHandle) && typeof completionHandle.publishResult === "function") {
    try {
      const reference = (completionHandle as unknown as ToolApprovalCompletionHandle).publishResult(value);
      if (
        typeof reference === "string" &&
        reference.length > 0 &&
        reference.length <= MAX_RESULT_REFERENCE_LENGTH
      ) {
        return reference;
      }
    } catch {
      // The service will fail closed if the live result sink is unavailable.
    }
  }
  // Standalone workflow fixtures have no live MCP response. An invocation
  // reference is still an opaque terminal marker; it cannot reveal a result
  // and a bridge without a protected sink will reject delivery safely.
  return fallbackReference;
}

function safeReason(value: unknown): string {
  // Only stable, code-owned reasons may cross the workflow/application
  // boundary.  Never persist an arbitrary Error.message: executors and
  // providers can put credentials, request bodies, or filesystem paths in it.
  if (value instanceof ToolError) {
    switch (value.code) {
      case "APPROVAL_REQUIRED":
        return "Human approval is required before execution";
      case "PERMISSION_DENIED":
        return "The tool invocation is not permitted";
      case "TOOL_INVOCATION_INVALIDATED":
        return "The tool invocation is no longer authorized";
      case "TOOL_EXECUTION_CLAIM_FAILED":
        return "The tool execution claim is no longer valid";
      case "TOOL_EXECUTION_EXPIRED":
        return "The tool execution was cancelled or expired";
      case "TOOL_INVALID_INPUT":
        return "The tool input is invalid";
      case "TOOL_OUTPUT_INVALID":
        return "The tool returned invalid output";
      case "TOOL_NOT_FOUND":
        return "The requested tool is unavailable";
      case "MCP_AUTHENTICATION_REQUIRED":
        return "Tool authentication is required";
      case "TOOL_EXECUTION_FAILED":
        return "The tool could not complete";
      default:
        return DEFAULT_FAILURE_REASON;
    }
  }
  if (value instanceof ToolApprovalStoreError) {
    switch (value.code) {
      case "EXPIRED":
        return "The approval deadline has elapsed";
      case "PRIVATE_STATE_UNAVAILABLE":
        return "The private approval state is unavailable";
      case "FOREIGN_BINDING":
      case "OWNER_EPOCH_MISMATCH":
      case "STALE_VERSION":
      case "EXECUTION_CLAIM_INVALID":
        return "The approval invocation is no longer valid";
      case "NOT_FOUND":
        return "The approval invocation is no longer available";
      default:
        return DEFAULT_FAILURE_REASON;
    }
  }
  return DEFAULT_FAILURE_REASON;
}

function invocationRefFrom(input: string | ToolApprovalWorkflowStartInput): string {
  const invocationRef = typeof input === "string" ? input : input.invocationRef;
  const parsed = z.string().min(1).max(MAX_INVOCATION_REFERENCE_LENGTH).safeParse(invocationRef);
  if (!parsed.success) {
    throw new ToolApprovalWorkflowConfigurationError("A valid invocation reference is required");
  }
  return parsed.data;
}

function isInMemoryStorage(storage: MastraCompositeStore): boolean {
  return storage instanceof InMemoryStore || storage.constructor?.name === "InMemoryStore";
}

function resolveStorage(options: ToolApprovalWorkflowStorageOptions): MastraCompositeStore {
  const storage = options.workflowStorage ?? options.storage;
  if (storage === undefined || storage === null) {
    throw new ToolApprovalWorkflowConfigurationError(
      "Native Mastra workflow storage is required for tool approvals",
    );
  }
  const environment = options.environment ?? process.env.NODE_ENV ?? "development";
  const allowInMemory = options.allowInMemoryStore === true || options.allowInMemoryStorage === true;
  const inMemoryAllowedEnvironment = environment === "development" || environment === "test";
  if (isInMemoryStorage(storage) && (environment === "production" || !allowInMemory || !inMemoryAllowedEnvironment)) {
    throw new ToolApprovalWorkflowConfigurationError(
      environment === "production"
        ? "InMemoryStore is not allowed for production tool approvals"
        : "InMemoryStore requires an explicit test/development opt-in",
    );
  }
  return storage;
}

function bindingFor(
  record: ToolApprovalInvocationRecord,
  inputBinding: string,
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

function preparedInvocationMatchesRecord(
  prepared: unknown,
  record: ToolApprovalInvocationRecord,
  privateState: ToolApprovalPrivateState,
): prepared is PreparedToolInvocation {
  if (!isRecord(prepared)) return false;
  const candidate = prepared as Partial<PreparedToolInvocation> & {
    context?: Record<string, unknown>;
    policy?: Record<string, unknown>;
  };
  const context = candidate.context;
  const policy = candidate.policy;
  if (
    candidate.kind !== "prepared-tool-invocation" ||
    candidate.toolId !== record.toolId ||
    context === undefined ||
    policy === undefined ||
    context.agentId !== record.agentId ||
    context.runId !== record.runId ||
    (context.projectId ?? null) !== record.projectId ||
    (context.orchestrationId ?? null) !== record.orchestrationId ||
    (context.toolId !== undefined && context.toolId !== record.toolId) ||
    context.principal === undefined ||
    !isRecord(context.principal) ||
    context.principal.kind !== "agent" ||
    context.principal.id !== record.agentId ||
    policy.mode !== "required" ||
    policy.version !== record.policyVersion ||
    typeof candidate.rawInputBinding !== "string" ||
    typeof candidate.inputBinding !== "string" ||
    typeof privateState.inputBinding !== "string" ||
    (privateState.inputBinding !== candidate.rawInputBinding &&
      privateState.inputBinding !== candidate.inputBinding)
  ) {
    return false;
  }
  return true;
}

/**
 * Reattach only server-owned correlation facts when a native run is started or
 * resumed. Prepared input, completion handles, and transport headers never
 * enter this context, so a persisted/native snapshot cannot become a data
 * exfiltration path.
 */
function requestContextForRecord(record: ToolApprovalInvocationRecord): RequestContext {
  const requestContext = new RequestContext();
  const values: Array<[string, string]> = [
    ["agentId", record.agentId],
    ["runId", record.runId],
    ["invocationId", record.invocationId],
    ["approvalId", record.approvalId],
    ["workflowRunId", record.workflowRunId],
  ];
  if (record.projectId !== null) values.push(["projectId", record.projectId]);
  if (record.orchestrationId !== null) values.push(["orchestrationId", record.orchestrationId]);
  if (record.turnId !== null) values.push(["turnId", record.turnId]);
  if (record.sessionId !== null) values.push(["sessionId", record.sessionId]);
  if (record.traceRefs.traceId !== undefined) values.push(["traceId", record.traceRefs.traceId]);
  if (record.traceRefs.parentSpanId !== undefined) values.push(["parentSpanId", record.traceRefs.parentSpanId]);
  for (const [key, value] of values) requestContext.setRaw(key, value);
  return requestContext;
}

function syntheticSuspendedResult(
  record: ToolApprovalInvocationRecord,
  workflowId: string,
  stepId: string,
): ToolApprovalWorkflowRunResult {
  return {
    status: "suspended",
    workflowId,
    runId: record.workflowRunId,
    input: { invocationRef: record.invocationId },
    suspendPayload: {
      invocationRef: record.invocationId,
      summary: record.safeSummary,
    },
    suspended: [[stepId]],
  };
}

function outputFromRecord(
  record: ToolApprovalInvocationRecord,
): ToolApprovalWorkflowOutput | undefined {
  if (record.status === "rejected") {
    return {
      status: "rejected",
      invocationRef: record.invocationId,
      reason: record.terminalReason ?? "Rejected by the decision actor",
    };
  }
  if (
    record.status === "failed_pre_execution" ||
    record.status === "failed" ||
    record.status === "expired" ||
    record.status === "cancelled" ||
    record.status === "revoked" ||
    record.status === "uncertain"
  ) {
    return {
      status: "failed_pre_execution",
      invocationRef: record.invocationId,
      reason: record.terminalReason ?? DEFAULT_FAILURE_REASON,
    };
  }
  return undefined;
}

function isTerminalApplicationStatus(status: ToolApprovalInvocationRecord["status"]): boolean {
  return status === "succeeded" || status === "rejected" || status === "failed_pre_execution" ||
    status === "failed" || status === "expired" || status === "cancelled" || status === "revoked" ||
    status === "uncertain";
}

function isTerminalApplicationRecord(record: ToolApprovalInvocationRecord): boolean {
  return isTerminalApplicationStatus(record.status);
}

async function closePreExecution(
  approvalStore: ToolApprovalStore,
  record: ToolApprovalInvocationRecord | null,
  reason: string,
  inputBinding?: string,
): Promise<ToolApprovalInvocationRecord | null> {
  if (record === null) return null;
  const current = approvalStore.get(record.approvalId) ?? record;
  const binding = inputBinding === undefined ? undefined : bindingFor(current, inputBinding);
  try {
    if (current.status === "requested" || current.status === "waiting") {
      return await approvalStore.cancel({
        approvalId: current.approvalId,
        expectedVersion: current.version,
        reason,
        ...(binding === undefined ? {} : { binding }),
      });
    }
    if (current.status === "approved" || current.status === "resuming") {
      return await approvalStore.markPreExecutionFailure(
        current.approvalId,
        current.version,
        reason,
        binding,
      );
    }
    return current;
  } catch (error) {
    // A competing cancellation/terminal transition is already safe.  Native
    // errors remain fenced and are intentionally not exposed to callers.
    return approvalStore.get(record.approvalId) ?? current;
  }
}

function nativeResultToServiceResult(
  result: unknown,
  record: ToolApprovalInvocationRecord,
  workflowId: string,
  stepId: string,
): ToolApprovalWorkflowRunResult {
  if (!isRecord(result) || typeof result.status !== "string") {
    return {
      status: "success",
      nativeFailure: true,
      workflowId,
      runId: record.workflowRunId,
      result: {
        status: "failed_pre_execution",
        invocationRef: record.invocationId,
        reason: DEFAULT_FAILURE_REASON,
      },
    };
  }
  const native = result as ToolApprovalWorkflowRunResult;
  if (native.status === "suspended") {
    return {
      status: "suspended",
      workflowId,
      runId: record.workflowRunId,
      suspendPayload: {
        invocationRef: record.invocationId,
        summary: record.safeSummary,
      },
      suspended: native.suspended ?? [[stepId]],
    };
  }
  // Do not forward the native result object wholesale: Mastra failure
  // snapshots may contain an Error with an arbitrary provider message. The
  // workflow service exposes only its small status/result union, and callers
  // map failed/tripwire states to the stable generic reason below.
  if (
    native.status === "success" ||
    native.status === "failed" ||
    native.status === "canceled" ||
    native.status === "tripwire" ||
    native.status === "pending" ||
    native.status === "running" ||
    native.status === "paused"
  ) {
    return {
      status: native.status,
      ...(native.status === "success" && native.result === undefined
        ? { nativeFailure: true }
        : {}),
      workflowId,
      runId: record.workflowRunId,
      ...(native.status === "success" && native.result !== undefined
        ? { result: native.result }
        : {}),
    };
  }
  return {
    status: "failed",
    nativeFailure: true,
    workflowId,
    runId: record.workflowRunId,
  };
}

function nativeStatusToResult(
  state: WorkflowState | null,
  record: ToolApprovalInvocationRecord,
  workflowId: string,
  stepId: string,
): ToolApprovalWorkflowRunResult | null {
  if (state === null) return null;
  if (state.status === "suspended") {
    return syntheticSuspendedResult(record, workflowId, stepId);
  }
  const output = outputFromRecord(record);
  if (state.status === "success" && isRecord(state.result)) {
    return {
      status: "success",
      workflowId,
      runId: record.workflowRunId,
      result: state.result as ToolApprovalWorkflowOutput,
    };
  }
  if (output !== undefined) {
    return {
      status: "success",
      workflowId,
      runId: record.workflowRunId,
      result: output,
    };
  }
  return {
    status: state.status as ToolApprovalNativeWorkflowStatus,
    ...(state.status !== "success" && state.status !== "canceled"
      ? { nativeFailure: true }
      : {}),
    workflowId,
    runId: record.workflowRunId,
    ...(state.status === "failed"
      ? {
          result: {
            status: "failed_pre_execution" as const,
            invocationRef: record.invocationId,
            reason: DEFAULT_FAILURE_REASON,
          },
        }
      : {}),
  };
}

/**
 * Build the one generic deterministic Mastra workflow.  The function does
 * not create a Mastra instance; register the returned workflow with the
 * service below so the native storage dependency is explicit.
 */
export function createToolApprovalWorkflow(
  options: ToolApprovalWorkflowDefinitionOptions,
) {
  const workflowId = options.workflowId ?? TOOL_APPROVAL_WORKFLOW_ID;
  const stepId = options.stepId ?? TOOL_APPROVAL_STEP_ID;
  const approvalStore = options.approvalStore;
  const toolService = options.toolService;

  const approvalStep = createStep({
    id: stepId,
    inputSchema: toolApprovalWorkflowInputSchema,
    outputSchema: toolApprovalWorkflowOutputSchema,
    suspendSchema: toolApprovalSuspendSchema,
    resumeSchema: toolApprovalResumeSchema,
    retries: 0,
    execute: async ({ inputData, resumeData, suspend, abortSignal }) => {
      const record = approvalStore.getByInvocationId(inputData.invocationRef);
      if (record === null) {
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: "The approval invocation is no longer available",
        };
      }

      // The first invocation may only establish the waiting state and yield
      // to the trusted decision channel.  No private input is fetched here.
      if (resumeData === undefined) {
        if (record.status === "requested") {
          try {
            await approvalStore.markWaiting(record.approvalId, record.version);
          } catch (error) {
            await closePreExecution(approvalStore, record, safeReason(error));
            return {
              status: "failed_pre_execution" as const,
              invocationRef: inputData.invocationRef,
              reason: DEFAULT_FAILURE_REASON,
            };
          }
        } else if (record.status !== "waiting") {
          const current = await closePreExecution(
            approvalStore,
            record,
            "The approval workflow was resumed without a decision",
          );
          return {
            status: "failed_pre_execution" as const,
            invocationRef: inputData.invocationRef,
            reason: current?.terminalReason ?? "The approval workflow was resumed without a decision",
          };
        }
        // `await` is intentional: a suspension is not a final tool result.
        return await suspend({
          invocationRef: inputData.invocationRef,
          summary: record.safeSummary,
        });
      }

      if (abortSignal.aborted) {
        await closePreExecution(approvalStore, record, "The approval workflow was cancelled");
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: "The approval workflow was cancelled",
        };
      }

      // A rejection is a terminal branch and intentionally never fetches the
      // private prepared invocation or reaches ToolService.
      if (!resumeData.approved) {
        const current = approvalStore.getByInvocationId(inputData.invocationRef);
        if (current !== null && current.decision !== "rejected") {
          await closePreExecution(
            approvalStore,
            current,
            "The tool invocation was rejected by the decision actor",
          );
        }
        return {
          status: "rejected" as const,
          invocationRef: inputData.invocationRef,
          reason:
            current?.terminalReason ??
            "The tool invocation was rejected by the decision actor",
        };
      }

      const approvedRecord = approvalStore.getByInvocationId(inputData.invocationRef);
      if (approvedRecord === null || approvedRecord.decision !== "approved") {
        const current = await closePreExecution(
          approvalStore,
          approvedRecord ?? record,
          "The approval decision is not available",
        );
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: current?.terminalReason ?? "The approval decision is not available",
        };
      }

      // Fetch the exact server-private PreparedToolInvocation only after the
      // explicit approval branch.  The workflow input never carries it.
      let privateState: ToolApprovalPrivateState;
      try {
        privateState = approvalStore.getPrivateStateForWorkflow(
          approvedRecord.invocationId,
        );
      } catch (error) {
        const current = await closePreExecution(approvalStore, approvedRecord, safeReason(error));
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: current?.terminalReason ?? DEFAULT_FAILURE_REASON,
        };
      }
      if (
        !preparedInvocationMatchesRecord(
          privateState.input,
          approvedRecord,
          privateState,
        )
      ) {
        const current = await closePreExecution(
          approvalStore,
          approvedRecord,
          "The private prepared invocation does not match the approval",
          privateState.inputBinding,
        );
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: current?.terminalReason ?? DEFAULT_FAILURE_REASON,
        };
      }

      const prepared = privateState.input as PreparedToolInvocation;
      const binding = bindingFor(approvedRecord, privateState.inputBinding);
      let resuming: ToolApprovalInvocationRecord;
      try {
        resuming = await approvalStore.markResuming(
          approvedRecord.approvalId,
          approvedRecord.version,
          binding,
        );
      } catch (error) {
        const current = await closePreExecution(
          approvalStore,
          approvedRecord,
          safeReason(error),
          privateState.inputBinding,
        );
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: current?.terminalReason ?? DEFAULT_FAILURE_REASON,
        };
      }

      // The durable application fence wins before a ToolService claim is
      // minted.  A second resume sees executing and returns without executing.
      const started = await approvalStore.claimExecutionStart({
        approvalId: resuming.approvalId,
        expectedVersion: resuming.version,
        binding,
      });
      if (!started.claimed || started.claim === undefined) {
        const current = started.record;
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason:
            current.terminalReason ??
            (started.reason === "already_started"
              ? "The tool invocation is already executing"
              : "The tool invocation is no longer executable"),
        };
      }

      if (abortSignal.aborted) {
        // The durable start claim has already won, so cancellation must settle
        // that claim as a pre-execution terminal outcome.  Merely recording a
        // cancellation request would leave the invocation stuck in
        // `executing` even though no business executor was called.
        try {
          await approvalStore.settleExecution({
            approvalId: started.record.approvalId,
            claim: started.claim,
            outcome: "failed",
            reason: "The approval workflow was cancelled before execution",
          });
        } catch {
          // A competing terminal transition remains authoritative. The
          // normal branch has no business effect to roll back.
        }
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: "The approval workflow was cancelled before execution",
        };
      }

      let executionClaim: ToolExecutionClaim;
      try {
        // This is deliberately after the durable store claim. The ToolService
        // object capability is one-shot and bound to this exact envelope.
        executionClaim = toolService.issueExecutionClaim(prepared, {
          ...(started.record.traceRefs.traceId === undefined
            ? {}
            : { traceId: started.record.traceRefs.traceId }),
          ...(started.record.traceRefs.parentSpanId === undefined
            ? {}
            : { parentSpanId: started.record.traceRefs.parentSpanId }),
          ...(started.record.turnId === null ? {} : { turnId: started.record.turnId }),
          ...(started.record.sessionId === null ? {} : { sessionId: started.record.sessionId }),
          invocationId: started.record.invocationId,
          approvalId: started.record.approvalId,
          workflowRunId: started.record.workflowRunId,
        });
      } catch (error) {
        await approvalStore.settleExecution({
          approvalId: started.record.approvalId,
          claim: started.claim,
          outcome: "failed",
          reason: "The server could not authorize the execution claim",
        }).catch(() => undefined);
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: DEFAULT_FAILURE_REASON,
        };
      }

      try {
        const result = await toolService.executePrepared(prepared, executionClaim, {
          abortSignal,
          // This callback runs after ToolService's final async audit and
          // immediately before it consumes the one-shot claim. The CAS gives
          // cancellation a durable linearization point at the executor edge.
          beforeExecute: async () => {
            await approvalStore.confirmExecutionStart({
              approvalId: started.record.approvalId,
              expectedVersion: started.claim!.version,
              binding,
            });
          },
        });
        // Persist only an opaque marker in the native workflow output. The
        // live approval bridge consumes the value from its protected in-memory
        // completion entry; a workflow snapshot must never contain it.
        const resultRef = publishProtectedResult(
          privateState.completionHandle,
          result,
          inputData.invocationRef,
        );
        await approvalStore.settleExecution({
          approvalId: started.record.approvalId,
          claim: started.claim,
          outcome: "succeeded",
        });
        return {
          status: "executed" as const,
          invocationRef: inputData.invocationRef,
          resultRef,
        };
      } catch (error) {
        const preExecution =
          isRecord(error) &&
          (error as { code?: unknown }).code !== undefined &&
          [
            "APPROVAL_REQUIRED",
            "TOOL_INVOCATION_INVALIDATED",
            "TOOL_EXECUTION_CLAIM_FAILED",
            "PERMISSION_DENIED",
            "TOOL_EXECUTION_EXPIRED",
          ].includes(String((error as { code?: unknown }).code));
        const storePreExecution =
          error instanceof ToolApprovalStoreError &&
          error.code === "EXECUTION_CLAIM_INVALID";
        await approvalStore.settleExecution({
          approvalId: started.record.approvalId,
          claim: started.claim,
          outcome: preExecution || storePreExecution ? "failed" : "uncertain",
          reason: safeReason(error),
        }).catch(() => undefined);
        return {
          status: "failed_pre_execution" as const,
          invocationRef: inputData.invocationRef,
          reason: preExecution || storePreExecution ? safeReason(error) : DEFAULT_FAILURE_REASON,
        };
      }
    },
  });

  return createWorkflow({
    id: workflowId,
    description: "Deterministic approval gate for sensitive Agent tool invocations",
    inputSchema: toolApprovalWorkflowInputSchema,
    outputSchema: toolApprovalWorkflowOutputSchema,
    // Approval execution is a side effect. Never replay it implicitly.
    retryConfig: { attempts: 0, delay: 0 },
  })
    .then(approvalStep)
    .commit();
}

/**
 * Mastra-backed service used by the MCP bridge/control plane.  It owns the
 * native run handles and serializes same-process duplicate start/resume calls;
 * the durable ToolApprovalStore remains the final cross-process fence.
 */
export class ToolApprovalWorkflowService {
  readonly workflow;
  readonly mastra: Mastra;
  readonly workflowId: string;
  readonly stepId: string;

  private readonly nativeStorage: MastraCompositeStore;
  private readonly approvalStore: ToolApprovalStore;
  private readonly toolService: ToolService;
  private readonly allowDirectDecision: boolean;
  private readonly decisionActorId: string;
  private readonly onAbort: ((invocationRef: string) => void | Promise<void>) | undefined;
  private readyPromise?: Promise<void>;
  private closed = false;
  private readonly startPromises = new Map<string, Promise<ToolApprovalWorkflowRunResult>>();
  private readonly resumePromises = new Map<string, Promise<ToolApprovalWorkflowRunResult>>();
  // Run's generic parameters are tied to the generated workflow graph.  Keep
  // this internal handle map erased; callers only receive the safe result
  // union above.
  private readonly nativeRuns = new Map<string, any>();

  constructor(options: ToolApprovalWorkflowDependencies) {
    this.nativeStorage = resolveStorage(options);
    this.approvalStore = options.approvalStore;
    this.toolService = options.toolService;
    this.workflowId = options.workflowId ?? TOOL_APPROVAL_WORKFLOW_ID;
    this.stepId = options.stepId ?? TOOL_APPROVAL_STEP_ID;
    const environment = options.environment ?? process.env.NODE_ENV ?? "development";
    this.allowDirectDecision = (options.allowDirectDecision ?? environment !== "production") &&
      environment !== "production";
    this.decisionActorId = options.decisionActorId ?? "tool-approval-test";
    this.onAbort = options.onAbort;
    this.workflow = createToolApprovalWorkflow({
      approvalStore: this.approvalStore,
      toolService: this.toolService,
      workflowId: this.workflowId,
      stepId: this.stepId,
    });
    this.mastra = new Mastra({
      logger: false,
      storage: this.nativeStorage,
      workflows: { [this.workflow.id]: this.workflow },
    });
  }

  /** Verify that the selected native workflow store supports CAS updates. */
  private async ensureReady(): Promise<void> {
    if (this.closed) {
      throw new ToolApprovalWorkflowConfigurationError(
        "Native Mastra workflow storage is closed",
      );
    }
    if (this.readyPromise === undefined) {
      this.readyPromise = (async () => {
        // `init()` is deliberately owned by this composition root. The pinned
        // Postgres adapter is allowed to provision its dedicated schema/table
        // set on first boot; development/test adapters may initialize their
        // local stores here as well.
        const initialize = (this.nativeStorage as MastraCompositeStore & {
          init?: () => Promise<void>;
        }).init;
        if (typeof initialize === "function") await initialize.call(this.nativeStorage);
        const workflowStore = await this.nativeStorage.getStore("workflows");
        if (workflowStore === undefined) {
          throw new ToolApprovalWorkflowConfigurationError(
            "Native Mastra workflow storage has no workflows domain",
          );
        }
        const supportsConcurrentUpdates = typeof workflowStore.supportsConcurrentUpdates === "function"
          ? workflowStore.supportsConcurrentUpdates()
          : false;
        if (supportsConcurrentUpdates !== true) {
          throw new ToolApprovalWorkflowConfigurationError(
            "Native Mastra workflow storage must support concurrent conditional updates",
          );
        }
      })();
    }
    return this.readyPromise;
  }

  /**
   * Complete native storage/provider initialization before routes are exposed.
   * Keeping this explicit prevents the first MCP request from becoming the
   * storage health probe (and prevents a partial bridge from being advertised).
   */
  async initialize(): Promise<void> {
    await this.ensureReady();
  }

  private async getNativeState(record: ToolApprovalInvocationRecord): Promise<WorkflowState | null> {
    try {
      return await this.workflow.getWorkflowRunById(record.workflowRunId);
    } catch {
      return null;
    }
  }

  private forgetNativeRun(workflowRunId: string): void {
    this.nativeRuns.delete(workflowRunId);
  }

  private forgetNativeRunIfTerminal(
    record: ToolApprovalInvocationRecord,
    state: WorkflowState | null,
  ): void {
    if (state !== null && isTerminalNativeWorkflowStatus(state.status)) {
      this.forgetNativeRun(record.workflowRunId);
    }
  }

  /**
   * A decision may be durably claimed by the control plane before this
   * service receives its resume call. Rejection still has to drive the
   * already-suspended native run to a terminal success containing the
   * rejected application result; returning the projection alone would leave
   * a native snapshot suspended forever.
   */
  private async resumePreClaimedRejection(
    record: ToolApprovalInvocationRecord,
  ): Promise<ToolApprovalWorkflowRunResult | null> {
    const state = await this.getNativeState(record);
    if (state === null) {
      this.forgetNativeRun(record.workflowRunId);
      return null;
    }
    if (state.status !== "suspended") {
      // The application projection is already terminal. Even if a stale
      // native snapshot reports a non-terminal status, do not retain a live
      // in-process run handle that can never be resumed safely.
      this.forgetNativeRun(record.workflowRunId);
      return nativeStatusToResult(state, record, this.workflowId, this.stepId);
    }
    try {
      const run = this.nativeRuns.get(record.workflowRunId) ??
        await this.workflow.createRun({ runId: record.workflowRunId });
      this.nativeRuns.set(record.workflowRunId, run);
      const result = await run.resume({
        step: this.stepId,
        resumeData: { approved: false },
        requestContext: requestContextForRecord(record),
      });
      const normalized = nativeResultToServiceResult(result, record, this.workflowId, this.stepId);
      if (isTerminalNativeWorkflowStatus(normalized.status)) {
        this.forgetNativeRun(record.workflowRunId);
      }
      if (normalized.nativeFailure === true) {
        await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
        return {
          status: "success",
          nativeFailure: true,
          workflowId: this.workflowId,
          runId: record.workflowRunId,
          result: {
            status: "failed_pre_execution",
            invocationRef: record.invocationId,
            reason: DEFAULT_FAILURE_REASON,
          },
        };
      }
      if (normalized.status === "suspended") {
        // A rejection can never legitimately suspend again. Close the
        // application projection and release the native handle on this path.
        this.forgetNativeRun(record.workflowRunId);
        return {
          ...this.syntheticTerminalResult(record),
          nativeFailure: true,
        };
      }
      return normalized;
    } catch {
      this.forgetNativeRun(record.workflowRunId);
      return {
        ...this.syntheticTerminalResult(record),
        nativeFailure: true,
      };
    }
  }

  private async closeAfterNativeFailure(
    record: ToolApprovalInvocationRecord | null,
    reason: string,
  ): Promise<void> {
    const closed = await closePreExecution(this.approvalStore, record, reason);
    const latest = closed ?? (record === null ? null : this.approvalStore.get(record.approvalId));
    if (latest !== null && isTerminalApplicationRecord(latest)) {
      this.forgetNativeRun(latest.workflowRunId);
    }
  }

  private syntheticTerminalResult(record: ToolApprovalInvocationRecord): ToolApprovalWorkflowRunResult {
    const output = outputFromRecord(record);
    return {
      status: "success",
      workflowId: this.workflowId,
      runId: record.workflowRunId,
      ...(output === undefined
        ? {}
        : { result: output }),
    };
  }

  private async startInternal(invocationRef: string): Promise<ToolApprovalWorkflowRunResult> {
    await this.ensureReady();
    let record = this.approvalStore.getByInvocationId(invocationRef);
    if (record === null) {
      return {
        status: "success",
        workflowId: this.workflowId,
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: "The approval invocation is no longer available",
        },
      };
    }
    const terminal = outputFromRecord(record);
    if (terminal !== undefined) {
      this.forgetNativeRun(record.workflowRunId);
      return this.syntheticTerminalResult(record);
    }

    const existingState = await this.getNativeState(record);
    const existing = nativeStatusToResult(
      existingState,
      record,
      this.workflowId,
      this.stepId,
    );
    if (existing !== null) {
      this.forgetNativeRunIfTerminal(record, existingState);
      if (existing.nativeFailure === true) {
        await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
      }
      return existing;
    }

    try {
      const run = await this.workflow.createRun({ runId: record.workflowRunId });
      this.nativeRuns.set(record.workflowRunId, run);
      const result = await run.start({
        inputData: { invocationRef },
        requestContext: requestContextForRecord(record),
      });
      const normalized = nativeResultToServiceResult(result, record, this.workflowId, this.stepId);
      if (isTerminalNativeWorkflowStatus(normalized.status)) {
        this.forgetNativeRun(record.workflowRunId);
      }
      if (normalized.status !== "suspended") {
        await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
        return {
          status: "success",
          nativeFailure: true,
          workflowId: this.workflowId,
          runId: record.workflowRunId,
          result: {
            status: "failed_pre_execution",
            invocationRef,
            reason: DEFAULT_FAILURE_REASON,
          },
        };
      }
      return normalized;
    } catch (error) {
      this.forgetNativeRun(record.workflowRunId);
      record = this.approvalStore.getByInvocationId(invocationRef);
      await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
      return {
        status: "success",
        nativeFailure: true,
        workflowId: this.workflowId,
        ...(record === null ? {} : { runId: record.workflowRunId }),
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: DEFAULT_FAILURE_REASON,
        },
      };
    }
  }

  /** Start the native run; a successful initial start must be suspended. */
  async start(
    input: string | ToolApprovalWorkflowStartInput,
  ): Promise<ToolApprovalWorkflowRunResult> {
    const invocationRef = invocationRefFrom(input);
    const existing = this.startPromises.get(invocationRef);
    if (existing !== undefined) return existing;
    const promise = this.startInternal(invocationRef);
    this.startPromises.set(invocationRef, promise);
    void promise.then(
      () => {
        if (this.startPromises.get(invocationRef) === promise) this.startPromises.delete(invocationRef);
      },
      () => {
        if (this.startPromises.get(invocationRef) === promise) this.startPromises.delete(invocationRef);
      },
    );
    return promise;
  }

  private async ensureDecision(
    record: ToolApprovalInvocationRecord,
    approved: boolean,
  ): Promise<ToolApprovalInvocationRecord | null> {
    if (record.decision !== null) {
      return record.decision === (approved ? "approved" : "rejected") ? record : null;
    }
    if (!this.allowDirectDecision || record.status !== "waiting") return null;
    try {
      return (
        await this.approvalStore.claimDecision({
          approvalId: record.approvalId,
          expectedVersion: record.version,
          approved,
          actor: { kind: "system", id: this.decisionActorId },
        })
      ).record;
    } catch {
      return this.approvalStore.get(record.approvalId);
    }
  }

  private async resumeInternal(
    invocationRef: string,
    approved: boolean,
  ): Promise<ToolApprovalWorkflowRunResult> {
    await this.ensureReady();
    let record = this.approvalStore.getByInvocationId(invocationRef);
    if (record === null) {
      return {
        status: "success",
        workflowId: this.workflowId,
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: "The approval invocation is no longer available",
        },
      };
    }
    const terminal = outputFromRecord(record);
    if (terminal !== undefined) {
      if (record.status === "rejected" && !approved) {
        const nativeRejection = await this.resumePreClaimedRejection(record);
        if (nativeRejection !== null) return nativeRejection;
      }
      this.forgetNativeRun(record.workflowRunId);
      return this.syntheticTerminalResult(record);
    }

    const decisionRecord = await this.ensureDecision(record, approved);
    if (decisionRecord === null) {
      this.forgetNativeRun(record.workflowRunId);
      await this.closeAfterNativeFailure(record, "The approval decision is not authorized");
      return {
        status: "success",
        workflowId: this.workflowId,
        runId: record.workflowRunId,
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: "The approval decision is not authorized",
        },
      };
    }
    record = decisionRecord;

    const state = await this.getNativeState(record);
    if (state === null) {
      this.forgetNativeRun(record.workflowRunId);
      await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
      return {
        status: "success",
        nativeFailure: true,
        workflowId: this.workflowId,
        runId: record.workflowRunId,
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: DEFAULT_FAILURE_REASON,
        },
      };
    }
    if (state.status === "success" || state.status === "failed" || state.status === "canceled") {
      this.forgetNativeRunIfTerminal(record, state);
      const existingResult = nativeStatusToResult(state, record, this.workflowId, this.stepId) ?? this.syntheticTerminalResult(record);
      if (existingResult.nativeFailure === true) {
        await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
      }
      return existingResult;
    }

    try {
      const run = this.nativeRuns.get(record.workflowRunId) ??
        await this.workflow.createRun({ runId: record.workflowRunId });
      this.nativeRuns.set(record.workflowRunId, run);
      const result = await run.resume({
        step: this.stepId,
        resumeData: { approved },
        requestContext: requestContextForRecord(record),
      });
      const normalized = nativeResultToServiceResult(result, record, this.workflowId, this.stepId);
      if (isTerminalNativeWorkflowStatus(normalized.status)) {
        this.forgetNativeRun(record.workflowRunId);
      }
      if (normalized.nativeFailure === true) {
        await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
        return {
          status: "success",
          nativeFailure: true,
          workflowId: this.workflowId,
          runId: record.workflowRunId,
          result: {
            status: "failed_pre_execution",
            invocationRef,
            reason: DEFAULT_FAILURE_REASON,
          },
        };
      }
      if (normalized.status === "suspended") {
        // The approval step has exactly one suspension. A repeated suspension
        // is a native/application mismatch, so close the durable invocation
        // and discard the native handle instead of retaining an unbounded run.
        this.forgetNativeRun(record.workflowRunId);
        await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
        return {
          status: "success",
          nativeFailure: true,
          workflowId: this.workflowId,
          runId: record.workflowRunId,
          result: {
            status: "failed_pre_execution",
            invocationRef,
            reason: DEFAULT_FAILURE_REASON,
          },
        };
      }
      if (normalized.status !== "success" && normalized.status !== "canceled") {
        await this.closeAfterNativeFailure(record, DEFAULT_FAILURE_REASON);
        return {
          status: "success",
          nativeFailure: true,
          workflowId: this.workflowId,
          runId: record.workflowRunId,
          result: {
            status: "failed_pre_execution",
            invocationRef,
            reason: DEFAULT_FAILURE_REASON,
          },
        };
      }
      return normalized;
    } catch (error) {
      const latest = this.approvalStore.getByInvocationId(invocationRef);
      if (latest !== null && isTerminalApplicationRecord(latest)) {
        this.forgetNativeRun(latest.workflowRunId);
      }
      if (
        latest !== null &&
        ["executing", "succeeded", "failed", "uncertain"].includes(latest.status)
      ) {
        const terminal: ToolApprovalWorkflowRunResult = outputFromRecord(latest) === undefined
          ? {
              status: "success" as const,
              workflowId: this.workflowId,
              runId: latest.workflowRunId,
              result: {
                status: "failed_pre_execution" as const,
                invocationRef,
                reason: DEFAULT_FAILURE_REASON,
              },
            }
          : this.syntheticTerminalResult(latest);
        return { ...terminal, nativeFailure: true };
      }
      this.forgetNativeRun(record.workflowRunId);
      await this.closeAfterNativeFailure(latest ?? record, DEFAULT_FAILURE_REASON);
      return {
        status: "success",
        nativeFailure: true,
        workflowId: this.workflowId,
        runId: record.workflowRunId,
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: DEFAULT_FAILURE_REASON,
        },
      };
    }
  }

  /** Resume with a strict boolean decision. */
  async resume(
    input: ToolApprovalWorkflowResumeInput,
  ): Promise<ToolApprovalWorkflowRunResult> {
    const request = toolApprovalResumeRequestSchema.safeParse(input);
    const invocationRef = invocationRefFrom(
      isRecord(input) ? String(input.invocationRef ?? "") : "",
    );
    const parsed = request.success
      ? request
      : { success: false as const, data: undefined };
    if (!parsed.success) {
      const record = this.approvalStore.getByInvocationId(invocationRef);
      await this.closeAfterNativeFailure(record, "The approval decision schema is invalid");
      return {
        status: "success",
        workflowId: this.workflowId,
        ...(record === null ? {} : { runId: record.workflowRunId }),
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: "The approval decision schema is invalid",
        },
      };
    }
    const existing = this.resumePromises.get(invocationRef);
    if (existing !== undefined) return existing;
    const promise = this.resumeInternal(invocationRef, parsed.data.approved);
    this.resumePromises.set(invocationRef, promise);
    void promise.then(
      () => {
        if (this.resumePromises.get(invocationRef) === promise) this.resumePromises.delete(invocationRef);
      },
      () => {
        if (this.resumePromises.get(invocationRef) === promise) this.resumePromises.delete(invocationRef);
      },
    );
    return promise;
  }

  /** Close the application fence first, then request native cancellation. */
  async cancel(
    input: string | ToolApprovalWorkflowCancelInput,
  ): Promise<ToolApprovalWorkflowRunResult> {
    const invocationRef = invocationRefFrom(typeof input === "string" ? input : input.invocationRef);
    await this.ensureReady();
    const record = this.approvalStore.getByInvocationId(invocationRef);
    if (record === null) {
      return {
        status: "success",
        workflowId: this.workflowId,
        result: {
          status: "failed_pre_execution",
          invocationRef,
          reason: "The approval invocation is no longer available",
        },
      };
    }
    const reason = typeof input === "string" ? undefined : input.reason;
    try {
      await this.approvalStore.cancel({
        approvalId: record.approvalId,
        expectedVersion: record.version,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      // A competing terminal transition is already fenced.
    }
    let nativeCancelFailed = false;
    try {
      const run = this.nativeRuns.get(record.workflowRunId) ??
        await this.workflow.createRun({ runId: record.workflowRunId });
      this.nativeRuns.set(record.workflowRunId, run);
      await run.cancel();
    } catch {
      // Native cancel errors never reopen the application fence.
      nativeCancelFailed = true;
    }
    if (this.onAbort !== undefined) {
      await Promise.resolve(this.onAbort(invocationRef)).catch(() => undefined);
    }
    const latest = this.approvalStore.getByInvocationId(invocationRef) ?? record;
    const nativeState = await this.getNativeState(latest);
    this.forgetNativeRunIfTerminal(latest, nativeState);
    if (isTerminalApplicationRecord(latest)) {
      this.forgetNativeRun(latest.workflowRunId);
    }
    const terminal = this.syntheticTerminalResult(latest);
    return nativeCancelFailed ? { ...terminal, nativeCancelFailed: true } : terminal;
  }

  /**
   * Release native run handles and the provider's connection resources. The
   * application approval service drains live invocations first; this method is
   * intentionally idempotent so a bounded shutdown can safely call it again.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const runs = [...this.nativeRuns.values()];
    this.nativeRuns.clear();
    await Promise.allSettled(
      runs.map(async (run) => {
        try {
          await run.cancel?.();
        } catch {
          // The application fence is already closed by the bridge. Native
          // cancellation is best effort during process shutdown.
        }
      }),
    );
    await this.nativeStorage.close();
  }

  /** Return a safe application projection plus native snapshot state. */
  async get(invocationRef: string): Promise<ToolApprovalWorkflowView> {
    const ref = invocationRefFrom(invocationRef);
    const invocation = this.approvalStore.getPublicByInvocationId(ref);
    const workflow = invocation === null
      ? null
      : await this.workflow.getWorkflowRunById(invocation.workflowRunId).catch(() => null);
    if (
      invocation !== null &&
      (isTerminalApplicationStatus(invocation.status) ||
        (workflow !== null && isTerminalNativeWorkflowStatus(workflow.status)))
    ) {
      this.forgetNativeRun(invocation.workflowRunId);
    }
    return {
      workflowId: this.workflowId,
      stepId: this.stepId,
      invocation,
      workflow,
    };
  }
}

export function createToolApprovalWorkflowService(
  options: ToolApprovalWorkflowDependencies,
): ToolApprovalWorkflowService {
  return new ToolApprovalWorkflowService(options);
}

/** Friendly aliases for composition roots and tests. */
export const createToolApprovalService = createToolApprovalWorkflowService;
export const approvalWorkflowId = TOOL_APPROVAL_WORKFLOW_ID;
export const approvalStepId = TOOL_APPROVAL_STEP_ID;

export type ToolApprovalWorkflowNativeResult = WorkflowResult<
  unknown,
  ToolApprovalWorkflowInput,
  ToolApprovalWorkflowOutput,
  any
>;
