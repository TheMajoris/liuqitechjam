import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../../apps/server/src/types.js";
import { JsonStore } from "../../../apps/server/src/store.js";
import type {
  PlatformAgentInvokerContract,
  PlatformAgentInvokerInput,
} from "../../../apps/server/src/orchestration/platform-agent-invoker.js";
import {
  OrchestrationService,
  type OrchestrationAgentAccess,
} from "../../../apps/server/src/orchestration/orchestration-service.js";
import type {
  CreateOrchestrationInput,
  OrchestrationSession,
} from "../../../apps/server/src/orchestration/types.js";

const agentIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function makeAgent(id: string, status: Agent["status"] = "ready"): Agent {
  const timestamp = "2026-08-28T00:00:00.000Z";
  return {
    id,
    name: `Agent ${id.slice(0, 4)}`,
    description: "Test Agent",
    instructions: "Do the assigned work.",
    status,
    workspacePath: `/tmp/launchpad-${id}`,
    codexThreadId: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeInput(
  participants = agentIds.map((agentId, position) => ({
    id: `participant-${position}`,
    agentId,
    role: `Role ${position}`,
    position,
  })),
): CreateOrchestrationInput {
  return {
    name: "Release pipeline",
    originalPrompt: "Ship the requested change safely.",
    participants,
    maxSteps: participants.length,
    perAgentTimeoutMs: 1_000,
  };
}

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-orchestration-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

async function waitForTerminal(
  service: OrchestrationService,
  id: string,
): Promise<OrchestrationSession> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = (await service.getSession(id)).session;
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "stopped" ||
      session.status === "interrupted"
    ) {
      return session;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for orchestration " + id);
}

class ImmediateInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  readonly cancellations: string[] = [];
  private count = 0;

  async invoke(input: PlatformAgentInvokerInput) {
    this.calls.push(input);
    this.count += 1;
    const runId = `00000000-0000-4000-8000-${String(this.count).padStart(12, "0")}`;
    await input.onRunAccepted?.(runId);
    return {
      runId,
      output: `result-${this.count}`,
    };
  }

  async cancel(runId: string): Promise<void> {
    this.cancellations.push(runId);
  }
}

class PendingInvoker implements PlatformAgentInvokerContract {
  readonly calls: PlatformAgentInvokerInput[] = [];
  readonly cancellations: string[] = [];
  private resolvePending: (() => void) | null = null;
  private rejectPending: ((error: Error) => void) | null = null;

  async invoke(input: PlatformAgentInvokerInput) {
    this.calls.push(input);
    const runId = "00000000-0000-4000-8000-000000000099";
    await input.onRunAccepted?.(runId);
    return new Promise<{ runId: string; output: string }>((resolve, reject) => {
      this.resolvePending = () => resolve({ runId, output: "late result" });
      this.rejectPending = reject;
      input.signal?.addEventListener(
        "abort",
        () => reject(new Error("child Run cancelled")),
        { once: true },
      );
    });
  }

  async cancel(runId: string): Promise<void> {
    this.cancellations.push(runId);
    this.rejectPending?.(new Error("child Run cancelled"));
    this.rejectPending = null;
    this.resolvePending = null;
  }
}

function makeAgentsAccess(agents: Agent[]): OrchestrationAgentAccess {
  return { listAgents: () => agents };
}

