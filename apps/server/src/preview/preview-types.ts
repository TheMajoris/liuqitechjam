import { z } from "zod";

export const PreviewStatusSchema = z.enum([
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "interrupted",
]);
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

export const PreviewErrorCodeSchema = z.enum([
  "PREVIEW_NOT_FOUND",
  "PREVIEW_ALREADY_RUNNING",
  "PREVIEW_NOT_RUNNING",
  "PREVIEW_START_FAILED",
  "PREVIEW_STOP_FAILED",
  "PREVIEW_RUNTIME_UNAVAILABLE",
  "PREVIEW_UNSUPPORTED_PROJECT",
  "PREVIEW_COMMAND_NOT_FOUND",
  "PREVIEW_PORT_ALLOCATION_FAILED",
  "PREVIEW_WORKSPACE_INVALID",
  "PREVIEW_LOGS_FAILED",
  "PREVIEW_INTERRUPTED",
  "PREVIEW_PERMISSION_DENIED",
]);
export type PreviewErrorCode = z.infer<typeof PreviewErrorCodeSchema>;

/** Internal persisted state. Host paths and runtime IDs never cross the HTTP boundary. */
export interface PreviewRecord {
  id: string;
  agentId: string;
  status: PreviewStatus;
  workspacePath: string;
  runtimeId: string | null;
  host: "127.0.0.1";
  hostPort: number | null;
  containerPort: number | null;
  command: string[] | null;
  url: string | null;
  errorCode: PreviewErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  updatedAt: string;
}

export const PreviewRecordSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  status: PreviewStatusSchema,
  workspacePath: z.string(),
  runtimeId: z.string().nullable(),
  host: z.literal("127.0.0.1"),
  hostPort: z.number().int().positive().nullable(),
  containerPort: z.number().int().positive().nullable(),
  command: z.array(z.string()).nullable(),
  url: z.string().url().nullable(),
  errorCode: PreviewErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export interface PreviewRuntimeHandle {
  runtimeId: string;
  hostPort: number;
  containerPort: number;
}

export interface PreviewResourceLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
}

export interface PreviewStartInput {
  previewId: string;
  agentId: string;
  workspacePath: string;
  command: string[];
  containerPort: number;
  /** Backend-owned port. Omitted only for runtimes that allocate an ephemeral port. */
  hostPort?: number;
  /** Backend-owned mount policy; static previews must not mutate the workspace. */
  workspaceReadOnly?: boolean;
  resourceLimits: PreviewResourceLimits;
}

export const PreviewRuntimeStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "failed",
  "unknown",
]);
export type PreviewRuntimeStatus = z.infer<typeof PreviewRuntimeStatusSchema>;

export interface PreviewLogResult {
  lines: string[];
  truncated: boolean;
}

export interface PreviewRuntime {
  start(input: PreviewStartInput): Promise<PreviewRuntimeHandle>;
  stop(handle: PreviewRuntimeHandle): Promise<void>;
  status(handle: PreviewRuntimeHandle): Promise<PreviewRuntimeStatus>;
  logs(handle: PreviewRuntimeHandle, options?: { tail?: number }): Promise<PreviewLogResult>;
}

/** Safe HTTP projection. Internal paths, commands, and runtime identifiers stay private. */
export interface PreviewView {
  id: string;
  agentId: string;
  status: PreviewStatus;
  host: "127.0.0.1";
  hostPort: number | null;
  url: string | null;
  errorCode: PreviewErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  updatedAt: string;
}
