import { randomUUID } from "node:crypto";
import type { Storage } from "../store.js";
import type { Database } from "../types.js";
import { ProjectError } from "./project-errors.js";
import type { ProjectEventSink } from "./project-service.js";
import {
  WorkspaceCheckpointError,
  isRecoveryPending,
  type WorkspaceCheckpointErrorCode,
  type WorkspaceOperation,
  type WorkspaceOperationStage,
} from "./workspace-checkpoint-types.js";

const now = (): string => new Date().toISOString();

/** Trusted internal assertion of who owns a Project reservation. */
export interface WorkspaceOwner {
  workspaceOperationId: string;
  workspaceEpoch?: number | undefined;
}

type AdmissionDatabase = Pick<Database, "workspaceOperations" | "projects">;

export interface ReserveCycleInput {
  projectId: string;
  orchestrationId: string;
  actorPrincipalId: string;
  expectedEpoch: number;
}

export interface ReserveRecoveryInput extends ReserveCycleInput {
  requestId: string;
  requestFingerprint: string;
  targetCheckpointId: string;
}

/**
 * Durable Project reservations for checkpoint-enabled work.
 *
 * A reservation covers a whole execution cycle or recovery: from baseline
 * capture through the final Agent's settlement and logical publication. The
 * existing per-Run write lease keeps excluding concurrent child writers
 * inside a cycle; this layer keeps every other participant — another
 * conversation, a direct Project run, a preview, an archive — out of the
 * intervals between leases where a restore could otherwise interleave.
 */
export class WorkspaceOperationCoordinator {
  constructor(
    private readonly store: Storage,
    private readonly onEvent: ProjectEventSink = () => undefined,
  ) {}

  // ---------------------------------------------------------------- queries

  heldOperationIn(database: AdmissionDatabase, projectId: string): WorkspaceOperation | null {
    return (
      database.workspaceOperations.find(
        (operation) => operation.projectId === projectId && operation.reservationHeld,
      ) ?? null
    );
  }

  heldOperation(projectId: string): WorkspaceOperation | null {
    const held = this.heldOperationIn(this.store.snapshot(), projectId);
    return held ? structuredClone(held) : null;
  }

  getOperation(operationId: string): WorkspaceOperation | null {
    const found = this.store.snapshot().workspaceOperations.find((item) => item.id === operationId);
    return found ? structuredClone(found) : null;
  }

