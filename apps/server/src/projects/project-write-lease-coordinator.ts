import type { Principal } from "../access/access-types.js";
import type { ApplicationLifecycleFailure } from "../application-health.js";
import type { Storage } from "../store.js";
import type {
  Database,
  OperationOptions,
  RuntimeReconciliationResult,
} from "../types.js";
import { ProjectError } from "./project-errors.js";
import {
  PROJECT_LIMITS,
  type ProjectWriteLease,
} from "./project-types.js";
import type { WorkspaceOwner } from "./workspace-operation-coordinator.js";

export interface ProjectWriteLeaseOptions {
  waitMs?: number;
  principal?: Principal;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Trusted cycle ownership; required while the Project is reserved. */
  workspaceOwner?: WorkspaceOwner | undefined;
}

/**
 * Reservation admission repeated inside serialized store callbacks. It reads
 * only the database it is handed, so it can run inside a mutation without
 * starting a nested one.
 */
export type ProjectAdmissionGuard = (
  database: Pick<Database, "workspaceOperations" | "projects">,
  projectId: string,
  owner?: WorkspaceOwner,
) => void;

export interface ProjectWriteLeaseHolder {
  agentId: string;
  runId: string;
}

export interface ProjectLeaseEvent {
  type: string;
  projectId: string;
  agentId?: string | undefined;
  runId?: string | undefined;
  status: string;
}

export type ProjectLeaseEventSink = (event: ProjectLeaseEvent) => void;
export type ProjectLeaseFailureSink = (failure: ApplicationLifecycleFailure) => void;

export interface ProjectLeaseRecoveryStatus {
  projectId: string;
  runId: string;
  agentId?: string;
  status: "recovery_required";
}

const MAX_SETTLED_RELEASE_ATTEMPTS = 2;

/**
 * Coordinates the single-writer Project lease without owning Project policy.
 *
 * The coordinator has one deliberately small seam: the ProjectService supplies
 * the authorization callback. Persistence remains serialized by Storage,
 * while the waiter set and archive guard stay process-local implementation
 * details. ProjectService keeps the public facade used by orchestration and
 * Playground callers.
 */
export class ProjectWriteLeaseCoordinator {
  private readonly leaseWaiters = new Map<string, Set<(error?: Error) => void>>();
  private readonly archivingProjects = new Set<string>();
  /** Process-local guard for Agent-owned membership/lease cleanup. */
  private readonly projectMutations = new Set<string>();
  /** Process-local ownership evidence used when Storage is unavailable. */
  private readonly heldLeases = new Map<string, ProjectWriteLeaseHolder>();
  /** A failed settled cleanup gates only the affected Project. */
  private readonly recoveryRequired = new Map<string, ProjectLeaseRecoveryStatus>();
  private admissionGuard: ProjectAdmissionGuard | undefined;

  constructor(
    private readonly store: Storage,
    private readonly authorizeAgentExecution: (
      projectId: string,
      agentId: string,
      principal?: Principal,
    ) => Promise<void>,
    private readonly onEvent: ProjectLeaseEventSink = () => undefined,
    private readonly onFailure?: ProjectLeaseFailureSink,
  ) {}

  /**
   * Releases only leases whose Agent runtime has been positively reconciled.
   * An absent result is intentionally unsafe: startup must not infer process
   * death from a stale database row, especially for local-process mode.
   */
  async initialize(
    reconciliation?: RuntimeReconciliationResult,
  ): Promise<void> {
    const stale = this.store.snapshot().projectLeases;
    if (stale.length === 0) return;

    const confirmed = new Set(reconciliation?.confirmedAgentIds ?? []);
    const unresolved = new Set(reconciliation?.unresolvedAgentIds ?? []);
    const releasable = stale.filter(
      (lease) => confirmed.has(lease.agentId) && !unresolved.has(lease.agentId),
    );
    const retained = stale.filter((lease) => !releasable.includes(lease));

    for (const lease of retained) {
      this.heldLeases.set(lease.projectId, {
        agentId: lease.agentId,
        runId: lease.runId,
      });
      if (this.recoveryRequired.has(lease.projectId)) continue;
      this.recoveryRequired.set(lease.projectId, {
        projectId: lease.projectId,
        runId: lease.runId,
        agentId: lease.agentId,
        status: "recovery_required",
      });
      this.onEvent({
        type: "project_write_lease_recovery_required",
        projectId: lease.projectId,
        agentId: lease.agentId,
        runId: lease.runId,
        status: "recovery_required",
      });
      try {
        this.onFailure?.({
          code: "PROJECT_LEASE_RELEASE_FAILED",
          message: "Startup could not verify the previous Project writer; operator recovery is required",
          projectId: lease.projectId,
          agentId: lease.agentId,
          runId: lease.runId,
        });
      } catch {
        // A lifecycle observer must not clear the startup safety gate.
      }
    }

    if (releasable.length > 0) {
      const releasableKeys = new Set(
        releasable.map((lease) => lease.projectId + "\u0000" + lease.runId),
      );
      await this.store.mutate((database) => {
        database.projectLeases = database.projectLeases.filter(
          (lease) => !releasableKeys.has(lease.projectId + "\u0000" + lease.runId),
        );
      });
    }
    for (const lease of releasable) {
      this.heldLeases.delete(lease.projectId);
      const recovery = this.recoveryRequired.get(lease.projectId);
      if (recovery?.runId === lease.runId) {
        this.recoveryRequired.delete(lease.projectId);
      }
      this.onEvent({
        type: "project_write_lease_released",
        projectId: lease.projectId,
        agentId: lease.agentId,
        runId: lease.runId,
        status: "reconciled",
      });
    }
  }

