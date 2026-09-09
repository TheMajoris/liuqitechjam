import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { humanPrincipal } from "../access/access-types.js";
import {
  isAuthorizationError,
  type AuthorizationService,
} from "../access/authorization-service.js";
import type { AgentRun } from "../types.js";
import { HttpError } from "../errors.js";
import { ToolError } from "../tools/tool-errors.js";
import {
  TOOL_APPROVAL_STATUSES,
  ToolApprovalStoreError,
  type ToolApprovalDecisionInput,
  type ToolApprovalInvocationRecord,
  type ToolApprovalPublicDto,
  type ToolApprovalStore,
  type ToolApprovalStatus,
} from "../tools/tool-approval-store.js";
import type { ToolApprovalService } from "../tools/tool-approval-service.js";
import {
  approvalDecisionAuthorityForTool,
  type ToolApprovalDecisionAuthority,
} from "../tools/tool-types.js";
import {
  toolApprovalDecisionBody,
  toolApprovalIdParams,
  toolApprovalListQuery,
} from "./route-schemas.js";

const ACTIVE_APPROVAL_STATUSES = new Set<ToolApprovalStatus>(
  ["requested", "waiting", "approved", "resuming", "executing"] as const,
);

const TERMINAL_APPROVAL_STATUSES = new Set<ToolApprovalStatus>(
  [
    "succeeded",
    "rejected",
    "failed_pre_execution",
    "failed",
    "expired",
    "cancelled",
    "revoked",
    "uncertain",
  ] as const,
);

type ApprovalStoreReader = Pick<
  ToolApprovalStore,
  "get" | "listPublic" | "getPublic" | "getPublicByInvocationId" | "ownerEpoch"
>;

/**
 * Safe control-plane projection consumed by the browser and activity feeds.
 * `canDecide` is computed here from current server-owned witnesses; clients
 * must never infer it from status or stale cached scope fields.
 */
export type ToolApprovalRouteDto = ToolApprovalPublicDto & {
  readonly canDecide: boolean;
};

/**
 * The HTTP layer receives only server-owned seams. In particular, it does not
 * receive a principal resolver, binding, or workflow Run supplied by a
 * request. The composition root may omit these dependencies while approval
 * mode is disabled; such routes fail closed with 503.
 */
export interface ToolApprovalRouteDependencies {
  readonly approvalService?: Pick<
    ToolApprovalService,
    "approvalStore" | "decide" | "cancel" | "expire" | "hasPending"
  > & Partial<Pick<ToolApprovalService, "isAvailable" | "isAdmissionEnabled">>;
  readonly authorization?: Pick<AuthorizationService, "require">;
  /** Alias used by composition roots that name the dependency explicitly. */
  readonly authorizationService?: Pick<AuthorizationService, "require">;
  /** Historical Run lookup; absent only in isolated read-only fixtures. */
  readonly getRun?: (
    runId: string,
  ) => Pick<AgentRun, "id" | "agentId" | "projectId" | "status"> | null | Promise<Pick<AgentRun, "id" | "agentId" | "projectId" | "status"> | null>;
  /** Optional liveness witness for the server-owned MCP session. */
  readonly isSessionLive?: (
    sessionId: string,
    record: ToolApprovalInvocationRecord,
  ) => boolean | Promise<boolean>;
  /** Optional current Agent authorization witness supplied by the composition root. */
  readonly authorizeAgent?: (
    record: ToolApprovalInvocationRecord,
  ) => void | Promise<void>;
  /** Resolves the current code-owned authority for the registered tool. */
  readonly resolveDecisionAuthority?: (
    toolId: string,
  ) => ToolApprovalDecisionAuthority | null | undefined;
  readonly now?: () => number;
}

type RequiredDecisionWitnesses = {
  readonly getRun: NonNullable<ToolApprovalRouteDependencies["getRun"]>;
  readonly isSessionLive: NonNullable<ToolApprovalRouteDependencies["isSessionLive"]>;
  readonly authorizeAgent: NonNullable<ToolApprovalRouteDependencies["authorizeAgent"]>;
};

function requireApprovalService(
  dependencies: ToolApprovalRouteDependencies,
): NonNullable<ToolApprovalRouteDependencies["approvalService"]> {
  if (dependencies.approvalService === undefined) {
    throw new HttpError(503, "Tool approvals are not configured");
  }
  return dependencies.approvalService;
}

