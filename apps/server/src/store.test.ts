import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseFormatError, JsonStore, migrateToLatest } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
  temporaryDirectories.push(root);
  return root;
};

const v1Fixture = () => ({
  version: 1 as const,
  agents: [
    {
      id: "agent-1",
      name: "Legacy Agent",
      description: "",
      instructions: "be helpful",
      status: "ready" as const,
      workspacePath: "/workspaces/agent-1",
      codexThreadId: "thread-abc-123",
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  messages: [
    {
      id: "message-1",
      agentId: "agent-1",
      runId: "run-1",
      role: "user" as const,
      content: "hello",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  runs: [
    {
      id: "run-1",
      agentId: "agent-1",
      status: "completed" as const,
      prompt: "hello",
      output: "hi there",
      error: null,
      usage: { inputTokens: 3, outputTokens: 2 },
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ],
});

describe("migrateToLatest", () => {
  it("upgrades a v1 database to v2 without altering legacy records", () => {
    const legacy = v1Fixture();
    const migrated = migrateToLatest(structuredClone(legacy));

    expect(migrated.version).toBe(2);
    expect(migrated.agents).toEqual(legacy.agents);
    expect(migrated.messages).toEqual(legacy.messages);
    expect(migrated.runs).toEqual(legacy.runs);
    expect(migrated.agents[0]?.codexThreadId).toBe("thread-abc-123");
    expect(migrated.agents[0]?.workspacePath).toBe("/workspaces/agent-1");
    expect(migrated.projects).toEqual([]);
    expect(migrated.orchestrations).toEqual([]);
    expect(migrated.queueJobs).toEqual([]);
    expect(migrated.handoffMessages).toEqual([]);
    expect(migrated.telemetry).toEqual([]);
    expect(migrated.nextQueueSequence).toBe(1);
  });

  it("is deterministic across repeated runs", () => {
    const legacy = v1Fixture();
    expect(migrateToLatest(structuredClone(legacy))).toEqual(
      migrateToLatest(structuredClone(legacy)),
    );
  });

  it("passes a well-formed v2 database through unchanged", () => {
    const v2 = { ...migrateToLatest(v1Fixture()), nextQueueSequence: 7 };
    expect(migrateToLatest(structuredClone(v2))).toEqual(v2);
  });

  it("rejects an unknown version", () => {
    expect(() => migrateToLatest({ version: 99, agents: [] })).toThrow(
      DatabaseFormatError,
    );
  });

  it("rejects a v1 database with a missing collection", () => {
    expect(() =>
      migrateToLatest({ version: 1, agents: [], messages: [] }),
    ).toThrow(/runs/);
  });

  it("rejects a non-object payload", () => {
    expect(() => migrateToLatest("not a database")).toThrow(DatabaseFormatError);
  });
});

describe("JsonStore.initialize", () => {
  it("creates an empty v2 database when no file exists", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "db.json");
    const store = new JsonStore(filePath);
    await store.initialize();

    const snapshot = store.snapshot();
    expect(snapshot.version).toBe(2);
    expect(snapshot.nextQueueSequence).toBe(1);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.version).toBe(2);
  });

  it("migrates an on-disk v1 file and rewrites it as v2", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "db.json");
    await writeFile(filePath, JSON.stringify(v1Fixture(), null, 2));

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot().agents[0]?.codexThreadId).toBe("thread-abc-123");
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.version).toBe(2);
    expect(persisted.agents).toHaveLength(1);
    expect(persisted.queueJobs).toEqual([]);
  });

  it("refuses a corrupt file and leaves it untouched", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "db.json");
    const corrupt = '{ "version": 3, "agents": [] }';
    await writeFile(filePath, corrupt);

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow(DatabaseFormatError);
    expect(await readFile(filePath, "utf8")).toBe(corrupt);
  });

  it("refuses an invalid-JSON file and leaves it untouched", async () => {
    const root = await makeRoot();
    const filePath = path.join(root, "db.json");
    const corrupt = "{ not json";
    await writeFile(filePath, corrupt);

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow(DatabaseFormatError);
    expect(await readFile(filePath, "utf8")).toBe(corrupt);
  });
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
