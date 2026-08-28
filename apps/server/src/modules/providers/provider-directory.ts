import type { AppConfig } from "../../config.js";
import { isSecretlessProfile } from "../../config.js";

/**
 * Safe, browser-shareable provider descriptor. Carries no base URL that would
 * enable proxy abuse, no key-env name, and no credential value.
 */
export interface ProviderSummary {
  id: string;
  protocol: "responses";
  models: string[];
  credentialMode: "gateway-managed";
  /** `mock` is always healthy; a live provider is `unknown` until first use. */
  health: "ok" | "degraded" | "unknown";
  live: boolean;
}

/**
 * Derives the provider catalog the control plane exposes at `GET /api/providers`
 * purely from trusted configuration. The gateway process owns the authoritative
 * catalog and the credentials; this is the redacted projection for the UI.
 */
export class ProviderDirectory {
  constructor(private readonly config: AppConfig) {}

  list(): ProviderSummary[] {
    const summaries: ProviderSummary[] = [
      {
        id: "mock",
        protocol: "responses",
        models: ["mock-responses-1", "mock-model"],
        credentialMode: "gateway-managed",
        health: "ok",
        live: false,
      },
    ];

    const liveId = this.config.runtimeProviderId;
    if (liveId && liveId !== "mock") {
      const model =
        this.config.runtimeModelId || this.config.arkModel || "not-configured";
      summaries.push({
        id: liveId,
        protocol: "responses",
        models: [model],
        credentialMode: "gateway-managed",
        health: isSecretlessProfile(this.config) ? "unknown" : "degraded",
        live: true,
      });
    }
    return summaries;
  }
}