function requireAuthorization(
  dependencies: ToolApprovalRouteDependencies,
): NonNullable<ToolApprovalRouteDependencies["authorization"]> {
  const authorization = dependencies.authorization ?? dependencies.authorizationService;
  if (authorization === undefined) {
    throw new HttpError(503, "Tool approval authorization is not configured");
  }
  return authorization;
}

/**
 * Decision mutation is a capability-sensitive operation.  An enabled
 * approval service must be composed with every independent server-owned
 * witness before a human decision can be accepted.  Read-only fixtures may
 * omit these dependencies, but a mutation must fail closed rather than
 * silently skipping a liveness or Agent recheck.
 */
function requireDecisionWitnesses(
  dependencies: ToolApprovalRouteDependencies,
): RequiredDecisionWitnesses {
  if (
    dependencies.getRun === undefined ||
    dependencies.isSessionLive === undefined ||
    dependencies.authorizeAgent === undefined
  ) {
    throw new HttpError(
      503,
      "Tool approval liveness checks are not configured",
    );
  }
  return {
    getRun: dependencies.getRun,
    isSessionLive: dependencies.isSessionLive,
    authorizeAgent: dependencies.authorizeAgent,
  };
}

function requireBridgeAvailability(
  service: NonNullable<ToolApprovalRouteDependencies["approvalService"]>,
): void {
  // Older isolated route fixtures may omit these optional methods. The real
  // composition always supplies both; when supplied, an unhealthy bridge must
  // reject decisions just as it rejects new MCP admissions.
  if (
    service.isAvailable !== undefined &&
    service.isAdmissionEnabled !== undefined &&
    (!service.isAvailable() || !service.isAdmissionEnabled())
  ) {
    throw new HttpError(503, "Tool approval bridge is unavailable");
  }
}

function notFound(): HttpError {
  // Reads intentionally do not distinguish a missing invocation from a
  // Project the deterministic human is not allowed to see.
  return new HttpError(404, "Approval not found");
}

function invalidated(message = "The approval invocation is no longer valid"): ToolError {
  return new ToolError("TOOL_INVOCATION_INVALIDATED", 409, message);
}

function staleDecision(): ToolError {
  return invalidated("The approval version is stale");
}

function mapStoreError(error: unknown): unknown {
  if (!(error instanceof ToolApprovalStoreError)) return error;
  switch (error.code) {
    case "NOT_FOUND":
      return new HttpError(404, "Approval not found");
    case "EXPIRED":
      return new ToolError("TOOL_EXECUTION_EXPIRED", 409, "The approval deadline has elapsed");
    case "STALE_VERSION":
      return staleDecision();
    case "CONFLICTING_DECISION":
      return invalidated("A conflicting approval decision already exists");
    case "FOREIGN_BINDING":
    case "OWNER_EPOCH_MISMATCH":
    case "PRIVATE_STATE_UNAVAILABLE":
    case "EXECUTION_CLAIM_INVALID":
    case "INVALID_TRANSITION":
      return invalidated();
    case "INVALID_RECORD":
      return new HttpError(422, "The approval decision is invalid");
    default:
      return invalidated();
  }
}

function recordFor(
  store: ApprovalStoreReader,
  approvalId: string,
): ToolApprovalInvocationRecord {
  const record = store.get(approvalId);
  if (record === null) throw notFound();
  return record;
}

function publicRecordFor(
  store: ApprovalStoreReader,
  approvalId: string,
): ToolApprovalInvocationRecord {
  const record = store.get(approvalId);
  if (record === null) throw notFound();
  return record;
}

function decisionAuthorityFor(
  dependencies: ToolApprovalRouteDependencies,
  toolId: string,
): ToolApprovalDecisionAuthority | null {
  try {
    if (dependencies.resolveDecisionAuthority !== undefined) {
      return dependencies.resolveDecisionAuthority(toolId) ?? null;
    }
    // Isolated tests and old persisted projections may not have a registry
    // seam. Only the immutable server-owned mapping is used as a fallback;
    // no authority field is read from a request or public DTO.
    return approvalDecisionAuthorityForTool(toolId);
  } catch {
    return null;
  }
}

/**
 * Require the server-registered tool's deterministic decision authority.
 *
 * The registered authority names the permission; the *record's* scope names
 * whose ownership is checked. A Project-scoped invocation is decided by that
 * Project's owner. A direct Agent run has no Project, so it is decided by the
 * local human who owns the Agent — the same authority that already controls
 * Agent-owned previews. Without this second branch a direct run could raise
 * an approval (web.search is reachable with no Project) that no one was ever
 * permitted to see or decide, so it could only expire.
 */
