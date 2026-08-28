/**
 * HTTP adapter for the gateway's private management interface.
 *
 * Only the control plane holds the gateway-admin capability. This client speaks
 * the two management endpoints from `tasks/plan.md` section 8:
 *
 *   POST /internal/leases
 *   POST /internal/leases/:id/revocations
 *
 * It never reads or forwards a provider credential; it exchanges an admin token
 * for an opaque run-scoped lease.
 */

export interface IssueLeaseRequest {
  runId: string;
  agentId: string;
  providerId: string;
  model: string;
  scope: "responses:create";
  projectId?: string;
  orchestrationId?: string;
  ttlSeconds?: number;
}

export interface IssuedLease {
  leaseId: string;
  token: string;
  expiresAt: string;
}

/** Small use-case port so `ModelAccess` can be tested without HTTP. */
export interface GatewayManagementClient {
  issueLease(request: IssueLeaseRequest): Promise<IssuedLease>;
  revokeLease(leaseId: string): Promise<void>;
}

export type GatewayClientErrorKind =
  | "GATEWAY_UNAVAILABLE"
  | "LEASE_REQUEST_REJECTED";

/**
 * Raised for every management-interface failure. `kind` distinguishes a
 * transport/5xx problem (retryable, fail-closed) from a deterministic 4xx
 * rejection (caller error). Neither path ever yields a direct provider key.
 */
export class GatewayClientError extends Error {
  constructor(
    readonly kind: GatewayClientErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpGatewayClientOptions {
  /** Base URL of the gateway, e.g. `http://127.0.0.1:4000` (no trailing slash). */
  baseUrl: string;
  /** Gateway-admin capability. Held by the control plane only. */
  adminToken: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout. Default 5s — management calls are local and fast. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "AbortError" || error.name === "TimeoutError");

export class HttpGatewayManagementClient implements GatewayManagementClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: HttpGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.adminToken = options.adminToken;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async issueLease(request: IssueLeaseRequest): Promise<IssuedLease> {
    const response = await this.send("/internal/leases", request);
    if (response.status === 201) {
      const body = (await this.readJson(response)) as Partial<IssuedLease>;
      if (
        typeof body.leaseId !== "string" ||
        typeof body.token !== "string" ||
        typeof body.expiresAt !== "string"
      ) {
        throw new GatewayClientError(
          "GATEWAY_UNAVAILABLE",
          "Gateway returned a malformed lease response",
          response.status,
        );
      }
      return { leaseId: body.leaseId, token: body.token, expiresAt: body.expiresAt };
    }
    throw await this.errorFor(response, "issue a lease");
  }

  async revokeLease(leaseId: string): Promise<void> {
    const path = `/internal/leases/${encodeURIComponent(leaseId)}/revocations`;
    const response = await this.send(path, {});
    // The management endpoint is idempotent; any 2xx (or 404 for an unknown id)
    // means "not usable anymore", which is all the caller needs.
    if (response.ok || response.status === 404) {
      return;
    }
    throw await this.errorFor(response, "revoke a lease");
  }

  private async send(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.adminToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        throw new GatewayClientError(
          "GATEWAY_UNAVAILABLE",
          "Gateway management request timed out",
        );
      }
      throw new GatewayClientError(
        "GATEWAY_UNAVAILABLE",
        "Gateway management interface is unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  private async errorFor(
    response: Response,
    action: string,
  ): Promise<GatewayClientError> {
    const body = (await this.readJson(response)) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code : undefined;
    // 4xx is a deterministic caller error (unknown provider, disallowed model,
    // bad admin token). 5xx / anything else is treated as unavailable so the
    // caller fails closed rather than retrying blindly.
    const kind: GatewayClientErrorKind =
      response.status >= 400 && response.status < 500
        ? "LEASE_REQUEST_REJECTED"
        : "GATEWAY_UNAVAILABLE";
    return new GatewayClientError(
      kind,
      `Gateway refused to ${action} (status ${response.status}${code ? `, ${code}` : ""})`,
      response.status,
      code,
    );
  }
}
