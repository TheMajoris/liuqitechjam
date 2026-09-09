import { randomUUID } from "node:crypto";
import type { AuditEventInput, AuditRecorder } from "../audit/audit-types.js";
import { systemPrincipal } from "../access/access-types.js";
import type { CheckpointResumeState } from "../orchestration/checkpoint-resume-state.js";
import type { Storage } from "../store.js";
import type { Database } from "../types.js";
import type { ProjectEventSink } from "./project-service.js";
import {
  GitWorkspaceCheckpointStore,
  type RestorePlan,
  type ValidatedManifest,
} from "./git-workspace-checkpoint-store.js";
import { CHECKPOINT_LIMITS } from "./workspace-checkpoint-policy.js";
import {
  CHECKPOINT_POLICY_VERSION,
  WorkspaceCheckpointError,
  isWorkspaceCheckpointError,
  toWorkspaceCheckpointView,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointErrorCode,
  type WorkspaceCheckpointKind,
  type WorkspaceCheckpointView,
} from "./workspace-checkpoint-types.js";

const now = (): string => new Date().toISOString();

export interface CheckpointCapability {
  enabled: boolean;
  available: boolean;
  errorCode: WorkspaceCheckpointErrorCode | null;
}

export interface WorkspaceCheckpointServiceDependencies {
  store: Storage;
  gitStore: GitWorkspaceCheckpointStore;
  enabled: boolean;
  audit?: AuditRecorder | undefined;
  onEvent?: ProjectEventSink | undefined;
}

interface CaptureOwner {
  projectId: string;
  operationId: string;
  workspaceEpoch: number;
  orchestrationId: string | null;
  executionCycleId: string | null;
  signal?: AbortSignal | undefined;
}

export interface CaptureBaselineInput extends CaptureOwner {
  parentCheckpointId: string | null;
  resume: CheckpointResumeState;
}

export interface CaptureTurnInput extends CaptureOwner {
  runId: string;
  agentId: string;
}

export interface CaptureSafetyInput extends CaptureOwner {
  parentCheckpointId: string | null;
}

export interface PublishTurnCheckpointInput {
  checkpointId: string;
  runId: string;
  executionCycleId: string;
  turnId: string;
  participantId: string;
  stepIndex: number;
  resume: CheckpointResumeState;
}

/**
 * Domain API for source checkpoints.
 *
 * It owns the record lifecycle (preparing → captured → ready | failed |
 * invalid) and asks the Git store for the physical work. Every capture first
 * persists an intent, then writes Git objects, then persists the identity, so
 * a crash between the steps leaves a recognizable partial record rather than
 * a fabricated success. It never dispatches an Agent.
 */
export class WorkspaceCheckpointService {
  private readonly store: Storage;
  private readonly gitStore: GitWorkspaceCheckpointStore;
  private readonly audit: AuditRecorder | undefined;
  private readonly onEvent: ProjectEventSink;
  private readonly enabled: boolean;
  private availability: WorkspaceCheckpointErrorCode | null | "unprobed" = "unprobed";

  constructor(dependencies: WorkspaceCheckpointServiceDependencies) {
    this.store = dependencies.store;
    this.gitStore = dependencies.gitStore;
    this.audit = dependencies.audit;
    this.onEvent = dependencies.onEvent ?? (() => undefined);
    this.enabled = dependencies.enabled;
  }

  /** Probe Git once and settle any capture that was interrupted mid-flight. */
  async initialize(): Promise<void> {
    this.availability = this.enabled ? await this.gitStore.probeCapability() : null;
    await this.reconcileIncompleteCaptures();
  }

