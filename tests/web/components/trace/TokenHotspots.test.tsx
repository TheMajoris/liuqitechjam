import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  TokenHotspots,
  addTokens,
  emptyHotspot,
} from "../../../../apps/web/src/components/trace/TokenHotspots";
import type { RunTokenTotals } from "../../../../apps/web/src/types";

function tokens(overrides: Partial<RunTokenTotals> = {}): RunTokenTotals {
  return {
    availability: "available",
    inputTokens: 1_000,
    cachedInputTokens: 500,
    outputTokens: 250,
    totalTokens: 1_750,
    runsReporting: 1,
    runsMissing: 0,
    ...overrides,
  };
}

describe("addTokens", () => {
  it("sums the reported split and counts the run", () => {
    const row = emptyHotspot("agent-1", "Researcher");
    addTokens(row, tokens());
    addTokens(row, tokens({ inputTokens: 200, totalTokens: 950 }));

    expect(row.runs).toBe(2);
    expect(row.inputTokens).toBe(1_200);
    expect(row.totalTokens).toBe(2_700);
    expect(row.runsMissing).toBe(0);
  });

  it("counts a run with no counters as missing rather than as zero spend", () => {
    const row = emptyHotspot("agent-1", "Researcher");
    addTokens(row, tokens({ availability: "unavailable" }));

    expect(row.runs).toBe(1);
    expect(row.runsMissing).toBe(1);
    expect(row.totalTokens).toBe(0);
  });

  it("carries a partial rollup's missing runs through", () => {
    const row = emptyHotspot("agent-1", "Researcher");
    addTokens(row, tokens({ availability: "partial", runsMissing: 3 }));

    expect(row.runsMissing).toBe(3);
    expect(row.totalTokens).toBe(1_750);
  });
});

describe("TokenHotspots", () => {
  it("ranks by spend rather than by the order it was handed", () => {
    const html = renderToStaticMarkup(
      <TokenHotspots
        title="Where the tokens went"
        subject="Agent"
        rows={[
          { ...emptyHotspot("a", "Small"), totalTokens: 100, inputTokens: 100, runs: 1 },
          { ...emptyHotspot("b", "Large"), totalTokens: 9_000, inputTokens: 9_000, runs: 4 },
        ]}
      />,
    );

    expect(html.indexOf("Large")).toBeLessThan(html.indexOf("Small"));
    expect(html).toContain("9.1K tokens");
  });

  it("folds everything past the limit into one row instead of a long tail", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      ...emptyHotspot("row-" + index, "Row " + index),
      totalTokens: 1_000 - index,
      inputTokens: 1_000 - index,
      runs: 1,
    }));
    const html = renderToStaticMarkup(
      <TokenHotspots title="Spend" subject="Agent" rows={rows} limit={4} />,
    );

    expect(html).toContain("5 other Agents");
    expect(html).not.toContain("Row 8<");
  });

  it("says nothing reported rather than showing an empty ranking", () => {
    const html = renderToStaticMarkup(
      <TokenHotspots
        title="Spend"
        subject="Model"
        rows={[emptyHotspot("a", "Unreported")]}
      />,
    );

    expect(html).toContain("No models reported token counters in this view.");
  });
});
