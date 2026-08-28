import { buildGatewayApp } from "./app.js";
import { describeProviders, loadGatewayConfig } from "./config.js";
import { LeaseRegistry } from "./lease-registry.js";
import { ProviderCatalog } from "./provider-catalog.js";

// Gateway composition root. This process is the only one permitted to read a
// provider credential value (resolved inside `loadGatewayConfig`).
const config = loadGatewayConfig();
const catalog = new ProviderCatalog(config.providers);
const leases = new LeaseRegistry();

const app = await buildGatewayApp(config, { catalog, leases });

const sweepTimer = setInterval(() => {
  leases.sweepExpired();
}, 60_000);
sweepTimer.unref();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "gateway shutting down");
  clearInterval(sweepTimer);
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });

app.log.info(
  {
    host: config.host,
    port: config.port,
    providers: describeProviders(config),
  },
  "model gateway listening",
);
