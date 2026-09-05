import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export interface WebFetchResult {
  /** The URL supplied by the caller after URL normalization. */
  url: string;
  /** The last URL after explicitly validated redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  /** Bounded response text. HTML is returned as data; it is never executed. */
  content: string;
}

export interface WebFetchAdapterOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  /** Optional test seam. The third argument is the validated pinned address. */
  fetchImpl?: WebFetchImpl;
  /** Injectable for tests; production uses node:dns/promises. */
  lookupImpl?: LookupImpl;
}

export type WebFetchImpl = (
  input: string | URL,
  init?: RequestInit,
  pinnedAddress?: LookupAddress,
) => Promise<Response>;

export type LookupAddress = { address: string; family: number };
export type LookupImpl = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export class WebFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "WebFetchError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_URL_LENGTH = 2_048;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPTED_CONTENT_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "text/xml",
  "application/xhtml+xml",
  "application/json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
]);

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa") ||
    normalized.endsWith(".lan");
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return -1;
    const parsed = Number(part);
    return parsed >= 0 && parsed <= 255 ? parsed : -1;
  });
  if (octets.some((part) => part < 0)) return null;
  return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!);
}

function inIpv4Range(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

/** RFC1918, loopback, link-local, special-use and multicast IPv4 ranges. */
function isPrivateIpv4(value: string): boolean {
  const parsed = ipv4ToNumber(value);
  if (parsed === null) return true;
  return inIpv4Range(parsed, 0x00000000, 0x00ffffff) ||
    inIpv4Range(parsed, 0x0a000000, 0x0affffff) ||
    inIpv4Range(parsed, 0x64400000, 0x647fffff) ||
    inIpv4Range(parsed, 0x7f000000, 0x7fffffff) ||
    inIpv4Range(parsed, 0xa9fe0000, 0xa9feffff) ||
    inIpv4Range(parsed, 0xac100000, 0xac1fffff) ||
    inIpv4Range(parsed, 0xc0000000, 0xc00000ff) ||
    inIpv4Range(parsed, 0xc0000200, 0xc00002ff) ||
    inIpv4Range(parsed, 0xc0a80000, 0xc0a8ffff) ||
    inIpv4Range(parsed, 0xc0586300, 0xc05863ff) ||
    inIpv4Range(parsed, 0xc6120000, 0xc613ffff) ||
    inIpv4Range(parsed, 0xc6336400, 0xc63364ff) ||
    inIpv4Range(parsed, 0xcb007100, 0xcb0071ff) ||
    inIpv4Range(parsed, 0xe0000000, 0xffffffff);
}

function ipv6ToBigInt(value: string): bigint | null {
  let normalized = value.toLowerCase();
  const zone = normalized.indexOf("%");
  if (zone >= 0) normalized = normalized.slice(0, zone);
  if (!normalized.includes(":")) return null;

  // IPv4-mapped IPv6 addresses are common in DNS results. Convert the tail
  // to two 16-bit groups before handling IPv6 compression.
  const lastColon = normalized.lastIndexOf(":");
  const ipv4Tail = normalized.slice(lastColon + 1);
  if (ipv4Tail.includes(".")) {
    const ipv4 = ipv4ToNumber(ipv4Tail);
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    normalized = normalized.slice(0, lastColon + 1) + high + ":" + low;
  }

  const sections = normalized.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] === "" ? [] : sections[0]!.split(":");
  const right = sections.length === 2 && sections[1] !== ""
    ? sections[1]!.split(":")
    : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
      right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((sections.length === 1 && missing !== 0) || (sections.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(parseInt(group!, 16));
  return result;
}

function inIpv6Range(value: bigint, prefix: bigint, bits: number): boolean {
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === (prefix & mask);
}

function isPrivateIpv6(value: string): boolean {
  const parsed = ipv6ToBigInt(value);
  if (parsed === null) return true;
  // Unspecified, loopback, IPv4-mapped private, unique-local, link-local,
  // site-local and multicast addresses are not safe remote fetch targets.
  if (parsed === 0n || parsed === 1n) return true;
  if (inIpv6Range(parsed, 0xfc00n << 112n, 7) ||
      inIpv6Range(parsed, 0xfe80n << 112n, 10) ||
      inIpv6Range(parsed, 0xfec0n << 112n, 10) ||
      inIpv6Range(parsed, 0xff00n << 112n, 8)) return true;
  // IPv4-mapped addresses use ::ffff:0:0/96 (the ffff group is the
  // sixth 16-bit group, i.e. bits 32-47 of the 128-bit value).
  if (inIpv6Range(parsed, 0xffffn << 32n, 96)) {
    const mappedIpv4 = Number(parsed & 0xffffffffn);
    return isPrivateIpv4([
      (mappedIpv4 >>> 24) & 0xff,
      (mappedIpv4 >>> 16) & 0xff,
      (mappedIpv4 >>> 8) & 0xff,
      mappedIpv4 & 0xff,
    ].join("."));
  }
  // Deprecated IPv4-compatible addresses use ::/96 without the ffff marker;
  // apply the same low-32-bit policy so they cannot bypass the IPv4 checks.
  if (inIpv6Range(parsed, 0n, 96)) {
    const compatibleIpv4 = Number(parsed & 0xffffffffn);
    return isPrivateIpv4([
      (compatibleIpv4 >>> 24) & 0xff,
      (compatibleIpv4 >>> 16) & 0xff,
      (compatibleIpv4 >>> 8) & 0xff,
      compatibleIpv4 & 0xff,
    ].join("."));
  }
  return false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function validateHttpUrl(value: string): URL {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_URL_LENGTH) {
    throw new WebFetchError("A valid HTTP(S) URL is required");
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch (error) {
    throw new WebFetchError("A valid HTTP(S) URL is required", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError("Only HTTP(S) URLs can be fetched");
  }
  if (url.username || url.password) {
    throw new WebFetchError("URLs with embedded credentials cannot be fetched");
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || isPrivateHostname(hostname)) {
    throw new WebFetchError("The requested host is not allowed");
  }
  if (isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
    throw new WebFetchError("The requested host is not allowed");
  }
  return url;
}

async function assertPublicTarget(url: URL, lookupImpl: LookupImpl): Promise<LookupAddress> {
  const hostname = normalizedHostname(url.hostname);
  if (isPrivateHostname(hostname)) {
    throw new WebFetchError("The requested host is not allowed");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isPrivateAddress(hostname)) throw new WebFetchError("The requested host is not allowed");
    return { address: hostname, family: literalFamily };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new WebFetchError("The requested host could not be resolved", { cause: error });
  }
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new WebFetchError("The requested host is not allowed");
  }
  const first = addresses.find((item) => isIP(item.address) !== 0);
  if (!first) throw new WebFetchError("The requested host is not allowed");
  return {
    address: first.address,
    family: isIP(first.address),
  };
}

function contentTypeFrom(response: Response): string {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!value || !ACCEPTED_CONTENT_TYPES.has(value)) {
    throw new WebFetchError("The response content type is not allowed");
  }
  return value;
}

class WebResponseTooLargeError extends Error {
  constructor() {
    super("The web response was too large");
    this.name = "WebResponseTooLargeError";
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new WebResponseTooLargeError();
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new WebResponseTooLargeError();
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WebResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function headersForNodeRequest(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers);
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  // Do not allow transparent compression to make the byte limit ambiguous;
  // the response stream is bounded after transport decoding by the adapter.
  result["accept-encoding"] = "identity";
  return result;
}

/**
 * Make one request with the already-validated address. `hostname` remains the
 * original URL hostname, so HTTP Host and HTTPS certificate/SNI validation
 * are preserved while Node's DNS lookup is pinned to `pinnedAddress`.
 */
function fetchWithPinnedAddress(
  url: URL,
  init: RequestInit,
  pinnedAddress: LookupAddress,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const hostname = normalizedHostname(url.hostname);
    const signal = init.signal;
    let settled = false;
    let request: ReturnType<typeof httpRequest> | undefined;
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      request?.destroy(new Error("Web fetch aborted"));
    };
    if (signal?.aborted) {
      fail(new Error("Web fetch aborted"));
      return;
    }

    const options: import("node:http").RequestOptions = {
      protocol: url.protocol,
      hostname,
      ...(url.port ? { port: url.port } : {}),
      path: url.pathname + url.search,
      method: String(init.method ?? "GET"),
      headers: headersForNodeRequest(init),
      // Node passes `all: true` whenever it uses the multi-address connect
      // path (autoSelectFamily, on by default since Node 20) and then expects
      // an address array. The positional form is only valid without it, and
      // answering in the wrong shape fails the connect with
      // ERR_INVALID_IP_ADDRESS rather than reaching the host.
      lookup: (_lookupHostname, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }]);
          return;
        }
        callback(null, pinnedAddress.address, pinnedAddress.family);
      },
    };
    const onResponse = (response: import("node:http").IncomingMessage) => {
      const status = response.statusCode;
      if (status === undefined) {
        response.resume();
        fail(new Error("HTTP response did not include a status"));
        return;
      }
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        const value = response.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) headers.append(name, value);
      }
      const body = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
      settled = true;
      // Keep the abort listener alive while the response body is being
      // consumed. Removing it here would let a slow body outlive the timeout.
      response.once("close", cleanup);
      resolve(new Response(body, {
        status,
        ...(response.statusMessage === undefined ? {} : { statusText: response.statusMessage }),
        headers,
      }));
    };
    request = url.protocol === "https:"
      ? httpsRequest({
          ...options,
          // Keep certificate validation enabled while SNI/verification uses
          // the original hostname rather than the pinned address.
          rejectUnauthorized: true,
          ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        }, onResponse)
      : httpRequest(options, onResponse);
    request.once("error", fail);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

