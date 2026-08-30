import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { PermitAuthorizationAdapter } from "../access/permit-authorization-adapter.js";
import { McpSessionService } from "../tools/mcp-session-service.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { ToolService, type ToolApprovalGateway } from "../tools/tool-service.js";
import type { ToolDefinition } from "../tools/tool-types.js";
import { JsonStore } from "../store.js";
import { AuditService, type AuditEvent } from "./audit-service.js";
import type { AuditStoreAdapter } from "./audit-store.js";
import { correlationAttributes } from "../telemetry/telemetry-types.js";
import { normalizeRunUsage } from "../telemetry/telemetry-usage.js";
import {
  FailSafeSpanExporter,
} from "../telemetry/runtime-telemetry.js";
import { ExportResultCode } from "@opentelemetry/core";
import type { SpanExporter } from "@opentelemetry/sdk-trace";

class MemoryAuditStore implements AuditStoreAdapter {
  readonly events: AuditEvent[] = [];

  read(): readonly AuditEvent[] {
    return this.events;
  }

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("AuditService", () => {
  it("correlates trusted IDs while redacting audit projections and bounding queries", async () => {
    const audit = new AuditService(new MemoryAuditStore());
    const authorization = new PermitAuthorizationAdapter({
      client: { check: async () => true },
      audit,
    });
    const definition: ToolDefinition<{ value: string }, { echoed: string }> = {
      id: "test.echo",
      title: "Echo",
      description: "Echo a value",
      risk: "read",
      requiredPermission: "project.read",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      async execute(_context, input) {
        return { echoed: input.value };
      },
    };
    const approvals = {
      isAvailable: () => true,
      consumeOperationApproval: async () => true,
    } as unknown as ToolApprovalGateway;
    const toolService = new ToolService(
      new ToolRegistry([definition]),
      authorization,
      new JsonStore("/tmp/wave12-audit-test.json"),
      approvals,
      audit,
    );
    const sessions = new McpSessionService(60_000);
    const minted = sessions.mint({
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      orchestrationId: "orchestration-1",
    });
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      { listAgents: () => [], systemInfo: async () => ({}) } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { sessions, toolService, auditService: audit },
    );
    try {
      const invoked = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: "Bearer " + minted.token,
          accept: "application/json, text/event-stream",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "test.echo", arguments: { value: "hello" } },
        },
      });
      expect(invoked.statusCode).toBe(200);
      expect(invoked.json().result.structuredContent).toEqual({ echoed: "hello" });
    } finally {
      await app.close();
    }
    const correlated = audit.query({ runId: "run-1" });
    expect(correlated).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "authorization_decision",
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-1",
        orchestrationId: "orchestration-1",
        resource: { kind: "tool", id: "test.echo" },
        metadata: expect.objectContaining({ decision: "allow" }),
      }),
      expect.objectContaining({
        type: "tool_succeeded",
        agentId: "agent-1",
        projectId: "project-1",
        runId: "run-1",
        resource: { kind: "tool", id: "test.echo" },
      }),
    ]));
    const event = await audit.record({
      type: "tool_failed",
      status: "failure",
      summary: "prompt=read /Users/darrenng/private output=Bearer abcdefghijklmnop",
      principal: { kind: "agent", id: "agent-1" },
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      metadata: {
        errorCode: "TOOL_EXECUTION_FAILED",
        output: "provider response must not persist",
        nested: { secret: "no" },
      },
    });
    expect(event.summary).toBe("Server audit event");
    expect(event.summary).not.toContain("/Users");
    expect(event.summary).not.toContain("Bearer");
    expect(event.metadata).toEqual({ errorCode: "TOOL_EXECUTION_FAILED" });
    expect(audit.query({ type: "tool_succeeded" })).toHaveLength(1);
    expect(audit.query({ limit: 0 }).length).toBeGreaterThan(2);
    expect(correlationAttributes({
      principalKind: "agent",
      principalId: "agent-1",
      agentId: "agent-1",
      projectId: "project-1",
      runId: "run-1",
      orchestrationId: "orchestration-1",
      permitRequestId: "permit-1",
    })).toMatchObject({
      "principal.kind": "agent",
      "principal.id": "agent-1",
      "agent.id": "agent-1",
      "project.id": "project-1",
      "run.id": "run-1",
      "orchestration.id": "orchestration-1",
      "permit.request_id": "permit-1",
    });
  });

  it("reports authoritative usage as available, partial, or unavailable", () => {
    expect(normalizeRunUsage({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    })).toEqual({
      availability: "available",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    });
    expect(normalizeRunUsage({ outputTokens: 4 }).availability).toBe("partial");
    expect(normalizeRunUsage(null)).toEqual({ availability: "unavailable" });
    const availableTimeline = new AuditService(new MemoryAuditStore(), {
      readRuns: () => [{
        id: "run-1",
        agentId: "agent-1",
        usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 },
        startedAt: "2026-08-30T00:00:00.000Z",
        completedAt: "2026-08-30T00:00:01.000Z",
      }],
    }).queryTimeline({ runId: "run-1" });
    expect(availableTimeline.summary).toMatchObject({
      usageAvailability: "available",
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    const unavailableTimeline = new AuditService(new MemoryAuditStore(), {
      readRuns: () => [{
        id: "run-2",
        agentId: "agent-1",
        usage: null,
        startedAt: null,
        completedAt: null,
      }],
    }).queryTimeline({ runId: "run-2" });
    expect(unavailableTimeline.summary).toMatchObject({
      usageAvailability: "unavailable",
      llmCount: 1,
    });
    expect(unavailableTimeline.summary).not.toHaveProperty("totalTokens");
  });

  it("contains exporter failures without affecting the runtime", async () => {
    const broken: SpanExporter = {
      export() {
        throw new Error("provider response body");
      },
      shutdown() {
        return Promise.reject(new Error("exporter unavailable"));
      },
    };
    const exporter = new FailSafeSpanExporter(broken);
    let code: ExportResultCode | undefined;
    expect(() => exporter.export([], (result) => {
      code = result.code;
    })).not.toThrow();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
    expect(code).toBe(ExportResultCode.FAILED);
  });
});
