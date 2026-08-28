import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_DB_VERSION,
  type Database,
  type DatabaseV1,
  type DatabaseV2,
} from "./types.js";

export class DatabaseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseFormatError";
  }
}

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
  projects: [],
  orchestrations: [],
  queueJobs: [],
  handoffMessages: [],
  telemetry: [],
  nextQueueSequence: 1,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireArray = (
  source: Record<string, unknown>,
  key: string,
): unknown[] => {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new DatabaseFormatError(
      `Database is missing the required "${key}" array`,
    );
  }
  return value;
};

/** Fill the v2-only collections while preserving every legacy record as-is. */
const upgradeV1ToV2 = (legacy: DatabaseV1): DatabaseV2 => ({
  version: 2,
  agents: legacy.agents,
  messages: legacy.messages,
  runs: legacy.runs,
  projects: [],
  orchestrations: [],
  queueJobs: [],
  handoffMessages: [],
  telemetry: [],
  nextQueueSequence: 1,
});

/**
 * Bring any supported on-disk database up to the current version.
 *
 * Legacy (v1) files are upgraded losslessly: agents, messages, runs, thread
 * IDs, and workspace paths are copied by reference and never rewritten. Any
 * unrecognized or corrupt shape throws {@link DatabaseFormatError}; callers
 * must not persist over the source file in that case.
 */
export const migrateToLatest = (raw: unknown): Database => {
  if (!isRecord(raw)) {
    throw new DatabaseFormatError("Database file is not a JSON object");
  }
  const version = raw.version;

  if (version === 1) {
    const legacy: DatabaseV1 = {
      version: 1,
      agents: requireArray(raw, "agents") as DatabaseV1["agents"],
      messages: requireArray(raw, "messages") as DatabaseV1["messages"],
      runs: requireArray(raw, "runs") as DatabaseV1["runs"],
    };
    return upgradeV1ToV2(legacy);
  }

  if (version === 2) {
    const next: DatabaseV2 = {
      version: 2,
      agents: requireArray(raw, "agents") as DatabaseV2["agents"],
      messages: requireArray(raw, "messages") as DatabaseV2["messages"],
      runs: requireArray(raw, "runs") as DatabaseV2["runs"],
      projects: requireArray(raw, "projects") as DatabaseV2["projects"],
      orchestrations: requireArray(
        raw,
        "orchestrations",
      ) as DatabaseV2["orchestrations"],
      queueJobs: requireArray(raw, "queueJobs") as DatabaseV2["queueJobs"],
      handoffMessages: requireArray(
        raw,
        "handoffMessages",
      ) as DatabaseV2["handoffMessages"],
      telemetry: requireArray(raw, "telemetry") as DatabaseV2["telemetry"],
      nextQueueSequence:
        typeof raw.nextQueueSequence === "number" && raw.nextQueueSequence >= 1
          ? raw.nextQueueSequence
          : 1,
    };
    return next;
  }

  throw new DatabaseFormatError(
    `Unsupported database version ${JSON.stringify(version)}; expected 1 or ${CURRENT_DB_VERSION}`,
  );
};

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new DatabaseFormatError(
        `Database file is not valid JSON: ${(error as Error).message}`,
      );
    }

    const wasVersion = isRecord(parsed) ? parsed.version : undefined;
    // Throws before any write, so a corrupt file is never overwritten.
    this.data = migrateToLatest(parsed);
    if (wasVersion !== CURRENT_DB_VERSION) {
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
