import type { ToolDefinition, ToolMetadata } from "./tool-types.js";

/** Code-owned registry. No HTTP input can add or replace an executable tool. */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<unknown, unknown>>();

  constructor(definitions: readonly ToolDefinition<unknown, unknown>[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.id)) {
      throw new Error("Invalid tool identifier");
    }
    if (this.definitions.has(definition.id)) {
      throw new Error("Tool is already registered: " + definition.id);
    }
    this.definitions.set(
      definition.id,
      definition as unknown as ToolDefinition<unknown, unknown>,
    );
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  get(id: string): ToolDefinition<unknown, unknown> | undefined {
    return this.definitions.get(id);
  }

  require(id: string): ToolDefinition<unknown, unknown> {
    const definition = this.get(id);
    if (!definition) throw new Error("Tool is not registered: " + id);
    return definition;
  }

  list(): ToolDefinition<unknown, unknown>[] {
    return [...this.definitions.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  metadata(): ToolMetadata[] {
    return this.list().map((definition) => ({
      id: definition.id,
      title: definition.title,
      description: definition.description,
      risk: definition.risk,
      requiredPermission: definition.requiredPermission,
    }));
  }
}

export type { ToolDefinition, ToolMetadata } from "./tool-types.js";
