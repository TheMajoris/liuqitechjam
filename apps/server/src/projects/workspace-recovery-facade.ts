import type { Principal } from "../access/access-types.js";
import type { Database } from "../types.js";
import type { RestorePlan } from "./git-workspace-checkpoint-store.js";
import type { ProjectService } from "./project-service.js";
import type {
  CaptureBaselineInput,
  CaptureSafetyInput,
  PublishTurnCheckpointInput,
  WorkspaceCheckpointService,
} from "./workspace-checkpoint-service.js";
import type {
  WorkspaceCheckpoint,
  WorkspaceCheckpointErrorCode,
  WorkspaceCheckpointView,
  WorkspaceOperation,
  WorkspaceOperationStage,
} from "./workspace-checkpoint-types.js";
import type {
  ReserveCycleInput,
  ReserveRecoveryInput,
  WorkspaceOperationCoordinator,
} from "./workspace-operation-coordinator.js";

/**
 * Everything orchestration needs from the Project layer to run checkpointed
 * cycles and operator recovery. It is a narrow composition over the Project
 * service, the checkpoint service, and the reservation coordinator, so the
 * orchestration module never reaches Git, the filesystem, or lease internals.
 */
export interface OrchestrationWorkspaceRecovery {
  enabled(): boolean;
  assertRuntimeSupported(): void;
  workspaceEpoch(projectId: string): number;
  authorizeRecovery(projectId: string, principal: Principal): Promise<void>;
  quiescePreviews(projectId: string): Promise<void>;
  requireNoPhysicalWriter(projectId: string): void;
  reserveCycle(
    input: ReserveCycleInput,
    check?: (database: Database) => void,
  ): Promise<WorkspaceOperation>;
  reserveRecovery(
    input: ReserveRecoveryInput,
    check?: (database: Database) => void,
  ): Promise<{ operation: WorkspaceOperation; duplicate: boolean }>;
  findRecoveryRequest(projectId: string, requestId: string): WorkspaceOperation | null;
  getOperation(operationId: string): WorkspaceOperation | null;
  latestOperationForSession(
    orchestrationId: string,
    kind?: WorkspaceOperation["kind"],
  ): WorkspaceOperation | null;
  transitionOperation(
    operationId: string,
    stage: WorkspaceOperationStage,
    patch?: Parameters<WorkspaceOperationCoordinator["transitionIn"]>[3],
  ): Promise<WorkspaceOperation>;
  transitionOperationIn(
    database: Database,
    operationId: string,
    stage: WorkspaceOperationStage,
    patch?: Parameters<WorkspaceOperationCoordinator["transitionIn"]>[3],
  ): WorkspaceOperation;
  releaseOperation(
    operationId: string,
    stage: "settled" | "failed",
    errorCode?: WorkspaceCheckpointErrorCode | null,
  ): Promise<WorkspaceOperation>;
  releaseOperationIn(
    database: Database,
    operationId: string,
    stage: "settled" | "failed",
    errorCode?: WorkspaceCheckpointErrorCode | null,
  ): WorkspaceOperation;
  transferToCycleIn(
    database: Database,
    recoveryOperationId: string,
    cycle: { orchestrationId: string; executionCycleId: string; actorPrincipalId: string; expectedEpoch: number },
  ): WorkspaceOperation;
  captureBaseline(input: CaptureBaselineInput): Promise<WorkspaceCheckpoint>;
  captureSafety(input: CaptureSafetyInput): Promise<WorkspaceCheckpoint>;
  publishTurnCheckpoint(database: Database, input: PublishTurnCheckpointInput): WorkspaceCheckpoint;
  invalidateCandidate(checkpointId: string, errorCode: WorkspaceCheckpointErrorCode): Promise<void>;
  validateCheckpoint(checkpointId: string, signal?: AbortSignal): Promise<unknown>;
  prepareRestore(
    targetCheckpointId: string,
    safetyCheckpointId: string | null,
    signal?: AbortSignal,
    options?: { fromSafety?: boolean },
  ): Promise<RestorePlan>;
  applyRestore(plan: RestorePlan, signal?: AbortSignal): Promise<unknown>;
  currentSourceMatches(checkpoint: WorkspaceCheckpoint, signal?: AbortSignal): Promise<boolean>;
  getCheckpoint(checkpointId: string): WorkspaceCheckpoint | null;
  listSessionCheckpoints(orchestrationId: string): WorkspaceCheckpoint[];
  checkpointView(checkpoint: WorkspaceCheckpoint): WorkspaceCheckpointView;
  auditCheckpointCreated(checkpoint: WorkspaceCheckpoint): Promise<void>;
  /** Advance the epoch and clear every Project thread inside the caller's mutation. */
  resetWorkspaceIn(database: Database, projectId: string, checkpointId: string): number;
}

