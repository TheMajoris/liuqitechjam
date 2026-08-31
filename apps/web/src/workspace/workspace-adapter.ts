import type {
  Agent,
  ApprovalRecord,
  AuditEventRecord,
  ModelDescriptor,
  ModelProviderDescriptor,
  OrchestrationEvent,
  OrchestrationParticipant,
  OrchestrationSessionDetail,
  OrchestrationTurn,
  Preview,
  Project,
  ProjectRole,
} from "../types";
import { formatAgentWorkerModel } from "../components/WorkerModelFields";
import { agentName, humanizeFailure, isOrchestrationActive } from "../components/orchestration/orchestration-utils";
import { MAX_SEATS } from "./workspace-layout";
import type {
  WorkspaceAgentActivity,
  WorkspaceAgentViewModel,
  WorkspaceApprovalViewModel,
  WorkspaceDoorState,
  WorkspaceHandoffViewModel,
  WorkspacePreviewActivity,
  WorkspaceStation,
  WorkspaceToolActivity,
  WorkspaceViewModel,
} from "./workspace-view-model";

export interface WorkspaceSource {
  agents: Agent[];
  detail: OrchestrationSessionDetail | null;
  project: Project | null;
  preview: Preview | null;
  /** `null` means the approvals API is not configured; the door stays dormant. */
  approvals: ApprovalRecord[] | null;
  selectedAgentId: string | null;
  modelProviders?: ModelProviderDescriptor[];
  models?: ModelDescriptor[];
  /** Safe audit projection; absent when the activity API is not configured. */
  activity?: AuditEventRecord[];
}

const SUMMARY_LIMIT = 160;

/** One seat per Agent: a roster may list the same Agent more than once. */
function rosterAgentIds(source: WorkspaceSource): Array<{
  agentId: string;
  participant: OrchestrationParticipant | null;
}> {
  const seen = new Set<string>();
  const roster: Array<{ agentId: string; participant: OrchestrationParticipant | null }> = [];
  for (const participant of source.detail?.session.participants ?? []) {
    if (seen.has(participant.agentId)) continue;
    seen.add(participant.agentId);
    roster.push({ agentId: participant.agentId, participant });
  }
  for (const agentId of source.project?.agentIds ?? []) {
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    roster.push({ agentId, participant: null });
  }
  return roster;
}

function latestTurnFor(turns: readonly OrchestrationTurn[], agentId: string): OrchestrationTurn | null {
  let latest: OrchestrationTurn | null = null;
  for (const turn of turns) {
    if (turn.agentId !== agentId) continue;
    if (latest === null) {
      latest = turn;
      continue;
    }
    const currentStep = turn.stepIndex ?? -1;
    const latestStep = latest.stepIndex ?? -1;
    if (currentStep !== latestStep) {
      if (currentStep > latestStep) latest = turn;
      continue;
    }
    if (turn.createdAt.localeCompare(latest.createdAt) >= 0) latest = turn;
  }
  return latest;
}

/**
 * Roster labels are the only signal the current backend gives about the *kind*
 * of turn an Agent is running, so "reviewing" and "testing" are refinements of
 * "working" derived from the Team's own responsibility label. The underlying
 * fact is unchanged: the runtime is busy on this Agent's behalf.
 */
function busyActivity(role: string | null): WorkspaceAgentActivity {
  const label = (role ?? "").toLowerCase();
  if (/\b(test|qa|verif|validat)/.test(label)) return "testing";
  if (/\b(review|critiqu|audit|inspect)/.test(label)) return "reviewing";
  return "working";
}

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

/**
 * Close any emphasis or code marker left hanging by truncation.
 *
 * Cutting inside `**bold**` would otherwise render the literal asterisks, so
 * the visible fragment keeps its emphasis instead of showing the syntax.
 */
function closeMarkers(text: string): string {
  let result = text;
  if (occurrences(result, "```") % 2 === 1) return result + "\n```";
  if (occurrences(result, "`") % 2 === 1) result += "`";
  if (occurrences(result, "**") % 2 === 1) result += "**";
  return result;
}

