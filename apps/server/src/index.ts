import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { FixedPipeline } from "./modules/orchestration/fixed-pipeline.js";
import { OrchestrationControl } from "./modules/orchestration/orchestration-control.js";
import { ProjectService } from "./modules/projects/project-service.js";
import { ProjectWorkspaceManager } from "./modules/projects/project-workspace.js";
import { ProviderDirectory } from "./modules/providers/provider-directory.js";
import { TelemetryLedger } from "./modules/telemetry/telemetry-ledger.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);

const ledger = new TelemetryLedger({
  store,
  secretValues: () =>
    [config.arkApiKey, config.gatewayAdminToken, config.authToken].filter(
      (value) => value.length > 0,
    ),
});
const providers = new ProviderDirectory(config);

const runner = createRunner(config, { telemetry: ledger });
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const projects = new ProjectService(
  store,
  new ProjectWorkspaceManager(config.projectWorkspaceRoot),
);
await projects.initialize();

const orchestration = new OrchestrationControl(store, {
  queueLimit: config.orchestrationQueueLimit,
});
await orchestration.reconcileAfterRestart();

const pipeline = new FixedPipeline({
  store,
  control: orchestration,
  runner,
  telemetry: ledger,
});
pipeline.start();

const app = await createApp(config, service, {
  projects,
  orchestration,
  telemetry: { config, store, ledger, providers },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  pipeline.stop();
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
