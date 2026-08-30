import type { Principal } from "../access/access-types.js";
import type { JsonStore } from "../store.js";
import type { Database } from "../types.js";
import { ProjectError } from "./project-errors.js";
import {
  PROJECT_LIMITS,
  type ProjectWriteLease,
} from "./project-types.js";

export interface ProjectWriteLeaseOptions {
  waitMs?: number;
  principal?: Principal;
}

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

/**
 * Coordinates the single-writer Project lease without owning Project policy.
 *
 * The coordinator has one deliberately small seam: the ProjectService supplies
 * the authorization callback. Persistence remains serialized by JsonStore,
 * while the waiter set and archive guard stay process-local implementation
 * details. ProjectService keeps the public facade used by orchestration and
 * Playground callers.
 */
export class ProjectWriteLeaseCoordinator {
  private readonly leaseWaiters = new Map<string, Set<() => void>>();
  private readonly archivingProjects = new Set<string>();

  constructor(
    private readonly store: JsonStore,
    private readonly authorizeAgentExecution: (
      projectId: string,
      agentId: string,
      principal?: Principal,
    ) => Promise<void>,
    private readonly onEvent: ProjectLeaseEventSink = () => undefined,
  ) {}

  /**
   * Releases leases orphaned by a server restart. A lease only ever guards a
   * live run; nothing in-flight survives a restart, so persisted leases are
   * stale by definition.
   */
  async initialize(): Promise<void> {
    const stale = this.store.snapshot().projectLeases;
    if (stale.length === 0) return;

    await this.store.mutate((database) => {
      database.projectLeases = [];
    });
    for (const lease of stale) {
      this.onEvent({
        type: "project_write_lease_released",
        projectId: lease.projectId,
        agentId: lease.agentId,
        runId: lease.runId,
        status: "reconciled",
      });
    }
  }

  /** Marks a Project as being moved so no new lease can race the archive. */
  beginArchive(projectId: string): void {
    this.requireNoWriteLease(projectId);
    if (this.archivingProjects.has(projectId)) throw this.projectBusy();
    this.archivingProjects.add(projectId);
  }

  /** Releases the process-local archive guard on every archive exit path. */
  endArchive(projectId: string): void {
    this.archivingProjects.delete(projectId);
  }

  /** Atomic check used inside a JsonStore mutation during archive. */
  assertDatabaseLeaseFree(
    database: Pick<Database, "projectLeases">,
    projectId: string,
  ): void {
    if (database.projectLeases.some((lease) => lease.projectId === projectId)) {
      throw this.projectBusy();
    }
  }

  requireNoWriteLease(projectId: string): void {
    if (this.writeLeaseHolder(projectId)) throw this.projectBusy();
  }

  async acquire(
    projectId: string,
    agentId: string,
    runId: string,
    options: ProjectWriteLeaseOptions = {},
  ): Promise<void> {
    this.assertNotArchiving(projectId);
    await this.authorizeAgentExecution(projectId, agentId, options.principal);

    const waitMs = options.waitMs ?? PROJECT_LIMITS.writeLeaseWaitMs;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const acquired = await this.store.mutate(async (database) => {
        // JsonStore serializes this callback with role and attachment writes.
        // Reauthorize immediately before persistence to close the wait/revoke
        // race: an authorization change cannot leave an unauthorized lease.
        this.assertNotArchiving(projectId);
        await this.authorizeAgentExecution(projectId, agentId, options.principal);
        if (database.projectLeases.some((lease) => lease.projectId === projectId)) {
          return false;
        }
        database.projectLeases.push({
          projectId,
          agentId,
          runId,
          acquiredAt: new Date().toISOString(),
        });
        return true;
      });

      if (acquired) {
        this.onEvent({
          type: "project_write_lease_acquired",
          projectId,
          agentId,
          runId,
          status: "held",
        });
        return;
      }
      if (Date.now() >= deadline) throw this.projectBusy();
      await this.waitForRelease(projectId, deadline);
    }
  }

  /** Idempotent; safe to call from a run's finally block. */
  async release(projectId: string, runId: string): Promise<void> {
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
  }

  writeLeaseHolder(projectId: string): ProjectWriteLeaseHolder | null {
    const held = this.store.snapshot().projectLeases.find(
      (lease) => lease.projectId === projectId,
    );
    return held ? { agentId: held.agentId, runId: held.runId } : null;
  }

  private assertNotArchiving(projectId: string): void {
    if (this.archivingProjects.has(projectId)) throw this.projectBusy();
  }

  private projectBusy(): ProjectError {
    return new ProjectError(
      "PROJECT_BUSY",
      409,
      "Another Agent is currently writing to this Project",
    );
  }

  private async waitForRelease(projectId: string, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;

    const waiters = this.leaseWaiters.get(projectId) ?? new Set<() => void>();
    this.leaseWaiters.set(projectId, waiters);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        clearTimeout(timer);
        resolve();
      };
      // Poll as well as listen: another process may release the persisted
      // lease without having access to this process's waiter set.
      const timer = setTimeout(
        finish,
        Math.min(PROJECT_LIMITS.writeLeasePollIntervalMs, remaining),
      );
      waiters.add(finish);
    });
  }

  private notifyRelease(projectId: string): void {
    const waiters = this.leaseWaiters.get(projectId);
    if (!waiters) return;
    this.leaseWaiters.delete(projectId);
    for (const waiter of waiters) waiter();
  }
}

export type { ProjectWriteLease };
