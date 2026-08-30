import { HttpError } from "../errors.js";

export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_INVALID_INPUT"
  | "TOOL_OUTPUT_INVALID"
  | "TOOL_EXECUTION_FAILED"
  | "PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "MCP_AUTHENTICATION_REQUIRED";

/** Stable, safe errors crossing the ToolService/MCP boundary. */
export class ToolError extends HttpError {
  constructor(
    public readonly code: ToolErrorCode,
    statusCode: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(statusCode, message);
    this.name = "ToolError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export class ToolApprovalRequiredError extends ToolError {
  /** Backward-compatible alias; this value is always a Permit request ID. */
  public readonly permitRequestId: string;

  constructor(
    public readonly approvalRequestId: string,
    reason: string,
  ) {
    super(
      "APPROVAL_REQUIRED",
      403,
      reason,
    );
    this.name = "ToolApprovalRequiredError";
    this.permitRequestId = approvalRequestId;
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

export function toolErrorStatus(code: ToolErrorCode): number {
  switch (code) {
    case "TOOL_NOT_FOUND":
      return 404;
    case "TOOL_INVALID_INPUT":
      return 422;
    case "PERMISSION_DENIED":
    case "APPROVAL_REQUIRED":
      return 403;
    case "MCP_AUTHENTICATION_REQUIRED":
      return 401;
    default:
      return 500;
  }
}
