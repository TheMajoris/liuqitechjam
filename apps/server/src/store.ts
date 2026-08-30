import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OrchestrationEventSchema,
  OrchestrationContinuationPromptSchema,
  OrchestrationSessionSchema,
  OrchestrationTurnSchema,
} from "./orchestration/schemas.js";
import { PreviewRecordSchema } from "./preview/preview-types.js";
import {
  ProjectAgentAttachmentSchema,
  ProjectSchema,
  ProjectWriteLeaseSchema,
} from "./projects/project-types.js";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  agentConversations: [],
  messages: [],
  runs: [],
  orchestrations: [],
  orchestrationTurns: [],
  orchestrationEvents: [],
  orchestrationContinuationPrompts: [],
  previews: [],
  projects: [],
  projectAgents: [],
  projectLeases: [],
  approvalRequests: [],
  capabilityGrants: [],
  auditEvents: [],
  permitApprovalCorrelations: [],
  roles: [],
  installedSkills: [],
});

const ORCHESTRATION_COLLECTIONS = [
  "orchestrations",
  "orchestrationTurns",
  "orchestrationEvents",
  "orchestrationContinuationPrompts",
] as const;
const PROJECT_COLLECTIONS = ["projects", "projectAgents", "projectLeases"] as const;
const ACCESS_COLLECTIONS = [
  "approvalRequests",
  "capabilityGrants",
  "auditEvents",
  "permitApprovalCorrelations",
] as const;
const ROLE_COLLECTIONS = ["roles", "installedSkills"] as const;
// Core Agent data, validated by shape like agents/messages/runs rather than
// by a Zod projection, so additive fields survive a round trip.
const AGENT_COLLECTIONS = ["agentConversations"] as const;
const ADDITIVE_COLLECTIONS = [
  ...ORCHESTRATION_COLLECTIONS,
  "previews",
  ...PROJECT_COLLECTIONS,
  ...ACCESS_COLLECTIONS,
  ...ROLE_COLLECTIONS,
  ...AGENT_COLLECTIONS,
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
  for (const collection of ADDITIVE_COLLECTIONS) {
    if (Object.prototype.hasOwnProperty.call(value, collection)) {
      if (!Array.isArray(value[collection])) {
        throw new Error("Unsupported database format");
      }
      normalized[collection] = value[collection];
    } else {
      normalized[collection] = [];
    }
  }

  // Normalize additive records by copying only the missing fields. Keeping
  // the original object shape (including unknown future fields) is important
  // for a forward-compatible JSON store.
  if (Array.isArray(normalized.agents)) {
    normalized.agents = normalized.agents.map((agent) =>
      isRecord(agent) && !Object.prototype.hasOwnProperty.call(agent, "skillIds")
        ? { ...agent, skillIds: [] }
        : agent,
    );
  }
  if (Array.isArray(normalized.projects)) {
    normalized.projects = normalized.projects.map((project) =>
      isRecord(project) && !Object.prototype.hasOwnProperty.call(project, "ownerPrincipalId")
        ? { ...project, ownerPrincipalId: "demo-owner" }
        : project,
    );
  }
  if (Array.isArray(normalized.projectAgents)) {
    normalized.projectAgents = normalized.projectAgents.map((attachment) => {
      if (!isRecord(attachment)) return attachment;
      const next = { ...attachment };
      if (!Object.prototype.hasOwnProperty.call(next, "role")) next.role = "editor";
      if (!Object.prototype.hasOwnProperty.call(next, "toolGrants")) next.toolGrants = [];
      if (!Object.prototype.hasOwnProperty.call(next, "updatedAt")) {
        next.updatedAt = next.attachedAt;
      }
      return next;
    });
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
  const validPreviews = PreviewRecordSchema.array().safeParse(normalized.previews);
  const validProjects = ProjectSchema.array().safeParse(normalized.projects);
  const validProjectAgents = ProjectAgentAttachmentSchema.array().safeParse(
    normalized.projectAgents,
  );
  const validProjectLeases = ProjectWriteLeaseSchema.array().safeParse(
    normalized.projectLeases,
  );
  if (
    !validSessions.success ||
    !validTurns.success ||
    !validEvents.success ||
    !validContinuationPrompts.success ||
    !validPreviews.success ||
    !validProjects.success ||
    !validProjectAgents.success ||
    !validProjectLeases.success
  ) {
    throw new Error("Unsupported database format");
  }

  return normalized as unknown as Database;
}

function needsDatabaseMigration(value: UnknownRecord): boolean {
  if (
    ADDITIVE_COLLECTIONS.some(
    (collection) => !Object.prototype.hasOwnProperty.call(value, collection),
    )
  ) {
    return true;
  }
  const agents = Array.isArray(value.agents) ? value.agents : [];
  if (agents.some((agent) => isRecord(agent) && !("skillIds" in agent))) return true;
  const projects = Array.isArray(value.projects) ? value.projects : [];
  if (projects.some((project) => isRecord(project) && !("ownerPrincipalId" in project))) {
    return true;
  }
  const attachments = Array.isArray(value.projectAgents) ? value.projectAgents : [];
  return attachments.some(
    (attachment) =>
      isRecord(attachment) &&
      (!("role" in attachment) || !("toolGrants" in attachment) || !("updatedAt" in attachment)),
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
      if (isRecord(parsed) && needsDatabaseMigration(parsed)) {
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
