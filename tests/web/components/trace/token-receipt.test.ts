import { describe, expect, it } from "vitest";
import { buildTokenReceipt } from "../../../../apps/web/src/components/trace/token-receipt";
import type { FlatSpan } from "../../../../apps/web/src/components/trace/trace-tree";
import type { AuditEventRecord } from "../../../../apps/web/src/types";

let sequence = 0;

function event(
  type: string,
  metadata: Record<string, string | number>,
  overrides: Partial<AuditEventRecord> = {},
): AuditEventRecord {
  sequence += 1;
  return {
    id: "event-" + sequence,
    type,
    status: "success",
    summary: type,
    createdAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    metadata,
    ...overrides,
  };
}

function span(events: AuditEventRecord[], overrides: Partial<FlatSpan> = {}): FlatSpan {
  const first = events[0]!;
  return {
    spanId: "span-" + first.id,
    parentSpanId: null,
    depth: 0,
    event: first,
    events,
    category: "model_call",
    status: "success",
    startedAt: first.createdAt,
    endedAt: first.createdAt,
    durationMs: 0,
    label: first.type,
    ...overrides,
  };
}

function turn(
  agentId: string,
  inputTokens: number,
  outputTokens: number,
  extra: Record<string, number> = {},
  runId?: string,
): FlatSpan {
  return span(
    [
      event(
        "model_turn",
        { inputTokens, outputTokens, ...extra },
        { agentId, ...(runId === undefined ? {} : { runId }) },
      ),
    ],
    runId === undefined ? {} : { runId },
  );
}

/** A Run span naming the model, so its turns can be priced. */
function runSpan(runId: string, modelUsed: string): FlatSpan {
  return span([event("run_completed", { modelUsed }, { runId })], { runId });
}

/** The live BytePlus ModelArk rates, in USD per 1K tokens. */
const ARK_RATES = {
  "ep-flash": { inputMiss: 0.00044, inputHit: 0.000014, output: 0.00132 },
};

