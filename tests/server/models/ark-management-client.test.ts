import { describe, expect, it, vi } from "vitest";
import {
  ArkManagementClient,
  ARK_MANAGEMENT_API_VERSION,
} from "../../../apps/server/src/models/ark-management-client.js";

const observedAt = new Date("2026-09-06T04:05:06.000Z");

function metadata(action: string, result: Record<string, unknown>): Record<string, unknown> {
  return {
    ResponseMetadata: {
      Action: action,
      Version: ARK_MANAGEMENT_API_VERSION,
    },
    Result: result,
  };
}

describe("ArkManagementClient", () => {
  it("signs ListEndpoints and only returns exact Running endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const url = new URL(String(_input));
      expect(url.searchParams.get("Action")).toBe("ListEndpoints");
      expect(url.searchParams.get("Version")).toBe(ARK_MANAGEMENT_API_VERSION);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ PageNumber: 1, PageSize: 100 });
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Date")).toBe("20260906T040506Z");
      expect(headers.get("X-Content-Sha256")).toMatch(/^[a-f0-9]{64}$/u);
      expect(headers.get("Authorization")).toMatch(
        /^HMAC-SHA256 Credential=ak-test\/20260906\/ap-southeast-1\/ark\/request,/u,
      );
      expect(headers.get("Authorization")).not.toContain("secret-test");
      return new Response(JSON.stringify(metadata("ListEndpoints", {
        TotalCount: 2,
        PageNumber: 1,
        PageSize: 100,
        Items: [
          {
            Id: "ep-running",
            Name: "Running endpoint",
            Status: "Running",
            RateLimit: { Rpm: 60, Tpm: 100_000 },
          },
          {
            Id: "ep-stopped",
            Name: "Stopped endpoint",
            Status: "Stopped",
            StatusReason: "paused",
          },
        ],
      })), { status: 200 });
    });
    const client = new ArkManagementClient({
      accessKey: "ak-test",
      secretKey: "secret-test",
      fetchImpl,
      now: () => observedAt,
    });

    await expect(client.listRunningEndpoints()).resolves.toEqual([
      expect.objectContaining({ id: "ep-running", status: "running" }),
    ]);
  });

  it("normalizes Fields/Data usage rows and preserves missing counters", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        QueryInterval: "Day",
        StartTime: "2026-09-05",
        EndTime: "2026-09-06",
        ShowWindowDetail: false,
        Filters: [{ Key: "ModelEndpoint", Values: ["ep-running"] }],
      });
      return new Response(JSON.stringify(metadata("GetInferenceUsage", {
        DataCount: 2,
        Fields: [
          { Name: "ModelEndpoint", Type: "STRING" },
          { Name: "InputTokens", Type: "BIGINT" },
          { Name: "CacheTokensHit", Type: "BIGINT" },
          { Name: "OutputTokens", Type: "BIGINT" },
          { Name: "TotalTokens", Type: "BIGINT" },
          { Name: "ReqCnt", Type: "BIGINT" },
        ],
        Data: [
          ["ep-running", 100, 5, 40, 140, 2],
          ["ep-running", 10, null, 4, 14, 1],
        ],
      })), { status: 200 });
    });
    const client = new ArkManagementClient({
      accessKey: "ak-test",
      secretKey: "secret-test",
      fetchImpl,
      now: () => observedAt,
    });

    await expect(client.getInferenceUsage({
      queryInterval: "Day",
      startTime: "2026-09-05",
      endTime: "2026-09-06",
      modelEndpoint: "ep-running",
    })).resolves.toMatchObject({
      availability: "partial",
      dataCount: 2,
      inputTokens: 110,
      cachedInputTokens: 5,
      outputTokens: 44,
      totalTokens: 154,
      requests: 3,
      modelEndpoint: "ep-running",
      rows: [
        expect.objectContaining({ modelEndpoint: "ep-running", inputTokens: 100 }),
        expect.objectContaining({ modelEndpoint: "ep-running", cachedInputTokens: null }),
      ],
    });
  });

  it("requests live free-token counters from ListModelActivations", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const url = new URL(String(_input));
      expect(url.searchParams.get("Action")).toBe("ListModelActivations");
      expect(JSON.parse(String(init?.body))).toEqual({
        PageNumber: 1,
        PageSize: 100,
        WithFreeUsage: true,
      });
      return new Response(JSON.stringify(metadata("ListModelActivations", {
        TotalCount: 1,
        PageNumber: 1,
        PageSize: 100,
        Items: [{
          FoundationModelName: "seed-2-0-mini",
          State: "Available",
          InitialInferenceFreeUsage: { Total: 497_500, Consumed: 287_345 },
        }],
      })), { status: 200 });
    });
    const client = new ArkManagementClient({
      accessKey: "ak-test",
      secretKey: "secret-test",
      fetchImpl,
      now: () => observedAt,
    });

    await expect(client.listModelActivations()).resolves.toEqual([{
      foundationModelName: "seed-2-0-mini",
      state: "Available",
      initialInferenceFreeUsage: { total: 497_500, consumed: 287_345 },
      freeInferenceUsage: null,
      observedAt: observedAt.toISOString(),
    }]);
  });

  it("reads free-inference pack counters for an activated model", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(metadata("ListModelActivations", {
        TotalCount: 1,
        PageNumber: 1,
        PageSize: 100,
        Items: [{
          FoundationModelName: "seed-1-6",
          State: "Available",
          // An activated model drops InitialInferenceFreeUsage and reports its
          // live grant through the pack list instead.
          FreeResourcePackItems: [
            {
              Total: 500_000,
              Consumed: 488_549,
              Type: "FreeInference",
              SyncTime: "2026-08-30T03:37:32+08:00",
              Reclaimed: 0,
            },
            { Total: 200, Consumed: 10, Type: "FreeImageGeneration" },
          ],
        }],
      })), { status: 200 }));
    const client = new ArkManagementClient({
      accessKey: "ak-test",
      secretKey: "secret-test",
      fetchImpl,
      now: () => observedAt,
    });

    await expect(client.listModelActivations()).resolves.toEqual([{
      foundationModelName: "seed-1-6",
      state: "Available",
      initialInferenceFreeUsage: null,
      freeInferenceUsage: { total: 500_000, consumed: 488_549 },
      observedAt: observedAt.toISOString(),
    }]);
  });
});
