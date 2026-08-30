import type { WorkspaceAgentActivity } from "../workspace-view-model";
import type { AvatarFace } from "./art/sprites";

/** Badge shown above an Agent. Never the only carrier of a status. */
export type AgentIndicator =
  | "none"
  | "dots"
  | "pause"
  | "alert"
  | "check"
  | "sleep"
  | "page"
  | "flask";

export interface AgentPresentation {
  face: AvatarFace;
  /** Runs the two-frame forearm loop when the runtime is busy. */
  typing: boolean;
  breathing: "calm" | "slow" | "none";
  indicator: AgentIndicator;
  /** Lifted out of the scene so a stopped Agent reads as inactive, not absent. */
  dimmed: boolean;
  /** A one-off flourish when the Agent enters this state. */
  celebrate: boolean;
  /** Shoulders drop by a pixel. Restrained, and never flashing. */
  slumped: boolean;
}

const PRESENTATION: Record<WorkspaceAgentActivity, AgentPresentation> = {
  idle: { face: "neutral", typing: false, breathing: "calm", indicator: "none", dimmed: false, celebrate: false, slumped: false },
  queued: { face: "neutral", typing: false, breathing: "slow", indicator: "pause", dimmed: false, celebrate: false, slumped: false },
  thinking: { face: "think", typing: false, breathing: "calm", indicator: "dots", dimmed: false, celebrate: false, slumped: false },
  working: { face: "focus", typing: true, breathing: "calm", indicator: "none", dimmed: false, celebrate: false, slumped: false },
  reviewing: { face: "focus", typing: false, breathing: "calm", indicator: "page", dimmed: false, celebrate: false, slumped: false },
  testing: { face: "focus", typing: true, breathing: "calm", indicator: "flask", dimmed: false, celebrate: false, slumped: false },
  waiting: { face: "neutral", typing: false, breathing: "slow", indicator: "pause", dimmed: false, celebrate: false, slumped: false },
  blocked: { face: "worried", typing: false, breathing: "slow", indicator: "alert", dimmed: false, celebrate: false, slumped: false },
  success: { face: "happy", typing: false, breathing: "calm", indicator: "check", dimmed: false, celebrate: true, slumped: false },
  failed: { face: "worried", typing: false, breathing: "slow", indicator: "alert", dimmed: false, celebrate: false, slumped: true },
  stopped: { face: "sleep", typing: false, breathing: "none", indicator: "sleep", dimmed: true, celebrate: false, slumped: false },
};

export function agentPresentation(activity: WorkspaceAgentActivity): AgentPresentation {
  return PRESENTATION[activity];
}
