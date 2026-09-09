import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyDatabase, JsonStore, normalizeDatabase } from "../../../apps/server/src/store.js";
import {
  toWorkspaceCheckpointView,
  WorkspaceCheckpointSchema,
  type WorkspaceCheckpoint,
} from "../../../apps/server/src/projects/workspace-checkpoint-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checkpoint(overrides: Partial<WorkspaceCheckpoint> = {}): WorkspaceCheckpoint {
  return {
    id: "cp-1",
    projectId: "project-1",
    ordinal: 1,
    kind: "baseline",
    state: "preparing",
    operationId: "op-1",
    workspaceEpoch: 0,
    executionCycleId: "cycle-1",
    orchestrationId: "session-1",
    turnId: null,
    runId: null,
    agentId: null,
    participantId: null,
    stepIndex: null,
    parentCheckpointId: null,
    policyVersion: "source-v1",
    gitSha: null,
    treeSha: null,
    manifestHash: null,
    fileCount: 0,
    byteCount: 0,
    excludedFileCount: 0,
    resume: null,
    errorCode: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    readyAt: null,
    ...overrides,
  };
}

describe("workspace checkpoint records", () => {
  it("loads an older JSON database without the new collections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lqam-cp-records-"));
    roots.push(root);
    const databasePath = path.join(root, "db.json");
    const legacy = { ...emptyDatabase() } as Record<string, unknown>;
    delete legacy.workspaceCheckpoints;
    delete legacy.workspaceExecutionCycles;
    delete legacy.workspaceOperations;
    await writeFile(databasePath, JSON.stringify(legacy), "utf8");
    const store = new JsonStore(databasePath);
    await store.initialize();
    expect(store.snapshot().workspaceCheckpoints).toEqual([]);
    expect(store.snapshot().workspaceExecutionCycles).toEqual([]);
    expect(store.snapshot().workspaceOperations).toEqual([]);
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as Record<string, unknown>;
    expect(persisted.workspaceOperations).toEqual([]);
  });

  it("refuses a present but malformed checkpoint collection instead of emptying it", () => {
    const malformed = { ...emptyDatabase(), workspaceCheckpoints: [{ id: "x", state: "ready" }] };
    expect(() => normalizeDatabase(malformed)).toThrow("Unsupported database format");
    const notArray = { ...emptyDatabase(), workspaceOperations: {} };
    expect(() => normalizeDatabase(notArray)).toThrow("Unsupported database format");
  });

  it("rejects a ready record without its physical identity or continuation", () => {
    expect(WorkspaceCheckpointSchema.safeParse(checkpoint()).success).toBe(true);
    expect(
      WorkspaceCheckpointSchema.safeParse(checkpoint({ state: "ready", kind: "turn_success" })).success,
    ).toBe(false);
    const captured = checkpoint({
      state: "captured",
      kind: "turn_success",
      gitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      manifestHash: "c".repeat(64),
    });
    expect(WorkspaceCheckpointSchema.safeParse(captured).success).toBe(true);
    expect(WorkspaceCheckpointSchema.safeParse({ ...captured, state: "ready" }).success).toBe(false);
  });

  it("projects a public view without private metadata", () => {
    const record = checkpoint({
      state: "ready",
      kind: "safety",
      gitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      manifestHash: "c".repeat(64),
      readyAt: "2026-09-01T00:00:01.000Z",
    });
    const view = toWorkspaceCheckpointView(record, { recoverable: false });
    expect(Object.keys(view).sort()).toEqual([
      "byteCount", "checkpointId", "createdAt", "excludedFileCount", "fileCount", "kind",
      "orchestrationId", "ordinal", "projectId", "recoverable", "runId", "state", "stepIndex",
      "turnId", "unavailableReason",
    ]);
    expect(JSON.stringify(view)).not.toMatch(/aaaa|bbbb|cccc|resume|operationId/u);
  });
});
