import { describe, expect, it, vi } from "vitest";
import {
  ArkLiveModelState,
  ArkManagementClient,
  ARK_MANAGEMENT_API_VERSION,
} from "../../../apps/server/src/models/index.js";
import type {
  ArkEndpointRecord,
  ArkInferenceUsageRecord,
  ArkManagementClient as ArkManagementClientContract,
} from "../../../apps/server/src/models/index.js";

function listResponse(): Response {
  return new Response(JSON.stringify({
    ResponseMetadata: {
      Action: "ListEndpoints",
      Version: ARK_MANAGEMENT_API_VERSION,
    },
    Result: {
      TotalCount: 2,
      PageNumber: 1,
      PageSize: 100,
      Items: [
        { Id: "ep-running", Name: "Ready", Status: "Running" },
        { Id: "ep-stopped", Name: "Paused", Status: "Stopped" },
      ],
    },
  }), { status: 200 });
}

function endpoint(id: string): ArkEndpointRecord {
  return {
    id,
    name: id,
    foundationModel: null,
    status: "running",
    statusReason: null,
    modelUnitId: null,
    rateLimit: { rpm: null, tpm: null },
    updateTime: null,
    observedAt: "2026-09-06T04:05:06.000Z",
  };
}

function usage(rows: ArkInferenceUsageRecord["rows"]): ArkInferenceUsageRecord {
  return {
    dataCount: rows.length,
    availability: "available",
    inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    cachedInputTokens: rows.reduce((sum, row) => sum + (row.cachedInputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
    totalTokens: rows.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
    requests: rows.reduce((sum, row) => sum + (row.requests ?? 0), 0),
    rows,
    modelEndpoint: null,
    modelEndpoints: ["ep-a", "ep-b"],
    queryInterval: "Day",
    startTime: "2026-08-07",
    endTime: "2026-09-06",
    showWindowDetail: false,
    observedAt: "2026-09-06T04:05:06.000Z",
  };
}

describe("ArkLiveModelState", () => {
  it("deduplicates an in-flight refresh and exposes only Running selectors", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    const client = new ArkManagementClient({
      accessKey: "ak-test",
      secretKey: "secret-test",
      fetchImpl,
      now: () => new Date("2026-09-06T04:05:06.000Z"),
    });
    const state = new ArkLiveModelState({
      client,
      ttlMs: 60_000,
      now: () => new Date("2026-09-06T04:05:06.000Z").getTime(),
    });

    const first = state.refresh();
    const second = state.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release?.(listResponse());
    await Promise.all([first, second]);

    expect(state.listRunningDescriptors("worker").map((model) => model.id)).toEqual([
      "ep-running",
    ]);
    expect(state.getModel("volcengine_ark", "ep-stopped")).toBeUndefined();
    expect(state.getCatalogRevision()).toBe(1);
  });

  it("force refreshes through a new generation without allowing an old response to win", async () => {
    let releaseFirst!: (items: ArkEndpointRecord[]) => void;
    const first = new Promise<ArkEndpointRecord[]>((resolve) => {
      releaseFirst = resolve;
    });
    const client = {
      listEndpoints: vi.fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce([endpoint("ep-new")]),
      getInferenceUsage: vi.fn(),
    } as unknown as ArkManagementClientContract;
    const state = new ArkLiveModelState({
      client,
      ttlMs: 60_000,
      now: () => new Date("2026-09-06T04:05:06.000Z").getTime(),
    });

    const oldRefresh = state.refresh();
    const forcedRefresh = state.refresh({ force: true });
    await forcedRefresh;
    releaseFirst([endpoint("ep-old")]);
    await expect(oldRefresh).rejects.toMatchObject({
      code: "MODEL_PROVIDER_UNAVAILABLE",
    });
    expect(state.listRunningDescriptors("worker").map((model) => model.id)).toEqual([
      "ep-new",
    ]);
    expect(client.listEndpoints).toHaveBeenCalledTimes(2);
  });

  it("queries the 30-day endpoint set once and keeps usage totals scoped per endpoint", async () => {
    const client = {
      listEndpoints: vi.fn().mockResolvedValue([endpoint("ep-a"), endpoint("ep-b")]),
      getInferenceUsage: vi.fn(async () => usage([
        {
          modelEndpoint: "ep-a",
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 40,
          totalTokens: 140,
          requests: 2,
        },
        {
          modelEndpoint: "ep-b",
          inputTokens: 300,
          cachedInputTokens: 30,
          outputTokens: 80,
          totalTokens: 380,
          requests: 4,
        },
      ])),
    } as unknown as ArkManagementClientContract;
    const state = new ArkLiveModelState({
      client,
      ttlMs: 60_000,
      now: () => new Date("2026-09-06T04:05:06.000Z").getTime(),
    });

    const result = await state.modelResources({ force: true });

    expect(client.getInferenceUsage).toHaveBeenCalledTimes(1);
    expect(client.getInferenceUsage).toHaveBeenCalledWith(expect.objectContaining({
      startTime: "2026-08-07",
      endTime: "2026-09-06",
      modelEndpoints: ["ep-a", "ep-b"],
    }));
    expect(result.endpoints.map((item) => item.usage?.totalTokens)).toEqual([140, 380]);
    expect(result.inferenceUsage?.totalTokens).toBe(520);
  });

  it("attaches shared activation quota to matching foundation models", async () => {
    const firstEndpoint = {
      ...endpoint("ep-liuqi9"),
      foundationModel: { name: "seed-2-0-mini", version: "1" },
    };
    const secondEndpoint = {
      ...endpoint("ep-liuqi9-secondary"),
      foundationModel: { name: "seed-2-0-mini", version: "1" },
    };
    const unrelatedEndpoint = {
      ...endpoint("ep-other-model"),
      foundationModel: { name: "seed-2-0-pro", version: "1" },
    };
    const client = {
      listEndpoints: vi.fn().mockResolvedValue([
        firstEndpoint,
        secondEndpoint,
        unrelatedEndpoint,
      ]),
      listModelActivations: vi.fn().mockResolvedValue([{
        foundationModelName: "seed-2-0-mini",
        state: "Available",
        // An activated model reports live counters through the free pack only.
        initialInferenceFreeUsage: null,
        freeInferenceUsage: { total: 497_500, consumed: 287_345 },
        observedAt: "2026-09-06T04:05:06.000Z",
      }, {
        foundationModelName: "seed-2-0-pro",
        state: "Available",
        initialInferenceFreeUsage: { total: 10, consumed: 20 },
        freeInferenceUsage: null,
        observedAt: "2026-09-06T04:05:06.000Z",
      }]),
      getInferenceUsage: vi.fn(async () => usage([
        {
          modelEndpoint: "ep-liuqi9",
          inputTokens: 900_000,
          cachedInputTokens: 0,
          outputTokens: 1,
          totalTokens: 900_001,
          requests: 1,
        },
      ])),
    } as unknown as ArkManagementClientContract;
    const state = new ArkLiveModelState({
      client,
      ttlMs: 60_000,
      now: () => new Date("2026-09-06T04:05:06.000Z").getTime(),
    });

    const result = await state.modelResources({ force: true });

    expect(client.listModelActivations).toHaveBeenCalledTimes(1);
    expect(result.endpoints.map((item) => item.quota)).toEqual([
      { usedTokens: 287_345, totalTokens: 497_500, remainingTokens: 210_155 },
      { usedTokens: 287_345, totalTokens: 497_500, remainingTokens: 210_155 },
      // An overrun grant reads as exhausted rather than as an invalid snapshot.
      { usedTokens: 10, totalTokens: 10, remainingTokens: 0 },
    ]);
  });
});
