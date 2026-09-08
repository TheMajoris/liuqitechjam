import type {
  ToolAvailability,
  ToolCapabilitiesView,
  ToolMetadata,
} from "../tools/tool-types.js";

/** Skills are declarative guidance bundles; they never contain executors. */
export type SkillSource = "built-in" | "user" | "installed";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Platform tool IDs the guidance is useful with, never implicit grants. */
  requiredToolIds: readonly string[];
  capabilityTags: readonly string[];
  source: SkillSource;
  version: string;
}

/**
 * Persisted user/catalog skills. The record intentionally contains only the
 * instruction-only SkillDefinition fields plus lifecycle timestamps; there
 * is no executable payload, source URL, or installation command.
 */
export interface InstalledSkillRecord extends SkillDefinition {
  installedAt: string;
  updatedAt: string;
}

/** Safe registry projection returned by the HTTP control plane. */
export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  requiredToolIds: string[];
  capabilityTags: string[];
  source: SkillSource;
  version: string;
}

/** Safe catalog projection used by discovery/install screens. */
export interface SkillCatalogEntry extends SkillMetadata {
  installed: boolean;
  installable: boolean;
}

export interface SkillToolCapability {
  tool: ToolMetadata | null;
  toolId: string;
  availability: ToolAvailability;
  reason: string;
}

export interface AssignedSkillView extends SkillMetadata {
  instructions: string;
  capabilities: SkillToolCapability[];
}

export interface AgentSkillsView {
  agentId: string;
  projectId: string | null;
  /** Preserves assignment order after unknown legacy IDs are reconciled away. */
  skillIds: string[];
  skills: AssignedSkillView[];
}

/**
 * Once-resolved, read-only facts shared by runtime rendering and discovery.
 *
 * `toolCapabilities` is the complete capability view returned for this Agent
 * and Project scope. Consumers must reuse it rather than asking the capability
 * service again for the same run.
 */
export interface SkillRuntimeProjection {
  agentId: string;
  projectId: string | null;
  /** Preserves configured Agent/role assignment order. */
  skillIds: readonly string[];
  skills: readonly AssignedSkillView[];
  toolCapabilities: ToolCapabilitiesView;
  /** Stable skill names/instructions; safe to place before mutable state. */
  stableLines: readonly string[];
  /** Redacted current capability state; safe to place after fixed policies. */
  capabilityLines: readonly string[];
}

/** Bounded, safe facts consumed by workspace writers and runtime prompts. */
export interface SkillRuntimeContext extends SkillRuntimeProjection {
  /**
   * Compatibility projection for existing callers. New runtime renderers
   * should use `stableLines` and `capabilityLines` separately.
   */
  lines: readonly string[];
}