  /** Attach the workspace reservation check after the service graph exists. */
  setAdmissionGuard(guard: ProjectAdmissionGuard | undefined): void {
    this.admissionGuard = guard;
  }

  /** Marks a Project as being moved so no new lease can race the archive. */
  beginArchive(projectId: string): void {
    this.assertProjectMutationAllowed(projectId);
    this.requireNoWriteLease(projectId);
    this.archivingProjects.add(projectId);
  }

  /** Releases the process-local archive guard on every archive exit path. */
  endArchive(projectId: string): void {
    this.archivingProjects.delete(projectId);
  }

  /**
   * Reserves a Project while another lifecycle operation removes Agent-owned
   * membership and lease records. The reservation is process-local and must
   * be held through any compensation, so archive cannot restore an old
   * Project snapshot over an accepted deletion.
   */
  beginProjectMutation(projectId: string): void {
    this.assertProjectMutationAllowed(projectId);
    this.projectMutations.add(projectId);
  }

  /** Releases the Agent-owned Project mutation reservation. */
  endProjectMutation(projectId: string): void {
    this.projectMutations.delete(projectId);
  }

  /**
   * Rejects every Project-owned mutation while archive or its compensation is
   * in progress. Callers must repeat this check inside their serialized store
   * callback so a mutation that was waiting in the queue cannot slip through
   * after the archive guard was acquired.
   */
  assertProjectMutationAllowed(projectId: string, owner?: WorkspaceOwner): void {
    this.assertRecoveryClear(projectId);
    this.assertNotArchiving(projectId);
    this.assertNotProjectMutating(projectId);
    this.assertAdmitted(this.store.snapshot(), projectId, owner);
  }

  /** Atomic check used inside a Storage mutation during archive. */
  assertDatabaseLeaseFree(
    database: Pick<Database, "projectLeases" | "workspaceOperations" | "projects">,
    projectId: string,
  ): void {
    this.assertRecoveryClear(projectId);
    if (database.projectLeases.some((lease) => lease.projectId === projectId)) {
      throw this.projectBusy();
    }
    this.assertAdmitted(database, projectId);
  }

  requireNoWriteLease(projectId: string): void {
    this.assertRecoveryClear(projectId);
    if (this.writeLeaseHolder(projectId)) throw this.projectBusy();
    this.assertAdmitted(this.store.snapshot(), projectId);
  }

  /**
   * Retain a lease whose worker cannot be proven settled. The Project stays
   * gated until an operator resolves it; no timer ever releases it.
   */
  retainLeaseForRecovery(projectId: string, runId: string): void {
    this.markRecoveryRequired(projectId, runId, undefined);
  }

  private assertAdmitted(
    database: Pick<Database, "workspaceOperations" | "projects">,
    projectId: string,
    owner?: WorkspaceOwner,
  ): void {
    if (!this.admissionGuard) return;
    try {
      this.admissionGuard(database, projectId, owner);
    } catch (error) {
      // Only reservation state exists on this seam; a guard that fails to
      // read it is not permission to proceed.
      if (error instanceof ProjectError) throw error;
      throw this.projectBusy();
    }
  }

