import { z } from "zod";
import type { Principal } from "../access/access-types.js";
import type { PreviewOwnerRef, PreviewView } from "../preview/preview-types.js";
import { redactSensitiveText } from "../orchestration/handoff.js";
import { isHttpUrl } from "./brave-search-adapter.js";
import type { SearchResult } from "./search-provider.js";
import type { WebFetchResult } from "./web-fetch-adapter.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolError } from "./tool-errors.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "./tool-types.js";

const MAX_SAFE_REASON_LENGTH = 512;

const SearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  count: z.coerce.number().int().min(1).max(20).optional(),
});
const SearchResultSchema = z.object({
  title: z.string().trim().max(300),
  url: z
    .string()
    .trim()
    .url()
    .max(2_048)
    .refine(isHttpUrl, "Only HTTP(S) result URLs are allowed"),
  description: z.string().trim().max(1_000),
});
const SearchOutputSchema = z.object({ results: SearchResultSchema.array().max(20) });
const FetchInputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .url()
    .refine(isHttpUrl, "Only HTTP(S) URLs can be fetched"),
  maxBytes: z.coerce.number().int().min(4_096).max(4 * 1024 * 1024).optional(),
});
const FetchOutputSchema = z.object({
  url: z.string().url(),
  finalUrl: z.string().url(),
  status: z.number().int().min(200).max(299),
  contentType: z.string().trim().min(1).max(128),
  content: z.string().max(4 * 1024 * 1024),
});

const PreviewViewSchema = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  projectId: z.string().nullable(),
  status: z.enum(["starting", "running", "stopping", "stopped", "failed", "interrupted"]),
  host: z.literal("127.0.0.1"),
  hostPort: z.number().int().positive().nullable(),
  url: z.string().url().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  updatedAt: z.string(),
});
const EmptyInputSchema = z.object({});

export interface ToolPreviewService {
  get(owner: PreviewOwnerRef, principal?: Principal): Promise<PreviewView>;
  restart(owner: PreviewOwnerRef, principal?: Principal): Promise<PreviewView>;
}

/** Narrow search seam keeps definitions independent of the provider adapter. */
export interface ToolSearchService {
  search(query: string, count?: number): Promise<SearchResult[]>;
}

export interface ToolFetchService {
  fetch(url: string, maxBytes?: number): Promise<WebFetchResult>;
}

export interface BuiltInToolDependencies {
  search: ToolSearchService;
  fetch: ToolFetchService;
  preview: ToolPreviewService;
}

function safeReason(value: string): string {
  const redacted = redactSensitiveText(value).trim();
  if (redacted.length <= MAX_SAFE_REASON_LENGTH) return redacted;
  return redacted.slice(0, MAX_SAFE_REASON_LENGTH - 14).trimEnd() + " [TRUNCATED]";
}

/**
 * Build the platform-owned tools. The executor only receives trusted context
 * from ToolService; no MCP/HTTP input can choose a Project owner.
 */
export function createBuiltInToolDefinitions(
  dependencies: BuiltInToolDependencies,
): ToolDefinition<unknown, unknown>[] {
  return [
    {
      id: "project.preview.inspect",
      title: "Inspect Project Preview",
      description: "Read the current status and URL of the shared Project preview.",
      risk: "read",
      requiredPermission: "tool.execute:project.preview.inspect",
      inputSchema: EmptyInputSchema,
      outputSchema: PreviewViewSchema,
      async execute(context) {
        if (!context.projectId) {
          throw new ToolError(
            "PERMISSION_DENIED",
            403,
            "A Project-scoped run is required for this tool",
          );
        }
        return dependencies.preview.get(
          { kind: "project", projectId: context.projectId },
          context.principal,
        );
      },
    },
    {
      id: "project.preview.restart",
      title: "Restart Project Preview",
      description: "Restart the shared Project preview server.",
      risk: "write",
      requiredPermission: "tool.execute:project.preview.restart",
      inputSchema: EmptyInputSchema,
      outputSchema: PreviewViewSchema,
      async execute(context) {
        if (!context.projectId) {
          throw new ToolError(
            "PERMISSION_DENIED",
            403,
            "A Project-scoped run is required for this tool",
          );
        }
        return dependencies.preview.restart(
          { kind: "project", projectId: context.projectId },
          context.principal,
        );
      },
    },
    {
      id: "web.search",
      title: "Web Search",
      description: "Search the public web through the platform's bounded Brave adapter.",
      risk: "network",
      requiredPermission: "tool.execute:web.search",
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      async execute(context, input) {
        const parsed = SearchInputSchema.parse(input);
        const results = await dependencies.search.search(parsed.query, parsed.count);
        return { results };
      },
    },
    {
      id: "web.fetch",
      title: "Fetch Web Page",
      description: "Read a bounded public HTTP(S) page supplied by the caller.",
      risk: "network",
      requiredPermission: "tool.execute:web.fetch",
      inputSchema: FetchInputSchema,
      outputSchema: FetchOutputSchema,
      async execute(_context, input) {
        const parsed = FetchInputSchema.parse(input);
        return dependencies.fetch.fetch(parsed.url, parsed.maxBytes);
      },
    },
  ];
}

export function createBuiltInToolRegistry(
  dependencies: BuiltInToolDependencies,
): ToolRegistry {
  return new ToolRegistry(createBuiltInToolDefinitions(dependencies));
}

export const createToolRegistry = createBuiltInToolRegistry;
