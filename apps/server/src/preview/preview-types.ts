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

/**
 * Who owns a preview runtime.
 *
 * An Agent preview serves that Agent's private workspace; a Project preview
 * serves the shared collaborative workspace and is the canonical artifact for
 * a Team. Both use the same PreviewRuntime.
 */
export type PreviewOwnerRef =
  | { kind: "agent"; agentId: string }
  | { kind: "project"; projectId: string };

export function previewOwnerKey(owner: PreviewOwnerRef): string {
  return owner.kind === "agent" ? "agent:" + owner.agentId : "project:" + owner.projectId;
}

/** Reads the owner off a persisted record; legacy records are Agent-owned. */
export function previewOwnerOf(record: PreviewRecord): PreviewOwnerRef {
  return record.projectId !== undefined
    ? { kind: "project", projectId: record.projectId }
    : { kind: "agent", agentId: record.agentId ?? "" };
}

export function previewOwnerMatches(
  record: PreviewRecord,
  owner: PreviewOwnerRef,
): boolean {
  return previewOwnerKey(previewOwnerOf(record)) === previewOwnerKey(owner);
}

/** Internal persisted state. Host paths and runtime IDs never cross the HTTP boundary. */
export interface PreviewRecord {
  id: string;
  /** Set for Agent-owned previews. Legacy records always carry this. */
  agentId?: string;
  /** Set for Project-owned previews; mutually exclusive with agentId. */
  projectId?: string;
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
  agentId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
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
}).refine(
  (record) => (record.agentId === undefined) !== (record.projectId === undefined),
  { message: "A preview must have exactly one owner" },
);

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
  /** Stable owner label used for runtime tagging, e.g. "project:<id>". */
  ownerKey: string;
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
  /** Exactly one of these is set, mirroring the record's owner. */
  agentId: string | null;
  projectId: string | null;
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
