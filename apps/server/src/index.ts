import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { OrchestrationControl } from "./modules/orchestration/orchestration-control.js";
import { ProjectService } from "./modules/projects/project-service.js";
import { ProjectWorkspaceManager } from "./modules/projects/project-workspace.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
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

const app = await createApp(config, service, { projects, orchestration });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
