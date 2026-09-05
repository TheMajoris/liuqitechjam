import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpSessionContext } from "./tools/mcp-session-service.js";
import { McpSessionService } from "./tools/mcp-session-service.js";
import { ToolApprovalRequiredError, ToolError } from "./tools/tool-errors.js";
import { ToolService } from "./tools/tool-service.js";
import type { SkillService } from "./skills/skill-service.js";
import type { RoleService } from "./roles/role-service.js";
import type { PermitApprovalService } from "./access/permit-approval-service.js";
import type { AuditReader, AuditRecorder } from "./audit/audit-types.js";
import { systemPrincipal } from "./access/access-types.js";
import { correlationAttributes, type RuntimeTelemetry, type TelemetryCarrier } from "./telemetry/telemetry-types.js";
import type { SearchProvider } from "./tools/search-provider.js";
import type { WebFetchAdapter } from "./tools/web-fetch-adapter.js";

export interface McpRouteDependencies {
  sessions: McpSessionService;
  toolService: ToolService;
  /** Optional so isolated Wave 9 route tests can omit the skill plane. */
  skillService?: SkillService;
  /** Optional reusable Agent role-template control plane. */
  roleService?: RoleService;
  /** Optional in isolated tests; production wires the Permit-backed service. */
  approvalService?: PermitApprovalService;
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
  telemetry?: RuntimeTelemetry;
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
  if (error instanceof ToolApprovalRequiredError) {
    return {
      code: error.code,
      message:
        "Approval required for Permit request " +
        error.approvalRequestId +
        ": " +
        error.message +
        ". Explicitly retry the tool after approval.",
    };
  }
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
 * Create one stateless SDK server for one authenticated HTTP request. The
 * session context is closed over by handlers; callers cannot submit a
 * principal, Agent, Project, or run identity as tool input.
 */
export function createMcpServer(
  context: McpSessionContext,
  toolService: ToolService,
): McpServer {
  // The propagation header is a transport concern. Keep it out of the
  // ToolService execution context even though it remains available to the
  // authenticated HTTP boundary as a parent-context fallback.
  const { traceparent: _traceparent, ...toolContext } = context;
  const server = new McpServer({
    name: "lqam",
    version: "1.0.0",
  });
  for (const definition of toolService.getRegistry().list()) {
    server.registerTool(
      definition.id,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: annotationsForRisk(definition.risk),
      },
      async (input: unknown) => {
        try {
          const output = await toolService.execute(toolContext, definition.id, input);
          return {
            structuredContent: output as Record<string, unknown>,
            content: [{ type: "text", text: JSON.stringify(output) }],
          };
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    );
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
    const detailed = token === null ? null : dependencies.sessions.resolveDetailed(token);
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

    const handleRequest = async () => {
      const server = createMcpServer(context, dependencies.toolService);
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
        await writeTransportFailure(reply);
      } finally {
        await server.close().catch(() => undefined);
      }
    };
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
  });
}

export const registerMcpRoutes = registerMcpRoute;
