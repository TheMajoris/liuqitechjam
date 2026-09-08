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

  it("clones and freezes the advertised snapshot while refreshing each next run", () => {
    const service = new McpSessionService(60_000);
    const firstIds = ["web.search"];
    const first = service.mint({
      agentId: "agent-snapshot",
      runId: "run-first",
      advertisedToolIds: firstIds,
      diagnostics: {
        configuredCatalogueSize: 4,
        advertisedToolCount: 1,
        resolutionStatus: "scoped",
      },
    });
    firstIds.push("web.fetch");

    expect(first.context.advertisedToolIds).toEqual(["web.search"]);
    expect(Object.isFrozen(first.context.advertisedToolIds)).toBe(true);
    expect(first.context.diagnostics).toMatchObject({
      configuredCatalogueSize: 4,
      advertisedToolCount: 1,
      resolutionStatus: "scoped",
    });
    expect(Object.isFrozen(first.context.diagnostics)).toBe(true);
    expect(service.resolve(first.token)?.advertisedToolIds).toEqual(["web.search"]);

    const second = service.mint({
      agentId: "agent-snapshot",
      runId: "run-second",
      advertisedToolIds: ["web.fetch"],
      diagnostics: { configuredCatalogueSize: 4, advertisedToolCount: 1, resolutionStatus: "scoped" },
    });
    expect(service.resolve(second.token)?.advertisedToolIds).toEqual(["web.fetch"]);
    expect(service.resolve(first.token)?.runId).toBe("run-first");
  });

  it("records catalogue size separately and caps batch discovery observations", () => {
    const service = new McpSessionService(60_000);
    const { token } = service.mint({
      agentId: "agent-discovery",
      runId: "run-discovery",
      advertisedToolIds: [],
    });

    service.recordCatalogueObservation("run-discovery", 4, 0);
    service.recordCatalogueObservation("run-discovery", 99, 99);
    service.observeToolsList("run-discovery", 40);
    service.observeToolsList("run-discovery", 2);

    expect(service.resolve(token)?.diagnostics).toMatchObject({
      configuredCatalogueSize: 4,
      advertisedToolCount: 0,
      toolsListRequestsObserved: 32,
      toolsListRequestBound: 32,
      toolsListRequestCountStatus: "capped",
    });
  });

  it("marks malformed discovery bodies unknown without retaining a partial count", () => {
    const service = new McpSessionService(60_000);
    const { token } = service.mint({ agentId: "agent-unknown", runId: "run-unknown" });

    service.observeToolsListMessage("run-unknown", [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      null,
    ]);

    expect(service.resolve(token)?.diagnostics).toMatchObject({
      toolsListRequestBound: 32,
      toolsListRequestCountStatus: "unknown",
    });
    expect(service.resolve(token)?.diagnostics).not.toHaveProperty("toolsListRequestsObserved");
  });
});