  /** The newest operation recorded for one conversation, held or not. */
  latestForSession(orchestrationId: string, kind?: WorkspaceOperation["kind"]): WorkspaceOperation | null {
    const found = this.store
      .snapshot()
      .workspaceOperations.filter(
        (item) => item.orchestrationId === orchestrationId && (kind === undefined || item.kind === kind),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    return found ? structuredClone(found) : null;
  }

  findRecoveryRequest(projectId: string, requestId: string): WorkspaceOperation | null {
    const found = this.store
      .snapshot()
      .workspaceOperations.find(
        (item) => item.projectId === projectId && item.kind === "recovery" && item.requestId === requestId,
      );
    return found ? structuredClone(found) : null;
  }

  /** A held recovery that has not yet handed off to a resume cycle gates the Project. */
  recoveryGate(projectId: string): WorkspaceOperation | null {
    const held = this.heldOperation(projectId);
    return held && held.kind === "recovery" && isRecoveryPending(held.stage) ? held : null;
  }

  /**
   * Reject a writer that is not the current reservation owner. Used both from
   * snapshots and from inside serialized store callbacks, so it reads only the
   * database it is handed and never starts another mutation.
   */
  assertAdmission(database: AdmissionDatabase, projectId: string, owner?: WorkspaceOwner): void {
    const held = this.heldOperationIn(database, projectId);
    if (!held) {
      if (owner !== undefined) {
        throw new ProjectError(
          "PROJECT_BUSY",
          409,
          "This Project operation is no longer active",
        );
      }
      return;
    }
    if (owner === undefined || owner.workspaceOperationId !== held.id) {
      if (held.kind === "recovery" && isRecoveryPending(held.stage)) {
        throw new ProjectError(
          "PROJECT_RECOVERY_REQUIRED",
          409,
          "A workspace restore is in progress; wait for it to settle before writing to this Project",
        );
      }
      throw new ProjectError(
        "PROJECT_BUSY",
        409,
        "Another conversation currently owns this Project's workspace",
      );
    }
    if (owner.workspaceEpoch !== undefined) {
      const project = database.projects.find((item) => item.id === projectId);
      if ((project?.workspaceEpoch ?? 0) !== owner.workspaceEpoch) {
        throw new ProjectError(
          "PROJECT_BUSY",
          409,
          "The Project workspace was restored after this work was accepted",
        );
      }
    }
  }

  requireNoHeldOperation(projectId: string): void {
    this.assertAdmission(this.store.snapshot(), projectId);
  }

  // ----------------------------------------------------------- reservation

  async reserveCycle(
    input: ReserveCycleInput,
    check?: (database: Database) => void,
  ): Promise<WorkspaceOperation> {
    return this.store.mutate((database) => {
      this.assertReservable(database, input.projectId, input.expectedEpoch);
      check?.(database);
      const timestamp = now();
      const operation: WorkspaceOperation = {
        id: randomUUID(),
        projectId: input.projectId,
        kind: "cycle",
        orchestrationId: input.orchestrationId,
        executionCycleId: null,
        requestId: null,
        requestFingerprint: null,
        actorPrincipalId: input.actorPrincipalId,
        stage: "reserved",
        reservationHeld: true,
        targetCheckpointId: null,
        safetyCheckpointId: null,
        resumeCycleId: null,
        expectedEpoch: input.expectedEpoch,
        errorCode: null,
        lastAuditStage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.workspaceOperations.push(operation);
      return structuredClone(operation);
    });
  }

  /**
   * Accept one recovery intent. A repeated request with the same fingerprint
   * returns the original operation; the same request ID with a different
   * payload is a conflict and changes nothing.
   */
  async reserveRecovery(
    input: ReserveRecoveryInput,
    check?: (database: Database) => void,
  ): Promise<{ operation: WorkspaceOperation; duplicate: boolean }> {
    return this.store.mutate((database) => {
      const existing = database.workspaceOperations.find(
        (item) => item.projectId === input.projectId && item.kind === "recovery" && item.requestId === input.requestId,
      );
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new WorkspaceCheckpointError(
            "CHECKPOINT_IDEMPOTENCY_CONFLICT",
            "This request ID was already used for a different recovery action",
          );
        }
        return { operation: structuredClone(existing), duplicate: true };
      }
      this.assertReservable(database, input.projectId, input.expectedEpoch);
      check?.(database);
      const timestamp = now();
      const operation: WorkspaceOperation = {
        id: randomUUID(),
        projectId: input.projectId,
        kind: "recovery",
        orchestrationId: input.orchestrationId,
        executionCycleId: null,
        requestId: input.requestId,
        requestFingerprint: input.requestFingerprint,
        actorPrincipalId: input.actorPrincipalId,
        stage: "reserved",
        reservationHeld: true,
        targetCheckpointId: input.targetCheckpointId,
        safetyCheckpointId: null,
        resumeCycleId: null,
        expectedEpoch: input.expectedEpoch,
        errorCode: null,
        lastAuditStage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.workspaceOperations.push(operation);
      return { operation: structuredClone(operation), duplicate: false };
    });
  }

  private assertReservable(database: Database, projectId: string, expectedEpoch: number): void {
    const project = database.projects.find((item) => item.id === projectId);
    if (!project) throw new ProjectError("PROJECT_NOT_FOUND", 404, "Project not found");
    if (project.status !== "active") throw new ProjectError("PROJECT_ARCHIVED", 409, "This Project is archived");
    const held = this.heldOperationIn(database, projectId);
    if (held) {
      if (held.kind === "recovery" && isRecoveryPending(held.stage)) {
        throw new ProjectError(
          "PROJECT_RECOVERY_REQUIRED",
          409,
          "A workspace restore is in progress on this Project",
        );
      }
      throw new ProjectError("PROJECT_BUSY", 409, "Another conversation currently owns this Project's workspace");
    }
    if (database.projectLeases.some((lease) => lease.projectId === projectId)) {
      throw new ProjectError("PROJECT_BUSY", 409, "Another Agent is currently writing to this Project");
    }
    // A queued Project Run that has not yet taken its lease is still a writer
    // in waiting; only Runs that carry first-class scope can be recognized.
    if (
      database.runs.some(
        (run) => run.projectId === projectId && (run.status === "queued" || run.status === "running"),
      )
    ) {
      throw new ProjectError("PROJECT_BUSY", 409, "A Project Run is still queued or running");
    }
    if ((project.workspaceEpoch ?? 0) !== expectedEpoch) {
      throw new ProjectError("PROJECT_BUSY", 409, "The Project workspace changed; refresh and try again");
    }
  }

  // ------------------------------------------------------------ transitions

  transitionIn(
    database: Database,
    operationId: string,
    stage: WorkspaceOperationStage,
    patch: Partial<
      Pick<
        WorkspaceOperation,
        | "executionCycleId" | "safetyCheckpointId" | "resumeCycleId" | "errorCode"
        | "restorePlanHash" | "restoredEpoch" | "lastAuditStage"
        | "resumeRequestId" | "resumeRequestFingerprint" | "safetyRequestId" | "safetyRequestFingerprint"
      >
    > = {},
  ): WorkspaceOperation {
    const operation = database.workspaceOperations.find((item) => item.id === operationId);
    if (!operation) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Recovery operation not found");
    }
    operation.stage = stage;
    Object.assign(operation, patch);
    operation.updatedAt = now();
    return operation;
  }

  async transition(
    operationId: string,
    stage: WorkspaceOperationStage,
    patch: Parameters<WorkspaceOperationCoordinator["transitionIn"]>[3] = {},
  ): Promise<WorkspaceOperation> {
    const updated = await this.store.mutate((database) =>
      structuredClone(this.transitionIn(database, operationId, stage, patch)),
    );
    this.onEvent({
      type: "workspace_operation_" + stage,
      projectId: updated.projectId,
      status: stage,
    });
    return updated;
  }

