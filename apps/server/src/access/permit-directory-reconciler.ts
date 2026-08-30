import { Permit, type IPermitClient } from "permitio";
import type { AppConfig } from "../config.js";
import { isPermitConfigured } from "../config.js";
import type { Database } from "../types.js";
import type { Project, ProjectAgentAttachment, ProjectRole } from "../projects/project-types.js";
import { permitResourceKey, permitUserKey } from "./permit-policy.js";
import type { PermitSynchronizationGateLike } from "./permit-synchronization-gate.js";

export interface PermitDirectoryUser {
  key: string;
}

export interface PermitDirectoryResourceInstance {
  key: string;
  resource: string;
  tenant: string;
}

export interface PermitDirectoryRoleAssignment {
  user: string;
  /** Permit role keys may include Wave 11 approval/access roles. */
  role: string;
  tenant: string;
  resource_instance: string;
}

/**
 * Narrow management surface used by reconciliation. Tests inject a fake for
 * this interface; the official SDK is kept behind the production adapter.
 */
export interface PermitDirectoryClient {
  syncUser(user: PermitDirectoryUser): Promise<void>;
  ensureResourceInstance(resource: PermitDirectoryResourceInstance): Promise<void>;
  listRoleAssignments(
    resourceInstanceKey: string,
    tenantKey: string,
  ): Promise<readonly PermitDirectoryRoleAssignment[]>;
  assignRole(assignment: PermitDirectoryRoleAssignment): Promise<void>;
  unassignRole(assignment: PermitDirectoryRoleAssignment): Promise<void>;
}

export interface PermitDirectoryReconcilerOptions {
  tenantKey: string;
  synchronizationGate?: PermitSynchronizationGateLike;
}

export const PERMIT_DIRECTORY_SYNC_ERROR_CODE = "PERMIT_DIRECTORY_SYNC_FAILED" as const;
export const PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE = 100;
export const MAX_PERMIT_ROLE_ASSIGNMENT_PAGES = 100;
export const MAX_PERMIT_ROLE_ASSIGNMENTS =
  PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE * MAX_PERMIT_ROLE_ASSIGNMENT_PAGES;
const MANAGED_MEMBERSHIP_ROLES: ReadonlySet<ProjectRole> = new Set([
  "owner",
  "editor",
  "viewer",
]);

/** Stable error; provider response bodies and credentials are never retained. */
export class PermitDirectorySyncError extends Error {
  readonly code = PERMIT_DIRECTORY_SYNC_ERROR_CODE;

  constructor() {
    super("Permit directory synchronization failed");
    this.name = "PermitDirectorySyncError";
  }
}

export interface PermitDirectoryReconciliationResult {
  usersSynchronized: number;
  resourcesSynchronized: number;
  rolesAssigned: number;
  rolesUnassigned: number;
}

/** Lifecycle services depend only on this narrow, retryable seam. */
export interface PermitDirectoryReconciliationSink {
  reconcile(): Promise<PermitDirectoryReconciliationResult | void>;
}

function asUserKey(kind: "human" | "agent", id: string): string {
  return kind + ":" + id;
}

function humanOwnerKey(ownerPrincipalId: string | undefined): string {
  const value = ownerPrincipalId?.trim() || "demo-owner";
  if (value !== "demo-owner" && value !== "human:demo-owner") {
    throw new PermitDirectorySyncError();
  }
  return permitUserKey({ kind: "human", id: "demo-owner" });
}

function agentUserKey(agentId: string): string {
  return permitUserKey({ kind: "agent", id: agentId });
}

function projectInstanceKey(projectId: string): string {
  return permitResourceKey("project", projectId);
}

function attachmentRole(attachment: ProjectAgentAttachment): ProjectRole {
  return attachment.role ?? "editor";
}

