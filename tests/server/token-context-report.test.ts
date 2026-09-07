import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOfflineTokenContextReport,
  formatTokenContextReportJson,
  formatTokenContextReportMarkdown,
  measureText,
  summarizeUsageFile,
  summarizeUsageValue,
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
      expect(summary.scopes["last-request"].counters).toEqual({
        inputTokens: 12,
        cachedInputTokens: 2,
        outputTokens: 3,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