export function createWorkspaceRecoveryFacade(dependencies: {
  projects: ProjectService;
  checkpoints: WorkspaceCheckpointService;
  operations: WorkspaceOperationCoordinator;
}): OrchestrationWorkspaceRecovery {
  const { projects, checkpoints, operations } = dependencies;
  return {
    enabled: () => checkpoints.isEnabled(),
    assertRuntimeSupported: () => projects.assertCheckpointRuntimeSupported(),
    workspaceEpoch: (projectId) => projects.workspaceEpoch(projectId),
    authorizeRecovery: (projectId, principal) => projects.authorizeWorkspaceRecovery(projectId, principal),
    quiescePreviews: (projectId) => projects.quiescePreviewsForWorkspaceOperation(projectId),
    requireNoPhysicalWriter: (projectId) => projects.requireNoPhysicalWriter(projectId),
    reserveCycle: (input, check) => operations.reserveCycle(input, check),
    reserveRecovery: (input, check) => operations.reserveRecovery(input, check),
    findRecoveryRequest: (projectId, requestId) => operations.findRecoveryRequest(projectId, requestId),
    getOperation: (operationId) => operations.getOperation(operationId),
    latestOperationForSession: (orchestrationId, kind) => operations.latestForSession(orchestrationId, kind),
    transitionOperation: (operationId, stage, patch) => operations.transition(operationId, stage, patch),
    transitionOperationIn: (database, operationId, stage, patch) =>
      operations.transitionIn(database, operationId, stage, patch),
    releaseOperation: (operationId, stage, errorCode) => operations.release(operationId, stage, errorCode ?? null),
    releaseOperationIn: (database, operationId, stage, errorCode) =>
      operations.releaseIn(database, operationId, stage, errorCode ?? null),
    transferToCycleIn: (database, recoveryOperationId, cycle) =>
      operations.transferToCycleIn(database, recoveryOperationId, cycle),
    captureBaseline: (input) => checkpoints.captureBaseline(input),
    captureSafety: (input) => checkpoints.captureSafety(input),
    publishTurnCheckpoint: (database, input) => checkpoints.publishTurnCheckpoint(database, input),
    invalidateCandidate: (checkpointId, errorCode) => checkpoints.invalidateCandidate(checkpointId, errorCode),
    validateCheckpoint: (checkpointId, signal) => checkpoints.validateCheckpoint(checkpointId, signal),
    prepareRestore: (targetCheckpointId, safetyCheckpointId, signal, options) =>
      checkpoints.prepareRestore(targetCheckpointId, safetyCheckpointId, signal, options),
    applyRestore: (plan, signal) => checkpoints.applyRestore(plan, signal),
    currentSourceMatches: (checkpoint, signal) => checkpoints.currentSourceMatches(checkpoint, signal),
    getCheckpoint: (checkpointId) => checkpoints.getCheckpoint(checkpointId),
    listSessionCheckpoints: (orchestrationId) => checkpoints.listSessionCheckpoints(orchestrationId),
    checkpointView: (checkpoint) => checkpoints.toView(checkpoint),
    auditCheckpointCreated: (checkpoint) => checkpoints.auditCreated(checkpoint),
    resetWorkspaceIn: (database, projectId, checkpointId) =>
      projects.resetWorkspaceIn(database, projectId, checkpointId),
  };
}
