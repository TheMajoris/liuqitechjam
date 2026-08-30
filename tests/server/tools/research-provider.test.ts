import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../apps/server/src/config.js";
import { createBuiltInToolDefinitions } from "../../../apps/server/src/tools/built-in-tools.js";
import { createSearchProvider } from "../../../apps/server/src/tools/search-provider-factory.js";

describe("local research provider wiring", () => {
  it("defaults to SearXNG and supports explicit Brave/disabled selection", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults.searchProvider).toBe("searxng");
    expect(defaults.searxngUrl).toBe("http://127.0.0.1:8080/search");
    expect(createSearchProvider(defaults).id).toBe("searxng");
    expect(createSearchProvider(loadConfig({
      NODE_ENV: "test",
      SEARCH_PROVIDER: "brave",
      BRAVE_SEARCH_API_KEY: "test-key",
    })).id).toBe("brave");
    expect(createSearchProvider(loadConfig({
      NODE_ENV: "test",
      SEARCH_PROVIDER: "disabled",
    })).id).toBe("disabled");
    expect(() => loadConfig({
      NODE_ENV: "test",
      SEARXNG_URL: "http://127.0.0.1:8080/search?token=secret",
    })).toThrow("SEARXNG_URL");
  });

  it("registers web.fetch alongside web.search", () => {
    const fetch = async () => ({
      url: "https://example.com",
      finalUrl: "https://example.com",
      status: 200,
      contentType: "text/plain",
      content: "ok",
    });
    const definitions = createBuiltInToolDefinitions({
      search: { search: async () => [] },
      fetch: { fetch },
      preview: {
        get: async () => { throw new Error("not used"); },
        restart: async () => { throw new Error("not used"); },
      },
    });
    expect(definitions.map((definition) => definition.id)).toContain("web.fetch");
    expect(definitions.find((definition) => definition.id === "web.fetch")?.requiredPermission)
      .toBe("tool.execute:web.fetch");
  });
});
