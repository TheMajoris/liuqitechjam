import { describe, expect, it, vi } from "vitest";
import {
  WebFetchAdapter,
  WebFetchError,
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

  it("passes the validated address into the request seam to prevent DNS rebinding", async () => {
    const pinned = { address: "93.184.216.34", family: 4 as const };
    let lookupCalls = 0;
    let requestPin: LookupAddress | undefined;
    const adapter = new WebFetchAdapter({
      lookupImpl: async () => {
        lookupCalls += 1;
        return [pinned];
      },
      fetchImpl: async (_input, _init, validatedAddress) => {
        requestPin = validatedAddress;
        return new Response("pinned", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    });

    await expect(adapter.fetch("https://example.com/rebinding")).resolves.toMatchObject({
      content: "pinned",
    });
    expect(lookupCalls).toBe(1);
    expect(requestPin).toEqual(pinned);
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

  it("validates every redirect and refuses private destinations", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      }),
    );
    const adapter = new WebFetchAdapter({
      fetchImpl,
      lookupImpl: async () => [publicAddress],
    });

    await expect(adapter.fetch("https://example.com/redirect")).rejects.toThrow(
      "The requested host is not allowed",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-text content and oversized bodies", async () => {
    const binary = new WebFetchAdapter({
      fetchImpl: async () =>
        new Response("binary", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      lookupImpl: async () => [publicAddress],
    });
    await expect(binary.fetch("https://example.com/file")).rejects.toThrow(
      "The response content type is not allowed",
    );

    const oversized = new WebFetchAdapter({
      maxResponseBytes: 4_096,
      fetchImpl: async () =>
        new Response("x".repeat(4_097), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      lookupImpl: async () => [publicAddress],
    });
    await expect(oversized.fetch("https://example.com/large")).rejects.toBeInstanceOf(
      WebFetchError,
    );
    await expect(oversized.fetch("https://example.com/large")).rejects.toThrow(
      "The web response was too large",
    );
  });
});