function expectedProjectAssignments(
  project: Project,
  attachments: readonly ProjectAgentAttachment[],
  tenantKey: string,
): PermitDirectoryRoleAssignment[] {
  if (project.status !== "active") return [];
  const resource_instance = projectInstanceKey(project.id);
  return [
    {
      user: humanOwnerKey(project.ownerPrincipalId),
      role: "owner",
      tenant: tenantKey,
      resource_instance,
    },
    ...attachments
      .filter((attachment) => attachment.projectId === project.id)
      .sort((left, right) => left.agentId.localeCompare(right.agentId))
      .map((attachment) => ({
        user: agentUserKey(attachment.agentId),
        role: attachmentRole(attachment),
        tenant: tenantKey,
        resource_instance,
      })),
  ];
}

function assignmentKey(assignment: PermitDirectoryRoleAssignment): string {
  return [
    assignment.user,
    assignment.role,
    assignment.tenant,
    assignment.resource_instance,
  ].join("\u0000");
}

function isDirectoryAssignment(value: unknown): value is PermitDirectoryRoleAssignment {
  if (!value || typeof value !== "object") return false;
  const assignment = value as Partial<PermitDirectoryRoleAssignment>;
  return (
    safeDirectoryKey(assignment.user) &&
    safeDirectoryKey(assignment.role) &&
    safeDirectoryKey(assignment.tenant) &&
    safeDirectoryKey(assignment.resource_instance)
  );
}

function safeDirectoryKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\0\r\n\\/]/.test(value)
  );
}

/**
 * Reconciles repository identity and membership facts into Permit. The queue
 * serializes retries and lifecycle calls while preserving idempotent upserts.
 */
export class PermitDirectoryReconciler implements PermitDirectoryReconciliationSink {
  private queue: Promise<void> = Promise.resolve();
  private readonly tenantKey: string;
  private readonly synchronizationGate: PermitSynchronizationGateLike | undefined;

  constructor(
    private readonly database: { snapshot(): Database },
    private readonly client: PermitDirectoryClient | null | undefined,
    options: PermitDirectoryReconcilerOptions | string = { tenantKey: "default" },
  ) {
    this.tenantKey = (typeof options === "string" ? options : options.tenantKey).trim();
    this.synchronizationGate = typeof options === "string" ? undefined : options.synchronizationGate;
  }

