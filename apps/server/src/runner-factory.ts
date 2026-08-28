import path from "node:path";
import { isSecretlessProfile, type AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { HttpGatewayManagementClient } from "./modules/model-access/gateway-client.js";
import { GatewayModelAccess } from "./modules/model-access/model-access.js";
import { SecretlessRunner } from "./runtime/secretless-runner.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  if (config.runtimeProvider !== "container") {
    // Host-process execution: explicitly ungoverned developer fallback.
    return new CodexRunner(config);
  }

  const container = new ContainerCodexRunner(config);
  if (!isSecretlessProfile(config)) {
    return container;
  }

  const modelAccess = new GatewayModelAccess({
    client: new HttpGatewayManagementClient({
      baseUrl: config.modelGatewayUrl,
      adminToken: config.gatewayAdminToken,
    }),
    gatewayUrl: config.modelGatewayUrl,
  });
  return new SecretlessRunner({
    inner: container,
    modelAccess,
    providerId: config.runtimeProviderId,
    model: config.runtimeModelId || config.runtimeProviderId,
    gatewayUrl: config.modelGatewayUrl,
    codexHomeRoot: path.join(config.codexHome, "secretless"),
  });
}