  capability(): CheckpointCapability {
    const errorCode = this.availability === "unprobed" ? "CHECKPOINT_UNAVAILABLE" : this.availability;
    return {
      enabled: this.enabled,
      available: this.enabled && errorCode === null,
      errorCode: this.enabled ? errorCode : null,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  assertAvailable(): void {
    const capability = this.capability();
    if (!capability.enabled) {
      throw new WorkspaceCheckpointError("CHECKPOINT_UNAVAILABLE", "Workspace checkpoints are not enabled on this server");
    }
    if (!capability.available) {
      throw new WorkspaceCheckpointError(
        capability.errorCode ?? "CHECKPOINT_UNAVAILABLE",
        "Workspace checkpoints are unavailable; the Git executable or private storage could not be prepared",
      );
    }
  }

  // ---------------------------------------------------------------- capture

  /** Cycle baseline: ready immediately, carrying the cycle's initial continuation. */
  async captureBaseline(input: CaptureBaselineInput): Promise<WorkspaceCheckpoint> {
    return this.captureInternal("baseline", input, {
      parentCheckpointId: input.parentCheckpointId,
      resume: input.resume,
      runId: null,
      agentId: null,
      readyOnCapture: true,
    });
  }

  /**
   * Post-turn candidate: captured under the per-Run lease, ready only once the
   * completion hook publishes its logical continuation.
   */
  async captureTurn(input: CaptureTurnInput): Promise<WorkspaceCheckpoint> {
    const parent = this.latestReadyInCycle(input.projectId, input.executionCycleId);
    return this.captureInternal("turn_success", input, {
      parentCheckpointId: parent?.id ?? null,
      resume: null,
      runId: input.runId,
      agentId: input.agentId,
      readyOnCapture: false,
    });
  }

  /** Safety snapshot of the current eligible source; restorable, never resumable. */
  async captureSafety(input: CaptureSafetyInput): Promise<WorkspaceCheckpoint> {
    return this.captureInternal("safety", input, {
      parentCheckpointId: input.parentCheckpointId,
      resume: null,
      runId: null,
      agentId: null,
      readyOnCapture: true,
    });
  }

  private async captureInternal(
    kind: WorkspaceCheckpointKind,
    owner: CaptureOwner,
    fields: {
      parentCheckpointId: string | null;
      resume: CheckpointResumeState | null;
      runId: string | null;
      agentId: string | null;
      readyOnCapture: boolean;
    },
  ): Promise<WorkspaceCheckpoint> {
    this.assertAvailable();
    const createdAt = now();
    const id = randomUUID();
    // Step 1: durable intent. Never hold this callback open during Git I/O.
    const intent = await this.store.mutate((database) => {
      const project = database.projects.find((item) => item.id === owner.projectId);
      if (!project) {
        throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "The Project no longer exists");
      }
      if ((project.workspaceEpoch ?? 0) !== owner.workspaceEpoch) {
        throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "The workspace changed under this operation");
      }
      const held = database.workspaceOperations.find(
        (operation) => operation.projectId === owner.projectId && operation.reservationHeld,
      );
      if (!held || held.id !== owner.operationId) {
        throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "The capture is not owned by the Project reservation");
      }
      if (fields.runId !== null) {
        const lease = database.projectLeases.find((item) => item.projectId === owner.projectId);
        if (!lease || lease.runId !== fields.runId) {
          throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "The capturing Run does not hold the Project lease");
        }
      }
      const ready = database.workspaceCheckpoints.filter(
        (checkpoint) => checkpoint.projectId === owner.projectId && checkpoint.state === "ready",
      ).length;
      if (ready >= CHECKPOINT_LIMITS.maxReadyCheckpointsPerProject) {
        throw new WorkspaceCheckpointError("CHECKPOINT_LIMIT_EXCEEDED", "This Project has reached its checkpoint quota");
      }
      const parent = fields.parentCheckpointId === null
        ? null
        : database.workspaceCheckpoints.find(
            (checkpoint) => checkpoint.id === fields.parentCheckpointId && checkpoint.projectId === owner.projectId,
          ) ?? null;
      if (fields.parentCheckpointId !== null && (!parent || parent.gitSha === null)) {
        throw new WorkspaceCheckpointError("CHECKPOINT_INVALID_INPUT", "The parent checkpoint is not a captured checkpoint");
      }
      const ordinal = database.workspaceCheckpoints
        .filter((checkpoint) => checkpoint.projectId === owner.projectId)
        .reduce((maximum, checkpoint) => Math.max(maximum, checkpoint.ordinal), 0) + 1;
      const record: WorkspaceCheckpoint = {
        id,
        projectId: owner.projectId,
        ordinal,
        kind,
        state: "preparing",
        operationId: owner.operationId,
        workspaceEpoch: owner.workspaceEpoch,
        executionCycleId: owner.executionCycleId,
        orchestrationId: owner.orchestrationId,
        turnId: null,
        runId: fields.runId,
        agentId: fields.agentId,
        participantId: null,
        stepIndex: null,
        parentCheckpointId: fields.parentCheckpointId,
        policyVersion: CHECKPOINT_POLICY_VERSION,
        gitSha: null,
        treeSha: null,
        manifestHash: null,
        fileCount: 0,
        byteCount: 0,
        excludedFileCount: 0,
        resume: null,
        errorCode: null,
        createdAt,
        readyAt: null,
      };
      database.workspaceCheckpoints.push(record);
      return { record: structuredClone(record), parentGitSha: parent?.gitSha ?? null };
    });

    // Step 2: physical capture outside every store callback.
    try {
      await this.gitStore.ensureRepository(owner.projectId, true);
      const physical = await this.gitStore.capture(
        { projectId: owner.projectId, checkpointId: id, parentGitSha: intent.parentGitSha, createdAt },
        { signal: owner.signal },
      );
      // Step 3: persist identity; baseline/safety become ready with it.
      const readyAt = now();
      const stored = await this.store.mutate((database) => {
        const record = database.workspaceCheckpoints.find((checkpoint) => checkpoint.id === id);
        if (!record) throw new WorkspaceCheckpointError("CHECKPOINT_CAPTURE_FAILED", "The checkpoint intent disappeared");
        record.gitSha = physical.gitSha;
        record.treeSha = physical.treeSha;
        record.manifestHash = physical.manifestHash;
        record.fileCount = physical.fileCount;
        record.byteCount = physical.byteCount;
        record.excludedFileCount = physical.excludedFileCount;
        if (fields.readyOnCapture) {
          record.state = "ready";
          record.readyAt = readyAt;
          record.resume = fields.resume === null ? null : structuredClone(fields.resume);
          if (kind === "baseline") {
            const project = database.projects.find((item) => item.id === owner.projectId);
            if (project) project.currentCheckpointId = record.id;
          }
        } else {
          record.state = "captured";
        }
        return structuredClone(record);
      });
      if (fields.readyOnCapture) await this.auditCreated(stored);
      return stored;
    } catch (error) {
      const code = errorCodeOf(error);
      await this.store
        .mutate((database) => {
          const record = database.workspaceCheckpoints.find((checkpoint) => checkpoint.id === id);
          if (!record || record.state !== "preparing") return;
          record.state = "failed";
          record.errorCode = code;
        })
        .catch(() => undefined);
      await this.auditFailed(intent.record, code, "capture");
      throw error;
    }
  }

  /**
   * Publish a captured candidate as the ready boundary of a completed turn.
   * Runs synchronously inside the caller's mutation, so the turn completion,
   * the checkpoint promotion, and the cycle head advance in one transaction.
   */
  publishTurnCheckpoint(database: Database, input: PublishTurnCheckpointInput): WorkspaceCheckpoint {
    const record = database.workspaceCheckpoints.find((checkpoint) => checkpoint.id === input.checkpointId);
    if (!record) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_READY", "The turn's checkpoint candidate was not found");
    }
    if (record.state === "ready" && record.turnId === input.turnId && record.runId === input.runId) {
      return record;
    }
    if (
      record.state !== "captured" ||
      record.kind !== "turn_success" ||
      record.runId !== input.runId ||
      record.executionCycleId !== input.executionCycleId ||
      record.gitSha === null ||
      record.manifestHash === null
    ) {
      throw new WorkspaceCheckpointError(
        "CHECKPOINT_NOT_READY",
        "The turn's checkpoint candidate does not belong to this completed Run",
      );
    }
    record.turnId = input.turnId;
    record.participantId = input.participantId;
    record.stepIndex = input.stepIndex;
    record.resume = structuredClone(input.resume);
    record.state = "ready";
    record.readyAt = now();
    const project = database.projects.find((item) => item.id === record.projectId);
    if (project) project.currentCheckpointId = record.id;
    return record;
  }

  /** A candidate whose logical outcome was unusable is never offered as a success. */
  async invalidateCandidate(checkpointId: string, errorCode: WorkspaceCheckpointErrorCode): Promise<void> {
    const record = await this.store.mutate((database) => {
      const stored = database.workspaceCheckpoints.find((checkpoint) => checkpoint.id === checkpointId);
      if (!stored || stored.state !== "captured") return null;
      stored.state = "failed";
      stored.errorCode = errorCode;
      return structuredClone(stored);
    });
    if (record) await this.auditFailed(record, errorCode, "publish");
  }

  // ---------------------------------------------------------------- restore

  /** Full physical validation; a failure marks the record invalid. */
  async validateCheckpoint(checkpointId: string, signal?: AbortSignal): Promise<ValidatedManifest> {
    this.assertAvailable();
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Checkpoint not found");
    if (checkpoint.state !== "ready" || checkpoint.gitSha === null || checkpoint.treeSha === null || checkpoint.manifestHash === null) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_READY", "This checkpoint is not ready to restore");
    }
    try {
      return await this.gitStore.validate(
        { projectId: checkpoint.projectId, gitSha: checkpoint.gitSha, treeSha: checkpoint.treeSha, manifestHash: checkpoint.manifestHash },
        { signal },
      );
    } catch (error) {
      if (isWorkspaceCheckpointError(error) && error.code === "CHECKPOINT_CORRUPT") {
        await this.store
          .mutate((database) => {
            const stored = database.workspaceCheckpoints.find((item) => item.id === checkpointId);
            if (stored && stored.state === "ready") {
              stored.state = "invalid";
              stored.errorCode = "CHECKPOINT_CORRUPT";
            }
          })
          .catch(() => undefined);
        await this.recordAudit({
          type: "workspace_checkpoint_invalid",
          status: "failure",
          projectId: checkpoint.projectId,
          ...(checkpoint.orchestrationId === null ? {} : { orchestrationId: checkpoint.orchestrationId }),
          principal: systemPrincipal(),
          summary: "Workspace checkpoint failed validation",
          metadata: { checkpointId, errorCode: "CHECKPOINT_CORRUPT", eventKey: checkpointId + ":invalid" },
        });
      }
      throw error;
    }
  }

  /**
   * Plan the exact apply. When `fromSafety` is set the plan is derived from
   * the safety checkpoint's recorded tree rather than the live directory, so
   * an interrupted apply resumes the identical plan.
   */
  async prepareRestore(
    targetCheckpointId: string,
    safetyCheckpointId: string | null,
    signal?: AbortSignal,
    options: { fromSafety?: boolean } = {},
  ): Promise<RestorePlan> {
    this.assertAvailable();
    const target = this.getCheckpoint(targetCheckpointId);
    if (!target || target.state !== "ready" || target.treeSha === null || target.manifestHash === null) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_READY", "The restore target is not a ready checkpoint");
    }
    let sourceTreeSha: string | undefined;
    if (options.fromSafety && safetyCheckpointId !== null) {
      const safety = this.getCheckpoint(safetyCheckpointId);
      if (!safety || safety.state !== "ready" || safety.treeSha === null) {
        throw new WorkspaceCheckpointError("CHECKPOINT_NOT_READY", "The safety checkpoint is not ready");
      }
      sourceTreeSha = safety.treeSha;
    }
    return this.gitStore.prepareRestore(
      {
        projectId: target.projectId,
        targetCheckpointId: target.id,
        targetTreeSha: target.treeSha,
        targetManifestHash: target.manifestHash,
        safetyCheckpointId,
        ...(sourceTreeSha === undefined ? {} : { sourceTreeSha }),
      },
      { signal },
    );
  }

  async applyRestore(plan: RestorePlan, signal?: AbortSignal): Promise<ValidatedManifest> {
    this.assertAvailable();
    return this.gitStore.applyRestore(plan, { signal });
  }

  /** Whether the eligible source on disk already equals a checkpoint's manifest. */
  async currentSourceMatches(checkpoint: WorkspaceCheckpoint, signal?: AbortSignal): Promise<boolean> {
    if (checkpoint.manifestHash === null) return false;
    const current = await this.gitStore.currentManifest(checkpoint.projectId, signal);
    return current.manifestHash === checkpoint.manifestHash;
  }

  // ------------------------------------------------------------------ reads

  getCheckpoint(checkpointId: string): WorkspaceCheckpoint | null {
    const found = this.store.snapshot().workspaceCheckpoints.find((item) => item.id === checkpointId);
    return found ? structuredClone(found) : null;
  }

  /** Cross-Project identities are hidden as not found. */
  requireCheckpoint(projectId: string, checkpointId: string): WorkspaceCheckpoint {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.projectId !== projectId) {
      throw new WorkspaceCheckpointError("CHECKPOINT_NOT_FOUND", "Checkpoint not found");
    }
    return checkpoint;
  }

  listProjectCheckpoints(
    projectId: string,
    options: { limit?: number; beforeOrdinal?: number } = {},
  ): { checkpoints: WorkspaceCheckpoint[]; nextBeforeOrdinal: number | null } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const items = this.store
      .snapshot()
      .workspaceCheckpoints.filter(
        (item) =>
          item.projectId === projectId &&
          (options.beforeOrdinal === undefined || item.ordinal < options.beforeOrdinal),
      )
      .sort((left, right) => right.ordinal - left.ordinal);
    const page = items.slice(0, limit).map((item) => structuredClone(item));
    const last = page.at(-1);
    return {
      checkpoints: page,
      nextBeforeOrdinal: items.length > limit && last ? last.ordinal : null,
    };
  }

  listSessionCheckpoints(orchestrationId: string): WorkspaceCheckpoint[] {
    return this.store
      .snapshot()
      .workspaceCheckpoints.filter((item) => item.orchestrationId === orchestrationId)
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => structuredClone(item));
  }

  /** The newest ready checkpoint of one execution cycle, if any. */
  latestReadyInCycle(projectId: string, executionCycleId: string | null): WorkspaceCheckpoint | null {
    if (executionCycleId === null) return null;
    const found = this.store
      .snapshot()
      .workspaceCheckpoints.filter(
        (item) =>
          item.projectId === projectId &&
          item.executionCycleId === executionCycleId &&
          item.state === "ready" &&
          item.kind !== "safety",
      )
      .sort((left, right) => right.ordinal - left.ordinal)[0];
    return found ? structuredClone(found) : null;
  }

  /** Server-derived affordance; a POST revalidates it. */
  isRecoverable(checkpoint: WorkspaceCheckpoint): boolean {
    return (
      this.capability().available &&
      checkpoint.state === "ready" &&
      checkpoint.kind !== "safety" &&
      checkpoint.resume !== null &&
      (checkpoint.kind !== "turn_success" || checkpoint.turnId !== null)
    );
  }

  toView(checkpoint: WorkspaceCheckpoint): WorkspaceCheckpointView {
    const recoverable = this.isRecoverable(checkpoint);
    const capability = this.capability();
    return toWorkspaceCheckpointView(checkpoint, {
      recoverable,
      unavailableReason: recoverable
        ? null
        : checkpoint.errorCode ?? (!capability.available ? capability.errorCode : null),
    });
  }

  // -------------------------------------------------------------- lifecycle

  /** Permanent Project deletion removes the private repository as well. */
  async deleteProjectData(projectId: string): Promise<void> {
    await this.gitStore.deleteRepository(projectId);
  }

  /**
   * Startup: a capture interrupted before its identity was persisted is
   * reconciled from its prewritten intent ref. Physical metadata may be
   * recovered; logical success never is.
   */
  private async reconcileIncompleteCaptures(): Promise<void> {
    const incomplete = this.store
      .snapshot()
      .workspaceCheckpoints.filter((item) => item.state === "preparing" || item.state === "captured");
    for (const checkpoint of incomplete) {
      let physical: Awaited<ReturnType<GitWorkspaceCheckpointStore["inspectIntentRef"]>> = null;
      if (this.capability().available && checkpoint.state === "preparing") {
        physical = await this.gitStore.inspectIntentRef(checkpoint.projectId, checkpoint.id).catch(() => null);
      }
      await this.store.mutate((database) => {
        const stored = database.workspaceCheckpoints.find((item) => item.id === checkpoint.id);
        if (!stored || (stored.state !== "preparing" && stored.state !== "captured")) return;
        if (physical) {
          stored.gitSha = physical.gitSha;
          stored.treeSha = physical.treeSha;
          stored.manifestHash = physical.manifestHash;
          stored.fileCount = physical.fileCount;
          stored.byteCount = physical.byteCount;
        }
        // A candidate without a published continuation is not a success; a
        // baseline or safety intent that never became ready is unusable too.
        stored.state = "failed";
        stored.errorCode = "CHECKPOINT_CAPTURE_FAILED";
      });
      await this.recordAudit({
        type: "workspace_checkpoint_reconciled",
        status: "failure",
        projectId: checkpoint.projectId,
        ...(checkpoint.orchestrationId === null ? {} : { orchestrationId: checkpoint.orchestrationId }),
        principal: systemPrincipal(),
        summary: "Incomplete workspace checkpoint reconciled after restart",
        metadata: {
          checkpointId: checkpoint.id,
          operationId: checkpoint.operationId,
          stage: checkpoint.state,
          reconciled: true,
          physicalRecovered: physical !== null,
          eventKey: checkpoint.id + ":reconciled",
        },
      });
    }
  }

  // ------------------------------------------------------------------ audit

  async auditCreated(checkpoint: WorkspaceCheckpoint): Promise<void> {
    this.onEvent({
      type: "workspace_checkpoint_created",
      projectId: checkpoint.projectId,
      ...(checkpoint.agentId === null ? {} : { agentId: checkpoint.agentId }),
      ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
      status: "ready",
      detail: "Workspace checkpoint #" + String(checkpoint.ordinal) + " (" + checkpoint.kind + ")",
    });
    await this.recordAudit({
      type: "workspace_checkpoint_created",
      status: "success",
      projectId: checkpoint.projectId,
      ...(checkpoint.orchestrationId === null ? {} : { orchestrationId: checkpoint.orchestrationId }),
      ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
      ...(checkpoint.agentId === null ? {} : { agentId: checkpoint.agentId }),
      principal: systemPrincipal(),
      summary: "Workspace checkpoint created",
      metadata: {
        checkpointId: checkpoint.id,
        checkpointOrdinal: checkpoint.ordinal,
        checkpointKind: checkpoint.kind,
        ...(checkpoint.executionCycleId === null ? {} : { executionCycleId: checkpoint.executionCycleId }),
        ...(checkpoint.stepIndex === null ? {} : { stepIndex: checkpoint.stepIndex }),
        fileCount: checkpoint.fileCount,
        byteCount: checkpoint.byteCount,
        excludedFileCount: checkpoint.excludedFileCount,
        policyVersion: checkpoint.policyVersion,
        eventKey: checkpoint.id + ":ready",
      },
    });
  }

  private async auditFailed(
    checkpoint: WorkspaceCheckpoint,
    errorCode: WorkspaceCheckpointErrorCode,
    stage: "capture" | "publish",
  ): Promise<void> {
    this.onEvent({
      type: "workspace_checkpoint_failed",
      projectId: checkpoint.projectId,
      ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
      status: "failed",
      detail: errorCode,
    });
    await this.recordAudit({
      type: "workspace_checkpoint_failed",
      status: "failure",
      projectId: checkpoint.projectId,
      ...(checkpoint.orchestrationId === null ? {} : { orchestrationId: checkpoint.orchestrationId }),
      ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
      principal: systemPrincipal(),
      summary: "Workspace checkpoint could not be established",
      metadata: {
        checkpointId: checkpoint.id,
        operationId: checkpoint.operationId,
        stage,
        errorCode,
        eventKey: checkpoint.id + ":" + stage + "-failed",
      },
    });
  }

  private async recordAudit(input: AuditEventInput): Promise<void> {
    if (!this.audit) return;
    await this.audit.record(input).catch(() => undefined);
  }
}

function errorCodeOf(error: unknown): WorkspaceCheckpointErrorCode {
  if (isWorkspaceCheckpointError(error)) return error.code;
  return "CHECKPOINT_CAPTURE_FAILED";
}
