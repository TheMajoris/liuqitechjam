import {
  GatewayClientError,
  type GatewayManagementClient,
  type IssueLeaseRequest,
} from "./gateway-client.js";

/**
 * `ModelAccess` is the control plane's only door to model execution.
 *
 * It hides lease issue/use/revoke sequencing and guarantees revocation in
 * every terminal path — success, failure, timeout, or a thrown callback. The
 * callback receives an ephemeral Runtime configuration (`RuntimeGatewaySession`)
 * and never a provider credential. There is no direct-key fallback: if the
 * gateway cannot issue a lease, the operation fails closed.
 *
 * See `tasks/plan.md` section 5 (`ModelAccess`) and section 8.
 */

export interface GatewayScope {
  runId: string;
  agentId: string;
  providerId: string;
  model: string;
  projectId?: string;
  orchestrationId?: string;
  /** Requested lease lifetime; the gateway clamps this. */
  ttlSeconds?: number;
}

/**
 * What the `withSession` callback is handed. Enough to point a Runtime at the
 * gateway for one Run — and nothing more.
 */
export interface RuntimeGatewaySession {
  runId: string;
  agentId: string;
  leaseId: string;
  /** Base URL the Runtime uses to reach the gateway data plane. */
  gatewayUrl: string;
  /** Opaque run lease. Presented by the Runtime as `Authorization: Bearer`. */
  leaseToken: string;
  providerId: string;
  model: string;
  expiresAt: string;
}

export interface ModelAccess {
  withSession<T>(
    scope: GatewayScope,
    use: (session: RuntimeGatewaySession) => Promise<T>,
  ): Promise<T>;
  revoke(runId: string): Promise<void>;
}

export type ModelAccessErrorCode = "GATEWAY_UNAVAILABLE" | "LEASE_REQUEST_REJECTED";

/** Stable fail-closed error surfaced to callers of `withSession`. */
export class ModelAccessError extends Error {
  constructor(
    readonly code: ModelAccessErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModelAccessError";
  }
}

export interface GatewaySessionEvent {
  kind: "gateway.lease" | "gateway.revoke";
  status: "ok" | "error";
  scope: GatewayScope;
  leaseId?: string;
  expiresAt?: string;
  code?: string;
  durationMs: number;
}

export interface GatewayModelAccessOptions {
  client: GatewayManagementClient;
  /** Data-plane base URL handed to the Runtime (usually `MODEL_GATEWAY_URL`). */
  gatewayUrl: string;
  now?: () => number;
  /** Optional structured observation hook for gateway.lease / gateway.revoke. */
  onEvent?: (event: GatewaySessionEvent) => void;
}

interface ActiveLease {
  leaseId: string;
  /** Guards against a double revoke racing the `finally` and an explicit call. */
  revoking: Promise<void> | null;
  revoked: boolean;
}

export class GatewayModelAccess implements ModelAccess {
  private readonly client: GatewayManagementClient;
  private readonly gatewayUrl: string;
  private readonly now: () => number;
  private readonly onEvent: (event: GatewaySessionEvent) => void;
  private readonly active = new Map<string, ActiveLease>();

  constructor(options: GatewayModelAccessOptions) {
    this.client = options.client;
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
    this.now = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async withSession<T>(
    scope: GatewayScope,
    use: (session: RuntimeGatewaySession) => Promise<T>,
  ): Promise<T> {
    const session = await this.issue(scope);
    try {
      return await use(session);
    } finally {
      await this.revoke(scope.runId);
    }
  }

  async revoke(runId: string): Promise<void> {
    const entry = this.active.get(runId);
    if (!entry) {
      return; // idempotent: nothing issued, or already cleaned up
    }
    if (entry.revoking) {
      await entry.revoking;
      return;
    }
    if (entry.revoked) {
      return;
    }
    if (entry.leaseId === "") {
      // Issuance is still in flight or failed; nothing was minted upstream.
      this.active.delete(runId);
      return;
    }
    const started = this.now();
    entry.revoking = (async () => {
      try {
        await this.client.revokeLease(entry.leaseId);
        entry.revoked = true;
        this.emit("gateway.revoke", "ok", { runId } as GatewayScope, {
          leaseId: entry.leaseId,
          durationMs: this.now() - started,
        });
      } catch (error) {
        // Best-effort: a revoke that cannot reach the gateway is logged, but the
        // lease is short-lived and the in-memory registry drops on restart.
        this.emit("gateway.revoke", "error", { runId } as GatewayScope, {
          leaseId: entry.leaseId,
          code: error instanceof GatewayClientError ? error.kind : "REVOKE_FAILED",
          durationMs: this.now() - started,
        });
      } finally {
        this.active.delete(runId);
      }
    })();
    await entry.revoking;
  }

  private async issue(scope: GatewayScope): Promise<RuntimeGatewaySession> {
    if (this.active.has(scope.runId)) {
      throw new ModelAccessError(
        "LEASE_REQUEST_REJECTED",
        `Run ${scope.runId} already holds an active gateway session`,
      );
    }
    const request: IssueLeaseRequest = {
      runId: scope.runId,
      agentId: scope.agentId,
      providerId: scope.providerId,
      model: scope.model,
      scope: "responses:create",
      ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
      ...(scope.orchestrationId !== undefined
        ? { orchestrationId: scope.orchestrationId }
        : {}),
      ...(scope.ttlSeconds !== undefined ? { ttlSeconds: scope.ttlSeconds } : {}),
    };

    // Reserve the run slot synchronously so a concurrent `withSession` for the
    // same run is rejected before it can request a second lease.
    const reservation: ActiveLease = {
      leaseId: "",
      revoking: null,
      revoked: false,
    };
    this.active.set(scope.runId, reservation);

    const started = this.now();
    try {
      const lease = await this.client.issueLease(request);
      reservation.leaseId = lease.leaseId;
      this.emit("gateway.lease", "ok", scope, {
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt,
        durationMs: this.now() - started,
      });
      return {
        runId: scope.runId,
        agentId: scope.agentId,
        leaseId: lease.leaseId,
        gatewayUrl: this.gatewayUrl,
        leaseToken: lease.token,
        providerId: scope.providerId,
        model: scope.model,
        expiresAt: lease.expiresAt,
      };
    } catch (error) {
      this.active.delete(scope.runId); // release the reservation; nothing minted
      const code: ModelAccessErrorCode =
        error instanceof GatewayClientError &&
        error.kind === "LEASE_REQUEST_REJECTED"
          ? "LEASE_REQUEST_REJECTED"
          : "GATEWAY_UNAVAILABLE";
      this.emit("gateway.lease", "error", scope, {
        code:
          error instanceof GatewayClientError
            ? (error.code ?? error.kind)
            : "LEASE_ISSUE_FAILED",
        durationMs: this.now() - started,
      });
      throw new ModelAccessError(
        code,
        code === "GATEWAY_UNAVAILABLE"
          ? "Model gateway is unavailable; failing closed with no direct provider access"
          : `Model gateway rejected the lease request: ${(error as Error).message}`,
        error,
      );
    }
  }

  private emit(
    kind: GatewaySessionEvent["kind"],
    status: GatewaySessionEvent["status"],
    scope: GatewayScope,
    extra: {
      leaseId?: string;
      expiresAt?: string;
      code?: string;
      durationMs: number;
    },
  ): void {
    try {
      this.onEvent({ kind, status, scope, ...extra });
    } catch {
      // An observation hook must never break lease lifecycle.
    }
  }
}
