import { describe, expect, it } from "vitest";
import { OrchestrationService } from "../../../apps/server/src/orchestration/orchestration-service.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OrchestrationSession } from "../../../apps/server/src/orchestration/types.js";

async function storeWith(session: OrchestrationSession, projectId: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "orch-delete-"));
  const store = new JsonStore(path.join(dir, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.orchestrations.push(session);
    database.projects.push({
      id: projectId,
      name: "SMU",
      description: "",
      workspacePath: "/projects/" + projectId,
      teamId: session.id,
      ownerPrincipalId: "demo-owner",
      status: "active",
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
    });
  });
  return store;
}

function stoppedSession(projectId: string | null): OrchestrationSession {
  return {
    id: randomUUID(),
    name: "team",
    originalPrompt: "go",
    ...(projectId === null ? {} : { projectId }),
    participants: [
      { id: randomUUID(), agentId: randomUUID(), role: "Builder", position: 0 },
    ],
    mode: "sequential",
    status: "stopped",
    currentParticipantId: null,
    currentRunId: null,
    stepIndex: 0,
    maxSteps: 8,
    perAgentTimeoutMs: 60_000,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  } as OrchestrationSession;
}

describe("deleteSession and its shared Project", () => {
  it("deletes only the conversation and leaves its Project active", async () => {
    const projectId = randomUUID();
    const session = stoppedSession(projectId);
    const store = await storeWith(session, projectId);
    const archived: string[] = [];
    const service = new OrchestrationService({
      store,
      agents: { getAgent: () => undefined } as never,
      projectBinding: {
        async bindTeam() {},
        async archiveProject(id) {
          archived.push(id);
          await store.mutate((database) => {
            const project = database.projects.find((item) => item.id === id);
            if (project) project.status = "archived";
          });
        },
      },
    });

    await service.deleteSession(session.id);

    expect(archived).toEqual([]);
    expect(store.snapshot().projects[0]?.status).toBe("active");
    expect(store.snapshot().orchestrations).toEqual([]);
  });

  it("clears a teamId that would otherwise point at a deleted session", async () => {
    const projectId = randomUUID();
    const session = stoppedSession(projectId);
    const store = await storeWith(session, projectId);
    const service = new OrchestrationService({
      store,
      agents: { getAgent: () => undefined } as never,
      // No archiveProject: a caller that only binds Teams must still not be
      // left with a Project claiming a Team that no longer exists.
      projectBinding: { async bindTeam() {} },
    });

    await service.deleteSession(session.id);

    const project = store.snapshot().projects[0];
    expect(project?.teamId).toBeNull();
    expect(project?.status).toBe("active");
  });

  it("deletes a text-only Team without touching any Project", async () => {
    const projectId = randomUUID();
    const session = stoppedSession(null);
    const store = await storeWith(session, projectId);
    const archived: string[] = [];
    const service = new OrchestrationService({
      store,
      agents: { getAgent: () => undefined } as never,
      projectBinding: {
        async bindTeam() {},
        async archiveProject(id) {
          archived.push(id);
        },
      },
    });

    await service.deleteSession(session.id);

    expect(archived).toEqual([]);
    expect(store.snapshot().projects[0]?.status).toBe("active");
  });
});