async function requireDecisionAuthority(
  dependencies: ToolApprovalRouteDependencies,
  record: Pick<ToolApprovalInvocationRecord, "projectId" | "toolId" | "agentId">,
  options: { hideUnauthorized: boolean },
): Promise<void> {
  const authority = decisionAuthorityFor(dependencies, record.toolId);
  if (authority === null || authority.kind !== "project-owner") {
    throw new HttpError(503, "Tool approval decision authority is not configured");
  }

  try {
    await requireAuthorization(dependencies).require({
      principal: humanPrincipal(),
      // Permission and owner semantics come from the current registered tool
      // policy, never from the approval request.
      permission: authority.permission,
      ...(record.projectId === null
        ? {
            agentId: record.agentId,
            resource: { kind: "agent", id: record.agentId } as const,
          }
        : {
            projectId: record.projectId,
            resource: { kind: "project", id: record.projectId } as const,
          }),
    });
  } catch (error) {
    if (options.hideUnauthorized && isAuthorizationError(error)) throw notFound();
    throw error;
  }
}

async function visibleToHuman(
  dependencies: ToolApprovalRouteDependencies,
  record: Pick<ToolApprovalInvocationRecord, "projectId" | "toolId" | "agentId">,
): Promise<boolean> {
  try {
    await requireDecisionAuthority(dependencies, record, { hideUnauthorized: true });
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404) return false;
    throw error;
  }
}

/**
 * Compute the one canonical decision eligibility bit. Every witness is
 * intentionally required: an unavailable liveness or authorization callback
 * produces `false`, never a permissive UI hint.
 */
async function computeCanDecide(
  dependencies: ToolApprovalRouteDependencies,
  record: ToolApprovalInvocationRecord,
): Promise<boolean> {
  if (record.status !== "waiting") return false;
  if (record.ownerEpoch !== dependencies.approvalService?.approvalStore.ownerEpoch) return false;
  const now = dependencies.now?.() ?? Date.now();
  const deadline = Date.parse(record.deadlineAt);
  if (!Number.isFinite(deadline) || now >= deadline) return false;
  const service = dependencies.approvalService;
  if (service === undefined || !service.hasPending(record.invocationId)) return false;
  // Availability/admission is a server-owned bridge witness.  A stale browser
  // projection must never present an actionable decision after native storage
  // or process shutdown has fenced the bridge.
  if (service.isAvailable?.() !== true || service.isAdmissionEnabled?.() !== true) return false;
  if (
    dependencies.getRun === undefined ||
    dependencies.isSessionLive === undefined ||
    dependencies.authorizeAgent === undefined ||
    record.sessionId === null
  ) return false;

  try {
    await requireDecisionAuthority(dependencies, record, { hideUnauthorized: true });
    const run = await dependencies.getRun(record.runId);
    if (
      run === null ||
      run === undefined ||
      run.agentId !== record.agentId ||
      (run.projectId ?? null) !== record.projectId ||
      (run.status !== "queued" && run.status !== "running")
    ) return false;
    if (!(await dependencies.isSessionLive(record.sessionId, record))) return false;
    await dependencies.authorizeAgent(record);
    return true;
  } catch {
    return false;
  }
}

async function publicFor(
  dependencies: ToolApprovalRouteDependencies,
  approvalId: string,
): Promise<ToolApprovalRouteDto> {
  const record = publicRecordFor(dependencies.approvalService!.approvalStore, approvalId);
  const projection = dependencies.approvalService!.approvalStore.getPublic(approvalId);
  if (projection === null) throw notFound();
  return {
    ...projection,
    canDecide: await computeCanDecide(dependencies, record),
  };
}

function queryMatches(
  record: Pick<
    ToolApprovalInvocationRecord,
    "agentId" | "projectId" | "runId" | "orchestrationId" | "status"
  >,
  query: z.infer<typeof toolApprovalListQuery>,
): boolean {
  if (query.agentId !== undefined && record.agentId !== query.agentId) return false;
  if (query.projectId !== undefined && record.projectId !== query.projectId) return false;
  if (query.runId !== undefined && record.runId !== query.runId) return false;
  if (query.orchestrationId !== undefined && record.orchestrationId !== query.orchestrationId) return false;
  if (query.status !== undefined && record.status !== query.status) return false;
  // Without an explicit status the collection is the pending control surface;
  // terminal records remain available from the detail route for polling.
  if (query.status === undefined && !ACTIVE_APPROVAL_STATUSES.has(record.status)) return false;
  return true;
}

