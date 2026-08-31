import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../apps/server/src/store.js";
import type { OrchestrationContinuationPrompt } from "../../apps/server/src/orchestration/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore continuation prompt collection", () => {
  it("migrates a legacy database without dropping existing records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-continuation-store-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [],
        messages: [],
        runs: [],
        orchestrations: [],
        orchestrationTurns: [],
        orchestrationEvents: [],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().orchestrationContinuationPrompts).toEqual([]);
    const persisted = JSON.parse(await readFile(databasePath, "utf8")) as {
      orchestrationContinuationPrompts?: unknown;
    };
    expect(persisted.orchestrationContinuationPrompts).toEqual([]);
  });

  it("round-trips continuation prompts as application-owned records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-continuation-store-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const store = new JsonStore(databasePath);
    await store.initialize();
    const prompt: OrchestrationContinuationPrompt = {
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      cycleIndex: 1,
      prompt: "Continue from the existing team work.",
      createdAt: "2026-08-29T00:00:00.000Z",
    };

    await store.mutate((database) => {
      database.orchestrationContinuationPrompts.push(prompt);
    });

    const reopened = new JsonStore(databasePath);
    await reopened.initialize();
    expect(reopened.snapshot().orchestrationContinuationPrompts).toEqual([prompt]);
  });
});
