import type { AgentRole } from "../roles/role-types.js";
import type { SkillDefinition } from "../skills/skill-types.js";
import type {
  ToolCapabilitiesView,
  ToolCapabilityView,
  ToolDefinition,
} from "./tool-types.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * The discovery resolver is deliberately narrower than ToolService. It only
 * decides which registered definitions may be advertised; execution remains
 * subject to the live ToolService authorization checks.
 */
export interface EffectiveToolResolverInput {
  /** A ToolRegistry preserves its own deterministic order; arrays preserve the supplied order. */
  registry: ToolRegistry | readonly ToolDefinition<unknown, unknown>[];
  /** Omitted means no explicit role. `null` is an explicit empty role. */
  effectiveRole?: Pick<AgentRole, "toolIds"> | null;
  assignedSkills: readonly Pick<SkillDefinition, "requiredToolIds">[];
  /** Capability state is supplied once for the run; the resolver never fetches it. */
  capabilities: ToolCapabilitiesView | readonly ToolCapabilityView[];
  /** Safe rollback: preserve the historical full-registry advertisement. */
  legacyFullAdvertisement?: boolean;
}

export type EffectiveToolResolutionStatus = "scoped" | "legacy-full" | "failed";

export interface EffectiveToolResolutionDiagnostics {
  status: EffectiveToolResolutionStatus;
  configuredCatalogueSize: number;
  advertisedToolCount: number;
  reason?: string;
}

export type EffectiveToolResolution =
  | {
      ok: true;
      advertisedToolIds: readonly string[];
      diagnostics: EffectiveToolResolutionDiagnostics;
    }
  | {
      ok: false;
      advertisedToolIds: readonly [];
      diagnostics: EffectiveToolResolutionDiagnostics;
    };

function failedResolution(
  configuredCatalogueSize: number,
  reason: string,
): EffectiveToolResolution {
  return {
    ok: false,
    advertisedToolIds: [],
    diagnostics: {
      status: "failed",
      configuredCatalogueSize,
      advertisedToolCount: 0,
      reason,
    },
  };
}

function registryDefinitions(
  registry: EffectiveToolResolverInput["registry"],
): readonly ToolDefinition<unknown, unknown>[] {
  if ("list" in registry) return registry.list();
  return registry;
}

function capabilityList(
  capabilities: EffectiveToolResolverInput["capabilities"],
): readonly ToolCapabilityView[] | null {
  if (Array.isArray(capabilities)) return capabilities;
  if (
    capabilities !== null &&
    typeof capabilities === "object" &&
    "tools" in capabilities &&
    Array.isArray(capabilities.tools)
  ) {
    return capabilities.tools;
  }
  return null;
}

function availableToolIds(
  capabilities: EffectiveToolResolverInput["capabilities"],
): Set<string> | null {
  const result = new Set<string>();
  const list = capabilityList(capabilities);
  if (list === null) return null;
  for (const capability of list) {
    if (
      !capability ||
      typeof capability.tool?.id !== "string" ||
      capability.tool.id.length === 0 ||
      (capability.availability !== "available" && capability.availability !== "denied")
    ) {
      return null;
    }
    if (capability.availability === "available") result.add(capability.tool.id);
  }
  return result;
}

function idsFromSkills(
  skills: readonly Pick<SkillDefinition, "requiredToolIds">[],
): string[] | null {
  if (!Array.isArray(skills)) return null;
  const result: string[] = [];
  for (const skill of skills) {
    if (!skill || !Array.isArray(skill.requiredToolIds)) return null;
    for (const id of skill.requiredToolIds) {
      if (typeof id !== "string" || id.length === 0) return null;
      result.push(id);
    }
  }
  return result;
}

/** Small, pure resolver used by the coordinator before an MCP session is minted. */
export class EffectiveToolResolver {
  resolve(input: EffectiveToolResolverInput): EffectiveToolResolution {
    let definitions: readonly ToolDefinition<unknown, unknown>[];
    try {
      definitions = registryDefinitions(input.registry);
    } catch {
      return failedResolution(0, "Tool catalogue is unavailable");
    }

    const configuredCatalogueSize = definitions.length;
    const orderedIds: string[] = [];
    const seen = new Set<string>();
    for (const definition of definitions) {
      if (!definition || typeof definition.id !== "string" || definition.id.length === 0) {
        return failedResolution(
          configuredCatalogueSize,
          "Tool catalogue contains an invalid definition",
        );
      }
      if (!seen.has(definition.id)) {
        seen.add(definition.id);
        orderedIds.push(definition.id);
      }
    }

    // This is the explicit, reversible compatibility path. It intentionally
    // does not require a capability projection, because legacy callers do not
    // have one yet; it still only advertises code-owned registry definitions.
    if (input.legacyFullAdvertisement ?? true) {
      return {
        ok: true,
        advertisedToolIds: Object.freeze([...orderedIds]),
        diagnostics: {
          status: "legacy-full",
          configuredCatalogueSize,
          advertisedToolCount: orderedIds.length,
        },
      };
    }

    const available = availableToolIds(input.capabilities);
    const skillIds = idsFromSkills(input.assignedSkills);
    if (!available || !skillIds) {
      return failedResolution(configuredCatalogueSize, "Capability projection is unavailable");
    }

    // Undefined is the only legacy no-role state. A null role is treated as
    // an explicit empty role so it cannot accidentally widen to all tools.
    const roleIds = input.effectiveRole === undefined
      ? undefined
      : input.effectiveRole === null
        ? []
        : input.effectiveRole.toolIds;
    if (roleIds !== undefined && !Array.isArray(roleIds)) {
      return failedResolution(configuredCatalogueSize, "Effective role is invalid");
    }
    const candidateIds = roleIds === undefined ? [...available] : [...roleIds, ...skillIds];
    if (candidateIds.some((id) => typeof id !== "string" || id.length === 0)) {
      return failedResolution(configuredCatalogueSize, "Effective tool candidates are invalid");
    }
    const candidates = new Set(candidateIds);
    const advertisedToolIds = orderedIds.filter((id) => candidates.has(id) && available.has(id));
    return {
      ok: true,
      advertisedToolIds: Object.freeze(advertisedToolIds),
      diagnostics: {
        status: "scoped",
        configuredCatalogueSize,
        advertisedToolCount: advertisedToolIds.length,
      },
    };
  }
}

export function resolveEffectiveToolIds(
  input: EffectiveToolResolverInput,
): EffectiveToolResolution {
  return new EffectiveToolResolver().resolve(input);
}
