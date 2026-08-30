import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_CODEX_TIMEOUT_MS = 600_000;
export const MCP_TOKEN_GRACE_MS = 60_000;
export const DEFAULT_MCP_TOKEN_TTL_MS =
  DEFAULT_CODEX_TIMEOUT_MS + MCP_TOKEN_GRACE_MS;
/** Keep accidental no-expiry deployments bounded while covering long runs. */
export const MAX_MCP_TOKEN_TTL_MS = 86_400_000;
export const DEFAULT_PERMIT_CHECK_TIMEOUT_MS = 5_000;

const PERMIT_PRODUCTION_FIELDS = [
  "PERMIT_API_KEY",
  "PERMIT_PDP_URL",
  "PERMIT_PROJECT_ID",
  "PERMIT_ENVIRONMENT_ID",
  "PERMIT_TENANT_KEY",
  "PERMIT_OPERATION_APPROVAL_CONFIG_ID",
] as const;

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
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
  ARK_MODEL: z.string().optional(),
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
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  BRAVE_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
  BRAVE_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(5),
  /** Standard OpenTelemetry exporter selection; none is safe by default. */
  OTEL_TRACES_EXPORTER: z.enum(["none", "console", "otlp"]).default("none"),
  OTEL_SERVICE_NAME: z.string().trim().min(1).max(128).default("launchpad-server"),
  /** Supply the complete OTLP/HTTP traces endpoint when using the OTLP path. */
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().trim().url().optional(),
  /** Permit credentials are optional outside production, but never trusted when absent. */
  PERMIT_API_KEY: z.string().trim().optional(),
  PERMIT_PDP_URL: z.string().trim().url().optional(),
  PERMIT_PROJECT_ID: z.string().trim().min(1).optional(),
  PERMIT_ENVIRONMENT_ID: z.string().trim().min(1).optional(),
  PERMIT_TENANT_KEY: z.string().trim().min(1).optional(),
  /** Required in production so the Wave 11 approval path has an explicit policy target. */
  PERMIT_OPERATION_APPROVAL_CONFIG_ID: z.string().trim().min(1).optional(),
  /** API-only Access Request element config used for persistent grants. */
  PERMIT_ACCESS_REQUEST_CONFIG_ID: z.string().trim().min(1).optional(),
  /** Permit Cloud API base; PDP remains the separate decision endpoint. */
  PERMIT_API_URL: z.string().trim().url().default("https://api.permit.io"),
  PERMIT_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(DEFAULT_PERMIT_CHECK_TIMEOUT_MS),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  if (env.NODE_ENV === "production") {
    const missing = PERMIT_PRODUCTION_FIELDS.filter((field) => {
      const value = env[field];
      return typeof value !== "string" || value.length === 0 || value.startsWith("replace-");
    });
    if (missing.length > 0) {
      throw new Error(
        "Permit authorization configuration is required in production: " +
          missing.join(", "),
      );
    }
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
      [env.ARK_MODEL ?? "", ...env.WORKER_CURATED_MODELS.split(",")]
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
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
    arkModel: env.ARK_MODEL?.trim() ?? "",
    workerCuratedModels,
    workerModelListTimeoutMs: env.WORKER_MODEL_LIST_TIMEOUT_MS,
    workerModelCacheTtlMs: env.WORKER_MODEL_CACHE_TTL_MS,
    supervisorModel: env.SUPERVISOR_MODEL?.trim() || env.ARK_MODEL?.trim() || "",
    supervisorTimeoutMs: env.SUPERVISOR_TIMEOUT_MS,
    mcpPublicUrl:
      env.MCP_PUBLIC_URL?.trim() || `http://127.0.0.1:${env.PORT}/mcp`,
    mcpContainerUrl: env.MCP_CONTAINER_URL?.trim() || "",
    mcpTokenTtlMs:
      env.MCP_TOKEN_TTL_MS ?? env.CODEX_TIMEOUT_MS + MCP_TOKEN_GRACE_MS,
    braveSearchApiKey: env.BRAVE_SEARCH_API_KEY?.trim() ?? "",
    braveSearchTimeoutMs: env.BRAVE_SEARCH_TIMEOUT_MS,
    braveSearchMaxResults: env.BRAVE_SEARCH_MAX_RESULTS,
    telemetryExporter: env.OTEL_TRACES_EXPORTER,
    telemetryServiceName: env.OTEL_SERVICE_NAME,
    telemetryEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || "",
    permitApiKey: env.PERMIT_API_KEY?.trim() ?? "",
    permitPdpUrl: env.PERMIT_PDP_URL?.trim() ?? "",
    permitProjectId: env.PERMIT_PROJECT_ID?.trim() ?? "",
    permitEnvironmentId: env.PERMIT_ENVIRONMENT_ID?.trim() ?? "",
    permitTenantKey: env.PERMIT_TENANT_KEY?.trim() ?? "",
    permitOperationApprovalConfigId:
      env.PERMIT_OPERATION_APPROVAL_CONFIG_ID?.trim() ?? "",
    permitAccessRequestConfigId:
      env.PERMIT_ACCESS_REQUEST_CONFIG_ID?.trim() ?? "",
    permitApiUrl: env.PERMIT_API_URL.replace(/\/+$/, ""),
    permitCheckTimeoutMs: env.PERMIT_CHECK_TIMEOUT_MS,
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

/** Permit authorization/operation-approval configuration is all-or-nothing. */
export function isPermitConfigured(config: AppConfig): boolean {
  return (
    config.permitApiKey.length > 0 &&
    !config.permitApiKey.startsWith("replace-") &&
    config.permitPdpUrl.length > 0 &&
    config.permitProjectId.length > 0 &&
    !config.permitProjectId.startsWith("replace-") &&
    config.permitEnvironmentId.length > 0 &&
    !config.permitEnvironmentId.startsWith("replace-") &&
    config.permitTenantKey.length > 0 &&
    !config.permitTenantKey.startsWith("replace-") &&
    config.permitOperationApprovalConfigId.length > 0 &&
    !config.permitOperationApprovalConfigId.startsWith("replace-")
  );
}

/** Persistent project access is an optional Wave 11 extension. */
export function isPermitAccessRequestConfigured(config: AppConfig): boolean {
  return (
    isPermitConfigured(config) &&
    config.permitAccessRequestConfigId.length > 0 &&
    !config.permitAccessRequestConfigId.startsWith("replace-")
  );
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
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
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
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
