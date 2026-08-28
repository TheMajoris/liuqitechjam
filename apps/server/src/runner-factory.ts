import { randomUUID } from "node:crypto";
import path from "node:path";
import { isSecretlessProfile, type AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { HttpGatewayManagementClient } from "./modules/model-access/gateway-client.js";
import { GatewayModelAccess } from "./modules/model-access/model-access.js";
import type { TelemetryLedger } from "./modules/telemetry/telemetry-ledger.js";
import { SecretlessRunner } from "./runtime/secretless-runner.js";
import type { AgentRunner } from "./types.js";

export interface RunnerFactoryDeps {
  telemetry?: TelemetryLedger;
}

export function createRunner(
  config: AppConfig,
  deps: RunnerFactoryDeps = {},
): AgentRunner {
  if (config.runtimeProvider !== "container") {
    // Host-process execution: explicitly ungoverned developer fallback.
    return new CodexRunner(config);
  }

  const container = new ContainerCodexRunner(config);
  if (!isSecretlessProfile(config)) {
    return container;
  }

  const telemetry = deps.telemetry;
  const modelAccess = new GatewayModelAccess({
    client: new HttpGatewayManagementClient({
      baseUrl: config.modelGatewayUrl,
      adminToken: config.gatewayAdminToken,
    }),
    gatewayUrl: config.modelGatewayUrl,
    ...(telemetry
      ? {
          onEvent: (event) => {
            void telemetry.append({
              traceId: event.scope.orchestrationId ?? event.scope.runId,
              spanId: randomUUID(),
              parentSpanId: null,
              kind: event.kind,
              name: event.kind,
              status: event.status === "ok" ? "ok" : "error",
              startedAt: new Date(Date.now() - event.durationMs).toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: event.durationMs,
              runId: event.scope.runId,
              agentId: event.scope.agentId,
              ...(event.scope.orchestrationId
                ? { orchestrationId: event.scope.orchestrationId }
                : {}),
              ...(event.code ? { code: event.code } : {}),
            });
          },
        }
      : {}),
  });

  return new SecretlessRunner({
    inner: container,
    modelAccess,
    providerId: config.runtimeProviderId,
    model: config.runtimeModelId || config.runtimeProviderId,
    gatewayUrl: config.modelGatewayUrl,
    codexHomeRoot: path.join(config.codexHome, "secretless"),
    ...(telemetry
      ? {
          onKill: (outcome) => {
            void telemetry.append({
              traceId: outcome.runId,
              spanId: randomUUID(),
              parentSpanId: null,
              kind: "security.kill",
              name: "security.kill",
              status: outcome.leaseRevoked ? "ok" : "error",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: 0,
              runId: outcome.runId,
              agentId: outcome.agentId,
              code: outcome.leaseRevoked ? "LEASE_REVOKED" : "REVOKE_FAILED",
              preview: {
                leaseRevoked: outcome.leaseRevoked,
                runtimeRemoved: outcome.runtimeRemoved,
              },
            });
          },
        }
      : {}),
  });
}
