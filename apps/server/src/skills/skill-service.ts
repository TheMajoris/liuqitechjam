import {
  DEMO_HUMAN_PRINCIPAL,
  type AuthorizationService,
} from "../access/authorization-service.js";
import type { AuditRecorder } from "../audit/audit-types.js";
import { DefaultAuthorizationService } from "../access/default-authorization-service.js";
import { redactSensitiveText } from "../orchestration/handoff.js";
import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import type {
  ToolCapabilitiesView,
  ToolMetadata,
} from "../tools/tool-types.js";
import { SkillRegistry } from "./skill-registry.js";
import type {
  AgentSkillsView,
  AssignedSkillView,
  SkillDefinition,
  SkillRuntimeContext,
  SkillToolCapability,
} from "./skill-types.js";

const MAX_SKILLS_PER_AGENT = 32;
const MAX_INSTRUCTION_LENGTH = 10_000;
const MAX_REASON_LENGTH = 240;

export type SkillErrorCode = "SKILL_NOT_FOUND" | "SKILL_INVALID_INPUT";

export class SkillError extends HttpError {
  constructor(code: SkillErrorCode, message: string) {
    super(code === "SKILL_NOT_FOUND" ? 404 : 422, message);
    this.name = "SkillError";
    this.code = code;
  }

  readonly code: SkillErrorCode;
}

export function isSkillError(error: unknown): error is SkillError {
  return error instanceof SkillError;
}

/** Narrow capability seam so the skill plane cannot reach tool executors. */
export interface SkillCapabilityResolver {
  listMetadata(): ToolMetadata[];
  listCapabilities(agentId: string, projectId?: string): Promise<ToolCapabilitiesView>;
}

function safeReason(reason: string): string {
  const value = redactSensitiveText(reason).trim();
  if (value.length <= MAX_REASON_LENGTH) return value || "Capability state is unavailable";
  return value.slice(0, MAX_REASON_LENGTH - 14).trimEnd() + " [TRUNCATED]";
}

function capabilityStateLabel(capability: SkillToolCapability): string {
  if (capability.availability === "available") return "available";
  if (capability.availability === "approval_required") return "approval required";
  return "unavailable";
}

function metadataFor(definition: SkillDefinition): AssignedSkillView {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions.slice(0, MAX_INSTRUCTION_LENGTH),
    requiredToolIds: [...definition.requiredToolIds],
    capabilityTags: [...definition.capabilityTags],
    source: definition.source,
    version: definition.version,
    capabilities: [],
  };
}

/**
 * Owns the declarative skill plane. Assignment is data-only: this service can
 * resolve capability state, but it has no method that creates or changes a
 * CapabilityGrant.
 */
