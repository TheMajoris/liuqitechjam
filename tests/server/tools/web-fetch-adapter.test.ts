import { EventEmitter } from "node:events";
import type { LookupFunction } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  WebFetchAdapter,
  type LookupAddress,
} from "../../../apps/server/src/tools/web-fetch-adapter.js";

const httpRequest = vi.hoisted(() => vi.fn());
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  request: httpRequest,
}));

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

  /**
   * The default transport pins Node's DNS lookup to the address the SSRF
   * guard already approved. Node asks for every address at once whenever it
   * uses the multi-address connect path (autoSelectFamily, on by default
   * since Node 20), and answering that with the legacy positional form fails
   * the connect with ERR_INVALID_IP_ADDRESS. Every other test in this file
   * injects `fetchImpl`, so this is the only coverage of the real transport.
   */
  it("answers Node's pinned DNS lookup in the shape the request asked for", async () => {
    let lookup: LookupFunction | undefined;
    httpRequest.mockImplementation((options: { lookup?: LookupFunction }, onResponse: (response: unknown) => void) => {
      lookup = options.lookup;
      const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      request.destroy = () => undefined;
      request.end = () => {
        const response = new PassThrough() as PassThrough & {
          statusCode: number;
          statusMessage: string;
          rawHeaders: string[];
        };
        response.statusCode = 200;
        response.statusMessage = "OK";
        response.rawHeaders = ["content-type", "text/markdown"];
        onResponse(response);
        response.end("# Imported skill");
      };
      return request;
    });
    const adapter = new WebFetchAdapter({ lookupImpl: async () => [publicAddress] });

    await expect(adapter.fetch("http://example.com/SKILL.md")).resolves.toMatchObject({
      status: 200,
      contentType: "text/markdown",
      content: "# Imported skill",
    });

    expect(lookup).toBeTypeOf("function");
    const all = vi.fn();
    lookup!("example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [publicAddress]);

    const positional = vi.fn();
    lookup!("example.com", {}, positional);
    expect(positional).toHaveBeenCalledWith(null, publicAddress.address, publicAddress.family);
  });
});
