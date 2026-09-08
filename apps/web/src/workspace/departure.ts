import type { AgentAppearance } from "../types";
import type { WorldPoint } from "./workspace-layout";

/**
 * The shape and timing of an Agent's departure, with no renderer attached.
 *
 * Kept out of the Pixi component on purpose. `useDepartures` runs in the plain
 * React stage, which is deliberately free of `@pixi/react` so the renderer is
 * only fetched when a room is actually drawn — importing the sprite just to
 * read its duration would undo that, and did: it pulled the whole reconciler
 * into the eager module graph and broke the app test suite.
 */

/**
 * How long an Agent takes to leave, in milliseconds.
 *
 * Deliberately short. This is a goodbye, not a cutscene: the room has to be
 * back to telling the truth about who works here quickly, and anyone deleting
 * six Agents in a row should not sit through six of these.
 */
export const DEPARTURE_NOTICE_MS = 700;
export const DEPARTURE_PACK_MS = 500;
export const DEPARTURE_FADE_MS = 320;
/** Enough for the longest corridor walk at the sprite's speed. */
export const DEPARTURE_WALK_MS = 2_400;
export const DEPARTURE_MS =
  DEPARTURE_NOTICE_MS + DEPARTURE_PACK_MS + DEPARTURE_WALK_MS;

export interface DepartingAgentModel {
  agentId: string;
  name: string;
  appearance: AgentAppearance | null;
  /** Where the Agent was standing when it was removed. */
  from: WorldPoint;
  /** `performance.now()` at the moment the roster lost it. */
  startedAt: number;
}
