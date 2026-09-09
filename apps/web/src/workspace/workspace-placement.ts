import {
  POST_STATIONS,
  dropLandingPoint,
  stationPoint,
  stationStandCentre,
  type DropTarget,
  type PostStation,
  type WorkspaceSeat,
  type WorldPoint,
} from "./workspace-layout";
import type {
  WorkspaceAgentViewModel,
  WorkspaceStation,
} from "./workspace-view-model";

/**
 * Where the people in this room have been put.
 *
 * A projection of *the viewer's* arrangement, not of backend state — the same
 * distinction the decor already draws. Moving an Agent to another desk or
 * standing it by the server rack changes nothing it can do, nothing a run
 * records, and nothing another person has to agree with; it changes where you
 * look for it. So the room stays a pure function of the roster plus this, and
 * a refresh rebuilds it exactly.
 *
 * Everything in this file is pure. The storage that remembers an arrangement
 * lives in `use-agent-placement`, and the dragging that produces one lives in
 * the stage.
 */

/** An Agent standing in a zone, on the spot it was put down on. */
export interface AgentPosting {
  station: PostStation;
  x: number;
  y: number;
}

export interface AgentPlacement {
  /** Workstation each moved Agent claimed. Absent means "wherever the roster puts me". */
  seats: Readonly<Record<string, number>>;
  /** Zone each posted Agent waits in. Absent means "at my desk". */
  posts: Readonly<Record<string, AgentPosting>>;
}

export const EMPTY_PLACEMENT: AgentPlacement = { seats: {}, posts: {} };

/**
 * Which Agent sits at which workstation.
 *
 * Chosen seats are honoured first, in roster order, so an arrangement survives
 * an Agent joining or leaving. Whoever is left falls into the free seats in
 * roster order — the original behaviour, and what an unarranged room still
 * does. A stored seat that is out of range or already claimed is dropped
 * rather than repaired: it is a stale preference, not data worth recovering.
 */
export function assignSeats(
  agentIds: readonly string[],
  seatCount: number,
  placement: AgentPlacement,
): Map<string, number> {
  const assigned = new Map<string, number>();
  const taken = new Set<number>();
  const seated = agentIds.slice(0, seatCount);

  for (const agentId of seated) {
    const seat = placement.seats[agentId];
    if (seat === undefined || seat < 0 || seat >= seatCount || taken.has(seat)) continue;
    assigned.set(agentId, seat);
    taken.add(seat);
  }

  let next = 0;
  for (const agentId of seated) {
    if (assigned.has(agentId)) continue;
    while (taken.has(next)) next += 1;
    assigned.set(agentId, next);
    taken.add(next);
  }
  return assigned;
}

/**
 * Take a workstation, trading places with whoever already has it.
 *
 * A swap rather than an eviction: the room seats exactly as many Agents as it
 * has desks, so displacing someone with nowhere to go would only move the
 * problem. Landing at a desk also ends any posting — the desk *is* the
 * arrangement now.
 *
 * The move records where *everyone* is sitting, not only the two Agents that
 * traded. Anyone the roster had merely dropped into the next free desk would
 * otherwise slide along to fill the vacancy, so moving one Agent would rear-
 * range the ones you had not touched — which is precisely the surprise an
 * arrangement is supposed to rule out.
 */
export function moveToSeat(
  placement: AgentPlacement,
  seating: ReadonlyMap<string, number>,
  agentId: string,
  seatIndex: number,
): AgentPlacement {
  const from = seating.get(agentId);
  if (from === seatIndex) return clearPost(placement, agentId);

  const seats: Record<string, number> = { ...placement.seats };
  for (const [otherId, otherSeat] of seating) seats[otherId] = otherSeat;
  for (const [otherId, otherSeat] of seating) {
    if (otherId === agentId || otherSeat !== seatIndex) continue;
    // Nowhere to send the occupant means nowhere it has to go: dropping its
    // entry lets the roster place it, rather than seating two Agents at once.
    if (from === undefined) delete seats[otherId];
    else seats[otherId] = from;
  }
  seats[agentId] = seatIndex;
  return clearPost({ ...placement, seats }, agentId);
}

/** Stand an Agent in a zone, on the exact spot it was put down on. */
export function postTo(
  placement: AgentPlacement,
  agentId: string,
  station: PostStation,
  at: WorldPoint,
): AgentPlacement {
  return {
    ...placement,
    posts: {
      ...placement.posts,
      [agentId]: { station, x: Math.round(at.x), y: Math.round(at.y) },
    },
  };
}

