import { describe, expect, it } from "vitest";
import { createApp } from "../../../apps/server/src/app.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import type { AgentService } from "../../../apps/server/src/agent-service.js";
import type { McpRouteDependencies } from "../../../apps/server/src/mcp-server.js";
import type { CreateSkillInput, SkillService } from "../../../apps/server/src/skills/skill-service.js";
import { SkillError } from "../../../apps/server/src/skills/skill-service.js";
import { WebFetchError } from "../../../apps/server/src/tools/web-fetch-adapter.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

function dependencies(options: {
  create: (input: CreateSkillInput) => Promise<unknown>;
  fetch?: McpRouteDependencies["webFetch"];
  search?: McpRouteDependencies["searchProvider"];
}): McpRouteDependencies {
  return {
    sessions: {} as McpRouteDependencies["sessions"],
    toolService: {} as McpRouteDependencies["toolService"],
    skillService: { create: options.create } as unknown as SkillService,
    ...(options.fetch === undefined ? {} : { webFetch: options.fetch }),
    ...(options.search === undefined ? {} : { searchProvider: options.search }),
  };
}

async function makeApp(mcp: McpRouteDependencies) {
  return createApp(
    loadConfig({ NODE_ENV: "test" }),
    service,
    undefined,
    undefined,
    undefined,
    undefined,
    mcp,
  );
}

describe("skill import and discovery routes", () => {
  it("creates an instruction-only skill from local Markdown frontmatter", async () => {
    const created: CreateSkillInput[] = [];
    const app = await makeApp(dependencies({
      create: async (input) => {
        created.push(input);
        return { ...input, source: "user", installedAt: "now", updatedAt: "now" };
      },
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: {
        fileName: "api.md",
        markdown: `---
name: API Design
description: Design secure APIs
tags: [api, security]
---

# API Design

Prefer explicit contracts.
`,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(created[0]).toMatchObject({
      id: "api-design",
      name: "API Design",
      description: "Design secure APIs",
      capabilityTags: ["api", "security"],
      instructions: "# API Design\n\nPrefer explicit contracts.",
    });
    await app.close();
  });

  it("rejects malformed/oversized imports and preserves duplicate conflicts", async () => {
    const app = await makeApp(dependencies({
      create: async () => {
        throw new SkillError("SKILL_ALREADY_INSTALLED", "Skill ID is already in use");
      },
    }));
    const malformed = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { markdown: "   " },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().errorCode).toBe("SKILL_INVALID_INPUT");

    const oversized = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { markdown: "x".repeat(64 * 1024 + 1) },
    });
    expect(oversized.statusCode).toBe(422);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { markdown: "# Existing\n\nInstructions" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().errorCode).toBe("SKILL_ALREADY_INSTALLED");
    await app.close();
  });

  it("normalizes GitHub skill folders before using the bounded public fetcher", async () => {
    const created: CreateSkillInput[] = [];
    const fetcher = {
      fetch: async (url: string, maxBytes?: number) => {
        expect(url).toBe(
          "https://raw.githubusercontent.com/acme/skills/main/research/SKILL.md",
        );
        expect(maxBytes).toBe(64 * 1024);
        return {
          url,
          finalUrl: url,
          status: 200,
          contentType: "text/plain",
          content: "# Research\n\nGather evidence.",
        };
      },
    } satisfies NonNullable<McpRouteDependencies["webFetch"]>;
    const app = await makeApp(dependencies({
      create: async (input) => {
        created.push(input);
        return input;
      },
      fetch: fetcher,
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: "https://github.com/acme/skills/tree/main/research" },
    });
    expect(response.statusCode).toBe(201);
    expect(created[0]?.id).toBe("research");
    await app.close();
  });

  it("maps private URL denial safely and bounds discovery metadata", async () => {
    let searchQuery = "";
    const app = await makeApp(dependencies({
      create: async (input) => input,
      fetch: {
        fetch: async () => {
          throw new WebFetchError("The requested host is not allowed");
        },
      },
      search: {
        id: "searxng",
        search: async (query) => {
          searchQuery = query;
          return Array.from({ length: 30 }, (_, index) => ({
            title: `Result ${index}`,
            url: `https://example.com/${index}`,
            description: "A result",
          }));
        },
        health: async () => ({
          provider: "searxng",
          status: "available",
          configured: true,
          endpoint: "http://127.0.0.1:8080/search",
          message: "ok",
          checkedAt: new Date().toISOString(),
        }),
      },
    }));
    const denied = await app.inject({
      method: "POST",
      url: "/api/skills/import",
      payload: { url: "https://127.0.0.1/SKILL.md" },
    });
    expect(denied.statusCode).toBe(422);
    expect(denied.json()).toMatchObject({ errorCode: "SKILL_INVALID_INPUT" });

    const discovered = await app.inject({
      method: "GET",
      url: "/api/skills/discover?q=research&limit=7",
    });
    expect(discovered.statusCode).toBe(200);
    expect(searchQuery).toBe("research agent skill SKILL.md github");
    expect(discovered.json().results).toHaveLength(7);
    await app.close();
  });
});
