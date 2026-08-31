import { describe, expect, it } from "vitest";
import {
  SearXngSearchAdapter,
  SearXngSearchError,
} from "../../../apps/server/src/tools/searxng-search-adapter.js";

describe("SearXngSearchAdapter", () => {
  it("uses the JSON endpoint and normalizes SearXNG results", async () => {
    const adapter = new SearXngSearchAdapter({
      endpoint: "http://127.0.0.1:8080/search",
      maxResults: 1,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("q")).toBe("local research");
        expect(url.searchParams.get("format")).toBe("json");
        expect(init?.headers).toMatchObject({ Accept: "application/json" });
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "  Result  ",
                url: "https://example.com/result",
                content: "  Description  ",
              },
              {
                title: "Second",
                url: "https://example.com/second",
                content: "Second description",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(adapter.search("local research", 1)).resolves.toEqual([
      {
        title: "Result",
        url: "https://example.com/result",
        description: "Description",
      },
    ]);
  });

  it("redacts provider errors and exposes safe health metadata", async () => {
    const adapter = new SearXngSearchAdapter({
      endpoint: "http://127.0.0.1:8080/search",
      fetchImpl: async () => new Response("secret=not-for-agents", { status: 503 }),
    });
    await expect(adapter.search("failure")).rejects.toBeInstanceOf(SearXngSearchError);
    await expect(adapter.search("failure")).rejects.toThrow(
      "Web search provider returned an error",
    );
    await expect(adapter.health()).resolves.toMatchObject({
      provider: "searxng",
      status: "unavailable",
      configured: true,
      endpoint: "http://127.0.0.1:8080/search",
    });
  });
});