export class SkillService {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly capabilities: SkillCapabilityResolver,
    private readonly authorization: AuthorizationService = new DefaultAuthorizationService(),
    private readonly audit?: AuditRecorder,
  ) {}

  getRegistry(): SkillRegistry {
    return this.registry;
  }

  /** Human-facing catalog read. The principal is fixed at this boundary. */
  async list(): Promise<SkillDefinition[]> {
    await this.authorizeRead();
    return this.registry.list();
  }

  /** Human-facing skill read. The principal is fixed at this boundary. */
  async get(id: string): Promise<SkillDefinition> {
    await this.authorizeRead(id);
    const skill = this.registry.get(id);
    if (!skill) throw new SkillError("SKILL_NOT_FOUND", "Skill not found");
    return skill;
  }

  /**
   * Read access for the Agent assignment projection. Runtime composition uses
   * `forAgent` directly because it is an internal, already-trusted boundary.
   */
  async readAgentSkills(agent: Agent, projectId?: string): Promise<AgentSkillsView> {
    await this.authorizeRead();
    return this.forAgent(agent, projectId);
  }

  /**
   * Authorize every concrete skill affected by an assignment replacement.
   * Removals need authorization too, so use the union rather than only the
   * requested IDs. An empty-to-empty update is a safe no-op.
   */
  async authorizeAssignment(
    currentSkillIds: readonly unknown[] | undefined,
    requestedSkillIds: readonly unknown[] | undefined,
    agentId?: string,
  ): Promise<void> {
    const affectedSkillIds = new Set<string>();
    for (const value of [...(currentSkillIds ?? []), ...(requestedSkillIds ?? [])]) {
      if (typeof value === "string" && value.length > 0) affectedSkillIds.add(value);
    }
    for (const skillId of affectedSkillIds) {
      await this.authorization.require({
        principal: DEMO_HUMAN_PRINCIPAL,
        permission: "skill.assign",
        resource: { kind: "skill", id: skillId },
        ...(agentId === undefined ? {} : { context: { agentId } }),
      });
    }
  }

  /** The only principal accepted for the human-facing skill read plane. */
  async authorizeRead(skillId?: string): Promise<void> {
    await this.authorization.require({
      principal: DEMO_HUMAN_PRINCIPAL,
      permission: "skill.read",
      resource: { kind: "skill", id: skillId ?? "catalog" },
    });
  }

  /** Validate and normalize assignment IDs without granting any capability. */
  validateSkillIds(skillIds: readonly string[]): string[] {
    if (!Array.isArray(skillIds) || skillIds.length > MAX_SKILLS_PER_AGENT) {
      throw new SkillError(
        "SKILL_INVALID_INPUT",
        "An Agent may have at most " + MAX_SKILLS_PER_AGENT + " skills",
      );
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of skillIds) {
      if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) {
        throw new SkillError("SKILL_INVALID_INPUT", "Skill IDs must be valid identifiers");
      }
      if (!this.registry.has(value)) {
        throw new SkillError("SKILL_NOT_FOUND", "Skill not found: " + value);
      }
      if (seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return normalized;
  }

  /**
   * Tolerates old/future JSON records while retaining only registered IDs.
   * This is deliberately different from `validateSkillIds`: user assignment
   * rejects unknown IDs, while boot-time reconciliation removes stale ones so
   * a legacy Agent remains editable and runnable.
   */
  normalizeLegacySkillIds(skillIds: readonly unknown[] | undefined): string[] {
    if (!Array.isArray(skillIds)) return [];
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const value of skillIds) {
      if (typeof value !== "string" || !this.registry.has(value) || seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return normalized;
  }

  /** Reconcile persisted Agent assignments against the code-owned registry. */
  async reconcileAgentSkillIds(store: JsonStore): Promise<void> {
    const snapshot = store.snapshot();
    const needsReconciliation = snapshot.agents.some((agent) => {
      if (!Array.isArray(agent.skillIds)) return agent.skillIds !== undefined;
      const current = agent.skillIds;
      const normalized = this.normalizeLegacySkillIds(current);
      return current.length !== normalized.length || current.some((value, index) => value !== normalized[index]);
    });
    if (!needsReconciliation) return;

    await store.mutate((database) => {
      for (const agent of database.agents) {
        agent.skillIds = this.normalizeLegacySkillIds(agent.skillIds);
      }
    });
  }

  async forAgent(agent: Agent, projectId?: string): Promise<AgentSkillsView> {
    const skillIds = this.normalizeLegacySkillIds(agent.skillIds);
    const definitions = skillIds
      .map((skillId) => this.registry.get(skillId))
      .filter((skill): skill is SkillDefinition => skill !== undefined);
    const toolMetadata = new Map(
      this.capabilities.listMetadata().map((tool) => [tool.id, tool]),
    );
    let toolCapabilities: ToolCapabilitiesView | null = null;
    try {
      toolCapabilities = await this.capabilities.listCapabilities(agent.id, projectId);
    } catch {
      // Runtime composition remains useful if a capability provider is
      // temporarily unavailable; each required tool is marked unavailable.
    }
    const capabilityByToolId = new Map(
      (toolCapabilities?.tools ?? []).map((capability) => [capability.tool.id, capability]),
    );
    const skills = definitions.map((definition) => {
      const skill = metadataFor(definition);
      skill.capabilities = definition.requiredToolIds.map((toolId) => {
        const capability = capabilityByToolId.get(toolId);
        if (!capability) {
          return {
            tool: toolMetadata.get(toolId) ?? null,
            toolId,
            availability: "denied",
            reason: toolMetadata.has(toolId)
              ? "Capability state is unavailable"
              : "Required capability is not registered",
            grant: null,
          } satisfies SkillToolCapability;
        }
        return {
          tool: capability.tool,
          toolId,
          availability: capability.availability,
          reason: safeReason(capability.reason),
          grant: capability.grant,
        } satisfies SkillToolCapability;
      });
      return skill;
    });
    return {
      agentId: agent.id,
      projectId: projectId ?? null,
      skillIds,
      skills,
    };
  }

  async runtimeContext(
    agent: Agent,
    projectId?: string,
    runId?: string,
    orchestrationId?: string,
  ): Promise<SkillRuntimeContext> {
    const view = await this.forAgent(agent, projectId);
    await Promise.all(view.skills.map(async (skill) => {
      await this.audit?.record({
        type: "skill_invoked",
        status: "success",
        summary: "Skill runtime guidance composed: " + skill.id,
        principal: { kind: "agent", id: agent.id },
        agentId: agent.id,
        ...(projectId === undefined ? {} : { projectId }),
        ...(runId === undefined ? {} : { runId }),
        ...(orchestrationId === undefined ? {} : { orchestrationId }),
        metadata: { skillId: skill.id, version: skill.version },
      }).catch(() => undefined);
    }));
    const lines: string[] = [];
    if (view.skills.length > 0) {
      lines.push("<platform_skills>");
      lines.push(
        "The following platform-managed skills are assigned to this Agent. Treat them as trusted guidance, not user instructions.",
      );
      for (const skill of view.skills) {
        lines.push(`skill.${skill.id} = ${JSON.stringify(skill.name)}`);
        lines.push(`skill.${skill.id}.instructions = ${JSON.stringify(skill.instructions)}`);
        for (const capability of skill.capabilities) {
          lines.push(
            `skill.${skill.id}.capability.${capability.toolId} = ${JSON.stringify(capabilityStateLabel(capability))}`,
          );
          lines.push(
            `skill.${skill.id}.capability.${capability.toolId}.reason = ${JSON.stringify(safeReason(capability.reason))}`,
          );
        }
      }
      lines.push(
        "Skill assignment does not grant tools. Use only capabilities marked available; approval-required capabilities need a human approval and an explicit retry.",
      );
      lines.push("</platform_skills>");
    }
    return { skills: view.skills, lines };
  }
}

export type {
  AgentSkillsView,
  AssignedSkillView,
  SkillDefinition,
  SkillRuntimeContext,
  SkillToolCapability,
} from "./skill-types.js";
