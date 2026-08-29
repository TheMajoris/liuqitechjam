import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "../orchestration/handoff.js";
import type { AuthorizationService } from "../access/authorization-service.js";
import type { PermissionId } from "../access/permission-types.js";
import type { AppConfig } from "../config.js";
import type { Agent } from "../types.js";
import { HttpError } from "../errors.js";
import { isDirectory } from "./local-container-preview-runtime.js";
import { PreviewError, previewErrorStatus } from "./preview-errors.js";
import type {
  PreviewErrorCode,
  PreviewLogResult,
  PreviewRecord,
  PreviewResourceLimits,
  PreviewRuntime,
  PreviewRuntimeHandle,
  PreviewStatus,
  PreviewView,
} from "./preview-types.js";
import type {
  PreviewCommandResolver,
  ResolvedPreviewCommand,
} from "./preview-command-resolver.js";
import type { JsonStore } from "../store.js";

const DEFAULT_RESOURCE_LIMITS: PreviewResourceLimits = {
  memoryMb: 2_048,
  cpus: 2,
  pids: 256,
};
const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 512;

const now = (): string => new Date().toISOString();

function memoryLimitToMb(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([bkmg])$/);
  if (!match) return DEFAULT_RESOURCE_LIMITS.memoryMb;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "g" ? 1024 : unit === "m" ? 1 : unit === "k" ? 1 / 1024 : 1 / (1024 * 1024);
  const result = Math.ceil(amount * multiplier);
  return Number.isFinite(result) && result > 0 ? result : DEFAULT_RESOURCE_LIMITS.memoryMb;
}

export function previewResourceLimitsFromConfig(config: Pick<AppConfig, "containerMemoryLimit" | "containerCpuLimit" | "containerPidsLimit">): PreviewResourceLimits {
  return {
    memoryMb: memoryLimitToMb(config.containerMemoryLimit),
    cpus: config.containerCpuLimit,
    pids: config.containerPidsLimit,
  };
}

export interface PreviewAgentService {
  getAgent(id: string): Agent;
}

export interface PreviewPortAllocator {
  reserve(blockedPorts?: ReadonlySet<number>): Promise<number>;
  release(port: number): void;
}

export interface PreviewServiceOptions {
  portAllocator?: PreviewPortAllocator;
  resourceLimits?: PreviewResourceLimits;
}

export interface PreviewLogsView {
  preview: PreviewView;
  logs: string[];
  truncated: boolean;
}

export interface PreviewLifecycleCleanup {
  stopForAgent(agentId: string): Promise<void>;
}

function isActiveStatus(status: PreviewStatus): boolean {
  return status === "starting" || status === "running" || status === "stopping";
}

function safeErrorMessage(value: unknown): string {
  const redacted = redactSensitiveText(value instanceof Error ? value.message : String(value));
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) return redacted;
  return redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH - 18).trimEnd() + " [TRUNCATED]";
}

function handleFor(record: PreviewRecord): PreviewRuntimeHandle | null {
  if (!record.runtimeId) return null;
  return {
    runtimeId: record.runtimeId,
    hostPort: record.hostPort ?? 1,
    containerPort: record.containerPort ?? 1,
  };
}

