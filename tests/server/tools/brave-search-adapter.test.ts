import { describe, expect, it, vi } from "vitest";
import { BraveSearchAdapter, BraveSearchError } from "../../../apps/server/src/tools/brave-search-adapter.js";

describe("BraveSearchAdapter", () => {
  it("sends the query with the subscription token and bounds safe results", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).searchParams.get("q")).toBe("typescript tools");
      expect(new URL(String(input)).searchParams.get("count")).toBe("2");
      expect(init?.headers).toMatchObject({ "X-Subscription-Token": "brave-secret" });
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "  First result  ",
                url: "https://example.com/first",
                description: "  A bounded description  ",
              },
              {
                title: "Second result",
                url: "https://example.com/second",
                description: "Second description",
              },
              {
                title: "Third result",
                url: "https://example.com/third",
                description: "Third description",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const adapter = new BraveSearchAdapter({
      apiKey: "brave-secret",
      maxResults: 2,
      fetchImpl,
    });

    await expect(adapter.search("typescript tools", 2)).resolves.toEqual([
      {
        title: "First result",
        url: "https://example.com/first",
        description: "A bounded description",
      },
      {
        title: "Second result",
        url: "https://example.com/second",
        description: "Second description",
      },
    ]);
  });

  it("redacts provider failure details", async () => {
    const adapter = new BraveSearchAdapter({
      apiKey: "brave-secret",
      fetchImpl: async () => new Response("provider key=brave-secret", { status: 500 }),
    });
    await expect(adapter.search("failure")).rejects.toBeInstanceOf(BraveSearchError);
    await expect(adapter.search("failure")).rejects.toThrow(
      "Web search provider returned an error",
    );
  });

  it("rejects oversized responses and non-HTTP result URLs", async () => {
    const oversized = new BraveSearchAdapter({
      apiKey: "brave-secret",
      maxResponseBytes: 16,
      fetchImpl: async () =>
        new Response(JSON.stringify({ web: { results: [] } }) + "padding", {
          status: 200,
        }),
    });
    await expect(oversized.search("too large")).rejects.toThrow(
      "Web search provider response was too large",
    );

    const unsafeUrl = new BraveSearchAdapter({
      apiKey: "brave-secret",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Unsafe",
                  url: "file:///tmp/private.txt",
                  description: "should not leave the adapter",
                },
              ],
            },
          }),
          { status: 200 },
        ),
    });
    await expect(unsafeUrl.search("unsafe")).rejects.toThrow(
      "Web search provider returned invalid data",
    );
  });
});
