import type { WorldPoint, WorldRect } from "../workspace-layout";

/** Idle for this long and the Agent gives up and heads for the lounge. */
export const DOZE_AFTER_MS = 20_000;
/** How often a restless idle Agent picks a new spot within its pod. */
export const WANDER_INTERVAL_MS = 4200;

/**
 * What an idle Agent should do next.
 *
 * `wander` drifts to a spot inside its own pod, `doze` sends it to the lounge
 * to sleep, and `wake` brings it back once the middleware gives it work again.
 */
export type IdleAction =
  | { kind: "none" }
  | { kind: "wander"; point: WorldPoint }
  | { kind: "doze" }
  | { kind: "wake" };

export interface IdleInput {
  /** The middleware says this Agent has nothing to do. */
  isIdle: boolean;
  /** True only when the Agent is parked at its own desk. */
  atDesk: boolean;
  /** A walking Agent is already busy going somewhere. */
  walking: boolean;
  dozing: boolean;
  idleForMs: number;
  now: number;
  nextWanderAt: number;
  wander: WorldRect;
  /** Injected so the choice of spot is testable. */
  random: () => number;
}

/**
 * Pure idle state machine, so the behaviour can be verified without a ticker,
 * a renderer, or a visible browser tab.
 *
 * Deliberately conservative: an Agent that is walking, or that the middleware
 * has given work to, is never sent wandering. Only genuine idleness decays
 * into drifting and then sleep.
 */
export function nextIdleAction(input: IdleInput): IdleAction {
  // Work arrived while asleep: the Agent must return to its desk.
  if (!input.isIdle) {
    return input.dozing && !input.walking ? { kind: "wake" } : { kind: "none" };
  }
  if (input.walking || !input.atDesk) return { kind: "none" };
  if (input.dozing) return { kind: "none" };
  if (input.idleForMs >= DOZE_AFTER_MS) return { kind: "doze" };
  if (input.now < input.nextWanderAt) return { kind: "none" };
  const { wander, random } = input;
  return {
    kind: "wander",
    point: {
      x: Math.round(wander.x + random() * wander.width),
      y: Math.round(wander.y + random() * wander.height),
    },
  };
}
