import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OrchestrationEventSchema,
  OrchestrationContinuationPromptSchema,
  OrchestrationSessionSchema,
  OrchestrationTurnSchema,
} from "./orchestration/schemas.js";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  orchestrations: [],
  orchestrationTurns: [],
  orchestrationEvents: [],
  orchestrationContinuationPrompts: [],
});

const ORCHESTRATION_COLLECTIONS = [
  "orchestrations",
  "orchestrationTurns",
  "orchestrationEvents",
  "orchestrationContinuationPrompts",
] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the additive version-1 shape without hiding malformed data.
 * Orchestration collections were added after the original database format;
 * only those absent fields receive an empty-array default.
 */
function normalizeDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Unsupported database format");
  }
  if (
    !Array.isArray(value.agents) ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error("Unsupported database format");
  }

  const normalized: UnknownRecord = { ...value };
  for (const collection of ORCHESTRATION_COLLECTIONS) {
    if (Object.prototype.hasOwnProperty.call(value, collection)) {
      if (!Array.isArray(value[collection])) {
        throw new Error("Unsupported database format");
      }
      normalized[collection] = value[collection];
    } else {
      normalized[collection] = [];
    }
  }

  // Validate records without replacing them with Zod's parsed projection.
  // That keeps additive/unknown fields intact while preventing malformed
  // orchestration data from entering the in-memory store.
  const validSessions = OrchestrationSessionSchema.array().safeParse(
    normalized.orchestrations,
  );
  const validTurns = OrchestrationTurnSchema.array().safeParse(
    normalized.orchestrationTurns,
  );
  const validEvents = OrchestrationEventSchema.array().safeParse(
    normalized.orchestrationEvents,
  );
  const validContinuationPrompts = OrchestrationContinuationPromptSchema.array().safeParse(
    normalized.orchestrationContinuationPrompts,
  );
  if (
    !validSessions.success ||
    !validTurns.success ||
    !validEvents.success ||
    !validContinuationPrompts.success
  ) {
    throw new Error("Unsupported database format");
  }

  return normalized as unknown as Database;
}

function needsOrchestrationMigration(value: UnknownRecord): boolean {
  return ORCHESTRATION_COLLECTIONS.some(
    (collection) => !Object.prototype.hasOwnProperty.call(value, collection),
  );
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const normalized = normalizeDatabase(parsed);
      if (isRecord(parsed) && needsOrchestrationMigration(parsed)) {
        await this.persist(normalized);
      }
      this.data = normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
