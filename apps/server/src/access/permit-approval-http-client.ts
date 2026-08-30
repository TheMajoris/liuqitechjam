import { Permit, type IPermitClient } from "permitio";
import type { AppConfig } from "../config.js";
import { isPermitConfigured } from "../config.js";
import {
  DEFAULT_TIMEOUT_MS,
  HUMAN_OWNER_ID,
  MAX_PAGE_SIZE,
  MAX_RESPONSE_BYTES,
  externalApproval,
  safeId,
  validId,
} from "./permit-approval-helpers.js";
import {
  PermitApprovalError,
  type PermitAccessRequestInput,
  type PermitAccessRoleAssignment,
  type PermitApprovalClient,
  type PermitApprovalStatus,
  type PermitExternalApproval,
  type PermitOperationApprovalInput,
} from "./permit-approval-types.js";

export interface PermitApprovalHttpConfig {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  environmentId: string;
  tenantKey: string;
  operationApprovalConfigId: string;
  accessRequestConfigId?: string;
  timeoutMs?: number;
}

class PermitHttpError extends Error {
  constructor(readonly status: number) {
    super("Permit approval request failed");
    this.name = "PermitHttpError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new PermitApprovalError();
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new PermitApprovalError();
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new PermitApprovalError();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function responseApproval(response: Response, fallbackId?: string): Promise<PermitExternalApproval> {
  const raw = await boundedResponseText(response);
  if (!response.ok) throw new PermitHttpError(response.status);
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw new PermitApprovalError();
  }
  return externalApproval(parsed, fallbackId);
}

function pathPart(value: string): string {
  return encodeURIComponent(safeId(value));
}

function listExternalApprovals(value: unknown): PermitExternalApproval[] {
  if (!value || typeof value !== "object") throw new PermitApprovalError();
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.data) ? record.data : Array.isArray(value) ? value : null;
  if (items === null || items.length > MAX_PAGE_SIZE) throw new PermitApprovalError();
  return items.map((item) => externalApproval(item));
}

/**
 * Production bridge: Elements loginAs authenticates Operation Approval calls;
 * API-only Access Requests use the server-side Permit API key. No caller
 * supplies a principal or token to this adapter.
 */
export class PermitHttpApprovalClient implements PermitApprovalClient {
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;

  constructor(
    private readonly permit: Pick<IPermitClient, "elements"> & { api?: Pick<IPermitClient["api"], "unassignRole"> },
    private readonly config: PermitApprovalHttpConfig,
    fetcher: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.timeoutMs = Number.isFinite(config.timeoutMs) && (config.timeoutMs ?? 0) > 0
      ? Math.min(Math.floor(config.timeoutMs!), 120_000)
      : DEFAULT_TIMEOUT_MS;
    this.fetcher = fetcher;
  }

  async createOperationApproval(input: PermitOperationApprovalInput): Promise<PermitExternalApproval> {
    // The requester is the Agent. Review actions use the trusted human owner.
    // Permit derives the requester from the Element login cookie; putting the
    // userId only in the application payload would use the reviewer instead.
    return this.operationRequest("POST", "", {
      access_request_details: {
        tenant: input.tenantId,
        resource: input.resource,
        resource_instance: input.resourceInstance,
      },
      reason: input.reason,
    }, input.userId);
  }

  getOperationApproval(id: string): Promise<PermitExternalApproval> {
    return this.operationRequest("GET", "/" + pathPart(id));
  }

  async listOperationApprovals(filter: {
    status?: PermitApprovalStatus;
    resource?: string;
    resourceInstance?: string;
  } = {}): Promise<readonly PermitExternalApproval[]> {
    const headers: Record<string, string> = {};
    if (filter.status) headers.status = safeId(filter.status);
    if (filter.resource) headers.resource = safeId(filter.resource);
    if (filter.resourceInstance) headers.resource_instance = safeId(filter.resourceInstance);
    const response = await this.operationRequestRaw("GET", "", undefined, headers);
    return listExternalApprovals(response);
  }

  approveOperationApproval(id: string): Promise<PermitExternalApproval> {
    return this.operationRequest("PUT", "/" + pathPart(id) + "/approve", {});
  }

  denyOperationApproval(id: string): Promise<PermitExternalApproval> {
    return this.operationRequest("PUT", "/" + pathPart(id) + "/deny", {});
  }

  createAccessRequest(input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    return this.accessRequest("POST", "", input, {
      access_request_details: {
        tenant: input.tenantId,
        resource: input.resource,
        resource_instance: input.resourceInstance,
        role: input.role,
      },
      reason: input.reason,
    });
  }

  getAccessRequest(id: string, input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    return this.accessRequest("GET", "/" + pathPart(id), input);
  }

  async listAccessRequests(
    input: Pick<PermitAccessRequestInput, "userId" | "tenantId">,
    filter: { status?: PermitApprovalStatus; resource?: string; resourceInstance?: string } = {},
  ): Promise<readonly PermitExternalApproval[]> {
    const headers: Record<string, string> = {};
    if (filter.status) headers.status = safeId(filter.status);
    if (filter.resource) headers.resource = safeId(filter.resource);
    if (filter.resourceInstance) headers.resource_instance = safeId(filter.resourceInstance);
    const response = await this.accessRequestRaw("GET", "", {
      userId: safeId(input.userId),
      tenantId: safeId(input.tenantId),
      resource: "project",
      resourceInstance: "project:catalog",
      role: "viewer",
      reason: "",
    }, undefined, headers);
    return listExternalApprovals(response);
  }