function publicPreview(record: PreviewRecord): PreviewView {
  return {
    id: record.id,
    agentId: record.agentId,
    status: record.status,
    host: record.host,
    hostPort: record.hostPort,
    url: record.url,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeError(
  error: unknown,
  fallback: PreviewErrorCode,
): PreviewError {
  if (error instanceof PreviewError) return error;
  return new PreviewError(
    fallback,
    previewErrorStatus(fallback),
    fallback === "PREVIEW_START_FAILED"
      ? "The preview could not be started"
      : fallback === "PREVIEW_STOP_FAILED"
        ? "The preview could not be stopped"
        : fallback === "PREVIEW_LOGS_FAILED"
          ? "Preview logs could not be read"
          : "The preview operation failed",
    { cause: error },
  );
}

/** Reserve a loopback port using the operating system's ephemeral allocator. */
export class LocalPreviewPortAllocator implements PreviewPortAllocator {
  private readonly reserved = new Set<number>();

  async reserve(blockedPorts: ReadonlySet<number> = new Set()): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
          const address = server.address();
          const selected = typeof address === "object" && address !== null ? address.port : 0;
          server.close((error) => (error ? reject(error) : resolve(selected)));
        });
      }).catch(() => 0);
      if (port > 0 && !blockedPorts.has(port) && !this.reserved.has(port)) {
        this.reserved.add(port);
        return port;
      }
    }
    throw new PreviewError(
      "PREVIEW_PORT_ALLOCATION_FAILED",
      503,
      "A local preview port could not be allocated",
    );
  }

  release(port: number): void {
    this.reserved.delete(port);
  }
}

function previewUrl(host: string, port: number): string {
  return "http://" + host + ":" + port;
}

/** Trusted preview lifecycle/policy boundary. */
export class PreviewService implements PreviewLifecycleCleanup {
  private readonly portAllocator: PreviewPortAllocator;
  private readonly resourceLimits: PreviewResourceLimits;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly terminalLogs = new Map<string, PreviewLogResult>();

  constructor(
    private readonly store: JsonStore,
    private readonly agentService: PreviewAgentService,
    private readonly runtime: PreviewRuntime,
    private readonly commandResolver: PreviewCommandResolver,
    private readonly authorization: AuthorizationService,
    options: PreviewServiceOptions = {},
  ) {
    this.portAllocator = options.portAllocator ?? new LocalPreviewPortAllocator();
    this.resourceLimits = options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
  }

  /** Mark in-flight records interrupted after a control-plane restart. */
  async initialize(): Promise<void> {
    const stale = this.store
      .snapshot()
      .previews.filter((preview) => isActiveStatus(preview.status));
    if (stale.length === 0) return;

    const interruptedAt = now();
    await this.store.mutate((database) => {
      for (const preview of database.previews) {
        if (!isActiveStatus(preview.status)) continue;
        preview.status = "interrupted";
        preview.errorCode = "PREVIEW_INTERRUPTED";
        preview.errorMessage = "Preview was interrupted by a server restart";
        preview.url = null;
        preview.stoppedAt = interruptedAt;
        preview.updatedAt = interruptedAt;
      }
    });

    await Promise.all(
      stale.map(async (preview) => {
        const handle = handleFor(preview);
        if (!handle) return;
        this.portAllocator.release(preview.hostPort ?? 0);
        try {
          await this.runtime.stop(handle);
          await this.store.mutate((database) => {
            const stored = database.previews.find((item) => item.id === preview.id);
            if (stored) stored.runtimeId = null;
          });
        } catch {
          // Reconciliation is best effort. The persisted state remains
          // interrupted with its handle so restart can retry cleanup.
        }
      }),
    );
  }

  async start(agentId: string): Promise<PreviewView> {
    await this.requirePermission(agentId, "preview.start");
    return this.withLock(agentId, () => this.startInternal(agentId));
  }

  async get(agentId: string): Promise<PreviewView> {
    await this.requirePermission(agentId, "preview.inspect");
    this.agentService.getAgent(agentId);
    const current = this.latest(agentId);
    if (!current) {
      throw new PreviewError("PREVIEW_NOT_FOUND", 404, "Preview not found");
    }
    return publicPreview(await this.refreshStatus(current));
  }

  async restart(agentId: string): Promise<PreviewView> {
    await this.requirePermission(agentId, "preview.restart");
    return this.withLock(agentId, async () => {
      const current = this.latest(agentId);
      if (current && (isActiveStatus(current.status) || current.runtimeId)) {
        await this.stopInternal(current);
      }
      return this.startInternal(agentId);
    });
  }

