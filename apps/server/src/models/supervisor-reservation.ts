import type { Agent } from "../types.js";
import type { ModelDescriptor, ModelRef } from "./types.js";

/**
 * The narrow slice of AgentService this reconciliation needs. Keeping it
 * structural lets the routes and startup path share one implementation
 * without either of them depending on the full service surface.
 */
export interface ReservationAgentService {
  listAgents(): Agent[];
  updateAgent(
    id: string,
    input: { modelRef?: ModelRef; fallbackModelRefs?: ModelRef[] },
  ): Promise<Agent>;
}

export interface ReservationOutcome {
  agentId: string;
  agentName: string;
  /** Absent when only fallbacks referenced the reserved endpoint. */
  movedPrimaryTo?: string;
  droppedFallbacks: number;
  /** Set when the Agent could not be moved; it keeps its assignment. */
  skippedReason?: string;
}

function referencesReserved(
  modelRef: ModelRef | undefined,
  reservedModelId: string,
): boolean {
  return modelRef?.modelId === reservedModelId;
}

export interface ReservedModelConflict {
  agentId: string;
  agentName: string;
  /** True when the Agent's primary assignment is the reserved endpoint. */
  primary: boolean;
  /** How many of the Agent's fallbacks point at the reserved endpoint. */
  fallbacks: number;
}

/**
 * Which Agents are pointed at the endpoint reserved for supervisor routing.
 *
 * Read-only on purpose. A worker model assignment is the operator's choice, so
 * nothing that merely observes a conflict — a restart, a catalog poll — may
 * rewrite it; the conflict is reported and the operator decides. Only the
 * explicit supervisor-endpoint change offers the acknowledged move below.
 */
export function findAgentsOnReservedModel(
  agentService: Pick<ReservationAgentService, "listAgents">,
  reservedModelId: string,
): ReservedModelConflict[] {
  const reserved = reservedModelId.trim();
  if (reserved.length === 0) return [];
  const conflicts: ReservedModelConflict[] = [];
  for (const agent of agentService.listAgents()) {
    const primary = referencesReserved(agent.modelRef, reserved);
    const fallbacks = (agent.fallbackModelRefs ?? []).filter((fallback) =>
      referencesReserved(fallback, reserved),
    ).length;
    if (!primary && fallbacks === 0) continue;
    conflicts.push({ agentId: agent.id, agentName: agent.name, primary, fallbacks });
  }
  return conflicts;
}

/**
 * Move every Agent off the endpoint reserved for supervisor routing.
 *
 * Worker resolution rejects the reserved endpoint, so an Agent left pointing
 * at it cannot run at all. Reassigning is therefore the repair, not a silent
 * preference change — which is exactly why only the operator's own supervisor
 * change calls this, and why every move is reported back for display.
 */
export async function releaseAgentsFromReservedModel(options: {
  agentService: ReservationAgentService;
  reservedModelId: string;
  /** Running worker endpoints, already excluding the reserved one. */
  availableModels: ModelDescriptor[];
  preferredModelRef?: ModelRef | null;
}): Promise<ReservationOutcome[]> {
  const reservedModelId = options.reservedModelId.trim();
  if (reservedModelId.length === 0) return [];

  const affected = options.agentService.listAgents().filter(
    (agent) =>
      referencesReserved(agent.modelRef, reservedModelId) ||
      (agent.fallbackModelRefs ?? []).some((fallback) =>
        referencesReserved(fallback, reservedModelId),
      ),
  );
  if (affected.length === 0) return [];

  const preferred = options.preferredModelRef;
  const replacement: ModelRef | null =
    preferred && preferred.modelId !== reservedModelId
      ? { providerId: preferred.providerId, modelId: preferred.modelId }
      : options.availableModels[0]
        ? {
            providerId: options.availableModels[0].providerId,
            modelId: options.availableModels[0].id,
          }
        : null;

  const outcomes: ReservationOutcome[] = [];
  for (const agent of affected) {
    const needsPrimary = referencesReserved(agent.modelRef, reservedModelId);
    const keptFallbacks = (agent.fallbackModelRefs ?? []).filter(
      (fallback) => !referencesReserved(fallback, reservedModelId),
    );
    const droppedFallbacks =
      (agent.fallbackModelRefs ?? []).length - keptFallbacks.length;

    if (needsPrimary && replacement === null) {
      outcomes.push({
        agentId: agent.id,
        agentName: agent.name,
        droppedFallbacks: 0,
        skippedReason: "No other running worker endpoint is available",
      });
      continue;
    }

    try {
      await options.agentService.updateAgent(agent.id, {
        ...(needsPrimary && replacement !== null
          ? { modelRef: replacement }
          : {}),
        ...(droppedFallbacks > 0 ? { fallbackModelRefs: keptFallbacks } : {}),
      });
      outcomes.push({
        agentId: agent.id,
        agentName: agent.name,
        ...(needsPrimary && replacement !== null
          ? { movedPrimaryTo: replacement.modelId }
          : {}),
        droppedFallbacks,
      });
    } catch (error) {
      // A busy Agent cannot be edited. Report it rather than failing the
      // whole reconciliation; the next pass picks it up once it is idle.
      outcomes.push({
        agentId: agent.id,
        agentName: agent.name,
        droppedFallbacks: 0,
        skippedReason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