  approveAccessRequest(id: string, input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    return this.accessRequest("PUT", "/" + pathPart(id) + "/approve", input, {});
  }

  denyAccessRequest(id: string, input: PermitAccessRequestInput): Promise<PermitExternalApproval> {
    return this.accessRequest("PUT", "/" + pathPart(id) + "/deny", input, {});
  }

  unassignProjectAccess(assignment: PermitAccessRoleAssignment): Promise<void> {
    return this.unassignRole(assignment);
  }

  unassignOperationApproval(assignment: PermitAccessRoleAssignment): Promise<void> {
    return this.unassignRole(assignment);
  }

  private async unassignRole(assignment: PermitAccessRoleAssignment): Promise<void> {
    if (!this.permit.api?.unassignRole) throw new PermitApprovalError();
    try {
      await this.permit.api.unassignRole({
        user: safeId(assignment.user),
        role: safeId(assignment.role),
        tenant: safeId(assignment.tenant),
        resource_instance: safeId(assignment.resourceInstance),
      });
    } catch {
      throw new PermitApprovalError();
    }
  }

  private operationRequest(
    method: string,
    suffix: string,
    body?: unknown,
    userId = HUMAN_OWNER_ID,
  ): Promise<PermitExternalApproval> {
    return this.operationRequestRaw(method, suffix, body, undefined, userId)
      .then((response) => responseApproval(response));
  }

  private async operationRequestRaw(
    method: string,
    suffix: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    userId = HUMAN_OWNER_ID,
  ): Promise<Response> {
    const ticket = await this.elementTicket(userId);
    const url = this.baseUrl() + "/v2/elements/" + pathPart(this.config.projectId) + "/" +
      pathPart(this.config.environmentId) + "/config/" + pathPart(this.config.operationApprovalConfigId) +
      "/operation_approval" + suffix;
    return this.request(url, method, {
      // Permit Elements accepts this short-lived ticket as the session cookie.
      // The bearer form supports deployments that authenticate element login
      // through the Authorization header; neither reaches an application response.
      cookie: "permit_session=" + encodeURIComponent(ticket),
      authorization: "Bearer " + ticket,
      element_id: this.config.operationApprovalConfigId,
      ...(extraHeaders ?? {}),
    }, body);
  }

  private accessRequest(
    method: string,
    suffix: string,
    input: PermitAccessRequestInput,
    body?: unknown,
  ): Promise<PermitExternalApproval> {
    return this.accessRequestRaw(method, suffix, input, body)
      .then((response) => responseApproval(response));
  }

  private async accessRequestRaw(
    method: string,
    suffix: string,
    input: PermitAccessRequestInput,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const accessRequestConfigId = this.config.accessRequestConfigId;
    if (!validId(accessRequestConfigId)) throw new PermitApprovalError();
    const url = this.baseUrl() + "/v2/facts/" + pathPart(this.config.projectId) + "/" +
      pathPart(this.config.environmentId) + "/access_requests/" + pathPart(accessRequestConfigId) +
      "/user/" + pathPart(input.userId) + "/tenant/" + pathPart(input.tenantId) + suffix;
    return this.request(url, method, {
      authorization: "Bearer " + safeId(this.config.apiKey),
      ...(extraHeaders ?? {}),
    }, body);
  }

  private async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = this.fetcher(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const timeout = new Promise<Response>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PermitApprovalError());
        }, this.timeoutMs);
      });
      return await Promise.race([request, timeout]);
    } catch {
      throw new PermitApprovalError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async elementTicket(userId = HUMAN_OWNER_ID): Promise<string> {
    try {
      const ticket = await this.permit.elements.loginAs({
        userId: safeId(userId),
        tenantId: safeId(this.config.tenantKey),
      });
      const record = ticket as unknown as Record<string, unknown>;
      const token = record.token ?? record.element_bearer_token ??
        (record.content && typeof record.content === "object"
          ? (record.content as Record<string, unknown>).token
          : undefined);
      if (!validId(token)) throw new PermitApprovalError();
      return token;
    } catch {
      throw new PermitApprovalError();
    }
  }

  private baseUrl(): string {
    return this.config.apiUrl.replace(/\/+$/, "");
  }
}

export function createPermitApprovalClient(config: AppConfig): PermitApprovalClient | null {
  if (!isPermitConfigured(config)) return null;
  try {
    const permit = new Permit({
      token: config.permitApiKey,
      pdp: config.permitPdpUrl,
      timeout: config.permitCheckTimeoutMs,
      throwOnError: true,
      retry: false,
      pdpRetry: false,
      log: { level: "silent", label: "launchpad-permit", json: false },
    });
    return new PermitHttpApprovalClient(permit, {
      apiUrl: config.permitApiUrl,
      apiKey: config.permitApiKey,
      projectId: config.permitProjectId,
      environmentId: config.permitEnvironmentId,
      tenantKey: config.permitTenantKey,
      operationApprovalConfigId: config.permitOperationApprovalConfigId,
      accessRequestConfigId: config.permitAccessRequestConfigId,
      timeoutMs: config.permitCheckTimeoutMs,
    });
  } catch {
    return null;
  }
}