/** Send an Agent back to its own desk. */
export function clearPost(placement: AgentPlacement, agentId: string): AgentPlacement {
  if (placement.posts[agentId] === undefined) return placement;
  const posts = { ...placement.posts };
  delete posts[agentId];
  return { ...placement, posts };
}

/** Apply a drop. The target decides which kind of move it was. */
export function applyDrop(
  placement: AgentPlacement,
  seating: ReadonlyMap<string, number>,
  agentId: string,
  target: DropTarget,
  at: WorldPoint,
): AgentPlacement {
  return target.kind === "desk"
    ? moveToSeat(placement, seating, agentId, target.seatIndex)
    : postTo(placement, agentId, target.station, dropLandingPoint(target, at));
}

/** Forget the arrangement of Agents that are no longer in the room. */
export function prunePlacement(
  placement: AgentPlacement,
  agentIds: readonly string[],
): AgentPlacement {
  const live = new Set(agentIds);
  const seats = Object.fromEntries(
    Object.entries(placement.seats).filter(([agentId]) => live.has(agentId)),
  );
  const posts = Object.fromEntries(
    Object.entries(placement.posts).filter(([agentId]) => live.has(agentId)),
  );
  return { seats, posts };
}

/**
 * Where an Agent stands right now.
 *
 * A posting says where an Agent *waits*; it never claims what the Agent is
 * doing. The moment the middleware reports work that belongs in a zone —
 * thinking at the board, a web tool at the shelves, a command at the racks —
 * that wins, because it is the truth and the posting is only a preference. So
 * the posting applies exactly when the room would otherwise have parked the
 * Agent at its desk, and the Agent walks back to it when the work is done.
 */
export function effectiveStation(
  derived: WorkspaceStation,
  posting: AgentPosting | null,
): WorkspaceStation {
  return derived === "desk" && posting !== null ? posting.station : derived;
}

/** One seated Agent, the desk it owns, and the spot on the floor it belongs on. */
export interface PlacedAgent {
  agent: WorkspaceAgentViewModel;
  seat: WorkspaceSeat;
  /** Effective station: the posting when idle, whatever the work implies otherwise. */
  station: WorkspaceStation;
  /** Exactly where to stand — a seat, a chosen spot, or the zone's own tile. */
  anchor: WorldPoint;
  posting: AgentPosting | null;
}

/**
 * Seat the roster and work out where everyone stands.
 *
 * The one source both the canvas and the HTML overlay read, so a name plate
 * can never end up hanging under someone else's feet.
 */
export function placeAgents(
  agents: readonly WorkspaceAgentViewModel[],
  seats: readonly WorkspaceSeat[],
  placement: AgentPlacement,
): PlacedAgent[] {
  const seated = agents.slice(0, seats.length);
  const seating = assignSeats(
    seated.map((agent) => agent.agentId),
    seats.length,
    placement,
  );
  return seated.map((agent, index) => {
    const seat = seats[seating.get(agent.agentId) ?? index] ?? seats[index]!;
    const posting = placement.posts[agent.agentId] ?? null;
    const station = effectiveStation(agent.station, posting);
    const anchor =
      posting !== null && station === posting.station
        ? { x: posting.x, y: posting.y }
        : { ...stationPoint(seat, station) };
    return { agent, seat, station, anchor, posting };
  });
}

/** Seat index per Agent, for the move that has to know who to swap with. */
export function seatingOf(placed: readonly PlacedAgent[]): Map<string, number> {
  return new Map(placed.map((entry) => [entry.agent.agentId, entry.seat.index]));
}

/** What each area is called, in the drop labels and the move announcements. */
export const AREA_LABEL: Record<PostStation, string> = {
  board: "Meeting room",
  library: "Library",
  server: "Server nook",
  lounge: "Lounge",
};

export function dropTargetLabel(target: DropTarget): string {
  return target.kind === "desk" ? `Desk ${target.seatIndex + 1}` : AREA_LABEL[target.station];
}

/**
 * Every area a keyboard move steps through: the workstations, then the zones.
 * Desks first, because a desk is where an Agent normally belongs.
 */
export function moveTargets(seatCount: number): DropTarget[] {
  return [
    ...Array.from(
      { length: seatCount },
      (_, seatIndex): DropTarget => ({ kind: "desk", seatIndex }),
    ),
    ...POST_STATIONS.map((station): DropTarget => ({ kind: "station", station })),
  ];
}

/** Where a keyboard move parks an Agent: the middle of the area it landed on. */
export function moveTargetPoint(
  target: DropTarget,
  seats: readonly WorkspaceSeat[],
): WorldPoint {
  if (target.kind === "station") return stationStandCentre(target.station);
  const seat = seats[target.seatIndex];
  return seat ? { ...seat.anchor } : { x: 0, y: 0 };
}
