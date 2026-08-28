import { z } from "zod";
import type { ProviderProtocol } from "./types.js";

/**
 * Gateway composition root configuration. This is the ONLY process module
 * permitted to read provider credential values. Credential values are resolved
 * here into `GatewayProviderConfig.apiKey` and are never logged or returned by
 * any interface.
 */

const protocolSchema = z.enum(["mock", "responses-http"]);

const baseSchema = z.object({
  MODEL_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MODEL_GATEWAY_HOST: z.string().min(1).default("127.0.0.1"),
  MODEL_GATEWAY_ADMIN_TOKEN: z
    .string()
    .min(24, "MODEL_GATEWAY_ADMIN_TOKEN must be at least 24 characters")
    .regex(
      /^[A-Za-z0-9._~-]+$/,
      "MODEL_GATEWAY_ADMIN_TOKEN must use URL-safe characters",
    ),
  LOG_LEVEL: z.string().min(1).default("info"),
  GATEWAY_PROVIDERS: z.string().optional(),
});

export interface GatewayProviderConfig {
  id: string;
  protocol: ProviderProtocol;
  /** Fixed provider base URL for `responses-http`; `null` for `mock`. */
  baseUrl: string | null;
  /** Allowlisted model ids for this provider. */
  models: string[];
  /** Name of the env var that held the key. Kept for diagnostics only. */
  keyEnv: string | null;
  /** Resolved credential VALUE. Never log, never serialize, never return. */
  apiKey: string | null;
}

export interface GatewayConfig {
  host: string;
  port: number;
  logLevel: string;
  adminToken: string;
  providers: GatewayProviderConfig[];
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function envKeyFragment(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function parseProviders(env: NodeJS.ProcessEnv): GatewayProviderConfig[] {
  const ids = splitList(env.GATEWAY_PROVIDERS);
  if (ids.length === 0) {
    return [
      {
        id: "mock",
        protocol: "mock",
        baseUrl: null,
        models: ["mock-model"],
        keyEnv: null,
        apiKey: null,
      },
    ];
  }

  const seen = new Set<string>();
  const providers: GatewayProviderConfig[] = [];
  for (const id of ids) {
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new Error(`Invalid gateway provider id: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate gateway provider id: ${id}`);
    }
    seen.add(id);

    const fragment = envKeyFragment(id);
    const protocol = protocolSchema.parse(env[`PROVIDER_${fragment}_PROTOCOL`]);
    const models = splitList(env[`PROVIDER_${fragment}_MODELS`]);
    if (models.length === 0) {
      throw new Error(`PROVIDER_${fragment}_MODELS must list at least one model id`);
    }

    if (protocol === "mock") {
      providers.push({
        id,
        protocol,
        baseUrl: null,
        models,
        keyEnv: null,
        apiKey: null,
      });
      continue;
    }

    const baseUrl = z
      .string()
      .url(`PROVIDER_${fragment}_BASE_URL must be a valid URL`)
      .parse(env[`PROVIDER_${fragment}_BASE_URL`])
      .replace(/\/+$/, "");
    const keyEnv = z
      .string()
      .min(1, `PROVIDER_${fragment}_KEY_ENV is required`)
      .parse(env[`PROVIDER_${fragment}_KEY_ENV`]);
    const apiKey = env[keyEnv];
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        `Provider ${id} credential env ${keyEnv} is unset or empty`,
      );
    }

    providers.push({
      id,
      protocol,
      baseUrl,
      models,
      keyEnv,
      apiKey,
    });
  }
  return providers;
}

export function loadGatewayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const env = baseSchema.parse(environment);
  return {
    host: env.MODEL_GATEWAY_HOST,
    port: env.MODEL_GATEWAY_PORT,
    logLevel: env.LOG_LEVEL,
    adminToken: env.MODEL_GATEWAY_ADMIN_TOKEN,
    providers: parseProviders(environment),
  };
}

/** Safe view of provider configuration for startup logging. No credentials. */
export function describeProviders(
  config: GatewayConfig,
): Array<{ id: string; protocol: ProviderProtocol; models: string[] }> {
  return config.providers.map((provider) => ({
    id: provider.id,
    protocol: provider.protocol,
    models: [...provider.models],
  }));
}
