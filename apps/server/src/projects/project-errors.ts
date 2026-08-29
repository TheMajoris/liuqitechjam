import { z } from "zod";
import { HttpError } from "../errors.js";

export const ProjectErrorCodeSchema = z.enum([
  "PROJECT_NOT_FOUND",
  "PROJECT_ARCHIVED",
  "PROJECT_INVALID_INPUT",
  "PROJECT_AGENT_NOT_ATTACHED",
  "PROJECT_AGENT_ALREADY_ATTACHED",
  "PROJECT_TEAM_ALREADY_ATTACHED",
  "PROJECT_TEAM_NOT_ATTACHED",
  "PROJECT_BUSY",
  "PROJECT_WORKSPACE_INVALID",
  "PROJECT_PERMISSION_DENIED",
]);
export type ProjectErrorCode = z.infer<typeof ProjectErrorCodeSchema>;

export class ProjectError extends HttpError {
  constructor(
    public readonly code: ProjectErrorCode,
    statusCode: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(statusCode, message);
    this.name = "ProjectError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function projectErrorStatus(code: ProjectErrorCode): number {
  switch (code) {
    case "PROJECT_NOT_FOUND":
      return 404;
    case "PROJECT_ARCHIVED":
    case "PROJECT_AGENT_ALREADY_ATTACHED":
    case "PROJECT_TEAM_ALREADY_ATTACHED":
    case "PROJECT_TEAM_NOT_ATTACHED":
    case "PROJECT_BUSY":
      return 409;
    case "PROJECT_INVALID_INPUT":
    case "PROJECT_AGENT_NOT_ATTACHED":
    case "PROJECT_WORKSPACE_INVALID":
      return 422;
    case "PROJECT_PERMISSION_DENIED":
      return 403;
    default:
      return 500;
  }
}

export function isProjectError(error: unknown): error is ProjectError {
  return error instanceof ProjectError;
}
