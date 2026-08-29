import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";
import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationTurn,
} from "./orchestration/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("keeps legacy Agents without modelRef loadable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Legacy",
            description: "Old Agent",
            instructions: "Keep working.",
            status: "ready",
            workspacePath: "/tmp/legacy-workspace",
            codexThreadId: "legacy-thread",
            lastError: null,
            createdAt: "2026-08-28T00:00:00.000Z",
            updatedAt: "2026-08-28T00:00:01.000Z",
          },
        ],
        messages: [],
        runs: [],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();
    const legacy = store.snapshot().agents[0];
    expect(legacy?.name).toBe("Legacy");
    expect(legacy).not.toHaveProperty("modelRef");
  });

  it("creates empty orchestration collections for a new database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));

    await store.initialize();

    expect(store.snapshot()).toMatchObject({
      version: 1,
      orchestrations: [],
      orchestrationTurns: [],
      orchestrationEvents: [],
    });
  });

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

  it("rejects malformed orchestration collections instead of dropping them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [],
        orchestrations: { not: "an array" },
      }),
      "utf8",
    );
    const store = new JsonStore(databasePath);

    await expect(store.initialize()).rejects.toThrow("Unsupported database format");
  });

  it("rejects malformed orchestration records instead of casting them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [],
        orchestrations: [{ id: "not-a-session" }],
        orchestrationTurns: [],
        orchestrationEvents: [],
      }),
      "utf8",
    );
    const store = new JsonStore(databasePath);

    await expect(store.initialize()).rejects.toThrow("Unsupported database format");
  });

  it("preserves rejection of unsupported legacy envelopes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({ version: 2, agents: [], messages: [], runs: [] }),
      "utf8",
    );

    await expect(new JsonStore(databasePath).initialize()).rejects.toThrow(
      "Unsupported database format",
    );
  });

  it("round-trips sessions, turns, and ordered events through a reopened store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const store = new JsonStore(databasePath);
    await store.initialize();

    const session: OrchestrationSession = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Pipeline",
      originalPrompt: "Improve the product.",
      participants: [
        {
          id: "planner",
          agentId: "22222222-2222-4222-8222-222222222222",
          role: "Planner",
          position: 0,
        },
      ],
      status: "completed",
      currentParticipantId: null,
      currentRunId: null,
      stepIndex: 1,
      maxSteps: 1,
      perAgentTimeoutMs: 1_000,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:00:01.000Z",
    };
    const turn: OrchestrationTurn = {
      id: "33333333-3333-4333-8333-333333333333",
      sessionId: session.id,
      participantId: "planner",
      agentId: session.participants[0]!.agentId,
      runId: "44444444-4444-4444-8444-444444444444",
      position: 0,
      status: "completed",
      safeInputSummary: "Plan the work",
      safeOutput: "Plan complete",
      outputTruncated: false,
      errorCode: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      completedAt: "2026-08-28T00:00:01.000Z",
    };
    const events: OrchestrationEvent[] = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        sessionId: session.id,
        sequence: 0,
        type: "orchestration_started",
        status: "running",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        sessionId: session.id,
        sequence: 1,
        type: "orchestration_completed",
        status: "completed",
        safeSummary: "Pipeline completed",
        createdAt: "2026-08-28T00:00:01.000Z",
      },
    ];

    await store.mutate((database) => {
      database.orchestrations.push(session);
      database.orchestrationTurns.push(turn);
      database.orchestrationEvents.push(...events);
    });

    const reopened = new JsonStore(databasePath);
    await reopened.initialize();
    const snapshot = reopened.snapshot();
    expect(snapshot.orchestrations).toEqual([session]);
    expect(snapshot.orchestrationTurns).toEqual([turn]);
    expect(snapshot.orchestrationEvents).toEqual(events);
    expect(snapshot.orchestrationEvents.map((event) => event.sequence)).toEqual([0, 1]);
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
