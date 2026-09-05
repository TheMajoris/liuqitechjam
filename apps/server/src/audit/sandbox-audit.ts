import { systemPrincipal } from "../access/access-types.js";
import { newSpanId } from "./audit-span.js";
import type {
  AuditEventInput,
  AuditRecorder,
  AuditSpan,
} from "./audit-types.js";

export interface SandboxStartedInfo {
  engine: string;
  image: string;
  cpuLimit: number;
  memoryLimit: string;
  pidsLimit: number;
  containerName: string;
}

export interface SandboxExitedInfo {
  exitCode: number | null;
  oomKilled: boolean | null;
  durationMs: number;
  inspected: boolean;
  cancelled: boolean;
  timedOut: boolean;
  peakCpuPct?: number;
  peakMemBytes?: number;
  imageDigest?: string;
}

export interface SandboxCleanupFailedInfo {
  stage: "inspect" | "remove";
  durationMs: number;
}

/**
 * A host-side witness over one sandbox container's lifecycle. Every method is
 * best effort: an audit sink failure must never disturb the Run it observes.
 */
export interface SandboxAuditSink {
  started(info: SandboxStartedInfo): void;
  exited(info: SandboxExitedInfo): void;
  cleanupFailed(info: SandboxCleanupFailedInfo): void;
}

export interface SandboxAuditSinkOptions {
  audit: AuditRecorder;
  runId: string;
  agentId: string;
  projectId?: string;
  orchestrationId?: string;
  /** The Run span; the sandbox span parents under it. */
  parentSpan: AuditSpan;
  onError?: (error: unknown) => void;
}

/** The engine binary name, without directory or `.exe` suffix. */
function engineBasename(engine: string): string {
  const segment = engine.split(/[\\/]/).at(-1) ?? engine;
  return segment.replace(/\.exe$/i, "").slice(0, 64);
}

/** The image reference with any content digest stripped; the tag is evidence. */
function imageTag(image: string): string {
  return image.split("@")[0] ?? image;
}

export function createSandboxAuditSink(
  options: SandboxAuditSinkOptions,
): SandboxAuditSink {
  const onError =
    options.onError ?? ((error: unknown) => console.warn("sandbox audit write failed", error));
  // One span per container: start, exit, and cleanup are the same lifecycle.
  const span = {
    traceId: options.parentSpan.traceId,
    spanId: newSpanId(),
    parentSpanId: options.parentSpan.spanId,
  };
  const correlation = {
    agentId: options.agentId,
    runId: options.runId,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.orchestrationId === undefined
      ? {}
      : { orchestrationId: options.orchestrationId }),
    // The engine, not the Agent, is the witness to a container lifecycle.
    principal: systemPrincipal(),
    actorType: "system",
    span,
  } as const;

  function emit(input: Omit<AuditEventInput, keyof typeof correlation>): void {
    try {
      void options.audit.record({ ...correlation, ...input }).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  return {
    started(info: SandboxStartedInfo): void {
      emit({
        type: "sandbox_started",
        status: "success",
        summary: "Sandbox container started",
        metadata: {
          engine: engineBasename(info.engine),
          image: imageTag(info.image),
          cpuLimit: info.cpuLimit,
          memoryLimit: info.memoryLimit,
          pidsLimit: info.pidsLimit,
          containerName: info.containerName,
        },
      });
    },

    exited(info: SandboxExitedInfo): void {
      emit({
        type: "sandbox_exited",
        status: info.exitCode === 0 && !info.oomKilled ? "success" : "failure",
        summary: "Sandbox container exited",
        durationMs: info.durationMs,
        metadata: {
          exitCode: info.exitCode,
          oomKilled: info.oomKilled,
          inspected: info.inspected,
          cancelled: info.cancelled,
          timedOut: info.timedOut,
          ...(info.peakCpuPct === undefined ? {} : { peakCpuPct: info.peakCpuPct }),
          ...(info.peakMemBytes === undefined ? {} : { peakMemBytes: info.peakMemBytes }),
          ...(info.imageDigest === undefined ? {} : { imageDigest: info.imageDigest }),
        },
      });
    },

    cleanupFailed(info: SandboxCleanupFailedInfo): void {
      emit({
        type: "sandbox_cleanup_failed",
        status: "failure",
        summary: "Sandbox container cleanup failed",
        metadata: { stage: info.stage, durationMs: info.durationMs },
      });
    },
  };
}