/**
 * Bound Agent output for a preview surface without breaking its markdown.
 *
 * Line structure is preserved — collapsing newlines would flatten a list into
 * a run-on sentence — while runs of blank lines and horizontal whitespace are
 * still normalized so one reply cannot stretch the panel.
 */
function clip(value: string | null | undefined): string | null {
  const text = (value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ \n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  if (text.length <= SUMMARY_LIMIT) return closeMarkers(text);
  const cut = text.slice(0, SUMMARY_LIMIT - 1);
  // Prefer a word boundary, but never throw away most of the budget for one.
  const boundary = cut.lastIndexOf(" ");
  const body = boundary > SUMMARY_LIMIT * 0.6 ? cut.slice(0, boundary) : cut;
  // A marker at the very end opened something that was cut away entirely.
  const trimmed = body.trimEnd().replace(/[*_`~]+$/, "").trimEnd();
  // The ellipsis goes inside the markers, so a closing fence stays last.
  return closeMarkers(trimmed + "…");
}

interface ActivityInput {
  agent: Agent | undefined;
  participant: OrchestrationParticipant | null;
  detail: OrchestrationSessionDetail | null;
  hasPendingApproval: boolean;
}

export function resolveActivity({
  agent,
  participant,
  detail,
  hasPendingApproval,
}: ActivityInput): WorkspaceAgentActivity {
  if (!agent) return "stopped";
  if (hasPendingApproval) return "blocked";
  if (agent.status === "stopped") return "stopped";

  const session = detail?.session ?? null;
  const active = session ? isOrchestrationActive(session.status) : false;
  const turn = detail && agent ? latestTurnFor(detail.turns, agent.id) : null;

  if (session && active && participant) {
    const isCurrent = session.currentParticipantId === participant.id;
    if (isCurrent) {
      return turn?.status === "dispatched"
        ? busyActivity(participant.role)
        : "thinking";
    }
    return turn ? "waiting" : "queued";
  }

  if (agent.status === "error") return "failed";
  if (turn) {
    if (turn.status === "failed" || turn.status === "timed_out") return "failed";
    if (turn.status === "cancelled") return "stopped";
    if (turn.status === "dispatched") return busyActivity(participant?.role ?? null);
    if (turn.status === "completed") return "success";
  }
  if (agent.status === "busy") return "working";
  return "idle";
}

/**
 * Which zone a running tool sends the Agent to.
 *
 * Keyed by prefix so a tool added later lands somewhere sensible without this
 * table having to know its exact id. An unmapped tool keeps the Agent at its
 * desk rather than guessing.
 */
const TOOL_STATIONS: ReadonlyArray<readonly [string, WorkspaceStation]> = [
  ["web.", "library"],
  ["project.preview.", "server"],
];

export function stationForTool(toolId: string): WorkspaceStation | null {
  for (const [prefix, station] of TOOL_STATIONS) {
    if (toolId.startsWith(prefix)) return station;
  }
  return null;
}

/**
 * Where the visual state machine parks this Agent. Never a security fact.
 *
 * A live tool wins over the activity, because it is the more specific truth:
 * an Agent that is "working" *and* running `web.search` is at the shelves, not
 * at its desk. Approval and turn selection still outrank it — being stopped at
 * the boundary is the thing a viewer most needs to see.
 */
export function resolveStation(
  activity: WorkspaceAgentActivity,
  activeTool: WorkspaceToolActivity | null = null,
): WorkspaceStation {
  if (activity === "blocked") return "door";
  if (activity === "thinking") return "board";
  if (activeTool !== null) {
    const station = stationForTool(activeTool.toolId);
    if (station !== null) return station;
  }
  return "desk";
}

/**
 * The tool each Agent still has open.
 *
 * A `tool_started` with no later `tool_succeeded`/`tool_failed` for the same
 * run is treated as in flight. Events arrive newest-first from the API, so the
 * first outcome seen for a run closes it.
 */
export function resolveActiveTools(
  events: readonly AuditEventRecord[],
): Map<string, WorkspaceToolActivity> {
  const active = new Map<string, WorkspaceToolActivity>();
  const closed = new Set<string>();
  const ordered = [...events].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  for (const event of ordered) {
    const agentId = event.agentId;
    const toolId = event.resource?.id;
    if (agentId === undefined || toolId === undefined) continue;
    const key = agentId + "|" + (event.runId ?? "") + "|" + toolId;
    if (event.type === "tool_succeeded" || event.type === "tool_failed") {
      closed.add(key);
      continue;
    }
    if (event.type !== "tool_started") continue;
    if (closed.has(key)) continue;
    // Newest-first, so the first open start per Agent is the current one.
    if (!active.has(agentId)) {
      active.set(agentId, { toolId, startedAt: event.createdAt });
    }
  }
  return active;
}

function latestEventOfType(
  events: readonly OrchestrationEvent[],
  type: OrchestrationEvent["type"],
): OrchestrationEvent | null {
  let latest: OrchestrationEvent | null = null;
  for (const event of events) {
    if (event.type !== type) continue;
    if (latest === null || event.sequence > latest.sequence) latest = event;
  }
  return latest;
}

export function resolveHandoff(
  events: readonly OrchestrationEvent[],
): WorkspaceHandoffViewModel | null {
  const handoff = latestEventOfType(events, "handoff_applied");
  if (!handoff?.agentId) return null;
  let from: string | null = null;
  for (const event of events) {
    if (event.sequence >= handoff.sequence) continue;
    if (event.type !== "run_completed" || !event.agentId) continue;
    if (event.agentId === handoff.agentId) continue;
    from = event.agentId;
  }
  return {
    id: handoff.id,
    sequence: handoff.sequence,
    fromAgentId: from,
    toAgentId: handoff.agentId,
  };
}

export function resolveDoorState(approvals: ApprovalRecord[] | null): WorkspaceDoorState {
  if (approvals === null) return "dormant";
  if (approvals.some((approval) => approval.status === "pending")) return "waiting";
  const latest = [...approvals].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0];
  if (!latest) return "locked";
  if (latest.status === "approved") return "open";
  if (latest.status === "denied" || latest.status === "revoked" || latest.status === "expired") {
    return "denied";
  }
  return "locked";
}

function previewActivity(preview: Preview | null): WorkspacePreviewActivity {
  if (!preview) return "not_started";
  return preview.status;
}

function projectRoleFor(project: Project | null, agentId: string): ProjectRole | null {
  const membership = (project?.memberships ?? []).find((item) => item.agentId === agentId);
  if (membership) return membership.role;
  return project?.agentIds.includes(agentId) ? "editor" : null;
}

function orchestrationSummary(source: WorkspaceSource, activeName: string | null): string {
  const session = source.detail?.session;
  if (!session) {
    return source.project
      ? "No Team is running in this Workspace right now."
      : "Open a Team conversation to watch the Agents work.";
  }
  switch (session.status) {
    case "draft":
      return "Ready to start.";
    case "queued":
      return "Getting the first Agent started…";
    case "running":
      return activeName ? `${activeName} is working on its turn.` : "An Agent is working.";
    case "stopping":
      return "Finishing up and cancelling in-flight work…";
    case "completed":
      return "The Team finished this conversation.";
    case "stopped":
      return "You stopped this conversation.";
    case "interrupted":
      return "The service restarted while this was running.";
    case "failed":
      return humanizeFailure(session.errorCode, session.errorMessage);
    default:
      return session.status;
  }
}

/**
 * The only bridge from middleware state to the workspace.
 *
 * Pure and synchronous on purpose: everything the room shows can be recomputed
 * from what the backend last said, so a browser refresh reconstructs the scene
 * exactly and nothing visual has to be persisted anywhere.
 */
export function buildWorkspaceViewModel(source: WorkspaceSource): WorkspaceViewModel {
  const session = source.detail?.session ?? null;
  const events = source.detail?.events ?? [];
  const byId = new Map(source.agents.map((agent) => [agent.id, agent]));
  const pendingApprovals: WorkspaceApprovalViewModel[] = (source.approvals ?? [])
    .filter((approval) => approval.status === "pending")
    .map((approval) => ({
      id: approval.id,
      agentId: approval.agentId,
      agentName: agentName(source.agents, approval.agentId),
      toolId: approval.toolId,
      safeSummary: clip(approval.safeSummary) ?? "External access requested.",
      status: approval.status,
      createdAt: approval.createdAt,
    }));
  const blockedAgentIds = new Set(pendingApprovals.map((approval) => approval.agentId));

  const supervisorChoice = session && isOrchestrationActive(session.status)
    ? latestEventOfType(events, "supervisor_decision")?.agentId ?? null
    : null;

  const currentParticipant = session?.currentParticipantId
    ? session.participants.find((item) => item.id === session.currentParticipantId) ?? null
    : null;

  const activeTools = resolveActiveTools(source.activity ?? []);

  const agents: WorkspaceAgentViewModel[] = rosterAgentIds(source).map(
    ({ agentId, participant }, index) => {
      const agent = byId.get(agentId);
      // Only a running Agent can have a tool open; a stale start must not
      // strand a finished Agent in the library.
      const activeTool = agent?.status === "busy"
        ? activeTools.get(agentId) ?? null
        : null;
      const activity = resolveActivity({
        agent,
        participant,
        detail: source.detail,
        hasPendingApproval: blockedAgentIds.has(agentId),
      });
      const turn = source.detail ? latestTurnFor(source.detail.turns, agentId) : null;
      const role = participant?.role.trim() || null;
      return {
        agentId,
        participantId: participant?.id ?? null,
        name: agent?.name ?? "Unavailable Agent",
        role: role && role !== agent?.name ? role : null,
        activity,
        currentRunId:
          currentParticipant?.agentId === agentId ? session?.currentRunId ?? null : turn?.runId ?? null,
        // Only real, server-redacted turn output. An Agent that has not
        // spoken has no summary, and the inspector says nothing rather than
        // filling the space with its description.
        safeSummary: clip(turn?.safeOutput),
        isCurrentParticipant: currentParticipant?.agentId === agentId,
        isSupervisorChoice: supervisorChoice === agentId,
        isSelected: source.selectedAgentId === agentId,
        modelLabel: agent
          ? formatAgentWorkerModel(agent, source.modelProviders ?? [], source.models ?? [])
          : null,
        projectRole: projectRoleFor(source.project, agentId),
        available: agent !== undefined,
        lifecycle: agent?.status ?? "unknown",
        seatIndex: index,
        station: resolveStation(activity, activeTool),
        activeTool,
        appearance: agent?.appearance ?? null,
      };
    },
  );

  const activeAgentId = currentParticipant?.agentId ?? null;
  const activeName = activeAgentId ? agentName(source.agents, activeAgentId) : null;
  const kind: WorkspaceViewModel["kind"] = source.project
    ? "project"
    : session
      ? "team"
      : agents.length > 0
        ? "agent"
        : "empty";

  return {
    id: source.project?.id ?? session?.id ?? "workspace",
    name: source.project?.name ?? session?.name ?? "Workspace",
    kind,
    projectId: source.project?.id ?? null,
    sessionId: session?.id ?? null,
    agents,
    seatedAgentIds: agents.slice(0, MAX_SEATS).map((agent) => agent.agentId),
    orchestrationStatus: session?.status ?? null,
    orchestrationSummary: orchestrationSummary(source, activeName),
    boardTask: clip(session?.originalPrompt),
    stepIndex: session?.stepIndex ?? null,
    maxSteps: session?.maxSteps ?? null,
    previewStatus: source.project ? previewActivity(source.preview) : "unavailable",
    previewUrl: source.preview?.url ?? null,
    activeAgentId,
    selectedAgentId: source.selectedAgentId,
    latestHandoff: resolveHandoff(events),
    pendingApprovals,
    doorState: resolveDoorState(source.approvals),
  };
}
