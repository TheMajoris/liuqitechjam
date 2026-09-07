import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../apps/server/src/app.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import type {
  AgentService,
} from "../../../apps/server/src/agent-service.js";
import type { ModelCatalogServiceContract } from "../../../apps/server/src/app.js";
import type {
  ArkModelCatalogRecord,
  ModelDescriptor,
  ModelRef,
  ModelRegistry,
} from "../../../apps/server/src/models/index.js";
import type { Agent } from "../../../apps/server/src/types.js";

const PROVIDER = "volcengine_ark";

function descriptor(id: string): ModelDescriptor {
  return {
    id,
    label: id,
    providerId: PROVIDER,
    capabilities: { scopes: ["worker"], reasoning: false },
  };
}

function catalogRecord(
  supervisorModelRef: ModelRef | null | undefined,
): ArkModelCatalogRecord {
  return {
    provider: PROVIDER,
    baseUrl: "https://ark.example.test/api/v3",
    apiKeyEnv: "ARK_API_KEY",
    models: [],
    defaultModelRef: { providerId: PROVIDER, modelId: "ep-default" },
    ...(supervisorModelRef === undefined ? {} : { supervisorModelRef }),
    revision: 3,
  };
}

/** Live endpoints, as ListEndpoints would report them. */
const RUNNING = ["ep-default", "ep-worker", "ep-supervisor"];

function harness(options: {
  supervisorModelRef?: ModelRef | null;
  environmentModelId?: string;
  agents?: Agent[];
} = {}) {
  let record = catalogRecord(options.supervisorModelRef);
  const updateAgent = vi.fn(async () => ({}) as Agent);
  const modelCatalog: ModelCatalogServiceContract = {
    get: () => record,
    setSupervisorModelRef: async (modelRef) => {
      record = { ...record, supervisorModelRef: modelRef, revision: 4 };
      return record;
    },
  };
  const modelRegistry = {
    listProviders: async () => [],
    listModels: async (_providerId: string, scope: "worker" | "supervisor") =>
      // The worker listing withholds whatever is currently reserved; the
      // supervisor listing does not.
      (scope === "worker"
        ? RUNNING.filter((id) => id !== record.supervisorModelRef?.modelId)
        : RUNNING
      ).map(descriptor),
    resolveWorkerModel: () => {
      throw new Error("unused");
    },
    validateWorkerModelRef: () => undefined,
  } as unknown as ModelRegistry;
  const service = {
    listAgents: () => options.agents ?? [],
    updateAgent,
    systemInfo: async () => ({}),
  } as unknown as AgentService;

  return {
    updateAgent,
    catalog: () => record,
    app: createApp(
      loadConfig({
        NODE_ENV: "test",
        ...(options.environmentModelId === undefined
          ? {}
          : { SUPERVISOR_MODEL: options.environmentModelId }),
      }),
      service,
      undefined,
      modelRegistry,
      undefined,
      undefined,
      undefined,
      modelCatalog,
    ),
  };
}

describe("supervisor model routes", () => {
  it("reports the environment value when no override is persisted", async () => {
    const app = await harness({ environmentModelId: "ep-supervisor" }).app;

    const response = await app.inject({ method: "GET", url: "/api/supervisor-model" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      source: "environment",
      environmentModelId: "ep-supervisor",
    });
    await app.close();
  });

  it("prefers a persisted override over the environment value", async () => {
    const app = await harness({
      environmentModelId: "ep-supervisor",
      supervisorModelRef: { providerId: PROVIDER, modelId: "ep-worker" },
    }).app;

    expect((await app.inject({ method: "GET", url: "/api/supervisor-model" })).json())
      .toMatchObject({
        modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
        source: "override",
        environmentModelId: "ep-supervisor",
      });
    await app.close();
  });

  it("persists a new endpoint and moves Agents off it", async () => {
    const fixture = harness({
      environmentModelId: "ep-supervisor",
      agents: [
        {
          id: "a1",
          name: "Joshua",
          modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
        } as Agent,
      ],
    });
    const app = await fixture.app;

    const response = await app.inject({
      method: "PUT",
      url: "/api/supervisor-model",
      payload: { modelRef: { providerId: PROVIDER, modelId: "ep-worker" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      modelRef: { providerId: PROVIDER, modelId: "ep-worker" },
      source: "override",
      reassignments: [
        { agentId: "a1", agentName: "Joshua", movedPrimaryTo: "ep-default" },
      ],
    });
    expect(fixture.updateAgent).toHaveBeenCalledWith("a1", {
      modelRef: { providerId: PROVIDER, modelId: "ep-default" },
    });
    await app.close();
  });

  it("rejects an endpoint that is not running", async () => {
    const app = await harness({ environmentModelId: "ep-supervisor" }).app;

    const response = await app.inject({
      method: "PUT",
      url: "/api/supervisor-model",
      payload: { modelRef: { providerId: PROVIDER, modelId: "ep-missing" } },
    });

    expect(response.statusCode).toBe(422);
    await app.close();
  });

  it("rejects a provider that cannot supervise", async () => {
    const app = await harness({ environmentModelId: "ep-supervisor" }).app;

    const response = await app.inject({
      method: "PUT",
      url: "/api/supervisor-model",
      payload: { modelRef: { providerId: "openai", modelId: "ep-worker" } },
    });

    expect(response.statusCode).toBe(422);
    await app.close();
  });

  it("clears the override back to the environment value", async () => {
    const fixture = harness({
      environmentModelId: "ep-supervisor",
      supervisorModelRef: { providerId: PROVIDER, modelId: "ep-worker" },
    });
    const app = await fixture.app;

    const response = await app.inject({
      method: "PUT",
      url: "/api/supervisor-model",
      payload: { modelRef: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      modelRef: { providerId: PROVIDER, modelId: "ep-supervisor" },
      source: "environment",
    });
    expect(fixture.catalog().supervisorModelRef).toBeNull();
    await app.close();
  });
});
