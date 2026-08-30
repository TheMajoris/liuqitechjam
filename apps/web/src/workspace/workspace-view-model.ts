import type {
  OrchestrationStatus,
  PreviewStatus,
  ProjectRole,
} from "../types";

/**
 * Presentation vocabulary for the collaborative workspace.
 *
 * These values are a *projection* of backend state, never a source of it.
 * Nothing here is persisted, and no authorization, routing, or lifecycle
 * decision may be derived from a value in this file: the middleware decides,
 * the workspace only shows what it decided.
 */
export type WorkspaceAgentActivity =
  | "idle"
  | "queued"
  | "thinking"
  | "working"
  | "waiting"
  | "reviewing"
  | "testing"
  | "blocked"
  | "success"
  | "failed"
  | "stopped";

/** Where an Agent stands in the room. Purely visual. */
export type WorkspaceStation = "desk" | "board" | "door";

export interface WorkspaceAgentViewModel {
  agentId: string;
  /** Roster occurrence that seated this Agent, when a Team is open. */
  participantId: string | null;
  name: string;
  /** Roster responsibility label, when the Team set one. */
  role: string | null;
  activity: WorkspaceAgentActivity;
  currentRunId: string | null;
  /** Already redacted by the server before it ever reaches the client. */
  safeSummary: string | null;
  isCurrentParticipant: boolean;
  /** Target of the most recent `supervisor_decision` event. */
  isSupervisorChoice: boolean;
  isSelected: boolean;
  modelLabel: string | null;
  projectRole: ProjectRole | null;
  /** False when the roster references an Agent that no longer exists. */
  available: boolean;
  /** Backend lifecycle status, kept verbatim for the inspector. */
  lifecycle: "ready" | "busy" | "stopped" | "error" | "unknown";
  /** Deterministic seat, so an Agent keeps its desk across refreshes. */
  seatIndex: number;
  station: WorkspaceStation;
}

export type WorkspacePreviewActivity =
  | "unavailable"
  | "not_started"
  | PreviewStatus;

/**
 * The permission boundary's *appearance*. The door never enforces anything:
 * `PermitApprovalService` and the policy layer decide, and this only mirrors
 * the decision they already made.
 */
export type WorkspaceDoorState =
  | "dormant"
  | "locked"
  | "waiting"
  | "open"
  | "denied";

export interface WorkspaceApprovalViewModel {
  id: string;
  agentId: string;
  agentName: string;
  toolId: string;
  safeSummary: string;
  status: string;
  createdAt: string;
}

export interface WorkspaceHandoffViewModel {
  /** Event id; a new id is what triggers the visual handoff, once. */
  id: string;
  sequence: number;
  fromAgentId: string | null;
  toAgentId: string;
}

export interface WorkspaceViewModel {
  id: string;
  name: string;
  /** What the room represents right now. */
  kind: "project" | "team" | "agent" | "empty";
  projectId: string | null;
  sessionId: string | null;
  agents: WorkspaceAgentViewModel[];
  /** Seated Agents, capped by the room; the roster list shows everyone. */
  seatedAgentIds: string[];
  orchestrationStatus: OrchestrationStatus | null;
  orchestrationSummary: string;
  /** The Team's task, shown on the shared board. User-authored text. */
  boardTask: string | null;
  stepIndex: number | null;
  maxSteps: number | null;
  previewStatus: WorkspacePreviewActivity;
  previewUrl: string | null;
  activeAgentId: string | null;
  selectedAgentId: string | null;
  latestHandoff: WorkspaceHandoffViewModel | null;
  pendingApprovals: WorkspaceApprovalViewModel[];
  doorState: WorkspaceDoorState;
}

interface ActivityDescriptor {
  label: string;
  /** Short, non-colour explanation of the state for text surfaces. */
  detail: string;
  /** Semantic tone, mirrored by CSS classes and Pixi accents. */
  tone: "neutral" | "active" | "waiting" | "positive" | "danger" | "muted";
  /** Glyph so status never depends on colour alone. */
  glyph: string;
}

export const WORKSPACE_ACTIVITY: Record<WorkspaceAgentActivity, ActivityDescriptor> = {
  idle: { label: "Idle", detail: "At their desk, nothing running.", tone: "neutral", glyph: "○" },
  queued: { label: "Queued", detail: "In the Team, waiting for a turn.", tone: "waiting", glyph: "◔" },
  thinking: { label: "Thinking", detail: "Selected for this turn; the runtime is busy.", tone: "active", glyph: "◌" },
  working: { label: "Working", detail: "Running its turn in the workspace.", tone: "active", glyph: "◐" },
  waiting: { label: "Waiting", detail: "Finished a turn, waiting for the Team.", tone: "waiting", glyph: "◔" },
  reviewing: { label: "Reviewing", detail: "Running a review turn.", tone: "active", glyph: "◑" },
  testing: { label: "Testing", detail: "Running a test turn.", tone: "active", glyph: "◒" },
  blocked: { label: "Needs approval", detail: "Stopped at the permission boundary.", tone: "danger", glyph: "▲" },
  success: { label: "Completed", detail: "Its last turn finished successfully.", tone: "positive", glyph: "✓" },
  failed: { label: "Failed", detail: "Its last turn did not finish.", tone: "danger", glyph: "✕" },
  stopped: { label: "Stopped", detail: "Not running.", tone: "muted", glyph: "◼" },
};

/**
 * "Thinking" means the runtime is busy on this Agent's behalf. It is not a
 * window into model reasoning, and no reasoning text is ever rendered here.
 */
export function activityLabel(activity: WorkspaceAgentActivity): string {
  return WORKSPACE_ACTIVITY[activity].label;
}

export function activityDetail(activity: WorkspaceAgentActivity): string {
  return WORKSPACE_ACTIVITY[activity].detail;
}

export function activityTone(activity: WorkspaceAgentActivity): ActivityDescriptor["tone"] {
  return WORKSPACE_ACTIVITY[activity].tone;
}

export const PREVIEW_ACTIVITY_LABEL: Record<WorkspacePreviewActivity, string> = {
  unavailable: "No shared preview",
  not_started: "Not running",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted",
};

export const DOOR_STATE_LABEL: Record<WorkspaceDoorState, string> = {
  dormant: "Approvals not configured",
  locked: "Locked",
  waiting: "Waiting for you",
  open: "Approved",
  denied: "Denied",
};
