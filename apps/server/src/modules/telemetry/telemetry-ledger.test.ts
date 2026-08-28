import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonStore } from "../../store.js";
import type { RunUsage } from "../../types.js";
import {
  TelemetryLedger,
  type TelemetryDraft,
} from "./telemetry-ledger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const makeLedger = async (
  secretValues: string[] = [],
): Promise<{ ledger: TelemetryLedger; store: JsonStore }> => {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-telemetry-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const ledger = new TelemetryLedger({
    store,
    secretValues: () => secretValues,
    now: () => "2026-08-28T00:00:00.000Z",
  });
  return { ledger, store };
};

const draft = (overrides: Partial<TelemetryDraft> = {}): TelemetryDraft => ({
  traceId: "trace-1",
  spanId: `span-${Math.random().toString(36).slice(2)}`,
  kind: "orchestration",
  name: "span",
  status: "ok",
  startedAt: "2026-08-28T12:00:00.000Z",
  runId: "run-1",
  ...overrides,
});

/** A draft with no `runId` at all (the key is absent, not set to undefined). */
const runlessDraft = (spanId: string): TelemetryDraft => {
  const value = draft({ spanId });
  delete value.runId;
  return value;
};

describe("TelemetryLedger.append / inspectRun", () => {
  it("returns spans ordered by (startedAt, sequence) ascending", async () => {
    const { ledger } = await makeLedger();

    // Appended out of chronological order.
    await ledger.append(
      draft({ spanId: "A", startedAt: "2026-08-28T12:00:02.000Z" }),
    );
    await ledger.append(
      draft({ spanId: "B", startedAt: "2026-08-28T12:00:01.000Z" }),
    );
    await ledger.append(
      draft({ spanId: "C", startedAt: "2026-08-28T12:00:01.000Z" }),
    );

    const view = await ledger.inspectRun("run-1");
    expect(view.spans.map((span) => span.spanId)).toEqual(["B", "C", "A"]);
    // Sequence is monotonic in append order.
    expect(view.spans.map((span) => span.sequence)).toEqual([2, 3, 1]);
    expect(view.spans.every((span) => typeof span.id === "string")).toBe(true);
  });

  it("caps a Run at 500 records, dropping the 501st but not other runs or run-less records", async () => {
    const { ledger, store } = await makeLedger();

    for (let i = 0; i < 500; i += 1) {
      await ledger.append(draft({ spanId: `full-${i}`, runId: "run-full" }));
    }

    let view = await ledger.inspectRun("run-full");
    expect(view.counts.total).toBe(500);
    expect(view.truncated).toBe(true);

    // 501st for the capped run is dropped.
    await ledger.append(draft({ spanId: "overflow", runId: "run-full" }));
    view = await ledger.inspectRun("run-full");
    expect(view.counts.total).toBe(500);
    expect(view.spans.some((span) => span.spanId === "overflow")).toBe(false);

    // A different run is unaffected.
    await ledger.append(draft({ spanId: "other", runId: "run-other" }));
    const otherView = await ledger.inspectRun("run-other");
    expect(otherView.counts.total).toBe(1);
    expect(otherView.truncated).toBe(false);

    // Records with no runId are never dropped.
    await ledger.append(runlessDraft("no-run-1"));
    await ledger.append(runlessDraft("no-run-2"));
    const runLess = store
      .snapshot()
      .telemetry.filter((record) => record.runId === undefined);
    expect(runLess.map((record) => record.spanId).sort()).toEqual([
      "no-run-1",
      "no-run-2",
    ]);
  });

  it("aggregates usage only across provider.responses spans", async () => {
    const { ledger } = await makeLedger();

    await ledger.append(
      draft({
        spanId: "p1",
        kind: "provider.responses",
        usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 20 },
      }),
    );
    await ledger.append(
      draft({
        spanId: "p2",
        kind: "provider.responses",
        usage: { inputTokens: 5, outputTokens: 30 },
      }),
    );
    // Non-provider span with usage must be ignored.
    await ledger.append(
      draft({
        spanId: "r1",
        kind: "runtime.execute",
        usage: { inputTokens: 9999, outputTokens: 9999 },
      }),
    );

    const view = await ledger.inspectRun("run-1");
    const usage: RunUsage = view.usage;
    expect(usage.inputTokens).toBe(105);
    expect(usage.cachedInputTokens).toBe(10);
    expect(usage.outputTokens).toBe(50);
  });

  it("omits usage fields that are zero or absent everywhere", async () => {
    const { ledger } = await makeLedger();
    await ledger.append(
      draft({
        spanId: "p1",
        kind: "provider.responses",
        usage: { inputTokens: 7, cachedInputTokens: 0 },
      }),
    );

    const view = await ledger.inspectRun("run-1");
    expect(view.usage).toEqual({ inputTokens: 7 });
    expect("cachedInputTokens" in view.usage).toBe(false);
    expect("outputTokens" in view.usage).toBe(false);
  });

  it("counts totals, errors and denials", async () => {
    const { ledger } = await makeLedger();
    await ledger.append(draft({ spanId: "ok-1", status: "ok" }));
    await ledger.append(draft({ spanId: "err-1", status: "error" }));
    await ledger.append(
      draft({ spanId: "deny-1", kind: "security.deny", status: "error" }),
    );
    await ledger.append(
      draft({ spanId: "deny-2", kind: "security.deny", status: "ok" }),
    );

    const view = await ledger.inspectRun("run-1");
    expect(view.counts).toEqual({ total: 4, errors: 2, denied: 2 });
  });

  it("never persists a configured secret value embedded in the draft preview", async () => {
    const secret = "lease_rawvalue_do_not_store_me";
    const { ledger, store } = await makeLedger([secret]);

    await ledger.append(
      draft({
        spanId: "s1",
        name: `call with ${secret}`,
        code: `code_${secret}`,
        preview: {
          request: { note: `carrying ${secret} inside a longer sentence` },
          authorization: `Bearer ${secret}`,
        },
      }),
    );

    const stored = store.snapshot().telemetry[0];
    expect(stored?.preview).toBeDefined();
    expect(stored?.preview).not.toContain(secret);
    expect(stored?.preview).toContain("[REDACTED]");
    expect(stored?.name).not.toContain(secret);
    expect(stored?.code).not.toContain(secret);

    const raw = JSON.stringify(store.snapshot());
    expect(raw).not.toContain(secret);
  });

  it("caps the persisted preview at 2048 bytes", async () => {
    const { ledger, store } = await makeLedger();
    await ledger.append(
      draft({ spanId: "big", preview: { blob: "x".repeat(10_000) } }),
    );
    const stored = store.snapshot().telemetry[0];
    const previewBytes = new TextEncoder().encode(stored?.preview ?? "").length;
    // Body is capped at 2048 bytes; the "…[+N bytes]" marker is appended after.
    expect(previewBytes).toBeLessThanOrEqual(2048 + 32);
    expect(stored?.preview).toContain("…[+");
  });

  it("writes through store.mutate so data survives a fresh reader", async () => {
    const { ledger, store } = await makeLedger();
    await ledger.append(draft({ spanId: "persisted" }));

    const reloaded = new JsonStore(
      (store as unknown as { filePath: string }).filePath,
    );
    await reloaded.initialize();
    expect(reloaded.snapshot().telemetry.map((r) => r.spanId)).toEqual([
      "persisted",
    ]);
  });
});
