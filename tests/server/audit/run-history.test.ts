import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../../apps/server/src/agent-service.js";
import {
  AuditService,
  StorageAuditStoreAdapter,
} from "../../../apps/server/src/audit/audit-service.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../../apps/server/src/types.js";
import { WorkspaceManager } from "../../../apps/server/src/workspace.js";
import { listRunHistory } from "../../../apps/server/src/audit/run-history.js";
import type {
  AuditConversationSnapshot,
  AuditRunSnapshot,
} from "../../../apps/server/src/audit/audit-timeline.js";
import type { AuditEvent } from "../../../apps/server/src/audit/audit-types.js";
import { buildHandoffPrompt } from "../../../apps/server/src/orchestration/handoff.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

/** A real Agent service and a real audit log over one shared store. */
async function makeObservabilityHarness(): Promise<{
  service: AgentService;
  audit: AuditService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-observability-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    WORKER_CURATED_MODELS: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const adapter = new StorageAuditStoreAdapter(store);
  const audit = new AuditService(adapter, adapter);
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
  );
  service.setAuditRecorder(audit);
  await service.initialize();
  return { service, audit };
}

async function completedRun(service: AgentService, agentId: string, prompt: string) {
  const { run } = await service.sendMessage(agentId, prompt);
  await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  return run.id;
}

