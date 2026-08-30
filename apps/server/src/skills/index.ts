import { SkillRegistry } from "./skill-registry.js";
import { SkillService } from "./skill-service.js";
import type { SkillDefinition } from "./skill-types.js";

/** The initial platform skill catalog is deliberately code-owned and static. */
export const BUILT_IN_SKILLS: readonly SkillDefinition[] = [
  {
    id: "frontend-react",
    name: "Frontend React",
    description: "Build accessible, typed, responsive React interfaces that fit the existing app.",
    instructions:
      "Work as a React frontend specialist. Inspect the existing components and styling conventions first. Prefer semantic accessible markup, typed props, small composable components, responsive behavior, and focused UI tests. Keep visual and interaction changes purposeful.",
    requiredToolIds: ["project.preview.inspect"],
    capabilityTags: ["react", "frontend", "accessibility", "ui"],
    source: "built-in",
    version: "1.0.0",
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Review changes for correctness, security, maintainability, and test coverage.",
    instructions:
      "Review the current changes as a careful engineering reviewer. Prioritize correctness, security, regressions, accessibility, maintainability, and missing tests. Report concrete findings with evidence and severity, then suggest the smallest useful fixes. Do not rewrite unrelated work.",
    requiredToolIds: ["project.preview.inspect"],
    capabilityTags: ["review", "quality", "security", "testing"],
    source: "built-in",
    version: "1.0.0",
  },
  {
    id: "debug-build",
    name: "Debug and Build",
    description: "Diagnose build and test failures methodically and verify focused fixes.",
    instructions:
      "Work methodically on build and test failures. Reproduce the failure, identify the smallest root cause, make a focused fix, and rerun the narrowest useful verification before broadening checks. Explain remaining uncertainty instead of masking failures.",
    requiredToolIds: ["project.preview.inspect", "project.preview.restart"],
    capabilityTags: ["debugging", "build", "testing", "verification"],
    source: "built-in",
    version: "1.0.0",
  },
  {
    id: "research",
    name: "Research",
    description: "Gather bounded external information and distinguish evidence from inference.",
    instructions:
      "When the task needs current external facts, use web.fetch for a supplied HTTP(S) URL and web.search for bounded keyword research when available. Distinguish sourced facts from inference, keep research bounded and relevant, and say when a capability is unavailable or approval is required. Never invent a source or claim a search or fetch you did not perform.",
    // Search remains the explicit research capability; web.fetch is a
    // separately selectable tool for URL-focused research.
    requiredToolIds: ["web.search"],
    capabilityTags: ["research", "web", "evidence"],
    source: "built-in",
    version: "1.0.0",
  },
];

export function createBuiltInSkillRegistry(): SkillRegistry {
  return new SkillRegistry(BUILT_IN_SKILLS);
}

export const createSkillRegistry = createBuiltInSkillRegistry;

export { APPROVED_SKILL_CATALOG, cloneApprovedSkillCatalog } from "./skill-catalog.js";

export { SkillRegistry } from "./skill-registry.js";
export {
  MAX_SKILL_MARKDOWN_BYTES,
  normalizeSkillUrl,
  parseSkillMarkdown,
} from "./skill-markdown.js";
export {
  isSkillError,
  SkillError,
  SkillService,
} from "./skill-service.js";
export type { SkillCapabilityResolver } from "./skill-service.js";
export type {
  CreateSkillInput,
  SkillSearchOptions,
  SkillServiceOptions,
  UpdateSkillInput,
} from "./skill-service.js";
export type {
  AgentSkillsView,
  AssignedSkillView,
  InstalledSkillRecord,
  SkillCatalogEntry,
  SkillDefinition,
  SkillMetadata,
  SkillRuntimeContext,
  SkillSource,
  SkillToolCapability,
} from "./skill-types.js";