describe("OrchestrationService", () => {
  it("runs an arbitrary roster in order, journals turns, and preserves monotonic events", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(
      makeInput([
        {
          id: "last",
          agentId: agentIds[2]!,
          role: "Finisher",
          position: 2,
        },
        {
          id: "first",
          agentId: agentIds[0]!,
          role: "Planner",
          position: 0,
        },
        {
          id: "middle",
          agentId: agentIds[1]!,
          role: "Builder",
          position: 1,
        },
      ]),
    );

    const accepted = await service.startSession(created.id);
    expect(["queued", "running", "completed"]).toContain(accepted.status);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("completed");

    const detail = await service.getSession(created.id);
    expect(detail.turns.map((turn) => turn.participantId)).toEqual([
      "first",
      "middle",
      "last",
    ]);
    expect(detail.turns.map((turn) => turn.stepIndex)).toEqual([0, 1, 2]);
    expect(detail.turns.every((turn) => turn.status === "completed")).toBe(true);
    expect(invoker.calls.map((call) => call.agentId)).toEqual([
      agentIds[0],
      agentIds[1],
      agentIds[2],
    ]);
    expect(invoker.calls[1]?.prompt).toContain("result-1");
    const sequences = detail.events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_value, index) => index));
    expect(detail.events.at(-1)?.type).toBe("orchestration_completed");
    expect(detail.events.at(-1)?.completionReason).toBe("roster_exhausted");
  });

  it("fails a round-robin session at maxSteps and persists execution step indices", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession({
      ...makeInput(),
      mode: "round_robin",
      maxSteps: 5,
    });

    await service.startSession(created.id);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorCode).toBe("MAX_STEPS_EXCEEDED");
    expect(terminal.completionReason).toBeNull();

    const detail = await service.getSession(created.id);
    expect(detail.turns.map((turn) => turn.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(detail.turns.map((turn) => turn.participantId)).toEqual([
      "participant-0",
      "participant-1",
      "participant-2",
      "participant-0",
      "participant-1",
    ]);
    expect(invoker.calls).toHaveLength(5);
    expect(detail.events.at(-1)).toMatchObject({
      type: "orchestration_failed",
      errorCode: "MAX_STEPS_EXCEEDED",
    });
    expect(detail.events.at(-1)?.completionReason).toBeUndefined();
  });

  it("revalidates each dispatch and fails before invoking an unavailable next Agent", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const invoker = new ImmediateInvoker();
    let dispatchChecks = 0;
    const access: OrchestrationAgentAccess = {
      listAgents: () => {
        dispatchChecks += 1;
        if (dispatchChecks >= 3) agents[1]!.status = "stopped";
        return agents;
      },
    };
    const service = new OrchestrationService(store, access, invoker);
    const created = await service.createSession(makeInput());

    await service.startSession(created.id);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorCode).toBe("AGENT_STOPPED");
    expect(invoker.calls).toHaveLength(1);
    const detail = await service.getSession(created.id);
    expect(detail.turns).toHaveLength(1);
    expect(detail.events.some((event) => event.type === "participant_failed")).toBe(
      true,
    );
  });

  it("stops an active session by cancelling only its accepted child Run", async () => {
    const store = await makeStore();
    const agents = [makeAgent(agentIds[0]!)];
    const invoker = new PendingInvoker();
    const service = new OrchestrationService(
      store,
      makeAgentsAccess(agents),
      invoker,
    );
    const created = await service.createSession(
      makeInput([
        {
          id: "worker",
          agentId: agentIds[0]!,
          role: "Worker",
          position: 0,
        },
      ]),
    );
    await service.startSession(created.id);
    for (let attempt = 0; attempt < 100 && invoker.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(invoker.calls).toHaveLength(1);

    const stopped = await service.stopSession(created.id);
    expect(stopped.status).toBe("stopped");
    expect(invoker.cancellations).toEqual([
      "00000000-0000-4000-8000-000000000099",
    ]);
    expect((await service.getSession(created.id)).events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["child_run_cancelled", "orchestration_stopped"]),
    );
    expect(agents[0]?.status).toBe("ready");
  });

  it("snapshots the selected supervisor Agent model and passes it to routing", async () => {
    const store = await makeStore();
    const agents = agentIds.map((id) => makeAgent(id));
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    } as const;
    agents[1]!.modelRef = supervisorModel;
    await store.mutate((database) => database.agents.push(...agents));
    let selectedModel: string | undefined;
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker: new ImmediateInvoker(),
      selectNextParticipant: async (input) => {
        selectedModel = input.supervisorModel;
        return { kind: "end", reason: "supervisor_completed" };
      },
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
        catalogRevision: 7,
      }),
    });
    const created = await service.createSession({
      ...makeInput([{
        id: "worker",
        agentId: agentIds[0]!,
        role: "Worker",
        position: 0,
      }]),
      mode: "supervisor",
      supervisorAgentId: agentIds[1],
    });

    await service.startSession(created.id);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("completed");
    expect(selectedModel).toBe(supervisorModel.modelId);
    expect(terminal).toMatchObject({
      supervisorAgentId: agentIds[1],
      supervisorModelRef: supervisorModel,
      supervisorModelCatalogRevision: 7,
    });
  });

  it("assigns a Workspace Agent and starts an empty draft from its first prompt", async () => {
    const store = await makeStore();
    const projectId = "44444444-4444-4444-8444-444444444444";
    const agents = [makeAgent(agentIds[0]!)];
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    } as const;
    agents[0]!.modelRef = supervisorModel;
    await store.mutate((database) => {
      database.projects.push({
        id: projectId,
        name: "Workspace",
        description: "",
        workspacePath: "/tmp/workspace",
        teamId: null,
        ownerPrincipalId: "demo-owner",
        status: "active",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
      database.agents.push(...agents);
      database.projectAgents.push({
        projectId,
        agentId: agents[0]!.id,
        codexThreadId: null,
        attachedAt: "2026-08-28T00:00:00.000Z",
        role: "editor",
        toolGrants: [],
        updatedAt: "2026-08-28T00:00:00.000Z",
      });
    });
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker: new ImmediateInvoker(),
      selectNextParticipant: async () => ({
        kind: "end",
        reason: "supervisor_completed",
      }),
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
        catalogRevision: 8,
      }),
    });
    const created = await service.createSession({
      name: "Workspace draft",
      originalPrompt: "",
      participants: [],
      projectId,
      mode: "supervisor",
      maxSteps: 4,
      perAgentTimeoutMs: 1_000,
    });

    expect(created.status).toBe("draft");
    expect(created.supervisorAgentId).toBe(agents[0]!.id);

    const accepted = await service.startSession(created.id, "Ship the change");
    expect(["queued", "running", "completed"]).toContain(accepted.status);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal).toMatchObject({
      status: "completed",
      originalPrompt: "Ship the change",
      supervisorAgentId: agents[0]!.id,
      supervisorModelRef: supervisorModel,
      supervisorModelCatalogRevision: 8,
    });
    expect(terminal.participants).toMatchObject([
      {
        agentId: agents[0]!.id,
        role: "editor",
        position: 0,
      },
    ]);
  });

  it("repairs a legacy supervisor draft before accepting its first run", async () => {
    const store = await makeStore();
    const agents = [makeAgent(agentIds[0]!)];
    const supervisorModel = {
      providerId: "volcengine_ark",
      modelId: "ep-supervisor",
    } as const;
    agents[0]!.modelRef = supervisorModel;
    await store.mutate((database) => database.agents.push(...agents));
    const service = new OrchestrationService({
      store,
      agents: makeAgentsAccess(agents),
      invoker: new ImmediateInvoker(),
      selectNextParticipant: async () => ({
        kind: "end",
        reason: "supervisor_completed",
      }),
      resolveSupervisorModel: () => ({
        modelRef: supervisorModel,
        modelId: supervisorModel.modelId,
      }),
    });
    const created = await service.createSession({
      ...makeInput([{
        id: "worker",
        agentId: agents[0]!.id,
        role: "Worker",
        position: 0,
      }]),
      mode: "supervisor",
      supervisorAgentId: agents[0]!.id,
    });
    await store.mutate((database) => {
      const session = database.orchestrations.find((item) => item.id === created.id);
      if (session) delete session.supervisorAgentId;
    });

    const accepted = await service.startSession(created.id);
    expect(["queued", "running", "completed"]).toContain(accepted.status);
    const terminal = await waitForTerminal(service, created.id);
    expect(terminal.status).toBe("completed");
    expect(terminal.supervisorAgentId).toBe(agents[0]!.id);
  });

});
