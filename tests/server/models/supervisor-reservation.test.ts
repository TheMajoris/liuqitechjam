import { describe, expect, it, vi } from "vitest";
import {
  findAgentsOnReservedModel,
  releaseAgentsFromReservedModel,
} from "../../../apps/server/src/models/index.js";
import type {
  ModelDescriptor,
  ReservationAgentService,
} from "../../../apps/server/src/models/index.js";
import type { Agent } from "../../../apps/server/src/types.js";

const PROVIDER = "volcengine_ark";

function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    description: "",
    instructions: "",
    status: "idle",
    workspacePath: "/tmp/" + overrides.id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-09-06T04:05:06.000Z",
    updatedAt: "2026-09-06T04:05:06.000Z",
    ...overrides,
  } as Agent;
}

function descriptor(id: string): ModelDescriptor {
  return {
    id,
    label: id,
    providerId: PROVIDER,
    capabilities: { scopes: ["worker"], reasoning: false },
  };
}

function serviceFor(agents: Agent[]): ReservationAgentService & {
  updateAgent: ReturnType<typeof vi.fn>;
} {
  const updateAgent = vi.fn(async () => agents[0] as Agent);
  return { listAgents: () => agents, updateAgent };
}

describe("releaseAgentsFromReservedModel", () => {
  it("moves a primary assignment onto the catalog default", async () => {
    const service = serviceFor([
      agent({
        id: "a1",
        name: "Joshua",
        modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      }),
      agent({
        id: "a2",
        name: "Alex",
        modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
      }),
    ]);

    const outcomes = await releaseAgentsFromReservedModel({
      agentService: service,
      reservedModelId: "ep-supervisor",
      availableModels: [descriptor("ep-worker"), descriptor("ep-spare")],
      preferredModelRef: { providerId: PROVIDER, modelId: "ep-spare" },
    });

    expect(service.updateAgent).toHaveBeenCalledTimes(1);
    expect(service.updateAgent).toHaveBeenCalledWith("a1", {
      modelRef: { providerId: PROVIDER, modelId: "ep-spare" },
    });
    expect(outcomes).toEqual([
      {
        agentId: "a1",
        agentName: "Joshua",
        movedPrimaryTo: "ep-spare",
        droppedFallbacks: 0,
      },
    ]);
  });

  it("falls back to the first running endpoint when no default is set", async () => {
    const service = serviceFor([
      agent({
        id: "a1",
        name: "Darren",
        modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      }),
    ]);

    await releaseAgentsFromReservedModel({
      agentService: service,
      reservedModelId: "ep-supervisor",
      availableModels: [descriptor("ep-worker")],
      preferredModelRef: null,
    });

    expect(service.updateAgent).toHaveBeenCalledWith("a1", {
      modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
    });
  });

  it("never reassigns onto the reserved endpoint itself", async () => {
    const service = serviceFor([
      agent({
        id: "a1",
        name: "Bernard",
        modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      }),
    ]);

    await releaseAgentsFromReservedModel({
      agentService: service,
      reservedModelId: "ep-supervisor",
      availableModels: [descriptor("ep-worker")],
      // A stale catalog default can still name the endpoint being reserved.
      preferredModelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
    });

    expect(service.updateAgent).toHaveBeenCalledWith("a1", {
      modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
    });
  });

  it("strips the reserved endpoint from fallbacks without touching the primary", async () => {
    const service = serviceFor([
      agent({
        id: "a1",
        name: "Dwayne",
        modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
        fallbackModelRefs: [
          { providerId: PROVIDER, modelId: "ep-supervisor" },
          { providerId: PROVIDER, modelId: "ep-spare" },
        ],
      }),
    ]);

    const outcomes = await releaseAgentsFromReservedModel({
      agentService: service,
      reservedModelId: "ep-supervisor",
      availableModels: [descriptor("ep-worker")],
      preferredModelRef: null,
    });

    expect(service.updateAgent).toHaveBeenCalledWith("a1", {
      fallbackModelRefs: [{ providerId: PROVIDER, modelId: "ep-spare" }],
    });
    expect(outcomes[0]?.movedPrimaryTo).toBeUndefined();
    expect(outcomes[0]?.droppedFallbacks).toBe(1);
  });

  it("reports rather than throws when an Agent cannot be edited", async () => {
    const agents = [
      agent({
        id: "a1",
        name: "Joshua",
        status: "busy",
        modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      }),
    ];
    const service: ReservationAgentService = {
      listAgents: () => agents,
      updateAgent: async () => {
        throw new Error("Stop the active run before editing this Agent");
      },
    };

    const outcomes = await releaseAgentsFromReservedModel({
      agentService: service,
      reservedModelId: "ep-supervisor",
      availableModels: [descriptor("ep-worker")],
      preferredModelRef: null,
    });

    expect(outcomes).toEqual([
      {
        agentId: "a1",
        agentName: "Joshua",
        droppedFallbacks: 0,
        skippedReason: "Stop the active run before editing this Agent",
      },
    ]);
  });

  it("leaves an Agent alone when no replacement endpoint exists", async () => {
    const service = serviceFor([
      agent({
        id: "a1",
        name: "Joshua",
        modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      }),
    ]);

    const outcomes = await releaseAgentsFromReservedModel({
      agentService: service,
      reservedModelId: "ep-supervisor",
      availableModels: [],
      preferredModelRef: null,
    });

    expect(service.updateAgent).not.toHaveBeenCalled();
    expect(outcomes[0]?.skippedReason).toBe(
      "No other running worker endpoint is available",
    );
  });

  it("does nothing when no endpoint is reserved", async () => {
    const service = serviceFor([
      agent({
        id: "a1",
        name: "Joshua",
        modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
      }),
    ]);

    expect(
      await releaseAgentsFromReservedModel({
        agentService: service,
        reservedModelId: "   ",
        availableModels: [descriptor("ep-worker")],
        preferredModelRef: null,
      }),
    ).toEqual([]);
    expect(service.updateAgent).not.toHaveBeenCalled();
  });
});

