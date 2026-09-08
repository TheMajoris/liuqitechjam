import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EffectiveToolResolver,
  type EffectiveToolResolverInput,
} from "../../../apps/server/src/tools/effective-tool-resolver.js";
import type { ToolDefinition, ToolMetadata } from "../../../apps/server/src/tools/tool-types.js";

function definition(id: string): ToolDefinition<unknown, unknown> {
  return {
    id,
    title: id,
    description: id,
    risk: "read",
    requiredPermission: "preview.read",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    async execute() {
      return { ok: true };
    },
  };
}

function capability(
  id: string,
  availability: "available" | "denied",
): { tool: ToolMetadata; availability: "available" | "denied"; reason: string } {
  return {
    tool: {
      id,
      title: id,
      description: id,
      risk: "read",
      requiredPermission: "preview.read",
    },
    availability,
    reason: availability,
  };
}

function input(
  overrides: Partial<EffectiveToolResolverInput> = {},
): EffectiveToolResolverInput {
  return {
    registry: [definition("web.fetch"), definition("project.preview.inspect"), definition("web.search")],
    assignedSkills: [],
    capabilities: [
      capability("web.fetch", "available"),
      capability("project.preview.inspect", "available"),
      capability("web.search", "available"),
    ],
    legacyFullAdvertisement: false,
    ...overrides,
  };
}

describe("EffectiveToolResolver", () => {
  it("unions role and skill candidates, intersects availability, and preserves registry order", () => {
    const result = new EffectiveToolResolver().resolve(input({
      effectiveRole: { toolIds: ["web.search", "web.search"] },
      assignedSkills: [{ requiredToolIds: ["project.preview.inspect", "web.fetch"] }],
      capabilities: [
        capability("web.fetch", "denied"),
        capability("project.preview.inspect", "available"),
        capability("web.search", "available"),
      ],
    }));

    expect(result).toMatchObject({
      ok: true,
      advertisedToolIds: ["project.preview.inspect", "web.search"],
      diagnostics: {
        status: "scoped",
        configuredCatalogueSize: 3,
        advertisedToolCount: 2,
      },
    });
  });

  it("uses the available legacy Project set when no explicit role exists", () => {
    const result = new EffectiveToolResolver().resolve(input({
      assignedSkills: [{ requiredToolIds: ["web.search"] }],
      capabilities: [
        capability("web.fetch", "available"),
        capability("project.preview.inspect", "denied"),
        capability("web.search", "denied"),
      ],
    }));

    expect(result).toMatchObject({ ok: true, advertisedToolIds: ["web.fetch"] });
  });

  it("does not turn an explicit empty role into the legacy full set", () => {
    const result = new EffectiveToolResolver().resolve(input({
      effectiveRole: { toolIds: [] },
      assignedSkills: [],
    }));

    expect(result).toMatchObject({ ok: true, advertisedToolIds: [] });
  });

  it("fails closed when the capability projection is malformed", () => {
    const result = new EffectiveToolResolver().resolve(input({
      capabilities: [{
        ...capability("web.search", "available"),
        availability: "unknown" as "available",
      }],
    }));

    expect(result).toMatchObject({
      ok: false,
      advertisedToolIds: [],
      diagnostics: { status: "failed" },
    });
  });

  it("keeps the legacy full-advertisement rollback when no opt-in is supplied", () => {
    const { legacyFullAdvertisement: _legacy, ...legacyInput } = input();
    void _legacy;
    const result = new EffectiveToolResolver().resolve(legacyInput);
    expect(result).toMatchObject({
      ok: true,
      advertisedToolIds: ["web.fetch", "project.preview.inspect", "web.search"],
      diagnostics: { status: "legacy-full" },
    });
  });
});
