import { HttpError } from "../errors.js";

export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_INVALID_INPUT"
  | "TOOL_OUTPUT_INVALID"
  | "TOOL_EXECUTION_FAILED"
  | "APPROVAL_REQUIRED"
  | "TOOL_INVOCATION_INVALIDATED"
  | "TOOL_EXECUTION_CLAIM_FAILED"
  | "TOOL_EXECUTION_EXPIRED"
  | "PERMISSION_DENIED"
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
      return 403;
    case "MCP_AUTHENTICATION_REQUIRED":
      return 401;
    case "APPROVAL_REQUIRED":
    case "TOOL_INVOCATION_INVALIDATED":
    case "TOOL_EXECUTION_CLAIM_FAILED":
    case "TOOL_EXECUTION_EXPIRED":
      return 409;
    default:
      return 500;
  }
}