describe("findAgentsOnReservedModel", () => {
  it("reports a primary assignment without changing it", () => {
    const agents = [
      agent({
        id: "a1",
        name: "Small counter",
        modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      }),
    ];
    const service = serviceFor(agents);

    const conflicts = findAgentsOnReservedModel(service, "ep-supervisor");

    expect(conflicts).toEqual([
      { agentId: "a1", agentName: "Small counter", primary: true, fallbacks: 0 },
    ]);
    // The whole point: an observation must never rewrite the operator's choice.
    expect(service.updateAgent).not.toHaveBeenCalled();
    expect(agents[0]?.modelRef?.modelId).toBe("ep-supervisor");
  });

  it("counts fallbacks that point at the reserved endpoint", () => {
    const conflicts = findAgentsOnReservedModel(
      serviceFor([
        agent({
          id: "a2",
          name: "Prime counter",
          modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
          fallbackModelRefs: [
            { providerId: PROVIDER, modelId: "ep-supervisor" },
            { providerId: PROVIDER, modelId: "ep-other" },
          ],
        }),
      ]),
      "ep-supervisor",
    );

    expect(conflicts).toEqual([
      { agentId: "a2", agentName: "Prime counter", primary: false, fallbacks: 1 },
    ]);
  });

  it("says nothing about Agents that are not on the reserved endpoint", () => {
    expect(
      findAgentsOnReservedModel(
        serviceFor([
          agent({
            id: "a3",
            name: "Big counter",
            modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
          }),
        ]),
        "ep-supervisor",
      ),
    ).toEqual([]);
  });

  it("treats an unset reserved endpoint as nothing to report", () => {
    expect(
      findAgentsOnReservedModel(
        serviceFor([
          agent({
            id: "a4",
            name: "Any",
            modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
          }),
        ]),
        "   ",
      ),
    ).toEqual([]);
  });
});
