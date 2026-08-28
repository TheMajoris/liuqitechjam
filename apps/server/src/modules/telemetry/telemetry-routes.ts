import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { isSecretlessProfile } from "../../config.js";
import type { JsonStore } from "../../store.js";
import type { ProviderDirectory } from "../providers/provider-directory.js";
import type { TelemetryLedger } from "./telemetry-ledger.js";

const runIdParams = z.object({ id: z.string().uuid() });

export interface TelemetryRouteDeps {
  config: AppConfig;
  store: JsonStore;
  ledger: TelemetryLedger;
  providers: ProviderDirectory;
}

/**
 * Registers the redacted read surfaces:
 *   GET /api/providers                     safe provider descriptors
 *   GET /api/runs/:id/observability        correlated spans, usage, counts
 *   GET /api/security/posture              protected asset + recent evidence
 */
export function registerTelemetryRoutes(
  app: FastifyInstance,
  deps: TelemetryRouteDeps,
): void {
  app.get("/api/providers", async () => ({ providers: deps.providers.list() }));

  app.get("/api/runs/:id/observability", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return deps.ledger.inspectRun(id);
  });

  app.get("/api/security/posture", async () => {
    const db = deps.store.snapshot();
    const security = db.telemetry
      .filter(
        (record) =>
          record.kind === "security.deny" ||
          record.kind === "security.kill" ||
          record.kind === "gateway.revoke",
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 25)
      .map((record) => ({
        at: record.startedAt,
        kind: record.kind,
        status: record.status,
        code: record.code ?? null,
        runId: record.runId ?? null,
        orchestrationId: record.orchestrationId ?? null,
      }));

    const secretless = isSecretlessProfile(deps.config);
    return {
      protectedAsset: "Long-lived model-provider credential",
      track: "Kill Switch",
      profile: secretless ? "secretless-gateway" : "baseline",
      controls: [
        {
          id: "gateway-sidecar",
          label: "Provider credential isolated to the gateway process",
          active: secretless,
        },
        {
          id: "run-scoped-lease",
          label: "Runtime holds an opaque, short-lived, run-scoped lease only",
          active: secretless,
        },
        {
          id: "gateway-only-network",
          label: "Runtime can reach the gateway and nothing else",
          active: secretless,
        },
        {
          id: "revoke-first-kill",
          label: "Kill revokes the lease before terminating the Runtime",
          active: true,
        },
        {
          id: "pre-persistence-redaction",
          label: "Telemetry previews are redacted before they are stored",
          active: true,
        },
      ],
      gateway: {
        mode: secretless ? "gateway-managed" : "direct-key (developer fallback)",
        url: secretless ? deps.config.modelGatewayUrl : null,
      },
      recentEvents: security,
    };
  });
}
