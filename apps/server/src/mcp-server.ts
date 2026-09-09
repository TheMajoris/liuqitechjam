import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpSessionContext } from "./tools/mcp-session-service.js";
import { McpSessionService } from "./tools/mcp-session-service.js";
import { ToolError } from "./tools/tool-errors.js";
import { ToolService } from "./tools/tool-service.js";
import type { SkillService } from "./skills/skill-service.js";
import type { RoleService } from "./roles/role-service.js";
import type { AuditReader, AuditRecorder } from "./audit/audit-types.js";
import { systemPrincipal } from "./access/access-types.js";
import type { AuthorizationService } from "./access/authorization-service.js";
import { correlationAttributes, type RuntimeTelemetry, type TelemetryCarrier } from "./telemetry/telemetry-types.js";
import type { SearchProvider } from "./tools/search-provider.js";
import type { WebFetchAdapter } from "./tools/web-fetch-adapter.js";
import type { ToolApprovalService } from "./tools/tool-approval-service.js";

export interface McpRouteDependencies {
  sessions: McpSessionService;
  toolService: ToolService;
  /** Explicit opt-in switch for scoped discovery; omitted preserves legacy advertisement. */
  legacyFullAdvertisement?: boolean;
  /** Optional so isolated Wave 9 route tests can omit the skill plane. */
  skillService?: SkillService;
  /** Optional reusable Agent role-template control plane. */
  roleService?: RoleService;
  /**
   * Server-owned activity projection. Reads are the primary contract;
   * `record` is optional and used only by the HTTP route layer to append
   * human-intent control-action events (start/stop/approve/etc).
   */
  auditService?: AuditReader & Partial<AuditRecorder>;
  /** The selected provider is exposed only through safe health metadata. */
  searchProvider?: SearchProvider;
  /** Safe public-only fetcher reused for explicit skill Markdown imports. */
  webFetch?: Pick<WebFetchAdapter, "fetch">;
  /** Optional native approval bridge. Missing bridge remains fail-closed. */
  approvalService?: ToolApprovalService;
  /** Explicit approval deployment mode; disabled preserves legacy behavior. */
  approvalFeatureEnabled?: boolean;
  /** Startup health of the durable/native approval dependencies. */
  approvalAvailable?: boolean;
  /**
   * Optional Project policy authority for the human approval control plane.
   * The bridge is deliberately not constructed here; startup wiring may add
   * both dependencies when the approval feature is enabled.
   */
  authorizationService?: AuthorizationService;
  telemetry?: RuntimeTelemetry;
}

export interface McpServerOptions {
  /** Called only after an authenticated web tool returns PERMISSION_DENIED. */
  onWebToolPermissionDenied?: (runId: string) => void;
  /** Safe rollback hook; omitted preserves the historical full registry. */
  legacyFullAdvertisement?: boolean;
  /** Optional native approval bridge for sensitive Agent tool calls. */
  approvalService?: ToolApprovalService;
  /** Approval mode is fixed for the accepted Run; never downgrade on failure. */
  approvalFeatureEnabled?: boolean;
  /** Sensitive tools are unavailable until startup has completed all checks. */
  approvalAvailable?: boolean;
  /** Originating request signal used to fence a lost MCP response. */
  signal?: AbortSignal;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(ip: string): boolean {
  return LOOPBACK_ADDRESSES.has(ip);
}

function annotationsForRisk(
  risk: "read" | "write" | "network" | "external_write" | "high_cost",
): ToolAnnotations {
  if (risk === "read" || risk === "network") {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: risk === "network",
    };
  }
  return {
    readOnlyHint: false,
    destructiveHint: risk === "external_write" || risk === "high_cost",
    idempotentHint: risk === "write",
    openWorldHint: false,
  };
}

function safeToolError(error: unknown): { code: string; message: string } {
  if (error instanceof ToolError) {
    return { code: error.code, message: error.message };
  }
  return { code: "TOOL_EXECUTION_FAILED", message: "The tool could not complete" };
}

function toolErrorResult(error: unknown): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  const safe = safeToolError(error);
  return {
    isError: true,
    content: [{ type: "text", text: safe.code + ": " + safe.message }],
  };
}

/**
 * Codex 0.111's Responses/Ark bridge terminates a turn without a final
 * assistant message when an MCP result includes structuredContent. Keep the
 * same JSON payload in the required text content block instead; this is
 * accepted by older and newer MCP clients and lets the model continue after
 * an approved call.
 */
function toolSuccessResult(output: unknown): {
  content: [{ type: "text"; text: string }];
} {
  const serialized = JSON.stringify(output);
  return {
    content: [{ type: "text", text: serialized === undefined ? "null" : serialized }],
  };
}

