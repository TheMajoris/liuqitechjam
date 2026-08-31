import { describe, expect, it, vi } from "vitest";
import {
  WebFetchAdapter,
  type LookupAddress,
} from "../../../apps/server/src/tools/web-fetch-adapter.js";

const publicAddress: LookupAddress = { address: "93.184.216.34", family: 4 };

describe("WebFetchAdapter", () => {
  it("fetches bounded textual content and validates public DNS targets", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://example.com/page");
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).toMatchObject({
        Accept: expect.stringContaining("text/html"),
      });
      return new Response("<html><body>Hello</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const adapter = new WebFetchAdapter({
      fetchImpl,
      lookupImpl: async () => [publicAddress],
    });

    await expect(adapter.fetch("https://example.com/page")).resolves.toEqual({
      url: "https://example.com/page",
      finalUrl: "https://example.com/page",
      status: 200,
      contentType: "text/html",
      content: "<html><body>Hello</body></html>",
    });
  });

  it("rejects private literal and DNS-resolved targets before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new WebFetchAdapter({
      fetchImpl,
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    await expect(adapter.fetch("http://127.0.0.1:3000")).rejects.toThrow(
      "The requested host is not allowed",
    );
    await expect(adapter.fetch("https://public.example.test")).rejects.toThrow(
      "The requested host is not allowed",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

});
