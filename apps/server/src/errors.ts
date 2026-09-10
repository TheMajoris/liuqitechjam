export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

/** Stable code shared by the Agent Run and orchestration failure boundaries. */
export const WEB_TOOL_PERMISSION_DENIED = "WEB_TOOL_PERMISSION_DENIED" as const;
export const MODEL_INFERENCE_LIMIT_EXCEEDED = "MODEL_INFERENCE_LIMIT_EXCEEDED" as const;
export const MODEL_RATE_LIMITED = "MODEL_RATE_LIMITED" as const;
export const PROJECT_PERMISSION_DENIED = "PROJECT_PERMISSION_DENIED" as const;
/** Public wording for the provider-side inference-limit condition. */
export const MODEL_INFERENCE_LIMIT_MESSAGE =
  "This model is paused because its provider inference limit was reached. Review Safe Experience Mode in the provider's Model Activation settings, or choose another available model, then retry.";
/**
 * Public wording for a provider refusal the runtime reports as a rate limit.
 *
 * Deliberately not the inference-limit wording. The runtime forwards only the
 * HTTP status, never the provider's own error code, so a paused model and an
 * ordinary rate limit arrive identically: this states what is known and names
 * both readings rather than asserting the one it cannot prove.
 */
export const MODEL_RATE_LIMITED_MESSAGE =
  "This Agent's model was rate limited by the provider, which can also mean its inference limit is reached.";
/** Public wording for a pre-run Project write authorization denial. */
export const PROJECT_PERMISSION_DENIED_MESSAGE =
  "This Agent is not allowed to write to the Workspace. Add Allow Agent runs (agent.invoke) and Edit workspace files (project.write) to the Agent's role, make sure it has editable Workspace membership, then retry.";
/** The Agent finished, but its source checkpoint could not be established. */
export const CHECKPOINT_CAPTURE_FAILED = "CHECKPOINT_CAPTURE_FAILED" as const;
export type AgentRunErrorCode =
  | typeof WEB_TOOL_PERMISSION_DENIED
  | typeof MODEL_INFERENCE_LIMIT_EXCEEDED
  | typeof MODEL_RATE_LIMITED
  | typeof CHECKPOINT_CAPTURE_FAILED;

/** A web-tool denial observed through the authenticated MCP session. */
export class WebToolPermissionDeniedError extends Error {
  readonly errorCode = WEB_TOOL_PERMISSION_DENIED;
  readonly orchestrationErrorCode = WEB_TOOL_PERMISSION_DENIED;

  constructor() {
    super("Web tool permission denied");
    this.name = "WebToolPermissionDeniedError";
  }
}

/** A provider explicitly rejected the model because its inference limit is reached. */
export class ModelInferenceLimitExceededError extends Error {
  readonly errorCode = MODEL_INFERENCE_LIMIT_EXCEEDED;
  readonly orchestrationErrorCode = MODEL_INFERENCE_LIMIT_EXCEEDED;

  constructor() {
    super(MODEL_INFERENCE_LIMIT_MESSAGE);
    this.name = "ModelInferenceLimitExceededError";
  }
}

/**
 * The provider rejected the request as rate limited and the runtime exhausted
 * its own retries. Distinct from the inference limit: that one is proven by
 * the provider's error code, this one is only ever an HTTP status.
 */
export class ModelRateLimitedError extends Error {
  readonly errorCode = MODEL_RATE_LIMITED;
  readonly orchestrationErrorCode = MODEL_RATE_LIMITED;

  constructor() {
    super(MODEL_RATE_LIMITED_MESSAGE);
    this.name = "ModelRateLimitedError";
  }
}

/** A Project-scoped Agent turn was denied before a child Run was created. */
export class ProjectPermissionDeniedError extends Error {
  readonly orchestrationErrorCode = PROJECT_PERMISSION_DENIED;

  constructor() {
    super(PROJECT_PERMISSION_DENIED_MESSAGE);
    this.name = "ProjectPermissionDeniedError";
  }
}

/**
 * A runner may use this only when it knows that no model work was started.
 *
 * Model fallbacks are intentionally not inferred from generic runtime/tool
 * failures: retrying those can repeat side effects in a workspace. Keeping a
 * dedicated error type makes the retry decision an explicit runner signal.
 */
export class RetryableModelError extends Error {
  readonly retryableModel = true;

  constructor(message = "Worker model is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableModelError";
  }
}