/**
 * Create one stateless SDK server for one authenticated HTTP request. The
 * session context is closed over by handlers; callers cannot submit a
 * principal, Agent, Project, or run identity as tool input.
 */
export function createMcpServer(
  context: McpSessionContext,
  toolService: ToolService,
  options: McpServerOptions = {},
): McpServer {
  // The propagation header is a transport concern. Keep it out of the
  // ToolService execution context even though it remains available to the
  // authenticated HTTP boundary as a parent-context fallback.
  const {
    traceparent: _traceparent,
    expiresAt: _expiresAt,
    sessionId: _sessionId,
    deadlineAt: _deadlineAt,
    advertisedToolIds,
    diagnostics,
    ...toolContext
  } = context;
  void _traceparent;
  void _expiresAt;
  void _sessionId;
  void _deadlineAt;
  void diagnostics;
  const server = new McpServer({
    name: "lqam",
    version: "1.0.0",
  });
  const registryDefinitions = toolService.getRegistry().list();
  const approvalUnavailable =
    options.approvalFeatureEnabled === true && options.approvalAvailable !== true;
  const registeredDefinitions = advertisedToolIds === undefined
    ? diagnostics?.resolutionStatus === "failed" || options.legacyFullAdvertisement === false
      ? []
      : approvalUnavailable
        ? registryDefinitions.filter((definition) => definition.approvalPolicy?.mode !== "required")
        : registryDefinitions
    : (() => {
        const snapshot = new Set(advertisedToolIds);
        return registryDefinitions.filter((definition) => snapshot.has(definition.id));
      })();
  for (const definition of registeredDefinitions) {
    server.registerTool(
      definition.id,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        // Do not advertise an output schema here. Codex 0.111's MCP bridge
        // requires structuredContent whenever outputSchema is present, while
        // its Ark path cannot continue a turn after that response shape. The
        // text content below remains the canonical JSON result for clients.
        annotations: annotationsForRisk(definition.risk),
      },
      async (input: unknown) => {
        try {
          const approvalMode = definition.approvalPolicy?.mode;
          if (
            context.principal.kind === "agent" &&
            approvalMode === "required" &&
            (
              options.approvalService === undefined ||
              (options.approvalFeatureEnabled === true && options.approvalAvailable !== true)
            )
          ) {
            // Do not let a missing bridge turn a sensitive definition into a
            // direct executor call, including when this server is composed
            // with a test/demonstration ToolService adapter.
            throw new ToolError(
              "APPROVAL_REQUIRED",
              409,
              "The approval bridge is unavailable for this Agent tool",
            );
          }
          const output = options.approvalService
            ? await options.approvalService.execute(toolContext, definition.id, input, {
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                expiresAt: context.expiresAt,
                sessionId: context.sessionId,
                ...(context.traceparent === undefined ? {} : { traceparent: context.traceparent }),
                ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }),
              })
            : await toolService.execute(toolContext, definition.id, input);
          return toolSuccessResult(output);
        } catch (error) {
          if (
            error instanceof ToolError &&
            error.code === "PERMISSION_DENIED" &&
            (definition.id === "web.search" || definition.id === "web.fetch")
          ) {
            options.onWebToolPermissionDenied?.(context.runId);
          }
          return toolErrorResult(error);
        }
      },
    );
  }
  // McpServer lazily installs its tools handlers from registerTool(). A
  // fail-closed empty snapshot has no definition to trigger that setup, so
  // install the read-only empty catalogue handler directly without inventing
  // a dummy executable tool.
  if (registeredDefinitions.length === 0) {
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }
  return server;
}

async function writeTransportFailure(reply: FastifyReply): Promise<void> {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  reply.raw.statusCode = 500;
  reply.raw.setHeader("content-type", "application/json");
  reply.raw.end(JSON.stringify({ error: "MCP request failed" }));
}