  async stop(agentId: string): Promise<PreviewView> {
    await this.requirePermission(agentId, "preview.stop");
    return this.withLock(agentId, async () => {
      this.agentService.getAgent(agentId);
      const current = this.latest(agentId);
      if (!current) {
        throw new PreviewError("PREVIEW_NOT_FOUND", 404, "Preview not found");
      }
      return publicPreview(await this.stopInternal(current));
    });
  }

  async logs(agentId: string, tail = 100): Promise<PreviewLogsView> {
    await this.requirePermission(agentId, "preview.logs");
    this.agentService.getAgent(agentId);
    const current = this.latest(agentId);
    if (!current) {
      throw new PreviewError("PREVIEW_NOT_FOUND", 404, "Preview not found");
    }
    const refreshed = await this.refreshStatus(current);
    const handle = handleFor(refreshed);
    if (!handle) {
      const cached = this.terminalLogs.get(agentId) ?? { lines: [], truncated: false };
      return {
        preview: publicPreview(refreshed),
        logs: [...cached.lines],
        truncated: cached.truncated,
      };
    }

    const boundedTail = Number.isInteger(tail)
      ? Math.min(Math.max(tail, 1), MAX_LOG_LINES)
      : 100;
    let result: PreviewLogResult;
    try {
      result = await this.runtime.logs(handle, { tail: boundedTail });
    } catch (error) {
      throw normalizeError(error, "PREVIEW_LOGS_FAILED");
    }
    const bounded = this.boundLogs(result.lines, boundedTail);
    return {
      preview: publicPreview(refreshed),
      logs: bounded.lines,
      truncated: result.truncated || bounded.truncated,
    };
  }

  /** Called by AgentService lifecycle operations; this is a trusted internal seam. */
  async stopForAgent(agentId: string): Promise<void> {
    await this.withLock(agentId, async () => {
      const current = this.latest(agentId);
      if (!current || (!isActiveStatus(current.status) && !current.runtimeId)) return;
      await this.stopInternal(current);
    });
  }