function sortNewestFirst(
  left: ToolApprovalPublicDto,
  right: ToolApprovalPublicDto,
): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated !== 0 ? updated : right.approvalId.localeCompare(left.approvalId);
}

/**
 * Read the safe approval projection for an existing activity/polling scope.
 * This is intentionally a separate helper so the Run and Project activity
 * routes can add an optional `approvals` field without
 * exposing the private invocation envelope or weakening their existing
 * visibility checks.
 */
export async function listVisibleToolApprovals(
  dependencies: ToolApprovalRouteDependencies,
  filter: {
    readonly projectId?: string;
    readonly runId?: string;
    readonly includeTerminal?: boolean;
    readonly limit?: number;
  } = {},
): Promise<ToolApprovalRouteDto[]> {
  const service = requireApprovalService(dependencies);
  const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 200)));
  const projections: ToolApprovalRouteDto[] = [];
  for (const record of service.approvalStore.listPublic()) {
    if (filter.projectId !== undefined && record.projectId !== filter.projectId) continue;
    if (filter.runId !== undefined && record.runId !== filter.runId) continue;
    if (filter.includeTerminal !== true && TERMINAL_APPROVAL_STATUSES.has(record.status)) continue;
    if (!(await visibleToHuman(dependencies, record))) continue;
    const fullRecord = service.approvalStore.get(record.approvalId);
    if (fullRecord === null) continue;
    projections.push({
      ...record,
      canDecide: await computeCanDecide(dependencies, fullRecord),
    });
  }
  return projections.sort(sortNewestFirst).slice(0, limit);
}

async function closeInvalidated(
  dependencies: ToolApprovalRouteDependencies,
  record: ToolApprovalInvocationRecord,
  message: string,
): Promise<never> {
  try {
    await requireApprovalService(dependencies).cancel(record.invocationId, message);
  } catch {
    // The application fence is already closed or another lifecycle owner won
    // the race. Never turn this path into an approval bypass.
  }
  throw invalidated(message);
}

async function closeExpired(
  dependencies: ToolApprovalRouteDependencies,
  record: ToolApprovalInvocationRecord,
): Promise<never> {
  try {
    await requireApprovalService(dependencies).expire(
      record.invocationId,
      "The approval deadline has elapsed",
    );
  } catch {
    // A concurrent terminal transition is safe and remains fenced.
  }
  throw new ToolError("TOOL_EXECUTION_EXPIRED", 409, "The approval deadline has elapsed");
}

async function recheckLiveInvocation(
  dependencies: ToolApprovalRouteDependencies,
  record: ToolApprovalInvocationRecord,
): Promise<void> {
  const service = requireApprovalService(dependencies);
  const witnesses = requireDecisionWitnesses(dependencies);
  const current = service.approvalStore.get(record.approvalId);
  if (current === null) throw notFound();
  if (current.ownerEpoch !== service.approvalStore.ownerEpoch) {
    await closeInvalidated(dependencies, current, "The approval owner epoch is no longer active");
  }
  if (TERMINAL_APPROVAL_STATUSES.has(current.status)) {
    throw invalidated("The approval invocation is already closed");
  }
  if (current.status !== "waiting") {
    throw invalidated("The approval invocation is not waiting for a decision");
  }
  const now = dependencies.now?.() ?? Date.now();
  const deadline = Date.parse(current.deadlineAt);
  if (!Number.isFinite(deadline) || now >= deadline) {
    await closeExpired(dependencies, current);
  }
  if (service.hasPending && !service.hasPending(current.invocationId)) {
    await closeInvalidated(dependencies, current, "The original MCP call is no longer pending");
  }

  let run: Awaited<ReturnType<RequiredDecisionWitnesses["getRun"]>> = null;
  try {
    run = await witnesses.getRun(current.runId);
  } catch {
    await closeInvalidated(dependencies, current, "The originating Agent Run is no longer live");
  }
  if (run === null || run === undefined) {
    await closeInvalidated(dependencies, current, "The originating Agent Run is no longer live");
    return;
  }
  if (run.agentId !== current.agentId) {
    await closeInvalidated(dependencies, current, "The originating Agent Run is no longer live");
  }
  if ((run.projectId ?? null) !== current.projectId) {
    await closeInvalidated(dependencies, current, "The originating Project scope no longer matches");
  }
  if (run.status !== "queued" && run.status !== "running") {
    await closeInvalidated(dependencies, current, "The originating Agent Run is no longer live");
  }

  const sessionId = current.sessionId;
  if (sessionId === null) {
    await closeInvalidated(dependencies, current, "The originating MCP session is no longer active");
    return;
  }
  let sessionLive = false;
  try {
    sessionLive = await witnesses.isSessionLive(sessionId, current);
  } catch {
    await closeInvalidated(dependencies, current, "The originating MCP session is no longer active");
  }
  if (!sessionLive) {
    await closeInvalidated(dependencies, current, "The originating MCP session is no longer active");
  }

  try {
    await witnesses.authorizeAgent(current);
  } catch {
    await closeInvalidated(dependencies, current, "The Agent is no longer authorized for this invocation");
  }
}

