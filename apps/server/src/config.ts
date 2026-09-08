import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_ARK_MANAGEMENT_BASE_URL,
  DEFAULT_ARK_MANAGEMENT_MAX_RESPONSE_BYTES,
  DEFAULT_ARK_MANAGEMENT_REGION,
  DEFAULT_ARK_MANAGEMENT_TIMEOUT_MS,
} from "./models/ark-management-client.js";

export const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
export const MCP_TOKEN_GRACE_MS = 60_000;
export const DEFAULT_MCP_TOKEN_TTL_MS =
  DEFAULT_CODEX_TIMEOUT_MS + MCP_TOKEN_GRACE_MS;
/** Keep accidental no-expiry deployments bounded while covering long runs. */
export const MAX_MCP_TOKEN_TTL_MS = 86_400_000;
export const DEFAULT_WEB_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_WEB_FETCH_MAX_REDIRECTS = 3;

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  PERSISTENCE_BACKEND: z.enum(["json", "postgres"]).optional(),
  DATABASE_URL: z.string().trim().optional(),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(MAX_MCP_TOKEN_TTL_MS - MCP_TOKEN_GRACE_MS)
    .default(DEFAULT_CODEX_TIMEOUT_MS),
  // Bounds the largest single stdout line held in memory, not a turn's total
  // output. Codex echoes every command's full output through the JSON event
  // stream, so a total-volume budget would fail long but healthy turns.
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  // Stable, unique owner namespace for one concurrently running deployment.
  // Never reuse an ID across installations that share a container engine.
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  /** Server-only BytePlus management credentials used for signed ModelArk calls. */
  BYTEPLUS_ACCESS_KEY: z.string().trim().optional(),
  BYTEPLUS_SECRET_KEY: z.string().trim().optional(),
  BYTEPLUS_REGION: z.string().trim().min(1).max(64).default(DEFAULT_ARK_MANAGEMENT_REGION),
  BYTEPLUS_MANAGEMENT_BASE_URL: z
    .string()
    .trim()
    .url()
    .default(DEFAULT_ARK_MANAGEMENT_BASE_URL),
  BYTEPLUS_MANAGEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(DEFAULT_ARK_MANAGEMENT_TIMEOUT_MS),
  BYTEPLUS_MANAGEMENT_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(4_096)
    .max(4 * 1024 * 1024)
    .default(DEFAULT_ARK_MANAGEMENT_MAX_RESPONSE_BYTES),
  /** Comma-separated worker model IDs that are safe for the Codex runtime. */
  WORKER_CURATED_MODELS: z.string().default(""),
  WORKER_MODEL_LIST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  WORKER_MODEL_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(600_000),
  SUPERVISOR_MODEL: z.string().optional(),
  SUPERVISOR_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  /** Per-run platform MCP endpoint used by local Codex workers. */
  MCP_PUBLIC_URL: z.string().trim().url().optional(),
  /** Explicit host-reachable MCP endpoint used from container workers. */
  MCP_CONTAINER_URL: z.string().trim().url().optional(),
  // An explicit value is allowed for deployments with a shorter-lived policy;
  // the default below is derived from CODEX_TIMEOUT_MS instead of this field.
  MCP_TOKEN_TTL_MS: z.coerce.number().int().min(1_000).max(MAX_MCP_TOKEN_TTL_MS).optional(),
  /** Opt in to per-run MCP catalogue scoping. Omission preserves legacy advertisement. */
  MCP_SCOPED_ADVERTISEMENT: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Local-first by default; Brave remains available as an explicit option. */
  SEARCH_PROVIDER: z.enum(["searxng", "brave", "disabled"]).default("searxng"),
  SEARXNG_URL: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return !parsed.username && !parsed.password &&
          !parsed.search && !parsed.hash &&
          (parsed.protocol === "http:" || parsed.protocol === "https:");
      } catch {
        return false;
      }
    }, "SEARXNG_URL must be an HTTP(S) URL without embedded credentials or query data")
    .default("http://127.0.0.1:8080/search"),
  SEARXNG_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  SEARXNG_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(5),
  SEARXNG_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(4_096)
    .max(4 * 1024 * 1024)
    .default(512 * 1024),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  BRAVE_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  BRAVE_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(5),
  WEB_FETCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(DEFAULT_WEB_FETCH_TIMEOUT_MS),
  WEB_FETCH_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(4_096)
    .max(4 * 1024 * 1024)
    .default(DEFAULT_WEB_FETCH_MAX_RESPONSE_BYTES),
  WEB_FETCH_MAX_REDIRECTS: z.coerce
    .number()
    .int()
    .min(0)
    .max(5)
    .default(DEFAULT_WEB_FETCH_MAX_REDIRECTS),
  /** Standard OpenTelemetry exporter selection; none is safe by default. */
  OTEL_TRACES_EXPORTER: z.enum(["none", "console", "otlp"]).default("none"),
  OTEL_SERVICE_NAME: z.string().trim().min(1).max(128).default("lqam-server"),
  /** Supply the complete OTLP/HTTP traces endpoint when using the OTLP path. */
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().trim().url().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.ap-southeast.bytepluses.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const persistenceBackend = env.PERSISTENCE_BACKEND ??
    (env.NODE_ENV === "test" ? "json" : "postgres");
  const databaseUrl = env.DATABASE_URL ?? "";
  if (persistenceBackend === "postgres") {
    let valid = false;
    try {
      const url = new URL(databaseUrl);
      valid = ["postgres:", "postgresql:"].includes(url.protocol) && !!url.hostname;
    } catch { /* Report configuration without exposing the connection secret. */ }
    if (!valid) throw new Error("PERSISTENCE_BACKEND=postgres requires a valid DATABASE_URL");
  }
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  const workerCuratedModels = Array.from(
    new Set(
      env.WORKER_CURATED_MODELS.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    persistenceBackend,
    databaseUrl,
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    byteplusAccessKey: env.BYTEPLUS_ACCESS_KEY?.trim() ?? "",
    byteplusSecretKey: env.BYTEPLUS_SECRET_KEY?.trim() ?? "",
    byteplusRegion: env.BYTEPLUS_REGION.trim(),
    byteplusManagementBaseUrl: env.BYTEPLUS_MANAGEMENT_BASE_URL.replace(/\/+$/u, ""),
    byteplusManagementTimeoutMs: env.BYTEPLUS_MANAGEMENT_TIMEOUT_MS,
    byteplusManagementMaxResponseBytes: env.BYTEPLUS_MANAGEMENT_MAX_RESPONSE_BYTES,
    workerCuratedModels,
    workerModelListTimeoutMs: env.WORKER_MODEL_LIST_TIMEOUT_MS,
    workerModelCacheTtlMs: env.WORKER_MODEL_CACHE_TTL_MS,
    supervisorModel: env.SUPERVISOR_MODEL?.trim() || "",
    supervisorTimeoutMs: env.SUPERVISOR_TIMEOUT_MS,
    mcpPublicUrl:
      env.MCP_PUBLIC_URL?.trim() || `http://127.0.0.1:${env.PORT}/mcp`,
    mcpContainerUrl: env.MCP_CONTAINER_URL?.trim() || "",
    mcpTokenTtlMs:
      env.MCP_TOKEN_TTL_MS ?? env.CODEX_TIMEOUT_MS + MCP_TOKEN_GRACE_MS,
    mcpScopedAdvertisement: env.MCP_SCOPED_ADVERTISEMENT,
    searchProvider: env.SEARCH_PROVIDER,
    searxngUrl: env.SEARXNG_URL.replace(/\/+$/, ""),
    searxngTimeoutMs: env.SEARXNG_TIMEOUT_MS,
    searxngMaxResults: env.SEARXNG_MAX_RESULTS,
    searxngMaxResponseBytes: env.SEARXNG_MAX_RESPONSE_BYTES,
    braveSearchApiKey: env.BRAVE_SEARCH_API_KEY?.trim() ?? "",
    braveSearchTimeoutMs: env.BRAVE_SEARCH_TIMEOUT_MS,
    braveSearchMaxResults: env.BRAVE_SEARCH_MAX_RESULTS,
    webFetchTimeoutMs: env.WEB_FETCH_TIMEOUT_MS,
    webFetchMaxResponseBytes: env.WEB_FETCH_MAX_RESPONSE_BYTES,
    webFetchMaxRedirects: env.WEB_FETCH_MAX_REDIRECTS,
    telemetryExporter: env.OTEL_TRACES_EXPORTER,
    telemetryServiceName: env.OTEL_SERVICE_NAME,
    telemetryEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-")
  );
}

/** Whether the shared Ark credentials and resolved supervisor model are usable. */
export function isSupervisorConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.supervisorModel.length > 0 &&
    !config.supervisorModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Liu Qi Agent Management (LQAM). Edit environment variables, not this file.",
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
