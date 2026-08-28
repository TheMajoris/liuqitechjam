import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeCodexGatewayConfig } from "../config.js";
import type { ModelAccess } from "../modules/model-access/model-access.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";

/**
 * The protected local Runtime seam.
 *
 * `SecretlessRunner` wraps the existing container runner and {@link ModelAccess}.
 * For every turn it acquires a run-scoped gateway lease, writes a run-scoped
 * Codex home whose only credential reference is `MODEL_GATEWAY_TOKEN`, and hands
 * the inner runner a {@link RunnerRequest} carrying that lease — never a provider
 * key. The lease is revoked in `finally` and the run-scoped Codex home is
 * removed. If the gateway cannot issue a lease the turn fails closed: the inner
 * runner is never started.
 *
 * Host-process execution (`CodexRunner`) remains an explicitly ungoverned
 * developer fallback and is not wrapped here.
 */
export interface SecretlessRunnerOptions {
  inner: AgentRunner;
  modelAccess: ModelAccess;
  /** Allowlisted provider id every lease from this runner is bound to. */
  providerId: string;
  /** Model id every lease from this runner is bound to. */
  model: string;
  /** Data-plane base URL the Runtime uses to reach the gateway. */
  gatewayUrl: string;
  /** Parent directory for run-scoped Codex homes. */
  codexHomeRoot: string;
  /** Requested lease lifetime; the gateway clamps it. */
  leaseTtlSeconds?: number;
}

export class SecretlessRunner implements AgentRunner {
  constructor(private readonly options: SecretlessRunnerOptions) {}

  async isAvailable(): Promise<boolean> {
    return this.options.inner.isAvailable();
  }

  async cancel(agentId: string): Promise<boolean> {
    // Terminating the inner container rejects the in-flight `withSession`
    // callback, whose `finally` revokes the lease. Revoke-first Kill is layered
    // on in a later task.
    return this.options.inner.cancel(agentId);
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const { inner, modelAccess, providerId, model, gatewayUrl } = this.options;
    const runId = request.runId ?? randomUUID();
    const codexHome = path.join(this.options.codexHomeRoot, "runs", runId);

    await writeCodexGatewayConfig(codexHome, { gatewayUrl, providerId, model });

    try {
      return await modelAccess.withSession(
        {
          runId,
          agentId: request.agentId,
          providerId,
          model,
          ...(this.options.leaseTtlSeconds !== undefined
            ? { ttlSeconds: this.options.leaseTtlSeconds }
            : {}),
        },
        (session) =>
          inner.run({
            ...request,
            runId,
            gateway: {
              gatewayUrl: session.gatewayUrl,
              leaseToken: session.leaseToken,
              providerId,
              model,
              codexHome,
            },
          }),
      );
    } finally {
      await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Ensure the run-scoped Codex home root exists. */
  async initialize(): Promise<void> {
    await mkdir(path.join(this.options.codexHomeRoot, "runs"), {
      recursive: true,
    });
  }
}