  async acquire(
    projectId: string,
    agentId: string,
    runId: string,
    options: ProjectWriteLeaseOptions = {},
  ): Promise<void> {
    assertOperationActive(options);
    this.assertRecoveryClear(projectId);
    this.assertNotArchiving(projectId);
    this.assertNotProjectMutating(projectId);
    await this.authorizeAgentExecution(projectId, agentId, options.principal);
    assertOperationActive(options);

    const waitMs = options.waitMs ?? PROJECT_LIMITS.writeLeaseWaitMs;
    const waitDeadline = Date.now() + waitMs;
    const deadline =
      options.deadlineAt !== undefined && Number.isFinite(options.deadlineAt)
        ? Math.min(waitDeadline, options.deadlineAt)
        : waitDeadline;
    for (;;) {
      const acquired = await this.store.mutate(async (database) => {
        assertOperationActive(options);
        // Storage serializes this callback with role and attachment writes.
        // Reauthorize immediately before persistence to close the wait/revoke
        // race: an authorization change cannot leave an unauthorized lease.
        this.assertNotArchiving(projectId);
        this.assertNotProjectMutating(projectId);
        await this.authorizeAgentExecution(projectId, agentId, options.principal);
        assertOperationActive(options);
        // Authorization may yield while archive or recovery begins. Recheck
        // immediately before persistence so a late lease cannot be accepted
        // into a Project that is no longer writable. The reservation check
        // reads the in-flight database, never a stale snapshot.
        this.assertRecoveryClear(projectId);
        this.assertNotArchiving(projectId);
        this.assertNotProjectMutating(projectId);
        this.assertAdmitted(database, projectId, options.workspaceOwner);
        if (database.projectLeases.some((lease) => lease.projectId === projectId)) {
          return false;
        }
        database.projectLeases.push({
          projectId,
          agentId,
          runId,
          acquiredAt: new Date().toISOString(),
          ...(options.workspaceOwner === undefined
            ? {}
            : {
                workspaceOperationId: options.workspaceOwner.workspaceOperationId,
                ...(options.workspaceOwner.workspaceEpoch === undefined
                  ? {}
                  : { workspaceEpoch: options.workspaceOwner.workspaceEpoch }),
              }),
        });
        return true;
      });

      if (acquired) {
        const operationError = getOperationError(options);
        if (operationError) {
          await this.release(projectId, runId, { settled: true }).catch(() => undefined);
          throw operationError;
        }
        this.heldLeases.set(projectId, { agentId, runId });
        this.onEvent({
          type: "project_write_lease_acquired",
          projectId,
          agentId,
          runId,
          status: "held",
        });
        return;
      }
      if (Date.now() >= deadline) {
        const operationError = getOperationError(options);
        if (operationError) throw operationError;
        throw this.projectBusy();
      }
      await this.waitForRelease(projectId, deadline, options);
    }
  }

