import type { OrchestrationErrorCode } from "../types.js";

export type SupervisorErrorCode =
  | "SUPERVISOR_NOT_CONFIGURED"
  | "SUPERVISOR_REQUEST_FAILED"
  | "SUPERVISOR_TIMED_OUT"
  | "SUPERVISOR_INVALID_RESPONSE"
  | "SUPERVISOR_INVALID_ROUTE"
  | "SUPERVISOR_INVALID_CONTEXT";

/** A bounded, typed failure from the supervisor policy/provider boundary. */
export class SupervisorError extends Error {
  readonly orchestrationErrorCode: OrchestrationErrorCode;

  constructor(
    public readonly code: SupervisorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SupervisorError";
    this.orchestrationErrorCode = orchestrationErrorCodeFor(code);
  }
}

function orchestrationErrorCodeFor(code: SupervisorErrorCode): OrchestrationErrorCode {
  switch (code) {
    case "SUPERVISOR_INVALID_ROUTE":
    case "SUPERVISOR_INVALID_CONTEXT":
      return "SUPERVISOR_INVALID_SELECTION";
    case "SUPERVISOR_NOT_CONFIGURED":
      return "SUPERVISOR_UNAVAILABLE";
    case "SUPERVISOR_TIMED_OUT":
      return "SUPERVISOR_TIMED_OUT";
    case "SUPERVISOR_INVALID_RESPONSE":
      return "SUPERVISOR_INVALID_RESPONSE";
    case "SUPERVISOR_REQUEST_FAILED":
      return "SUPERVISOR_FAILED";
  }
}

/** Preserve the platform's cancellation shape across provider adapters. */
export function createAbortError(message = "Supervisor request was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