  private async startInternal(agentId: string): Promise<PreviewView> {
    const agent = this.agentService.getAgent(agentId);
    if (agent.status === "stopped") {
      throw new PreviewError(
        "PREVIEW_START_FAILED",
        409,
        "Start the Agent before starting its preview",
      );
    }

    const existing = this.latest(agentId);
    if (existing && (isActiveStatus(existing.status) || existing.runtimeId !== null)) {
      throw new PreviewError(
        "PREVIEW_ALREADY_RUNNING",
        409,
        "This Agent already has an active preview",
      );
    }
    if (!(await isDirectory(agent.workspacePath))) {
      throw new PreviewError(
        "PREVIEW_WORKSPACE_INVALID",
        422,
        "The Agent workspace is not available",
      );
    }
    this.terminalLogs.delete(agentId);

    let resolved: ResolvedPreviewCommand;
    try {
      resolved = await this.commandResolver.resolve({ workspacePath: agent.workspacePath });
    } catch (error) {
      throw normalizeError(error, "PREVIEW_UNSUPPORTED_PROJECT");
    }

    const blockedPorts = new Set(
      this.store
        .snapshot()
        .previews.filter(
          (preview) =>
            (isActiveStatus(preview.status) || preview.runtimeId !== null) &&
            preview.hostPort !== null,
        )
        .map((preview) => preview.hostPort as number),
    );
    let hostPort: number;
    try {
      hostPort = await this.portAllocator.reserve(blockedPorts);
    } catch (error) {
      throw normalizeError(error, "PREVIEW_PORT_ALLOCATION_FAILED");
    }

    const createdAt = now();
    const record: PreviewRecord = {
      id: randomUUID(),
      agentId,
      status: "starting",
      workspacePath: agent.workspacePath,
      runtimeId: null,
      host: "127.0.0.1",
      hostPort,
      containerPort: resolved.containerPort,
      command: [...resolved.command],
      url: null,
      errorCode: null,
      errorMessage: null,
      createdAt,
      startedAt: null,
      stoppedAt: null,
      updatedAt: createdAt,
    };
    try {
      await this.store.mutate((database) => {
        const active = database.previews.find(
          (preview) => preview.agentId === agentId && isActiveStatus(preview.status),
        );
        if (active) {
          throw new PreviewError(
            "PREVIEW_ALREADY_RUNNING",
            409,
            "This Agent already has an active preview",
          );
        }
        database.previews.push(record);
      });
    } catch (error) {
      this.portAllocator.release(hostPort);
      throw error;
    }

    let handle: PreviewRuntimeHandle | null = null;
    try {
      handle = await this.runtime.start({
        previewId: record.id,
        agentId,
        workspacePath: agent.workspacePath,
        command: [...resolved.command],
        containerPort: resolved.containerPort,
        hostPort,
        workspaceReadOnly: resolved.kind === "static",
        resourceLimits: { ...this.resourceLimits },
      });
      if (
        !handle.runtimeId ||
        !Number.isInteger(handle.hostPort) ||
        handle.hostPort < 1 ||
        !Number.isInteger(handle.containerPort) ||
        handle.containerPort < 1
      ) {
        throw new PreviewError("PREVIEW_START_FAILED", 500, "The preview runtime returned an invalid handle");
      }
      const startedAt = now();
      const updated = await this.store.mutate((database) => {
        const stored = database.previews.find((preview) => preview.id === record.id);
        if (!stored) throw new PreviewError("PREVIEW_START_FAILED", 500, "Preview state was lost");
        stored.status = "running";
        stored.runtimeId = handle!.runtimeId;
        stored.hostPort = handle!.hostPort;
        stored.containerPort = handle!.containerPort;
        stored.url = previewUrl(stored.host, handle!.hostPort);
        stored.startedAt = startedAt;
        stored.updatedAt = startedAt;
        return structuredClone(stored);
      });
      return publicPreview(updated);
    } catch (error) {
      this.portAllocator.release(hostPort);
      if (handle) {
        await this.runtime.stop(handle).catch(() => undefined);
      }
      const normalized = normalizeError(error, "PREVIEW_START_FAILED");
      const failedAt = now();
      await this.store.mutate((database) => {
        const stored = database.previews.find((preview) => preview.id === record.id);
        if (!stored) return;
        stored.status = "failed";
        stored.errorCode = normalized.code;
        stored.errorMessage = safeErrorMessage(normalized);
        stored.runtimeId = null;
        stored.url = null;
        stored.stoppedAt = failedAt;
        stored.updatedAt = failedAt;
      });
      throw normalized;
    }
  }

  private async stopInternal(record: PreviewRecord): Promise<PreviewRecord> {
    const handle = handleFor(record);
    const stoppingAt = now();
    await this.store.mutate((database) => {
      const stored = database.previews.find((preview) => preview.id === record.id);
      if (stored && stored.status !== "stopped") {
        stored.status = "stopping";
        stored.updatedAt = stoppingAt;
      }
    });

    try {
      if (handle) await this.runtime.stop(handle);
    } catch (error) {
      const normalized = normalizeError(error, "PREVIEW_STOP_FAILED");
      const failedAt = now();
      await this.store.mutate((database) => {
        const stored = database.previews.find((preview) => preview.id === record.id);
        if (!stored) return;
        stored.status = "failed";
        stored.errorCode = normalized.code;
        stored.errorMessage = safeErrorMessage(normalized);
        stored.updatedAt = failedAt;
      });
      throw normalized;
    }

    this.portAllocator.release(record.hostPort ?? 0);
    const stoppedAt = now();
    return this.store.mutate((database) => {
      const stored = database.previews.find((preview) => preview.id === record.id);
      if (!stored) throw new PreviewError("PREVIEW_NOT_FOUND", 404, "Preview not found");
      stored.status = "stopped";
      stored.runtimeId = null;
      stored.url = null;
      stored.errorCode = null;
      stored.errorMessage = null;
      stored.stoppedAt = stoppedAt;
      stored.updatedAt = stoppedAt;
      return structuredClone(stored);
    });
  }