describe("token receipt", () => {
  it("balances: the line items sum to the billed total", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 21391, 900),
      turn("agent-a", 28008, 800),
      turn("agent-a", 34633, 700),
    ]);
    const lines =
      receipt.openingTokens +
      receipt.addedTokens +
      receipt.resentTokens +
      receipt.outputTokens;
    expect(lines).toBe(receipt.billedTokens);
    expect(receipt.billedTokens).toBe(21391 + 28008 + 34633 + 900 + 800 + 700);
  });

  it("attributes a resumed thread's growth, not its whole prompt", () => {
    // The verified codex-cli probe in docs/TOKEN_USAGE_REDUCTION_BASELINE.md:
    // input rose a flat ~6.6K per turn on one resumed thread.
    const receipt = buildTokenReceipt([
      turn("agent-a", 21391, 0),
      turn("agent-a", 28008, 0),
      turn("agent-a", 34633, 0),
    ]);
    expect(receipt.openingTokens).toBe(21391);
    expect(receipt.addedTokens).toBe(6617 + 6625);
    expect(receipt.resentTokens).toBe(21391 + 28008);
    expect(receipt.uniqueTokens).toBe(34633);
  });

  it("subtracts the previous turn's output from the growth it caused", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 1000, 400),
      turn("agent-a", 1600, 0),
    ]);
    // The prompt grew 600, but 400 of that was the model's own last answer.
    expect(receipt.addedTokens).toBe(200);
    expect(receipt.resentTokens).toBe(1400);
  });

  it("keeps two agents' threads apart", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 1000, 0),
      turn("agent-b", 5000, 0),
      turn("agent-a", 1200, 0),
    ]);
    expect(receipt.chains).toBe(2);
    expect(receipt.openingTokens).toBe(6000);
    expect(receipt.addedTokens).toBe(200);
    expect(receipt.resentTokens).toBe(1000);
  });

  it("treats a shrinking prompt as a restart rather than negative growth", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 9000, 0),
      turn("agent-a", 2000, 0),
    ]);
    expect(receipt.restarts).toBe(1);
    expect(receipt.openingTokens).toBe(11000);
    expect(receipt.addedTokens).toBe(0);
    expect(
      receipt.openingTokens + receipt.addedTokens + receipt.resentTokens,
    ).toBe(11000);
  });

  it("separates a provider that reports no cache from one that reports zero", () => {
    const silent = buildTokenReceipt([
      turn("agent-a", 10000, 100),
      turn("agent-a", 12000, 100),
    ]);
    expect(silent.cacheReported).toBe(false);
    expect(silent.cachedInputTokens).toBe(0);
    // With nothing measured, "processed" cannot be less than the bill.
    expect(silent.processedTokens).toBe(silent.billedTokens);

    const measured = buildTokenReceipt([
      turn("agent-a", 10000, 100, { cachedInputTokens: 0 }),
    ]);
    expect(measured.cacheReported).toBe(true);
    expect(measured.cachedInputTokens).toBe(0);
  });

  it("never lets cache read become an addend", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 20000, 500, { cachedInputTokens: 18000 }),
    ]);
    expect(receipt.cachedInputTokens).toBe(18000);
    expect(receipt.billedTokens).toBe(20500);
  });

  it("splits added context across the tools that produced it", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 1000, 0),
      span([event("sandbox_command", { program: "npm", stdoutBytes: 3000 })]),
      span([event("mcp_tool_call", { toolId: "search_docs", resultBytes: 1000 })]),
      turn("agent-a", 2000, 0),
    ]);
    expect(receipt.addedTokens).toBe(1000);
    expect(receipt.toolLines.map((line) => [line.label, line.estimatedTokens])).toEqual([
      ["npm", 750],
      ["search_docs", 250],
    ]);
    expect(receipt.toolEstimateScaled).toBe(false);
    expect(receipt.otherAddedTokens).toBe(0);
  });

  it("scales tool estimates down rather than overrunning the subtotal", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 1000, 0),
      span([event("sandbox_command", { program: "cat", stdoutBytes: 400_000 })]),
      turn("agent-a", 1100, 0),
    ]);
    expect(receipt.toolEstimateScaled).toBe(true);
    const attributed = receipt.toolLines.reduce(
      (sum, line) => sum + line.estimatedTokens,
      0,
    );
    expect(attributed + receipt.otherAddedTokens).toBe(receipt.addedTokens);
  });

  it("names the thread behind an oversized line", () => {
    const receipt = buildTokenReceipt([
      turn("agent-small", 20000, 0),
      turn("agent-heavy", 115000, 0),
      turn("agent-small", 20500, 0),
    ]);
    expect(
      receipt.chainLines.map((chain) => [chain.id, chain.openingTokens, chain.turns]),
    ).toEqual([
      ["agent-heavy", 115000, 1],
      ["agent-small", 20000, 2],
    ]);
    // Every thread's billed figure sums back to the receipt total.
    expect(
      receipt.chainLines.reduce((sum, chain) => sum + chain.billedTokens, 0),
    ).toBe(receipt.billedTokens);
  });

  it("splits a thread's own bill across the same four lines", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 1000, 100),
      turn("agent-a", 1400, 50),
    ]);
    const [chain] = receipt.chainLines;
    expect(
      chain!.openingTokens + chain!.addedTokens + chain!.resentTokens + chain!.outputTokens,
    ).toBe(chain!.billedTokens);
  });

  it("bills one run without blaming it for the thread it resumed", () => {
    const spans = [
      turn("agent-a", 10000, 200, {}, "run-1"),
      turn("agent-a", 12000, 300, {}, "run-2"),
    ];
    const scoped = buildTokenReceipt(spans, { runId: "run-2" });
    // The second run inherited a 10K prefix it never sent, so its opening is
    // zero and the prefix shows as re-sent rather than as its own setup.
    expect(scoped.openingTokens).toBe(0);
    expect(scoped.addedTokens).toBe(12000 - 10000 - 200);
    expect(scoped.resentTokens).toBe(10200);
    expect(scoped.outputTokens).toBe(300);
    expect(scoped.billedTokens).toBe(12300);
  });

  it("scopes to the run that opened the thread", () => {
    const spans = [
      turn("agent-a", 10000, 200, {}, "run-1"),
      turn("agent-a", 12000, 300, {}, "run-2"),
    ];
    const scoped = buildTokenReceipt(spans, { runId: "run-1" });
    expect(scoped.openingTokens).toBe(10000);
    expect(scoped.billedTokens).toBe(10200);
  });

  it("scoped runs sum back to the unscoped receipt", () => {
    const spans = [
      turn("agent-a", 10000, 200, {}, "run-1"),
      turn("agent-b", 8000, 100, {}, "run-2"),
      turn("agent-a", 12000, 300, {}, "run-3"),
    ];
    const whole = buildTokenReceipt(spans);
    const parts = ["run-1", "run-2", "run-3"].map(
      (runId) => buildTokenReceipt(spans, { runId }).billedTokens,
    );
    expect(parts.reduce((sum, value) => sum + value, 0)).toBe(whole.billedTokens);
  });

  it("reconciles the bill against the figure the Run list ranks by", () => {
    const receipt = buildTokenReceipt([
      turn("agent-a", 20000, 500, { cachedInputTokens: 12000 }),
    ]);
    expect(receipt.billedTokens).toBe(20500);
    expect(receipt.processedTokens).toBe(20500 - 12000);
  });

  it("prices a cache hit apart from a miss", () => {
    const receipt = buildTokenReceipt(
      [
        runSpan("run-1", "ep-flash"),
        turn("agent-a", 10_000, 1_000, { cachedInputTokens: 8_000 }, "run-1"),
      ],
      {},
      ARK_RATES,
    );
    // 2K miss + 8K hit + 1K output, at the live rates.
    const expected =
      (2_000 * 0.00044 + 8_000 * 0.000014 + 1_000 * 0.00132) / 1000;
    expect(receipt.cost?.total).toBeCloseTo(expected, 10);
    // The counterfactual prices the same input entirely as a miss.
    expect(receipt.cost?.withoutCache).toBeCloseTo(
      (10_000 * 0.00044 + 1_000 * 0.00132) / 1000,
      10,
    );
    expect(receipt.cost!.withoutCache).toBeGreaterThan(receipt.cost!.total);
  });

  it("spends the cache on the lines the provider actually matched", () => {
    const receipt = buildTokenReceipt(
      [
        runSpan("run-1", "ep-flash"),
        turn("agent-a", 10_000, 0, {}, "run-1"),
        runSpan("run-2", "ep-flash"),
        turn("agent-a", 15_000, 0, { cachedInputTokens: 10_000 }, "run-2"),
      ],
      {},
      ARK_RATES,
    );
    // Turn two carried a 10K prefix and added 5K; the 10K cache read covers
    // the prefix exactly, so the re-sent line is charged entirely at hit rate
    // and the added line entirely at miss rate.
    expect(receipt.resentTokens).toBe(10_000);
    expect(receipt.addedTokens).toBe(5_000);
    expect(receipt.cost?.resent).toBeCloseTo((10_000 * 0.000014) / 1000, 10);
    expect(receipt.cost?.added).toBeCloseTo((5_000 * 0.00044) / 1000, 10);
  });

  it("line costs sum to the total", () => {
    const receipt = buildTokenReceipt(
      [
        runSpan("run-1", "ep-flash"),
        turn("agent-a", 9_000, 120, { cachedInputTokens: 7_000 }, "run-1"),
        runSpan("run-2", "ep-flash"),
        turn("agent-a", 18_000, 240, { cachedInputTokens: 15_000 }, "run-2"),
      ],
      {},
      ARK_RATES,
    );
    const { opening, added, resent, output, total } = receipt.cost!;
    expect(opening + added + resent + output).toBeCloseTo(total, 10);
  });

  it("shows no price at all when any model has no configured rate", () => {
    const receipt = buildTokenReceipt(
      [
        runSpan("run-1", "ep-flash"),
        turn("agent-a", 1_000, 10, {}, "run-1"),
        runSpan("run-2", "ep-unpriced"),
        turn("agent-b", 1_000, 10, {}, "run-2"),
      ],
      {},
      ARK_RATES,
    );
    // A total covering only the priced turns would read as the trace's cost
    // while understating it.
    expect(receipt.cost).toBeNull();
  });

  it("reports nothing rather than zero when no turn carried counters", () => {
    const receipt = buildTokenReceipt([span([event("sandbox_command", { program: "ls" })])]);
    expect(receipt.availability).toBe("unavailable");
    expect(receipt.billedTokens).toBe(0);
  });
});
