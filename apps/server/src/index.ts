import { bootstrapApplication } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

// Database credentials are consumed by the server through the validated
// config object. Remove them from the inherited environment before any Agent
// worker or Codex child can observe process.env. Migration-owner credentials
// must never reach a runtime child process.
for (const key of [
  "DATABASE_ADMIN_URL",
  "DATABASE_RUNTIME_PASSWORD",
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
  "BYTEPLUS_ACCESS_KEY",
  "BYTEPLUS_SECRET_KEY",
]) {
  delete process.env[key];
}

const application = await bootstrapApplication(config);

const exitAfterShutdown = async (signal: string): Promise<void> => {
  await application.shutdown(signal);
  process.exit(0);
};
process.on("SIGTERM", () => void exitAfterShutdown("SIGTERM"));
process.on("SIGINT", () => void exitAfterShutdown("SIGINT"));

await application.app.listen({ host: config.host, port: config.port });