  private async refreshStatus(record: PreviewRecord): Promise<PreviewRecord> {
    if (!isActiveStatus(record.status) || !record.runtimeId) return record;
    let live;
    try {
      live = await this.runtime.status(handleFor(record)!);
    } catch {
      return record;
    }
    if (live === "running" && record.status === "starting") {
      return this.store.mutate((database) => {
        const stored = database.previews.find((preview) => preview.id === record.id);
        if (!stored) return record;
        stored.status = "running";
        stored.startedAt ??= now();
        stored.updatedAt = now();
        return structuredClone(stored);
      });
    }
    if (live !== "stopped" && live !== "failed") return record;
    const handle = handleFor(record);
    let runtimeRemoved = true;
    if (handle) {
      try {
        const result = await this.runtime.logs(handle, { tail: MAX_LOG_LINES });
        const bounded = this.boundLogs(result.lines, MAX_LOG_LINES);
        this.terminalLogs.set(record.agentId, {
          lines: bounded.lines,
          truncated: result.truncated || bounded.truncated,
        });
      } catch {
        // Failure logs are supplemental; cleanup remains mandatory.
      }
      try {
        await this.runtime.stop(handle);
      } catch {
        // Keep the runtime identity persisted so a later explicit restart can
        // retry cleanup instead of orphaning an exited managed container.
        runtimeRemoved = false;
      }
    }
    this.portAllocator.release(record.hostPort ?? 0);
    const failedAt = now();
    return this.store.mutate((database) => {
      const stored = database.previews.find((preview) => preview.id === record.id);
      if (!stored) return record;
      stored.status = "failed";
      stored.errorCode = "PREVIEW_START_FAILED";
      stored.errorMessage = "The preview process exited unexpectedly";
      if (runtimeRemoved) stored.runtimeId = null;
      stored.url = null;
      stored.stoppedAt = failedAt;
      stored.updatedAt = failedAt;
      return structuredClone(stored);
    });
  }

  private latest(agentId: string): PreviewRecord | null {
    const records = this.store
      .snapshot()
      .previews.filter((preview) => preview.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return records[0] ?? null;
  }

  private boundLogs(lines: readonly string[], tail: number): PreviewLogResult {
    const safeLines: string[] = [];
    let bytes = 0;
    let truncated = false;
    for (const line of lines.slice(-tail)) {
      const safe = redactSensitiveText(String(line));
      const nextBytes = bytes + Buffer.byteLength(safe, "utf8") + 1;
      if (nextBytes > MAX_LOG_BYTES) {
        truncated = true;
        break;
      }
      safeLines.push(safe);
      bytes = nextBytes;
    }
    return { lines: safeLines, truncated };
  }

  private async withLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(agentId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(agentId) === queued) this.locks.delete(agentId);
    }
  }

  private async requirePermission(agentId: string, permission: PermissionId): Promise<void> {
    try {
      await this.authorization.require({ agentId, permission });
    } catch (error) {
      // Authorization implementations are allowed to use their own internal
      // error type, but the HTTP boundary always receives a safe normalized
      // preview denial without an implementation detail or stack trace.
      if (error instanceof PreviewError) throw error;
      throw new PreviewError(
        "PREVIEW_PERMISSION_DENIED",
        403,
        "You are not authorized to perform this preview operation",
        { cause: error },
      );
    }
  }
}

export function isPreviewError(error: unknown): error is PreviewError {
  return error instanceof PreviewError || error instanceof HttpError && error.name === "PreviewError";
}
