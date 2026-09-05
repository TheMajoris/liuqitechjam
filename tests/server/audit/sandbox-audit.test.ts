import { describe, expect, it } from "vitest";
import { createSandboxAuditSink } from "../../../apps/server/src/audit/sandbox-audit.js";
import { safeAuditInput } from "../../../apps/server/src/audit/audit-redaction.js";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRecorder,
} from "../../../apps/server/src/audit/audit-types.js";

class RecordingAudit implements AuditRecorder {
  readonly inputs: AuditEventInput[] = [];

  async record(input: AuditEventInput): Promise<AuditEvent> {
    this.inputs.push(input);
    return {} as AuditEvent;
  }

  ofType(type: AuditEventInput["type"]): AuditEventInput[] {
    return this.inputs.filter((input) => input.type === type);
  }
}

const parentSpan = { traceId: "trace-1", spanId: "span-run" };

function makeSink() {
  const audit = new RecordingAudit();
  const sink = createSandboxAuditSink({
    audit,
    runId: "run-1",
    agentId: "agent-1",
    projectId: "project-1",
    parentSpan,
    onError: () => undefined,
  });
  return { audit, sink };
}

const started = {
  engine: "/usr/local/bin/podman",
  image: "ghcr.io/example/runtime:1.2.3",
  cpuLimit: 2,
  memoryLimit: "2g",
  pidsLimit: 256,
  containerName: "launchpad-test-agent",
};

describe("sandbox audit sink", () => {
  it("emits start, exit, and cleanup events under one sandbox span", async () => {
    const { audit, sink } = makeSink();

    sink.started(started);
    sink.exited({
      exitCode: 0,
      oomKilled: false,
      durationMs: 4_200,
      inspected: true,
      cancelled: false,
      timedOut: false,
    });
    sink.cleanupFailed({ stage: "remove", durationMs: 12 });
    await Promise.resolve();

    expect(audit.inputs.map((input) => input.type)).toEqual([
      "sandbox_started",
      "sandbox_exited",
      "sandbox_cleanup_failed",
    ]);
    const spanIds = new Set(audit.inputs.map((input) => input.span?.spanId));
    expect(spanIds.size).toBe(1);
    for (const input of audit.inputs) {
      expect(input.span?.traceId).toBe(parentSpan.traceId);
      expect(input.span?.parentSpanId).toBe(parentSpan.spanId);
      expect(input.span?.spanId).not.toBe(parentSpan.spanId);
      // The engine, not the Agent, witnesses the container lifecycle.
      expect(input.principal.kind).toBe("system");
      expect(input.actorType).toBe("system");
      expect(input.runId).toBe("run-1");
      expect(input.agentId).toBe("agent-1");
      expect(input.projectId).toBe("project-1");
    }
    expect(audit.ofType("sandbox_exited")[0]?.status).toBe("success");
    expect(audit.ofType("sandbox_exited")[0]?.durationMs).toBe(4_200);
    expect(audit.ofType("sandbox_cleanup_failed")[0]?.status).toBe("failure");
  });

  it("records a non-zero or OOM-killed exit as a failure", async () => {
    const { audit, sink } = makeSink();

    sink.exited({
      exitCode: 137,
      oomKilled: true,
      durationMs: 900,
      inspected: true,
      cancelled: false,
      timedOut: false,
    });
    sink.exited({
      exitCode: 0,
      oomKilled: true,
      durationMs: 900,
      inspected: true,
      cancelled: false,
      timedOut: false,
    });
    sink.exited({
      exitCode: null,
      oomKilled: null,
      durationMs: 900,
      inspected: false,
      cancelled: true,
      timedOut: false,
    });
    await Promise.resolve();

    expect(audit.inputs.map((input) => input.status)).toEqual([
      "failure",
      "failure",
      "failure",
    ]);
  });

  it("keeps sandbox evidence through redaction", async () => {
    const { audit, sink } = makeSink();

    sink.started(started);
    sink.exited({
      exitCode: 137,
      oomKilled: true,
      durationMs: 900,
      inspected: true,
      cancelled: false,
      timedOut: true,
    });
    await Promise.resolve();

    const startedMetadata = safeAuditInput(audit.ofType("sandbox_started")[0]!).metadata;
    expect(startedMetadata.engine).toBe("podman");
    expect(startedMetadata.image).toBe("ghcr.io/example/runtime:1.2.3");
    expect(startedMetadata.cpuLimit).toBe(2);
    expect(startedMetadata.pidsLimit).toBe(256);
    expect(startedMetadata.containerName).toBe("launchpad-test-agent");

    const exitedMetadata = safeAuditInput(audit.ofType("sandbox_exited")[0]!).metadata;
    expect(exitedMetadata.exitCode).toBe(137);
    expect(exitedMetadata.oomKilled).toBe(true);
    expect(exitedMetadata.inspected).toBe(true);
    expect(exitedMetadata.timedOut).toBe(true);
    expect(exitedMetadata.cancelled).toBe(false);
  });

  it("strips a digest from the image reference", async () => {
    const { audit, sink } = makeSink();

    sink.started({ ...started, image: "runtime:1.2.3@sha256:" + "a".repeat(64) });
    await Promise.resolve();

    expect(audit.ofType("sandbox_started")[0]?.metadata?.image).toBe("runtime:1.2.3");
  });

  it("never throws when the audit sink rejects", async () => {
    const failures: unknown[] = [];
    const sink = createSandboxAuditSink({
      audit: {
        record: () => Promise.reject(new Error("audit down")),
      },
      runId: "run-1",
      agentId: "agent-1",
      parentSpan,
      onError: (error) => failures.push(error),
    });

    expect(() => sink.started(started)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
  });
});
