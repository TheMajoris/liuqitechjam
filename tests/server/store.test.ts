import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationHealth } from "../../apps/server/src/application-health.js";
import { PostgresStore } from "../../apps/server/src/persistence/postgres-store.js";
import { emptyDatabase, JsonStore } from "../../apps/server/src/store.js";
import type { Database } from "../../apps/server/src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("loads a legacy version-1 database and normalizes absent orchestration arrays", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({ version: 1, agents: [], messages: [], runs: [] }),
      "utf8",
    );
    const store = new JsonStore(databasePath);

    await store.initialize();

    expect(store.snapshot()).toMatchObject({
      version: 1,
      agents: [],
      messages: [],
      runs: [],
      orchestrations: [],
      orchestrationTurns: [],
      orchestrationEvents: [],
    });
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted.orchestrations).toEqual([]);
    expect(persisted.orchestrationTurns).toEqual([]);
    expect(persisted.orchestrationEvents).toEqual([]);
  });

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

describe("PostgresStore failure boundary", () => {
  it("keeps callback rollback healthy and publishes one sanitized fatal transition", async () => {
    const health = new ApplicationHealth();
    const failures: string[] = [];
    health.onStorageFatal((failure) => failures.push(failure.message));
    const store = new PostgresStore("postgres://runtime:secret@example/launchpad");
    store.setFatalHandler(health.handleStorageFailure);

    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    };
    const internals = store as unknown as {
      client: typeof client | null;
      data: Database | null;
    };
    internals.client = client;
    internals.data = emptyDatabase();

    await expect(
      store.mutate(() => {
        throw new Error("ordinary validation rollback");
      }),
    ).rejects.toThrow("ordinary validation rollback");
    expect(health.isHealthy()).toBe(true);
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "ROLLBACK");

    const failClosed = (store as unknown as { failClosed(error: unknown): void }).failClosed;
    failClosed.call(store, new Error("postgres://runtime:secret@example/launchpad"));
    failClosed.call(store, new Error("second fatal error"));
    expect(health.isHealthy()).toBe(false);
    expect(failures).toEqual(["Persistent storage is unavailable"]);
    expect(failures.join(" ")).not.toContain("secret");
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
