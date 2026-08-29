import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import {
  isSupervisorConfigured,
  loadConfig,
  writeCodexConfig,
} from "./config.js";
import { createRunner } from "./runner-factory.js";
import { createModelRegistry, createWorkerModelResolver } from "./models/index.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { OrchestrationService } from "./orchestration/orchestration-service.js";
import {
  ArkResponsesSupervisorProvider,
  createOrchestrationParticipantSelector,
} from "./orchestration/supervisor/index.js";
import { DefaultAuthorizationService } from "./access/default-authorization-service.js";
import { LocalContainerPreviewRuntime } from "./preview/local-container-preview-runtime.js";
import { PreviewCommandResolver } from "./preview/preview-command-resolver.js";
import {
  PreviewService,
  previewResourceLimitsFromConfig,
} from "./preview/preview-service.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const workerModelResolver = createWorkerModelResolver(config);
const modelRegistry = createModelRegistry(config, {
  workerResolver: workerModelResolver,
});
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  workerModelResolver,
);
const previewService = new PreviewService(
  store,
  service,
  new LocalContainerPreviewRuntime(config),
  new PreviewCommandResolver(),
  new DefaultAuthorizationService(),
  { resourceLimits: previewResourceLimitsFromConfig(config) },
);
service.setPreviewLifecycle(previewService);
await service.initialize();
await previewService.initialize();

const supervisorSelector = isSupervisorConfigured(config)
  ? createOrchestrationParticipantSelector(
      new ArkResponsesSupervisorProvider({
        apiKey: config.arkApiKey,
        baseUrl: config.arkBaseUrl,
        model: config.supervisorModel,
        timeoutMs: config.supervisorTimeoutMs,
      }),
    )
  : undefined;
const orchestrationService = new OrchestrationService({
  store,
  agentService: service,
  ...(supervisorSelector === undefined
    ? {}
    : { selectNextParticipant: supervisorSelector }),
  supervisorTimeoutMs: config.supervisorTimeoutMs,
});
await orchestrationService.initialize();

const app = await createApp(
  config,
  service,
  orchestrationService,
  modelRegistry,
  previewService,
);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await orchestrationService.shutdown();
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
