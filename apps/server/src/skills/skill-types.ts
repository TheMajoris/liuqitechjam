import type {
  ToolAvailability,
  ToolCapabilityView,
  ToolMetadata,
} from "../tools/tool-types.js";

/** Skills are declarative guidance bundles; they never contain executors. */
export type SkillSource = "built-in";

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

export interface SkillToolCapability {
  tool: ToolMetadata | null;
  toolId: string;
  availability: ToolAvailability;
  reason: string;
  grant: ToolCapabilityView["grant"];
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

/** Bounded, safe facts consumed by workspace writers and runtime prompts. */
export interface SkillRuntimeContext {
  skills: AssignedSkillView[];
  /** Already redacted and bounded lines; safe to place in a prompt envelope. */
  lines: string[];
}