  /** Release the reservation in a terminal stage. Idempotent. */
  releaseIn(
    database: Database,
    operationId: string,
    stage: "settled" | "failed",
    errorCode: WorkspaceCheckpointErrorCode | null = null,
  ): WorkspaceOperation {
    const operation = database.workspaceOperations.find((item) => item.id === operationId);
    if (!operation) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Recovery operation not found");
    }
    if (!operation.reservationHeld) return operation;
    operation.reservationHeld = false;
    operation.stage = stage;
    if (errorCode !== null) operation.errorCode = errorCode;
    operation.updatedAt = now();
    return operation;
  }

  async release(
    operationId: string,
    stage: "settled" | "failed",
    errorCode: WorkspaceCheckpointErrorCode | null = null,
  ): Promise<WorkspaceOperation> {
    const updated = await this.store.mutate((database) =>
      structuredClone(this.releaseIn(database, operationId, stage, errorCode)),
    );
    this.onEvent({
      type: "workspace_operation_released",
      projectId: updated.projectId,
      status: stage,
    });
    return updated;
  }

  /**
   * Hand a recovery's reservation to the resume cycle it accepted, in one
   * mutation: no window exists in which the Project is unreserved.
   */
  transferToCycleIn(
    database: Database,
    recoveryOperationId: string,
    cycle: { orchestrationId: string; executionCycleId: string; actorPrincipalId: string; expectedEpoch: number },
  ): WorkspaceOperation {
    const recovery = database.workspaceOperations.find((item) => item.id === recoveryOperationId);
    if (!recovery || !recovery.reservationHeld) {
      throw new WorkspaceCheckpointError("CHECKPOINT_OPERATION_STAGE_INVALID", "The recovery no longer holds the Project");
    }
    if (recovery.resumeCycleId !== null) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_EXECUTION_ALREADY_ACCEPTED",
        "This recovery already accepted a resume cycle",
      );
    }
    const timestamp = now();
    recovery.reservationHeld = false;
    recovery.stage = "resume_accepted";
    recovery.resumeCycleId = cycle.executionCycleId;
    recovery.updatedAt = timestamp;
    const operation: WorkspaceOperation = {
      id: randomUUID(),
      projectId: recovery.projectId,
      kind: "cycle",
      orchestrationId: cycle.orchestrationId,
      executionCycleId: cycle.executionCycleId,
      requestId: null,
      requestFingerprint: null,
      actorPrincipalId: cycle.actorPrincipalId,
      stage: "reserved",
      reservationHeld: true,
      targetCheckpointId: recovery.targetCheckpointId,
      safetyCheckpointId: recovery.safetyCheckpointId,
      resumeCycleId: null,
      expectedEpoch: cycle.expectedEpoch,
      errorCode: null,
      lastAuditStage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    database.workspaceOperations.push(operation);
    return operation;
  }

  // ---------------------------------------------------------------- startup

  /**
   * Startup quarantine. A held cycle whose conversation the journal has just
   * marked interrupted is released only when no unresolved physical writer
   * remains for its Project. A recovery that had started changing files is
   * retained and marked recovery-required; one that had not is released as
   * failed, because the workspace is untouched.
   */
  async initialize(options: { unresolvedProjectIds: ReadonlySet<string> }): Promise<{
    released: WorkspaceOperation[];
    retained: WorkspaceOperation[];
  }> {
    const released: WorkspaceOperation[] = [];
    const retained: WorkspaceOperation[] = [];
    await this.store.mutate((database) => {
      for (const operation of database.workspaceOperations) {
        if (!operation.reservationHeld) continue;
        const unresolved =
          options.unresolvedProjectIds.has(operation.projectId) ||
          database.projectLeases.some((lease) => lease.projectId === operation.projectId);
        if (operation.kind === "cycle") {
          if (unresolved) {
            retained.push(structuredClone(operation));
            continue;
          }
          this.releaseIn(database, operation.id, "failed", null);
          released.push(structuredClone(operation));
          continue;
        }
        switch (operation.stage) {
          case "reserved":
          case "preparing":
          case "backed_up":
            if (unresolved) {
              retained.push(structuredClone(operation));
              break;
            }
            // Nothing on disk changed yet; the operator may simply try again.
            this.releaseIn(database, operation.id, "failed", "CHECKPOINT_RESTORE_FAILED");
            released.push(structuredClone(operation));
            break;
          default:
            // restoring / restored / recovery_required: files may be partly
            // applied. Keep the gate; only an explicit operator action
            // resumes or falls back to the safety checkpoint.
            if (operation.stage !== "recovery_required") {
              this.transitionIn(database, operation.id, "recovery_required", {
                errorCode: operation.errorCode ?? "CHECKPOINT_RESTORE_FAILED",
              });
            }
            retained.push(structuredClone(operation));
            break;
        }
      }
    });
    for (const operation of retained) {
      this.onEvent({
        type: "workspace_recovery_required",
        projectId: operation.projectId,
        status: operation.stage,
        detail: operation.errorCode ?? undefined,
      });
    }
    return { released, retained };
  }
}
