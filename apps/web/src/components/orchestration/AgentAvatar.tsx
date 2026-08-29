import type { CSSProperties } from "react";
import { agentHue, agentInitials } from "./orchestration-utils";

interface AgentAvatarProps {
  agentId: string;
  name: string;
  /** Turn order badge shown for roster and conversation contexts. */
  order?: number;
  size?: "sm" | "md";
}

export function AgentAvatar({ agentId, name, order, size = "md" }: AgentAvatarProps) {
  return (
    <span className={`orch-avatar orch-avatar-${size}`} aria-hidden="true">
      <span
        className="orch-avatar-disc"
        style={{ "--orch-avatar-hue": agentHue(agentId) } as CSSProperties}
      >
        {agentInitials(name)}
      </span>
      {order !== undefined && <span className="orch-avatar-order">{order}</span>}
    </span>
  );
}