  async reconcile(): Promise<PermitDirectoryReconciliationResult> {
    let result!: PermitDirectoryReconciliationResult;
    const operation = this.queue.then(async () => {
      result = await this.reconcileNow();
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return result;
  }

  private async reconcileNow(): Promise<PermitDirectoryReconciliationResult> {
    this.synchronizationGate?.begin();
    let usersSynchronized = 0;
    try {
      if (!this.client || !safeDirectoryKey(this.tenantKey)) {
        throw new PermitDirectorySyncError();
      }
      const snapshot = this.database.snapshot();
      const users = [
        { key: asUserKey("human", "demo-owner") },
        ...snapshot.agents
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((agent) => ({ key: agentUserKey(agent.id) })),
      ];
      for (const user of users) {
        await this.client.syncUser(user);
        usersSynchronized += 1;
      }

      let resourcesSynchronized = 0;
      let rolesAssigned = 0;
      let rolesUnassigned = 0;
      const attachments = snapshot.projectAgents;
      for (const project of snapshot.projects.slice().sort((left, right) => left.id.localeCompare(right.id))) {
        const resource_instance = projectInstanceKey(project.id);
        await this.client.ensureResourceInstance({
          key: resource_instance,
          resource: "project",
          tenant: this.tenantKey,
        });
        resourcesSynchronized += 1;

        const expected = expectedProjectAssignments(project, attachments, this.tenantKey);
        const expectedByIdentity = new Map(
          expected.map((assignment) => [assignment.user, assignment]),
        );
        const listed = await this.client.listRoleAssignments(
          resource_instance,
          this.tenantKey,
        );
        if (!Array.isArray(listed) || listed.some((item) => !isDirectoryAssignment(item))) {
          throw new PermitDirectorySyncError();
        }

        const retained = new Set<string>();
        for (const listedAssignment of listed) {
          const existing = listedAssignment as PermitDirectoryRoleAssignment;
          // Permit owns approval/access roles. Reconciliation manages only
          // the three repository membership roles and must never delete a
          // tool grant or another externally managed assignment.
          if (!MANAGED_MEMBERSHIP_ROLES.has(existing.role as ProjectRole)) continue;
          const desired = expectedByIdentity.get(existing.user);
          const exact = desired !== undefined && assignmentKey(existing) === assignmentKey(desired);
          if (exact && !retained.has(existing.user)) {
            retained.add(existing.user);
            continue;
          }
          await this.client.unassignRole(existing);
          rolesUnassigned += 1;
        }
        for (const desired of expected) {
          if (retained.has(desired.user)) continue;
          await this.client.assignRole(desired);
          rolesAssigned += 1;
        }
      }
      const result = {
        usersSynchronized,
        resourcesSynchronized,
        rolesAssigned,
        rolesUnassigned,
      };
      this.synchronizationGate?.markReady();
      return result;
    } catch (error) {
      this.synchronizationGate?.markFailed();
      if (error instanceof PermitDirectorySyncError) throw error;
      // Deliberately discard the original error: SDK errors can contain
      // headers, URLs, response bodies, and credential-shaped values.
      throw new PermitDirectorySyncError();
    }
  }
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; response?: unknown };
  if (typeof value.status === "number") return value.status;
  if (typeof value.statusCode === "number") return value.statusCode;
  if (value.response && typeof value.response === "object") {
    const status = (value.response as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Production bridge from the narrow directory interface to official SDK APIs. */
export class PermitSdkDirectoryClient implements PermitDirectoryClient {
  constructor(
    private readonly permit: Pick<IPermitClient, "api" | "config">,
    private readonly config: Pick<AppConfig, "permitProjectId" | "permitEnvironmentId">,
  ) {}

  async syncUser(user: PermitDirectoryUser): Promise<void> {
    try {
      await this.ensureEnvironmentContext();
      await this.permit.api.users.sync({ key: user.key });
      this.assertEnvironmentContext();
    } catch (error) {
      if (error instanceof PermitDirectorySyncError) throw error;
      throw new PermitDirectorySyncError();
    }
  }

  async ensureResourceInstance(resource: PermitDirectoryResourceInstance): Promise<void> {
    await this.ensureEnvironmentContext();
    try {
      const existing = await this.permit.api.resourceInstances.get(resource.key);
      this.assertEnvironmentContext();
      if (
        existing.resource !== resource.resource ||
        existing.tenant !== resource.tenant
      ) {
        throw new PermitDirectorySyncError();
      }
      return;
    } catch (error) {
      if (error instanceof PermitDirectorySyncError) throw error;
      if (statusCode(error) !== 404) throw new PermitDirectorySyncError();
      try {
        await this.permit.api.resourceInstances.create({
          key: resource.key,
          resource: resource.resource,
          tenant: resource.tenant,
        });
        this.assertEnvironmentContext();
      } catch (createError) {
        // A concurrent reconciler may have won the create. Verify that the
        // resulting instance is the expected one before treating it as safe.
        if (statusCode(createError) !== 409) throw new PermitDirectorySyncError();
        try {
          await this.ensureEnvironmentContext();
          const existing = await this.permit.api.resourceInstances.get(resource.key);
          this.assertEnvironmentContext();
          if (
            existing.resource !== resource.resource ||
            existing.tenant !== resource.tenant
          ) {
            throw new PermitDirectorySyncError();
          }
        } catch (retryError) {
          if (retryError instanceof PermitDirectorySyncError) throw retryError;
          throw new PermitDirectorySyncError();
        }
      }
    }
  }

  async listRoleAssignments(
    resourceInstanceKey: string,
    tenantKey: string,
  ): Promise<readonly PermitDirectoryRoleAssignment[]> {
    try {
      const assignments: PermitDirectoryRoleAssignment[] = [];
      for (let page = 1; page <= MAX_PERMIT_ROLE_ASSIGNMENT_PAGES; page += 1) {
        await this.ensureEnvironmentContext();
        const pageItems = await this.permit.api.roleAssignments.list({
          resourceInstance: resourceInstanceKey,
          tenant: tenantKey,
          detailed: false,
          page,
          perPage: PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE,
        });
        this.assertEnvironmentContext();
        if (
          !Array.isArray(pageItems) ||
          pageItems.length > PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE
        ) {
          throw new PermitDirectorySyncError();
        }
        for (const assignment of pageItems) {
          if (!assignment || typeof assignment !== "object") {
            throw new PermitDirectorySyncError();
          }
          const mapped = {
            user: assignment.user,
            role: assignment.role as ProjectRole,
            tenant: assignment.tenant ?? tenantKey,
            resource_instance: assignment.resource_instance ?? resourceInstanceKey,
          } satisfies PermitDirectoryRoleAssignment;
          if (!isDirectoryAssignment(mapped)) throw new PermitDirectorySyncError();
          assignments.push(mapped);
          if (assignments.length > MAX_PERMIT_ROLE_ASSIGNMENTS) {
            throw new PermitDirectorySyncError();
          }
        }
        if (pageItems.length < PERMIT_ROLE_ASSIGNMENT_PAGE_SIZE) return assignments;
      }
      // A full final page at the configured bound is ambiguous: fail closed
      // instead of assuming no additional assignments exist.
      throw new PermitDirectorySyncError();
    } catch (error) {
      if (error instanceof PermitDirectorySyncError) throw error;
      throw new PermitDirectorySyncError();
    }
  }

  async assignRole(assignment: PermitDirectoryRoleAssignment): Promise<void> {
    try {
      await this.ensureEnvironmentContext();
      await this.permit.api.roleAssignments.assign({
        user: assignment.user,
        role: assignment.role,
        tenant: assignment.tenant,
        resource_instance: assignment.resource_instance,
      });
      this.assertEnvironmentContext();
    } catch (error) {
      if (error instanceof PermitDirectorySyncError) throw error;
      throw new PermitDirectorySyncError();
    }
  }

  async unassignRole(assignment: PermitDirectoryRoleAssignment): Promise<void> {
    try {
      await this.ensureEnvironmentContext();
      await this.permit.api.roleAssignments.unassign({
        user: assignment.user,
        role: assignment.role,
        tenant: assignment.tenant,
        resource_instance: assignment.resource_instance,
      });
      this.assertEnvironmentContext();
    } catch (error) {
      if (error instanceof PermitDirectorySyncError) throw error;
      throw new PermitDirectorySyncError();
    }
  }

  /** Resolve and validate the SDK's API-key scope before any privileged write. */
  private async ensureEnvironmentContext(): Promise<void> {
    // ApiContextLevel.ENVIRONMENT is the SDK's numeric level 3; the public
    // package exports ApiContext but not the enum itself.
    await this.permit.api.ensureContext(3);
    this.assertEnvironmentContext();
  }

  private assertEnvironmentContext(): void {
    const context = this.permit.config.apiContext;
    if (
      context.project !== null &&
      context.project !== this.config.permitProjectId
    ) {
      throw new PermitDirectorySyncError();
    }
    if (
      context.environment !== null &&
      context.environment !== this.config.permitEnvironmentId
    ) {
      throw new PermitDirectorySyncError();
    }
  }
}

export function createPermitDirectoryClient(
  config: AppConfig,
): PermitDirectoryClient | null {
  if (!isPermitConfigured(config)) return null;
  try {
    const permit = new Permit({
      token: config.permitApiKey,
      pdp: config.permitPdpUrl,
      timeout: config.permitCheckTimeoutMs,
      throwOnError: true,
      retry: false,
      pdpRetry: false,
      // Provider bodies can contain credentials or policy details. The
      // reconciler exposes only its stable sync error and keeps SDK logging off.
      log: { level: "silent", label: "launchpad-permit", json: false },
    });
    return new PermitSdkDirectoryClient(permit, config);
  } catch {
    return null;
  }
}