  /**
   * Idempotent; safe to call from a run's finally block. A caller that has
   * confirmed the worker and terminal Run are settled may use the one bounded
   * retry permitted for this mutation. Unknown physical settlement gets one
   * attempt only and retains ownership evidence on failure.
   */
  async release(
    projectId: string,
    runId: string,
    options: { settled?: boolean } = {},
  ): Promise<void> {
    const maxAttempts = options.settled === true ? MAX_SETTLED_RELEASE_ATTEMPTS : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const released = await this.store.mutate((database) => {
          const held = database.projectLeases.find(
            (lease) => lease.projectId === projectId && lease.runId === runId,
          );
          if (!held) return null;
          database.projectLeases = database.projectLeases.filter(
            (lease) => !(lease.projectId === projectId && lease.runId === runId),
          );
          return held;
        });
        this.heldLeases.delete(projectId);
        const recovery = this.recoveryRequired.get(projectId);
        if (recovery?.runId === runId) this.recoveryRequired.delete(projectId);
        this.notifyRelease(projectId);
        if (released) {
          this.onEvent({
            type: "project_write_lease_released",
            projectId,
            agentId: released.agentId,
            runId,
            status: "released",
          });
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this.markRecoveryRequired(projectId, runId, lastError);
    throw lastError instanceof Error
      ? lastError
      : new Error("Project write lease release failed");
  }

  writeLeaseHolder(projectId: string): ProjectWriteLeaseHolder | null {
    try {
      const held = this.store.snapshot().projectLeases.find(
        (lease) => lease.projectId === projectId,
      );
      if (held) {
        const owner = { agentId: held.agentId, runId: held.runId };
        this.heldLeases.set(projectId, owner);
        return owner;
      }
      if (!this.recoveryRequired.has(projectId)) this.heldLeases.delete(projectId);
      return null;
    } catch {
      // Keep process-local ownership evidence available to cancellation and
      // Project gates while a fatal adapter transition rejects snapshots.
      return this.heldLeases.get(projectId) ?? null;
    }
  }

  isRecoveryRequired(projectId: string): boolean {
    return this.recoveryRequired.has(projectId);
  }

  /** Reject a new turn before it can create a queued Run for this Project. */
  assertProjectRecoveryClear(projectId: string): void {
    this.assertRecoveryClear(projectId);
  }

  recoveryStatus(projectId: string): ProjectLeaseRecoveryStatus | null {
    const status = this.recoveryRequired.get(projectId);
    return status === undefined ? null : { ...status };
  }

  private assertRecoveryClear(projectId: string): void {
    if (this.recoveryRequired.has(projectId)) {
      throw this.projectRecoveryRequired();
    }
  }

  private assertNotArchiving(projectId: string): void {
    if (this.archivingProjects.has(projectId)) throw this.projectBusy();
  }

  private assertNotProjectMutating(projectId: string): void {
    if (this.projectMutations.has(projectId)) throw this.projectBusy();
  }

  private projectBusy(): ProjectError {
    return new ProjectError(
      "PROJECT_BUSY",
      409,
      "Another Agent is currently writing to this Project",
    );
  }

  private projectRecoveryRequired(): ProjectError {
    return new ProjectError(
      "PROJECT_RECOVERY_REQUIRED",
      409,
      "Workspace cleanup requires operator recovery before another Agent can write",
    );
  }

  private markRecoveryRequired(
    projectId: string,
    runId: string,
    error: unknown,
  ): void {
    const held = this.heldLeases.get(projectId);
    const status: ProjectLeaseRecoveryStatus = {
      projectId,
      runId,
      ...(held?.agentId === undefined ? {} : { agentId: held.agentId }),
      status: "recovery_required",
    };
    this.recoveryRequired.set(projectId, status);
    this.onEvent({
      type: "project_write_lease_recovery_required",
      projectId,
      ...(held?.agentId === undefined ? {} : { agentId: held.agentId }),
      runId,
      status: "recovery_required",
    });
    try {
      this.onFailure?.({
        code: "PROJECT_LEASE_RELEASE_FAILED",
        message: "Project write lease release failed; operator recovery is required",
        runId,
        ...(held?.agentId === undefined ? {} : { agentId: held.agentId }),
        projectId,
      });
    } catch {
      // A lifecycle observer must not hide the original release failure or
      // clear the recovery gate that was just recorded.
    }
    void error;
  }

  private async waitForRelease(
    projectId: string,
    deadline: number,
    operation: ProjectWriteLeaseOptions,
  ): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;

    const waiters =
      this.leaseWaiters.get(projectId) ?? new Set<(error?: Error) => void>();
    this.leaseWaiters.set(projectId, waiters);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        if (waiters.size === 0 && this.leaseWaiters.get(projectId) === waiters) {
          this.leaseWaiters.delete(projectId);
        }
        if (timer) clearTimeout(timer);
        operation.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () =>
        finish(
          getOperationError(operation) ??
            abortError("Project lease acquisition was aborted"),
        );
      // Poll as well as listen: another process may release the persisted
      // lease without having access to this process's waiter set.
      timer = setTimeout(
        () => finish(getOperationError(operation)),
        Math.min(PROJECT_LIMITS.writeLeasePollIntervalMs, remaining),
      );
      waiters.add(finish);
      operation.signal?.addEventListener("abort", onAbort, { once: true });
      if (operation.signal?.aborted) onAbort();
    });
  }

  private notifyRelease(projectId: string): void {
    const waiters = this.leaseWaiters.get(projectId);
    if (!waiters) return;
    this.leaseWaiters.delete(projectId);
    for (const waiter of waiters) waiter();
  }
}

function getOperationError(operation: OperationOptions): Error | undefined {
  if (operation.signal?.aborted) {
    const reason = operation.signal.reason;
    if (reason instanceof Error && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
      return reason;
    }
    return abortError("Project lease acquisition was aborted");
  }
  if (
    operation.deadlineAt !== undefined &&
    Number.isFinite(operation.deadlineAt) &&
    Date.now() >= operation.deadlineAt
  ) {
    const error = new Error("Project lease acquisition timed out");
    error.name = "TimeoutError";
    return error;
  }
  return undefined;
}

function assertOperationActive(operation: OperationOptions): void {
  const error = getOperationError(operation);
  if (error) throw error;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export type { ProjectWriteLease };
