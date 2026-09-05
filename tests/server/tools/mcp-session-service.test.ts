import { describe, expect, it } from "vitest";
import { McpSessionService } from "../../../apps/server/src/tools/mcp-session-service.js";
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

describe("McpSessionService audit lifecycle", () => {
  it("emits mcp_session_issued on mint with expected correlation and no token metadata", () => {
    const audit = new RecordingAudit();
    const service = new McpSessionService(60_000, { audit });

    const { token } = service.mint({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      orchestrationId: "orch-1",
    });

    const issued = audit.ofType("mcp_session_issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      status: "success",
      summary: "MCP session issued",
      principal: { kind: "agent", id: "agent-1" },
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      orchestrationId: "orch-1",
    });
    const serialized = JSON.stringify(audit.inputs);
    expect(serialized).not.toContain(token);
    for (const input of audit.inputs) {
      for (const key of Object.keys(input.metadata ?? {})) {
        expect(key.toLowerCase()).not.toContain("token");
      }
    }
  });

  it("reports expired on resolveDetailed and emits mcp_session_expired exactly once", () => {
    const audit = new RecordingAudit();
    let now = 1_000;
    const service = new McpSessionService(1_000, { audit, now: () => now });

    const { token } = service.mint({ agentId: "agent-2", runId: "run-2" });
    now += 2_000; // past expiry

    const first = service.resolveDetailed(token);
    expect(first).toMatchObject({ context: null, reason: "expired" });

    const second = service.resolveDetailed(token);
    expect(second).toMatchObject({ context: null, reason: "invalid" });

    const expired = audit.ofType("mcp_session_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      status: "failure",
      summary: "MCP session expired",
      principal: { kind: "agent", id: "agent-2" },
      agentId: "agent-2",
      runId: "run-2",
      metadata: { reason: "expired" },
    });
    expect(JSON.stringify(audit.inputs)).not.toContain(token);
  });

  it("emits exactly one mcp_session_expired when prune evicts a stale record, not duplicated by a later resolve", () => {
    const audit = new RecordingAudit();
    let now = 1_000;
    const service = new McpSessionService(1_000, { audit, now: () => now });

    const { token } = service.mint({ agentId: "agent-3", runId: "run-3" });
    now += 2_000; // past expiry

    service.prune();
    expect(audit.ofType("mcp_session_expired")).toHaveLength(1);

    // The record is already gone; a follow-up resolve must not double-report.
    const detailed = service.resolveDetailed(token);
    expect(detailed).toMatchObject({ context: null, reason: "invalid" });
    expect(audit.ofType("mcp_session_expired")).toHaveLength(1);
  });

  it("does not emit audit events for revoke", () => {
    const audit = new RecordingAudit();
    const service = new McpSessionService(60_000, { audit });
    const { token } = service.mint({ agentId: "agent-5", runId: "run-5" });
    audit.inputs.length = 0;

    expect(service.revoke(token)).toBe(true);
    expect(audit.inputs).toHaveLength(0);
  });
});
