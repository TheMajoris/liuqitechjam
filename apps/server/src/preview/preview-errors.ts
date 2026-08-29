import { HttpError } from "../errors.js";
import type { PreviewErrorCode } from "./preview-types.js";

export class PreviewError extends HttpError {
  constructor(
    public readonly code: PreviewErrorCode,
    statusCode: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(statusCode, message);
    this.name = "PreviewError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function previewErrorStatus(code: PreviewErrorCode): number {
  switch (code) {
    case "PREVIEW_NOT_FOUND":
      return 404;
    case "PREVIEW_ALREADY_RUNNING":
    case "PREVIEW_NOT_RUNNING":
      return 409;
    case "PREVIEW_UNSUPPORTED_PROJECT":
    case "PREVIEW_COMMAND_NOT_FOUND":
    case "PREVIEW_WORKSPACE_INVALID":
      return 422;
    case "PREVIEW_PERMISSION_DENIED":
      return 403;
    case "PREVIEW_RUNTIME_UNAVAILABLE":
    case "PREVIEW_PORT_ALLOCATION_FAILED":
      return 503;
    default:
      return 500;
  }
}

