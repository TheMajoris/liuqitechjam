import type { SkillDefinition, SkillMetadata } from "./skill-types.js";

const SKILL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** Code-owned registry. No HTTP payload can add, replace, or execute a skill. */
export class SkillRegistry {
  private readonly definitions = new Map<string, SkillDefinition>();

  constructor(definitions: readonly SkillDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: SkillDefinition): void {
    if (!SKILL_ID_PATTERN.test(definition.id)) {
      throw new Error("Invalid skill identifier");
    }
    if (definition.name.trim().length === 0 || definition.description.trim().length === 0) {
      throw new Error("Skill name and description are required");
    }
    if (definition.instructions.trim().length === 0) {
      throw new Error("Skill instructions are required");
    }
    if (definition.source !== "built-in") {
      throw new Error("Only built-in skills may be registered");
    }
    if (this.definitions.has(definition.id)) {
      throw new Error("Skill is already registered: " + definition.id);
    }
    const requiredToolIds = [...new Set(definition.requiredToolIds)];
    if (requiredToolIds.some((toolId) => !SKILL_ID_PATTERN.test(toolId))) {
      throw new Error("Invalid required tool identifier");
    }
    this.definitions.set(definition.id, {
      ...definition,
      requiredToolIds,
      capabilityTags: [...new Set(definition.capabilityTags)],
    });
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  get(id: string): SkillDefinition | undefined {
    const definition = this.definitions.get(id);
    return definition === undefined ? undefined : this.clone(definition);
  }

  require(id: string): SkillDefinition {
    const definition = this.get(id);
    if (!definition) throw new Error("Skill is not registered: " + id);
    return definition;
  }

  list(): SkillDefinition[] {
    return [...this.definitions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => this.clone(definition));
  }

  metadata(): SkillMetadata[] {
    return this.list().map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      requiredToolIds: [...definition.requiredToolIds],
      capabilityTags: [...definition.capabilityTags],
      source: definition.source,
      version: definition.version,
    }));
  }

  private clone(definition: SkillDefinition): SkillDefinition {
    return {
      ...definition,
      requiredToolIds: [...definition.requiredToolIds],
      capabilityTags: [...definition.capabilityTags],
    };
  }
}

export type { SkillDefinition, SkillMetadata } from "./skill-types.js";

