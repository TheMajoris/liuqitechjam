import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOfflineTokenContextReport,
  computeCacheHitRatio,
  countToolsListRequests,
  formatTokenContextReportJson,
  formatTokenContextReportMarkdown,
  measureText,
  summarizeUsageFile,
  summarizeUsageValue,
  subtractUsageSnapshots,
  observeToolsListRequests,
  stableRuntimeContextFingerprint,
  TOOLS_LIST_REQUEST_BOUND,
} from "../../scripts/token-context-report.js";
import {
  REPORT_AGENT,
  REPORT_AGENT_WITH_SKILL,
  REPORT_FETCH_URL,
  REPORT_HTML,
  REPORT_PROMPTS,
  REPORT_USAGE_EVENTS,
} from "../../scripts/token-context-fixtures.js";

describe("offline token-context report", () => {
  it("measures Unicode characters separately from UTF-8 bytes", () => {
    expect(measureText("Aé🙂")).toEqual({ characters: 3, utf8Bytes: 7 });
  });

  it("uses deterministic fixtures and covers every Wave 0 boundary", async () => {
    const first = await buildOfflineTokenContextReport();
    const second = await buildOfflineTokenContextReport();
    expect(formatTokenContextReportJson(first)).toBe(formatTokenContextReportJson(second));

    expect(first.scenarios.map((scenario) => scenario.id)).toEqual([
      "fresh-message-no-skills",
      "assigned-skill",
      "private-workspace",
      "project-workspace",
      "two-participant-handoff",
      "longer-completed-conversation",
      "html-fetch-result-and-mcp-serialization",
    ]);
    const boundaries = first.scenarios.flatMap((scenario) =>
      scenario.measurements.map((measurement) => measurement.boundary),
    );
    expect(boundaries).toEqual(expect.arrayContaining([
      "raw-user-message-to-runtime-envelope",
      "skill-body-to-runtime-skill-lines",
      "agent-instructions-to-private-workspace-instructions",
      "project-workspace-instructions",
      "source-output-to-worker-handoff-prompt",
      "completed-turns-to-worker-handoff-prompt",
      "supervisor-context-to-supervisor-prompt",
      "logical-result-to-mcp-wire-result",
    ]));
    expect(first.deliveryComparisons.map((comparison) => comparison.boundary)).toEqual([
      "synthetic-legacy-duplicate-to-canonical-current-delivery",
      "same-run-legacy-no-runId-duplicate-to-runId-dedup",
      "same-run-supervisor-legacy-no-runId-duplicate-to-runId-dedup",
    ]);
    for (const comparison of first.deliveryComparisons) {
      expect(comparison.before.characters).toBeGreaterThan(comparison.after.characters);
      expect(comparison.before.utf8Bytes).toBeGreaterThan(comparison.after.utf8Bytes);
      expect(comparison.reduction.characters).toBeGreaterThan(0);
      expect(comparison.reduction.utf8Bytes).toBeGreaterThan(0);
    }

    expect(first.diagnostics).toMatchObject({
      runId: "run-token-report",
      runCorrelationStatus: "synthetic-unverified",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      usageSource: "unknown",
      usageScope: "unknown",
      configuredCatalogueSize: 1,
      numberOfToolsExposed: 1,
      toolsListRequestsObserved: 1,
      toolsListRequestBound: TOOLS_LIST_REQUEST_BOUND,
      toolsListRequestCountStatus: "bounded",
      discoveryObserved: true,
      authenticatedDiscoveryObserved: null,
      toolSchemaEstimatedTokens: null,
      rawTaskBytes: Buffer.byteLength(REPORT_PROMPTS.fresh, "utf8"),
      runtimeVersion: null,
      providerId: null,
      modelId: null,
      freshness: "fresh",
      fallbackStatus: "not-used",
    });
    expect(first.diagnostics.toolSchemaBytes).toBeGreaterThan(0);
    expect(first.diagnostics.catalogueFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.diagnostics.stableContextFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const serialized = formatTokenContextReportJson(first) + formatTokenContextReportMarkdown(first);
    expect(serialized).not.toContain(REPORT_PROMPTS.fresh);
    expect(serialized).not.toContain(REPORT_PROMPTS.assignedSkill);
    expect(serialized).not.toContain(REPORT_AGENT.instructions);
    expect(serialized).not.toContain(REPORT_AGENT_WITH_SKILL.name);
    expect(serialized).not.toContain(REPORT_FETCH_URL);
    expect(serialized).not.toContain(REPORT_HTML);
  });

  it("does not double-count repeated cumulative usage snapshots", () => {
    const summary = summarizeUsageValue(REPORT_USAGE_EVENTS);
    expect(summary.records).toBe(6);
    expect(summary.unsupportedOrAmbiguousRecords).toBe(0);
    expect(summary.scopes["last-request"]).toMatchObject({
      records: 1,
      duplicateRecords: 0,
      counters: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 18 },
    });
    expect(summary.scopes["cumulative-session"]).toMatchObject({
      records: 3,
      duplicateRecords: 1,
      distinctIdentities: 1,
      counters: { inputTokens: 640, cachedInputTokens: 260, outputTokens: 104 },
    });
    expect(summary.scopes["app-run"]).toMatchObject({
      records: 1,
      counters: { inputTokens: 720, cachedInputTokens: 280, outputTokens: 120 },
    });
    expect(summary.scopes.unknown).toMatchObject({
      records: 1,
      availability: "unknown",
      counters: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
    });
  });

  it("marks interleaved cumulative identities ambiguous instead of choosing one", () => {
    const summary = summarizeUsageValue([
      {
        scope: "cumulative-session",
        session_id: "session-a",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      },
      {
        scope: "cumulative-session",
        session_id: "session-b",
        usage: { input_tokens: 200, cached_input_tokens: 40, output_tokens: 20 },
      },
      {
        scope: "cumulative-session",
        session_id: "session-a",
        usage: { input_tokens: 140, cached_input_tokens: 30, output_tokens: 14 },
      },
      {
        scope: "cumulative-session",
        session_id: "session-b",
        usage: { input_tokens: 200, cached_input_tokens: 40, output_tokens: 20 },
      },
    ]);
    expect(summary.scopes["cumulative-session"]).toMatchObject({
      records: 4,
      duplicateRecords: 1,
      distinctStates: 3,
      distinctIdentities: 2,
      aggregation: "ambiguous-multiple-identities",
      availability: "unknown",
      counters: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
    });
  });

  it("keeps ambiguous and malformed usage shapes unknown when reading a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lqam-token-usage-test-"));
    const filePath = path.join(root, "rollout.jsonl");
    try {
      await writeFile(
        filePath,
        [
          JSON.stringify({
            type: "turn.completed",
            scope: "last-request",
            request_id: "request-file",
            usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 },
          }),
          JSON.stringify({ usage: { input_tokens: "not-a-counter" } }),
          "not-json",
          "",
        ].join("\n"),
        "utf8",
      );
      const summary = await summarizeUsageFile(filePath);
      expect(summary.source).toBe("offline-file");
      expect(summary.records).toBe(1);
      expect(summary.unsupportedOrAmbiguousRecords).toBe(2);
      expect(summary.rawEvidence).toMatchObject({
        status: "pending-sanitized-capture",
        path: null,
        records: 1,
      });
      expect(summary.scopes["last-request"].counters).toEqual({
        inputTokens: 12,
        cachedInputTokens: 2,
        outputTokens: 3,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not infer scope from event names or aggregate a known scope without identity", () => {
    const summary = summarizeUsageValue([
      {
        type: "turn.completed",
        usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 },
      },
      {
        scope: "cumulative-session",
        usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 5 },
      },
    ]);
    expect(summary.scopes.unknown).toMatchObject({
      records: 1,
      counters: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
    });
    expect(summary.scopes["cumulative-session"]).toMatchObject({
      records: 1,
      aggregation: "ambiguous-missing-identity",
      availability: "unknown",
      counters: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
    });
    expect(summary.unsupportedOrAmbiguousRecords).toBe(1);
  });

  it("reports provenance-gated cache ratios and verified snapshot differences", () => {
    const summary = summarizeUsageValue([
      {
        scope: "last-request",
        usage_source: "runtime-jsonl",
        request_id: "request-ratio",
        usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 8 },
      },
      {
        scope: "endpoint-window",
        usage_source: "provider-management-aggregate",
        window_id: "window-1",
        usage: { input_tokens: 1000, cached_input_tokens: 250, output_tokens: 80 },
      },
    ]);
    expect(summary.scopes["last-request"]).toMatchObject({
      usageSource: "runtime-jsonl",
      cacheHitRatio: 0.25,
      cacheHitRatioStatus: "valid",
    });
    expect(summary.scopes["endpoint-window"]).toMatchObject({
      usageSource: "provider-management-aggregate",
      cacheHitRatio: 0.25,
    });
    expect(computeCacheHitRatio({ inputTokens: 10, cachedInputTokens: 11, outputTokens: 1 })).toEqual({
      ratio: null,
      status: "invalid-cached-input",
    });
    expect(
      subtractUsageSnapshots(
        {
          counters: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
          source: "runtime-jsonl",
          scope: "cumulative-session",
          identity: "thread-1",
        },
        {
          counters: { inputTokens: 140, cachedInputTokens: 60, outputTokens: 14 },
          source: "runtime-jsonl",
          scope: "cumulative-session",
          identity: "thread-1",
        },
      ),
    ).toEqual({
      valid: true,
      reason: "valid",
      counters: { inputTokens: 40, cachedInputTokens: 20, outputTokens: 4 },
    });
    expect(
      subtractUsageSnapshots(
        {
          counters: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
          source: "runtime-jsonl",
          scope: "cumulative-session",
          identity: "thread-1",
        },
        {
          counters: { inputTokens: 90, cachedInputTokens: 45, outputTokens: 12 },
          source: "runtime-jsonl",
          scope: "cumulative-session",
          identity: "thread-1",
        },
      ),
    ).toMatchObject({ valid: false, reason: "counter-reset" });
    expect(
      subtractUsageSnapshots(
        {
          counters: { inputTokens: null, cachedInputTokens: 0, outputTokens: 0 },
          source: "runtime-jsonl",
          scope: "cumulative-session",
          identity: "thread-1",
        },
        {
          counters: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 1 },
          source: "runtime-jsonl",
          scope: "cumulative-session",
          identity: "thread-1",
        },
      ),
    ).toMatchObject({ valid: false, reason: "missing-counter" });
  });

  it("keeps mixed usage sources unknown instead of summing them", () => {
    const summary = summarizeUsageValue([
      {
        scope: "last-request",
        usage_source: "runtime-jsonl",
        request_id: "request-a",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      },
      {
        scope: "last-request",
        usage_source: "provider-response",
        request_id: "request-b",
        usage: { input_tokens: 200, cached_input_tokens: 40, output_tokens: 20 },
      },
    ]);
    expect(summary.scopes["last-request"]).toMatchObject({
      usageSource: "unknown",
      aggregation: "ambiguous-mixed-sources",
      availability: "unknown",
      counters: { inputTokens: null, cachedInputTokens: null, outputTokens: null },
    });
    expect(summary.usageSource).toBe("unknown");
  });

  it("requires compatible provenance for snapshot subtraction", () => {
    const base = {
      counters: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
      scope: "cumulative-session" as const,
      identity: "thread-1",
    };
    expect(
      subtractUsageSnapshots(
        { ...base, source: "runtime-jsonl" },
        {
          ...base,
          source: "provider-response",
          counters: { inputTokens: 110, cachedInputTokens: 25, outputTokens: 11 },
        },
      ),
    ).toMatchObject({ valid: false, reason: "incompatible-evidence" });
    expect(
      subtractUsageSnapshots(
        { ...base, source: "runtime-jsonl", identity: "thread-1" },
        {
          ...base,
          source: "runtime-jsonl",
          identity: "thread-2",
          counters: { inputTokens: 110, cachedInputTokens: 25, outputTokens: 11 },
        },
      ),
    ).toMatchObject({ valid: false, reason: "incompatible-evidence" });
    expect(
      subtractUsageSnapshots(
        {
          ...base,
          source: "provider-management-aggregate",
          scope: "endpoint-window",
          identity: "window-1",
        },
        {
          ...base,
          source: "provider-management-aggregate",
          scope: "endpoint-window",
          identity: "window-1",
          counters: { inputTokens: 110, cachedInputTokens: 25, outputTokens: 11 },
        },
      ),
    ).toMatchObject({ valid: false, reason: "incompatible-evidence" });
  });

  it("rejects impossible derived cache counters and fingerprints only stable context", () => {
    const difference = subtractUsageSnapshots(
      {
        counters: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
        source: "runtime-jsonl",
        scope: "cumulative-session",
        identity: "thread-1",
      },
      {
        counters: { inputTokens: 101, cachedInputTokens: 100, outputTokens: 11 },
        source: "runtime-jsonl",
        scope: "cumulative-session",
        identity: "thread-1",
      },
    );
    expect(difference).toMatchObject({ valid: false, reason: "invalid-cached-input" });

    const stablePrefix = "<platform_runtime_context>\nfixed guidance";
    const first = `${stablePrefix}\npreview.status = \"not_started\"\nstate a`;
    const second = `${stablePrefix}\npreview.status = \"running\"\nstate b`;
    expect(stableRuntimeContextFingerprint(first)).toBe(
      stableRuntimeContextFingerprint(second),
    );
    expect(stableRuntimeContextFingerprint("missing marker")).toBeNull();
  });

  it("counts tools/list in single and batch JSON-RPC messages", () => {
    expect(countToolsListRequests({ jsonrpc: "2.0", method: "tools/list", id: 1 })).toBe(1);
    expect(
      countToolsListRequests([
        { jsonrpc: "2.0", method: "tools/list", id: 1 },
        { jsonrpc: "2.0", method: "tools/call", id: 2 },
        { jsonrpc: "2.0", method: "tools/list", id: 3 },
      ]),
    ).toBe(2);
    expect(
      observeToolsListRequests(
        Array.from({ length: TOOLS_LIST_REQUEST_BOUND + 1 }, (_, id) => ({
          jsonrpc: "2.0",
          method: "tools/list",
          id,
        })),
      ),
    ).toEqual({ count: null, status: "overflow" });
    expect(observeToolsListRequests("not-a-json-rpc-message")).toEqual({
      count: null,
      status: "unknown",
    });
  });
});