/** Register the official Streamable HTTP MCP endpoint on a Fastify app. */
export function registerMcpRoute(
  app: FastifyInstance,
  dependencies: McpRouteDependencies,
  path = "/mcp",
): void {
  app.all(path, async (request, reply) => {
    // Authentication happens before creating the SDK server or request
    // context. The token itself is never placed in an error or log payload.
    const token = bearerToken(request);
    const detailed = token === null ? null : await dependencies.sessions.resolveDetailedAndAwait(token);
    if (!detailed || detailed.context === null) {
      const reason = detailed === null ? "missing" : detailed.reason;
      void dependencies.auditService
        ?.record?.({
          type: "mcp_session_rejected",
          status: "failure",
          summary: "MCP session rejected",
          principal: systemPrincipal(),
          actorType: "system",
          metadata: { reason, loopback: isLoopback(request.ip) },
        })
        ?.catch((error) => console.warn("audit write failed", error));
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Bearer realm="launchpad-mcp"')
        .send({ error: "Authentication required" });
    }
    const context = detailed.context;

    // A pending approval is tied to this live HTTP response. Aborting the
    // signal on an early socket close lets the approval bridge close its
    // application fence before any late decision can resume the workflow.
    const requestAbort = dependencies.approvalService === undefined
      ? undefined
      : new AbortController();
    const onRequestAborted = () => {
      // IncomingMessage.aborted is authoritative even if the response object
      // has already been marked destroyed or ended by the transport.
      requestAbort?.abort();
    };
    const onResponseClosed = () => {
      // A normal completed response also emits `close`; only an unwritten
      // response means the originating MCP call was lost.
      if (!reply.raw.writableEnded) requestAbort?.abort();
    };
    if (requestAbort !== undefined) {
      request.raw.once("aborted", onRequestAborted);
      reply.raw.once("close", onResponseClosed);
    }

    const configuredCatalogueSize = context.diagnostics?.configuredCatalogueSize ??
      dependencies.toolService.getRegistry().list().length;
    const advertisedToolCount = context.diagnostics?.advertisedToolCount ??
      context.advertisedToolIds?.length ??
      (context.diagnostics?.resolutionStatus === "failed" ||
      dependencies.legacyFullAdvertisement === false
        ? 0
        : configuredCatalogueSize);
    if (
      context.diagnostics?.configuredCatalogueSize === undefined ||
      context.diagnostics.advertisedToolCount === undefined
    ) {
      dependencies.sessions.recordCatalogueObservation(
        context.runId,
        configuredCatalogueSize,
        advertisedToolCount,
      );
    }
    dependencies.sessions.observeToolsListMessage(context.runId, request.body);

    const handleRequest = async () => {
      const server = createMcpServer(context, dependencies.toolService, {
        ...(dependencies.legacyFullAdvertisement === undefined
          ? {}
          : { legacyFullAdvertisement: dependencies.legacyFullAdvertisement }),
        onWebToolPermissionDenied: (runId) => {
          dependencies.sessions.markWebToolPermissionDenied(runId);
        },
        ...(dependencies.approvalService === undefined
          ? {}
          : { approvalService: dependencies.approvalService }),
        ...(dependencies.approvalFeatureEnabled === undefined
          ? {}
          : { approvalFeatureEnabled: dependencies.approvalFeatureEnabled }),
        ...(dependencies.approvalAvailable === undefined
          ? {}
          : { approvalAvailable: dependencies.approvalAvailable }),
        ...(requestAbort === undefined ? {} : { signal: requestAbort.signal }),
      });
      const transport = new StreamableHTTPServerTransport(
        {
          // A transport is created for each authenticated request. Explicitly
          // disable SDK session IDs so the bearer session remains the sole
          // identity boundary and later stateless requests do not depend on a
          // lost in-memory transport session.
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
      );
      // The SDK owns the raw response once hijacked. This keeps Fastify from
      // attempting to serialize a response after Streamable HTTP has finished.
      reply.hijack();
      try {
        // The SDK's Node transport currently has an exact-optional callback
        // variance mismatch under this project's strict compiler settings; it
        // still implements the runtime Transport contract.
        await server.connect(
          transport as unknown as Parameters<McpServer["connect"]>[0],
        );
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        requestAbort?.abort();
        await writeTransportFailure(reply);
      } finally {
        await server.close().catch(() => undefined);
      }
    };
    try {
      if (dependencies.telemetry) {
        const incomingCarrier = {
          ...(request.headers as TelemetryCarrier),
          ...(context.traceparent === undefined ||
          (request.headers.traceparent !== undefined)
            ? {}
            : { traceparent: context.traceparent }),
        };
        const parent = dependencies.telemetry.extract(
          incomingCarrier,
        );
        await dependencies.telemetry.withSpan(
          "mcp.request",
          {
            ...correlationAttributes({
              principalKind: context.principal.kind,
              principalId: context.principal.id,
              agentId: context.agentId,
              ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
              runId: context.runId,
              ...(context.orchestrationId === undefined
                ? {}
                : { orchestrationId: context.orchestrationId }),
            }),
            "mcp.method": request.method,
          },
          handleRequest,
          parent,
        );
      } else {
        await handleRequest();
      }
    } finally {
      if (requestAbort !== undefined) {
        request.raw.off("aborted", onRequestAborted);
        reply.raw.off("close", onResponseClosed);
      }
    }
  });
}

export const registerMcpRoutes = registerMcpRoute;
