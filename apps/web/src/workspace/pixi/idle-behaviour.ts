import type { WorldPoint, WorldRect } from "../workspace-layout";

/** Idle this long without a personal doze delay and the Agent goes to sleep. */
export const DOZE_AFTER_MS = 20_000;
/** Baseline gap between idle decisions, before each Agent's own jitter. */
export const WANDER_INTERVAL_MS = 4200;

/**
 * What an idle Agent should do next.
 *
 * `wander` drifts to a spot inside its own pod, `pause` simply stands there a
 * while longer, `break` stretches its legs in the lounge, `doze` sends it off
 * for a nap, and `wake` brings it back — when the nap ends, when a break is
 * over, or when the middleware gives it work again.
 *
 * Every one of these reads as *not working*. Nothing here sends an idle Agent
 * to the library, the board, or the server rack, because standing at those
 * would suggest activity the middleware never reported.
 */
export type IdleAction =
  | { kind: "none" }
  | { kind: "wander"; point: WorldPoint }
  | { kind: "pause"; forMs: number }
  | { kind: "break"; forMs: number }
  | { kind: "doze"; forMs: number }
  | { kind: "wake" };

export interface IdleInput {
  /** The middleware says this Agent has nothing to do. */
  isIdle: boolean;
  /** True only when the Agent is parked at its own desk. */
  atDesk: boolean;
  /** A walking Agent is already busy going somewhere. */
  walking: boolean;
  dozing: boolean;
  /** When the current nap ends. A nap is not permanent; the desk is home. */
  napUntil: number;
  /** Away from the desk on a break, and due back at `breakUntil`. */
  onBreak: boolean;
  breakUntil: number;
  idleForMs: number;
  /** This Agent's own patience before dozing, so a room never sleeps at once. */
  dozeAfterMs: number;
  now: number;
  nextWanderAt: number;
  wander: WorldRect;
  /** Injected so the choice of spot — and of action — is testable. */
  random: () => number;
}

/**
 * Pure idle state machine, so the behaviour can be verified without a ticker,
 * a renderer, or a visible browser tab.
 *
 * Deliberately conservative: an Agent that is walking, or that the middleware
 * has given work to, is never sent wandering. Only genuine idleness decays
 * into drifting, breaks, and then sleep.
 */
export function nextIdleAction(input: IdleInput): IdleAction {
  // Work arrived while away: the Agent must return to its desk.
  if (!input.isIdle) {
    return (input.dozing || input.onBreak) && !input.walking ? { kind: "wake" } : { kind: "none" };
  }
  if (input.walking) return { kind: "none" };
  // A break ends on its own clock, wherever the Agent took it.
  if (input.onBreak) {
    return input.now >= input.breakUntil ? { kind: "wake" } : { kind: "none" };
  }
  // A nap ends on its own clock too, and the Agent goes back to its desk —
  // otherwise a room of idle Agents drains into the lounge and stays there.
  if (input.dozing) {
    return input.now >= input.napUntil ? { kind: "wake" } : { kind: "none" };
  }
  if (!input.atDesk) return { kind: "none" };
  if (input.idleForMs >= input.dozeAfterMs) {
    return { kind: "doze", forMs: 9_000 + Math.round(input.random() * 12_000) };
  }
  if (input.now < input.nextWanderAt) return { kind: "none" };

  // Three ways to be idle, so a roomful of Agents does not move as one body.
  const roll = input.random();
  if (roll < 0.16) {
    return { kind: "break", forMs: 5_000 + Math.round(input.random() * 9_000) };
  }
  if (roll < 0.46) {
    return { kind: "pause", forMs: 1_800 + Math.round(input.random() * 5_200) };
  }
  const { wander, random } = input;
  return {
    kind: "wander",
    point: {
      x: Math.round(wander.x + random() * wander.width),
      y: Math.round(wander.y + random() * wander.height),
    },
  };
}

/**
 * Per-Agent timing, derived from the Agent's own ID.
 *
 * Deterministic like the avatar look, so an Agent keeps its temperament across
 * refreshes, but different from its neighbours' — which is the whole point.
 * Without this every Agent shares one clock and the room breathes, types, and
 * wanders in unison.
 */
export interface IdleTuning {
  /** Gap between idle decisions. */
  wanderIntervalMs: number;
  /** How long this Agent tolerates having nothing to do before dozing. */
  dozeAfterMs: number;
  /** World units per second when walking. */
  walkSpeed: number;
  /** Starting offset for the animation clock, so poses fall out of phase. */
  phaseMs: number;
}

export function idleTuning(agentId: string): IdleTuning {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return {
    wanderIntervalMs: 3_000 + (hash % 3_400),
    dozeAfterMs: 15_000 + ((hash >>> 5) % 15_000),
    walkSpeed: 44 + ((hash >>> 11) % 18),
    phaseMs: (hash >>> 17) % 4_000,
  };
}
