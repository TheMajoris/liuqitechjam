import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../apps/server/src/agent-service.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { JsonStore } from "../../apps/server/src/store.js";
import { WorkspaceManager } from "../../apps/server/src/workspace.js";
import type {
  AgentRunner,
  OrchestrationSession,
  RunnerRequest,
  RunnerResult,
} from "../../apps/server/src/types.js";

class IdleRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: "ok", threadId: request.threadId ?? "thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeService(): Promise<{ service: AgentService; store: JsonStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-delete-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    WORKER_CURATED_MODELS: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new IdleRunner(),
  );
  await service.initialize();
  return { service, store };
}

function session(
  status: OrchestrationSession["status"],
  agentIds: readonly string[],
): OrchestrationSession {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    name: "Count to ten",
    originalPrompt: "Count to ten",
    projectId: randomUUID(),
    participants: agentIds.map((agentId, position) => ({
      id: "p-" + position,
      agentId,
      role: "Agent",
      position,
    })),
    mode: "supervisor",
    status,
    currentParticipantId: null,
    currentRunId: null,
    stepIndex: 0,
    maxSteps: 20,
    perAgentTimeoutMs: 300_000,
    errorCode: null,
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: status === "draft" ? null : timestamp,
    completedAt: null,
  };
}

/**
 * Deleting an Agent has to remove it from everywhere it is *listed*, not only
 * from the Agents table. Membership was already cleaned up; a draft
 * Conversation's roster was not, so the room kept a desk for an Agent that no
 * longer existed and starting the Conversation failed with AGENT_NOT_FOUND
 * until the whole thing was deleted.
 */
describe("deleteAgent and Conversation rosters", () => {
  it("removes the Agent from a draft roster and closes the position gap", async () => {
    const { service, store } = await makeService();
    const keep = await service.createAgent({
      name: "Keeper",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const doomed = await service.createAgent({
      name: "Doomed",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const draft = session("draft", [keep.id, doomed.id]);
    await store.mutate((database) => {
      database.orchestrations.push(draft);
    });

    await service.deleteAgent(doomed.id);

    const after = store.snapshot().orchestrations.find((item) => item.id === draft.id);
    expect(after?.participants.map((item) => item.agentId)).toEqual([keep.id]);
    // Positions are renumbered, so deterministic turn order stays contiguous.
    expect(after?.participants.map((item) => item.position)).toEqual([0]);
  });

  it("leaves a completed Conversation's roster exactly as it was", async () => {
    const { service, store } = await makeService();
    const doomed = await service.createAgent({
      name: "Doomed",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const finished = session("completed", [doomed.id]);
    await store.mutate((database) => {
      database.orchestrations.push(finished);
    });

    await service.deleteAgent(doomed.id);

    // That record explains a run that actually happened; rewriting it would
    // make the transcript disagree with the turns beneath it.
    const after = store.snapshot().orchestrations.find((item) => item.id === finished.id);
    expect(after?.participants.map((item) => item.agentId)).toEqual([doomed.id]);
    expect(after?.updatedAt).toBe(finished.updatedAt);
  });

  it("still removes Workspace membership", async () => {
    const { service, store } = await makeService();
    // Deleting an Agent that holds Project membership goes through the Project
    // coordination seam, which the real app wires at startup. The seam only has
    // to hand back a release function for this path to run.
    service.setProjectExecutionScope({
      beginAgentDeletion: () => () => undefined,
    } as Parameters<typeof service.setProjectExecutionScope>[0]);
    const doomed = await service.createAgent({
      name: "Doomed",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const projectId = randomUUID();
    await store.mutate((database) => {
      database.projectAgents.push({
        projectId,
        agentId: doomed.id,
        role: "editor",
        createdAt: new Date().toISOString(),
      });
    });

    await service.deleteAgent(doomed.id);

    expect(
      store.snapshot().projectAgents.filter((item) => item.agentId === doomed.id),
    ).toEqual([]);
  });

  it("fences native tool approvals before deleting an Agent", async () => {
    const { service } = await makeService();
    const doomed = await service.createAgent({
      name: "Doomed",
      modelRef: { providerId: "volcengine_ark", modelId: "ep-test" },
    });
    const invalidated: string[] = [];
    service.setToolApprovalInvalidator({
      async invalidateForAgent(agentId) {
        invalidated.push(agentId);
        return 1;
      },
      async invalidateForProject() {
        return 0;
      },
    });

    await service.deleteAgent(doomed.id);

    expect(invalidated).toEqual([doomed.id]);
  });
});