/**
 * Fetches only public HTTP(S) resources, following redirects one at a time so
 * every destination gets the same host/DNS policy. The response is bounded
 * and limited to textual content before it reaches the Agent.
 */
export class WebFetchAdapter {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly fetchImpl: WebFetchImpl | undefined;
  private readonly lookupImpl: LookupImpl;

  constructor(options: WebFetchAdapterOptions = {}) {
    this.timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000);
    this.maxResponseBytes = boundedPositive(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
    );
    this.maxRedirects = Number.isInteger(options.maxRedirects) && options.maxRedirects !== undefined && options.maxRedirects >= 0
      ? Math.min(options.maxRedirects, 5)
      : DEFAULT_MAX_REDIRECTS;
    this.fetchImpl = options.fetchImpl;
    this.lookupImpl = options.lookupImpl ?? (async (hostname, lookupOptions) =>
      dnsLookup(hostname, lookupOptions));
  }

  async fetch(url: string, maxBytes?: number): Promise<WebFetchResult> {
    const initialUrl = validateHttpUrl(url);
    const responseLimit = boundedPositive(maxBytes, this.maxResponseBytes, this.maxResponseBytes);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    let current = initialUrl;
    let redirects = 0;
    try {
      while (true) {
        const pinnedAddress = await assertPublicTarget(current, this.lookupImpl);
        const requestInit: RequestInit = {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "text/html, text/plain, application/xhtml+xml, application/json, application/xml;q=0.9, */*;q=0.1",
            "User-Agent": "LQAM/1.0",
          },
          signal: controller.signal,
        };
        const response = this.fetchImpl
          ? await this.fetchImpl(current, requestInit, pinnedAddress)
          : await fetchWithPinnedAddress(current, requestInit, pinnedAddress);
        if (REDIRECT_STATUSES.has(response.status)) {
          if (response.body) void response.body.cancel().catch(() => undefined);
          if (redirects >= this.maxRedirects) {
            throw new WebFetchError("The web page redirected too many times");
          }
          const location = response.headers.get("location");
          if (!location) throw new WebFetchError("The web page returned an invalid redirect");
          let redirected: URL;
          try {
            redirected = new URL(location, current);
          } catch (error) {
            throw new WebFetchError("The web page returned an invalid redirect", { cause: error });
          }
          current = validateHttpUrl(redirected.toString());
          redirects += 1;
          continue;
        }
        if (!response.ok) {
          throw new WebFetchError("The web page returned an error");
        }
        const contentType = contentTypeFrom(response);
        let content: string;
        try {
          content = await readBoundedBody(response, responseLimit);
        } catch (error) {
          if (controller.signal.aborted) throw new WebFetchError("Web fetch timed out");
          if (error instanceof WebResponseTooLargeError) throw new WebFetchError(error.message);
          throw error;
        }
        return {
          url: initialUrl.toString(),
          finalUrl: current.toString(),
          status: response.status,
          contentType,
          content,
        };
      }
    } catch (error) {
      if (error instanceof WebFetchError) throw error;
      throw new WebFetchError(
        controller.signal.aborted ? "Web fetch timed out" : "The web page is unavailable",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
