import { describe, expect, it } from "vitest";
import { summarizeRunTokens } from "../../../apps/server/src/telemetry/telemetry-usage.js";

describe("summarizeRunTokens", () => {
  it("reports nothing as unavailable rather than as zero", () => {
    expect(summarizeRunTokens([])).toMatchObject({
      availability: "unavailable",
      totalTokens: 0,
      runsReporting: 0,
    });
    expect(summarizeRunTokens([null, undefined])).toMatchObject({
      availability: "unavailable",
      runsReporting: 0,
      runsMissing: 2,
    });
  });

  it("marks a complete set of counters available", () => {
    expect(
      summarizeRunTokens([
        { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
      ]),
    ).toMatchObject({
      availability: "available",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      totalTokens: 120,
      runsReporting: 1,
      runsMissing: 0,
    });
  });

  it("never double-counts cached input inside the total", () => {
    // Cached input is a subset of input, so adding it would inflate the total.
    const totals = summarizeRunTokens([
      { inputTokens: 100, cachedInputTokens: 90, outputTokens: 10 },
    ]);
    expect(totals.totalTokens).toBe(110);
  });

  it("degrades to partial when any Run reported an incomplete set", () => {
    expect(
      summarizeRunTokens([
        { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
        { inputTokens: 7 },
      ]),
    ).toMatchObject({
      availability: "partial",
      inputTokens: 17,
      outputTokens: 5,
      runsReporting: 2,
      runsMissing: 0,
    });
  });

  it("degrades to partial when some Runs reported nothing at all", () => {
    expect(
      summarizeRunTokens([
        { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
        null,
      ]),
    ).toMatchObject({
      availability: "partial",
      totalTokens: 15,
      runsReporting: 1,
      runsMissing: 1,
    });
  });

  it("ignores counters that are negative or not safe integers", () => {
    expect(
      summarizeRunTokens([
        { inputTokens: -5, cachedInputTokens: 1.5, outputTokens: 8 },
      ]),
    ).toMatchObject({
      availability: "partial",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 8,
      totalTokens: 8,
    });
  });
});

describe("net-new tokens", () => {
  // Runs resume a Codex thread, so every turn re-sends the conversation so far
  // and reports it as input. Measured from a live 3-turn probe on one thread:
  // input rose 21391 -> 28008 -> 34633 while each turn only added ~6.6K.
  it("counts the re-sent prefix once instead of once per turn", () => {
    const totals = summarizeRunTokens([
      { inputTokens: 21_391, cachedInputTokens: 12_032, outputTokens: 5 },
      { inputTokens: 28_008, cachedInputTokens: 12_032, outputTokens: 5 },
      { inputTokens: 34_633, cachedInputTokens: 21_248, outputTokens: 5 },
    ]);

    expect(totals.inputTokens).toBe(84_032);
    expect(totals.netNewInputTokens).toBe(38_720);
    expect(totals.netNewTokens).toBe(38_735);
    // The billed figure is still reported; it is just no longer the headline.
    expect(totals.totalTokens).toBe(84_047);
  });

  it("clamps per Run so one bad cache counter cannot eat another Run's input", () => {
    const totals = summarizeRunTokens([
      { inputTokens: 100, cachedInputTokens: 400, outputTokens: 0 },
      { inputTokens: 500, cachedInputTokens: 0, outputTokens: 0 },
    ]);

    expect(totals.netNewInputTokens).toBe(500);
  });

  it("reports nothing rather than zero work when no Run reported counters", () => {
    expect(summarizeRunTokens([])).toMatchObject({
      availability: "unavailable",
      netNewInputTokens: 0,
      netNewTokens: 0,
    });
  });
});
