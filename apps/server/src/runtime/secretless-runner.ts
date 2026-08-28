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
  /** Observation hook for a Kill: what was revoked and cleaned up. */
  onKill?: (outcome: KillOutcome) => void;
}

export interface KillOutcome {
  agentId: string;
  runId: string;
  /** The run lease was revoked at the gateway before Runtime termination. */
  leaseRevoked: boolean;
  /** The inner runner reported it removed a live Runtime container. */
  runtimeRemoved: boolean;
}

export class SecretlessRunner implements AgentRunner {
  private readonly activeByAgent = new Map<string, string>();

  constructor(private readonly options: SecretlessRunnerOptions) {}

  async isAvailable(): Promise<boolean> {
    return this.options.inner.isAvailable();
  }

  async cancel(agentId: string): Promise<boolean> {
    const runId = this.activeByAgent.get(agentId);
    let leaseRevoked = false;
    if (runId !== undefined) {
      // Revoke-first: the lease is dead before the container is touched, so a
      // compromised Runtime cannot race a final provider call during teardown.
      try {
        await this.options.modelAccess.revoke(runId);
        leaseRevoked = true;
      } catch {
        leaseRevoked = false;
      }
    }
    const runtimeRemoved = await this.options.inner.cancel(agentId);
    if (runId !== undefined) {
      this.emitKill({ agentId, runId, leaseRevoked, runtimeRemoved });
    }
    return runtimeRemoved;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const { inner, modelAccess, providerId, model, gatewayUrl } = this.options;
    const runId = request.runId ?? randomUUID();
    const codexHome = path.join(this.options.codexHomeRoot, "runs", runId);

    // Register before the first await so a Kill arriving during setup still
    // finds the run and can revoke its (pending or issued) lease first.
    this.activeByAgent.set(request.agentId, runId);

    try {
      await writeCodexGatewayConfig(codexHome, { gatewayUrl, providerId, model });
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
      this.activeByAgent.delete(request.agentId);
      await rm(codexHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Ensure the run-scoped Codex home root exists. */
  async initialize(): Promise<void> {
    await mkdir(path.join(this.options.codexHomeRoot, "runs"), {
      recursive: true,
    });
  }

  private emitKill(outcome: KillOutcome): void {
    try {
      this.options.onKill?.(outcome);
    } catch {
      // Observation must never break the Kill path.
    }
  }
}