async function decideApproval(
  dependencies: ToolApprovalRouteDependencies,
  approvalId: string,
  input: z.infer<typeof toolApprovalDecisionBody>,
): Promise<ToolApprovalRouteDto> {
  const service = requireApprovalService(dependencies);
  requireBridgeAvailability(service);
  // Check composition before revealing or mutating a decision record.  This
  // keeps every enabled decision path fail-closed, including stale/duplicate
  // requests that would otherwise return early.
  requireDecisionWitnesses(dependencies);
  let record = recordFor(service.approvalStore, approvalId);
  await requireDecisionAuthority(dependencies, record, { hideUnauthorized: false });

  // Refresh after authorization. A competing decision may have completed
  // while the owner check awaited storage, and the duplicate path is
  // intentionally idempotent for the same boolean.
  record = recordFor(service.approvalStore, approvalId);
  const desired = input.approved ? "approved" : "rejected";
  if (record.decision !== null) {
    if (record.decision === desired) return publicFor(dependencies, approvalId);
    throw invalidated("A conflicting approval decision already exists");
  }
  if (record.version !== input.expectedVersion) throw staleDecision();

  await recheckLiveInvocation(dependencies, record);
  const decision: ToolApprovalDecisionInput = {
    approvalId,
    expectedVersion: input.expectedVersion,
    approved: input.approved,
    // This is deliberately resolved here. No request field can replace it.
    actor: humanPrincipal(),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  try {
    await service.decide(decision);
  } catch (error) {
    throw mapStoreError(error);
  }
  return publicFor(dependencies, approvalId);
}

/** Register the minimal trusted human approval control surface. */
export function registerToolApprovalRoutes(
  app: FastifyInstance,
  dependencies: ToolApprovalRouteDependencies,
): void {
  app.get("/api/approvals", async (request) => {
    const service = requireApprovalService(dependencies);
    const query = toolApprovalListQuery.parse(request.query);
    const projections: ToolApprovalRouteDto[] = [];
    for (const record of service.approvalStore.listPublic()) {
      if (!queryMatches(record as ToolApprovalInvocationRecord, query)) continue;
      // listPublic returns only safe DTO data; the owner check is still
      // required so an approval ID is never a visibility grant.
      if (!(await visibleToHuman(dependencies, record))) continue;
      const fullRecord = service.approvalStore.get(record.approvalId);
      if (fullRecord === null) continue;
      projections.push({
        ...record,
        canDecide: await computeCanDecide(dependencies, fullRecord),
      });
    }
    // Visibility filtering must precede ordering and limiting.  Otherwise a
    // storage-order prefix could hide the newest authorized approvals.
    projections.sort(sortNewestFirst);
    return { approvals: projections.slice(0, query.limit) };
  });

  app.get("/api/approvals/:approvalId", async (request) => {
    const service = requireApprovalService(dependencies);
    const { approvalId } = toolApprovalIdParams.parse(request.params);
    const record = recordFor(service.approvalStore, approvalId);
    await requireDecisionAuthority(dependencies, record, { hideUnauthorized: true });
    return { approval: await publicFor(dependencies, approvalId) };
  });

  app.post("/api/approvals/:approvalId/decision", async (request) => {
    const { approvalId } = toolApprovalIdParams.parse(request.params);
    const input = toolApprovalDecisionBody.parse(request.body);
    return { approval: await decideApproval(dependencies, approvalId, input) };
  });
}

/** Short alias for route tests/composition roots that use the generic name. */
export const registerApprovalRoutes = registerToolApprovalRoutes;

export { TOOL_APPROVAL_STATUSES };
