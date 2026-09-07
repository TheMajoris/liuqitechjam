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