describe("historical observability", () => {
  it("keeps Runs, traces and audit evidence after the Agent is deleted", async () => {
    const { service, audit } = await makeObservabilityHarness();
    const agent = await service.createAgent({
      name: "Builder",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const runId = await completedRun(service, agent.id, "Build login page");

    await service.deleteAgent(agent.id);

    expect(() => service.getAgent(agent.id)).toThrow(/Agent not found/);
    // The Run record survives and identifies its Agent on its own.
    const run = service.getRun(runId);
    expect(run.agentId).toBe(agent.id);
    expect(run.agentName).toBe("Builder");
    expect(run.agentDeletedAt).toBeTypeOf("string");
    expect(run.traceId).toBeTypeOf("string");
    expect(run.status).toBe("completed");
    // Its trace and audit events remain readable.
    const trace = audit.runTrace(runId);
    expect(trace?.eventCount).toBeGreaterThan(0);
    expect(audit.query({ runId }).length).toBeGreaterThan(0);
  });

  it("exposes a Run and its trace events from the Agent's Run list", async () => {
    const { service, audit } = await makeObservabilityHarness();
    const agent = await service.createAgent({
      name: "Builder",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const runId = await completedRun(service, agent.id, "Build login page");

    const runs = audit.runs({ agentId: agent.id });

    expect(runs.map((entry) => entry.runId)).toContain(runId);
    const entry = runs.find((item) => item.runId === runId);
    expect(entry?.agentName).toBe("Builder");
    expect(entry?.agentDeleted).toBe(false);
    expect(entry?.title).toBe("Build login page");
    expect(entry?.eventCount).toBeGreaterThan(0);
    expect(entry?.durationMs).not.toBeNull();
    // The listed trace identity resolves to the same trace the detail view reads.
    expect(audit.runTrace(runId)?.traceId).toBe(entry?.traceId);
  });

  it("still lists a deleted Agent's Run in the global observability list", async () => {
    const { service, audit } = await makeObservabilityHarness();
    const agent = await service.createAgent({
      name: "Builder",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const runId = await completedRun(service, agent.id, "Build login page");

    await service.deleteAgent(agent.id);

    const entry = audit.runs().find((item) => item.runId === runId);
    expect(entry).toBeDefined();
    expect(entry?.agentName).toBe("Builder");
    expect(entry?.agentDeleted).toBe(true);
    expect(entry?.agentDeletedAt).toBeTypeOf("string");
    expect(entry?.status).toBe("completed");
  });

  it("reports each Run's tokens and rolls them into its trace", async () => {
    const { service, audit } = await makeObservabilityHarness();
    const agent = await service.createAgent({
      name: "Builder",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const runId = await completedRun(service, agent.id, "Build login page");

    const entry = audit.runs({ agentId: agent.id }).find((item) => item.runId === runId);

    // The runner reports input and output but no cached counter, so the
    // rollup must stay explicitly partial rather than implying an exact total.
    expect(entry?.tokens).toMatchObject({
      availability: "partial",
      inputTokens: 12,
      cachedInputTokens: 0,
      outputTokens: 5,
      totalTokens: 17,
      runsReporting: 1,
      runsMissing: 0,
    });

    // The trace covering that Run reports the same tokens.
    const trace = audit.runTrace(runId);
    expect(trace?.tokens.totalTokens).toBe(17);
    expect(audit.traces().find((item) => item.traceId === trace?.traceId)?.tokens.totalTokens)
      .toBe(17);
  });
});

/** A Run snapshot with only the fields the history rollup reads. */
function runSnapshot(partial: Partial<AuditRunSnapshot> & Pick<AuditRunSnapshot, "id">): AuditRunSnapshot {
  return {
    agentId: "agent-1",
    agentName: "Builder",
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 4 },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    ...partial,
  };
}

let eventSequence = 0;

function auditEvent(partial: Partial<AuditEvent> & Pick<AuditEvent, "type" | "runId">): AuditEvent {
  eventSequence += 1;
  return {
    id: "event-" + eventSequence,
    status: "success",
    summary: partial.type,
    createdAt: "2026-01-01T00:00:00.500Z",
    principal: { kind: "agent", id: "agent-1" },
    metadata: {},
    traceId: "trace-1",
    spanId: "span-" + eventSequence,
    sequence: eventSequence,
    actorType: "agent",
    category: "tool_call",
    ...partial,
  } as AuditEvent;
}

describe("reading a Run list", () => {
  it("titles a Team Run by its task, not by the handoff preamble", () => {
    // The real prompt builder, so the title survives a change to the preamble.
    const { prompt } = buildHandoffPrompt({
      originalPrompt: "Rewrite the retry workflow\nand keep the old API",
      participant: {
        id: "participant-1",
        agentId: "agent-1",
        role: "Reviewer",
        position: "middle",
      },
    });
    expect(prompt.startsWith("You are participating in a shared multi-Agent conversation."))
      .toBe(true);

    const [entry] = listRunHistory([runSnapshot({ id: "run-1", prompt })], []);

    expect(entry?.title).toBe("Rewrite the retry workflow");
  });

  it("gives two participants of one Team turn the same conversation", () => {
    const runs = [
      runSnapshot({ id: "run-1", agentId: "agent-1", agentName: "Darren" }),
      runSnapshot({ id: "run-2", agentId: "agent-2", agentName: "Joshua" }),
    ];
    const events = [
      auditEvent({ type: "run_started", category: "model_call", runId: "run-1", orchestrationId: "orch-1" }),
      auditEvent({ type: "run_started", category: "model_call", runId: "run-2", orchestrationId: "orch-1" }),
    ];
    const conversations: AuditConversationSnapshot[] = [
      { id: "orch-1", kind: "team", title: "Retry workflow" },
    ];

    const entries = listRunHistory(runs, events, {}, undefined, conversations);

    expect(entries.map((entry) => entry.conversation)).toEqual([
      { id: "orch-1", kind: "team", title: "Retry workflow", derived: false },
      { id: "orch-1", kind: "team", title: "Retry workflow", derived: false },
    ]);
  });

  it("still groups a Team turn whose session record is gone", () => {
    const entries = listRunHistory(
      [runSnapshot({ id: "run-1", prompt: "Ship the fix" })],
      [auditEvent({ type: "run_started", category: "model_call", runId: "run-1", orchestrationId: "orch-1" })],
      {},
      undefined,
      [],
    );

    // Grouping survives the missing name; the Run's own task stands in for it.
    expect(entries[0]?.conversation).toEqual({
      id: "orch-1",
      kind: "team",
      title: "Ship the fix",
      derived: true,
    });
  });

  it("names a private chat thread from the conversation record", () => {
    const entries = listRunHistory(
      [runSnapshot({ id: "run-1", conversationId: "conv-1", prompt: "hi" })],
      [],
      {},
      undefined,
      [{ id: "conv-1", kind: "direct", title: "Login page" }],
    );

    expect(entries[0]?.conversation).toEqual({
      id: "conv-1",
      kind: "direct",
      title: "Login page",
      derived: false,
    });
  });

  it("leaves a Run that belongs to no thread unattached", () => {
    const entries = listRunHistory([runSnapshot({ id: "run-1", prompt: "One-off" })], []);

    expect(entries[0]?.conversation).toBeNull();
  });

  it("says what each Run called, not just how many events it produced", () => {
    const entries = listRunHistory(
      [runSnapshot({ id: "run-1" })],
      [
        auditEvent({ type: "tool_started", runId: "run-1", resource: { kind: "tool", id: "read_file" } }),
        auditEvent({ type: "tool_succeeded", runId: "run-1", resource: { kind: "tool", id: "read_file" } }),
        auditEvent({
          type: "sandbox_command",
          category: "sandbox_execution",
          runId: "run-1",
          metadata: { program: "rg" },
        }),
      ],
    );

    expect(entries[0]?.eventCount).toBe(3);
    expect(entries[0]?.tools).toEqual({
      calls: 1,
      sandboxCommands: 1,
      names: [
        { name: "$ rg", calls: 1, failed: 0 },
        { name: "read_file", calls: 1, failed: 0 },
      ],
    });
  });
});
