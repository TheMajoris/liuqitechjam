import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  WALL_HEIGHT,
  WORLD,
  dropTargetAt,
  sameDropTarget,
  screenToWorld,
  type DropTarget,
  type StageTransform,
  type WorkspaceSeat,
  type WorldPoint,
} from "./workspace-layout";
import { moveTargetPoint, moveTargets } from "./workspace-placement";

/**
 * Picking an Agent up and carrying it somewhere else.
 *
 * The hook owns the *decisions* — has a drag begun, what is under the pointer,
 * where does the Agent land — and nothing about how any of it looks. The one
 * value that changes every frame, the carry point, is kept in a ref and read
 * by the renderer on its own ticker: a pointer moving across the room must not
 * cost sixty React renders a second, and the room is drawn on a canvas that
 * would have to be reconciled by every one of them.
 *
 * React state therefore holds only what changes rarely: who is being carried,
 * and which area they would land in. Both change a handful of times per drag.
 */

/** How far a pointer must travel before a press becomes a carry, in stage pixels. */
const DRAG_THRESHOLD = 4;

/**
 * How far outside an area still counts as aiming at it, in world units.
 *
 * Only ever consulted when the pointer is over bare corridor, so being
 * generous here never overrules a deliberate drop into a neighbouring zone.
 */
const DROP_TOLERANCE = 12;

export type DragVia = "pointer" | "keyboard";

export interface AgentDrag {
  agentId: string;
  via: DragVia;
  /** Where the Agent would land if it were let go now. */
  target: DropTarget | null;
}

/** Just enough of a pointer event to place it on the stage. */
export interface PointerLike {
  clientX: number;
  clientY: number;
  pointerId?: number;
}

interface UseAgentDragOptions {
  transform: StageTransform;
  hostRef: RefObject<HTMLElement | null>;
  seats: readonly WorkspaceSeat[];
  /** Off while the room cannot be drawn: there is nothing to carry an Agent across. */
  enabled: boolean;
  /** Where an Agent is standing this instant, from the renderer. */
  positionOf: (agentId: string) => WorldPoint | null;
  /** Which area an Agent already occupies, so a keyboard move starts from home. */
  areaOf: (agentId: string) => DropTarget | null;
  onDrop: (agentId: string, target: DropTarget, at: WorldPoint) => void;
}

export interface AgentDragController {
  drag: AgentDrag | null;
  /** The carried Agent's feet, in world units. Read on the ticker, never rendered. */
  carry: RefObject<WorldPoint>;
  /**
   * Whether the press that just ended was a carry.
   *
   * A drag on a name plate finishes with a browser `click`, which arrives too
   * late to consult React state that the release has already cleared. This is
   * the synchronous answer, so moving an Agent never also opens its details.
   */
  justCarried: RefObject<boolean>;
  /** Begin from a press on the Agent or its name plate. */
  grab: (agentId: string, event: PointerLike) => void;
  /** Begin from the keyboard, stepping between whole areas. */
  grabByKeyboard: (agentId: string) => void;
  /** Move a keyboard carry to the next or previous area. */
  step: (delta: number) => void;
  /** Put the Agent down where it is. */
  commit: () => void;
  /** Abandon the carry; the Agent walks back to where it came from. */
  cancel: () => void;
}

function clampToRoom(point: WorldPoint): WorldPoint {
  return {
    x: Math.min(Math.max(point.x, 4), WORLD.width - 4),
    y: Math.min(Math.max(point.y, WALL_HEIGHT + 10), WORLD.height - 4),
  };
}

export function useAgentDrag({
  transform,
  hostRef,
  seats,
  enabled,
  positionOf,
  areaOf,
  onDrop,
}: UseAgentDragOptions): AgentDragController {
  const [drag, setDrag] = useState<AgentDrag | null>(null);
  const carry = useRef<WorldPoint>({ x: 0, y: 0 });
  const justCarried = useRef(false);

  /**
   * Everything the pointer handlers need, without re-subscribing.
   *
   * The window listeners are attached once, when a press starts, and must keep
   * working while React re-renders around them — so they read the live values
   * from here rather than closing over the render that created them.
   */
  const live = useRef({ transform, seats, positionOf, areaOf, onDrop, enabled });
  live.current = { transform, seats, positionOf, areaOf, onDrop, enabled };

  /** The press in progress. Null between drags; `moved` is what makes it a carry. */
  const press = useRef<{
    agentId: string;
    pointerId: number | null;
    startX: number;
    startY: number;
    /** Pointer-to-feet offset, so the Agent does not jump when it is picked up. */
    grip: WorldPoint;
    moved: boolean;
    target: DropTarget | null;
  } | null>(null);

  /** The keyboard carry's place in the ring of areas. */
  const keyboardIndex = useRef(0);

  const toWorld = useCallback(
    (event: PointerLike): WorldPoint | null => {
      const host = hostRef.current;
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      return screenToWorld(live.current.transform, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    [hostRef],
  );

  /** Aim the carry at a point, and surface the area under it only when it changes. */
  const aim = useCallback((at: WorldPoint, tolerance: number) => {
    const point = clampToRoom(at);
    carry.current = point;
    const target = dropTargetAt(point, tolerance);
    const held = press.current;
    if (held && sameDropTarget(held.target, target)) return;
    if (held) held.target = target;
    setDrag((current) => (current ? { ...current, target } : current));
  }, []);

  const detach = useRef<(() => void) | null>(null);
  const release = useCallback(() => {
    detach.current?.();
    detach.current = null;
    press.current = null;
    setDrag(null);
  }, []);

  const cancel = useCallback(() => {
    release();
  }, [release]);

  const commit = useCallback(() => {
    const held = press.current;
    const target = held?.target ?? null;
    const agentId = held?.agentId ?? null;
    const at = { ...carry.current };
    release();
    // No target means the pointer was over the corridor: nothing is moved, and
    // the Agent walks back from wherever it was let go. That is a kinder answer
    // than snapping it to the nearest desk it was never aimed at.
    if (agentId !== null && target !== null) live.current.onDrop(agentId, target, at);
  }, [release]);

  const commitRef = useRef(commit);
  commitRef.current = commit;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  const grab = useCallback(
    (agentId: string, event: PointerLike) => {
      if (!live.current.enabled || press.current !== null) return;
      const at = toWorld(event);
      if (!at) return;
      justCarried.current = false;
      const feet = live.current.positionOf(agentId) ?? at;
      press.current = {
        agentId,
        pointerId: event.pointerId ?? null,
        startX: event.clientX,
        startY: event.clientY,
        grip: { x: at.x - feet.x, y: at.y - feet.y },
        moved: false,
        target: null,
      };
      carry.current = { ...feet };

      const onMove = (native: PointerEvent) => {
        const held = press.current;
        if (!held) return;
        if (held.pointerId !== null && native.pointerId !== held.pointerId) return;
        if (!held.moved) {
          const travelled =
            Math.abs(native.clientX - held.startX) + Math.abs(native.clientY - held.startY);
          if (travelled < DRAG_THRESHOLD) return;
          held.moved = true;
          justCarried.current = true;
          // One render, at the moment a press becomes a carry.
          setDrag({ agentId: held.agentId, via: "pointer", target: null });
        }
        const world = toWorld(native);
        if (!world) return;
        native.preventDefault();
        aim({ x: world.x - held.grip.x, y: world.y - held.grip.y }, DROP_TOLERANCE);
      };

      const onUp = (native: PointerEvent) => {
        const held = press.current;
        if (!held) return;
        if (held.pointerId !== null && native.pointerId !== held.pointerId) return;
        // A press that never travelled is a click, and the Agent's own tap
        // handler has already run: let go of it without moving anything.
        if (held.moved) commitRef.current();
        else release();
      };

      const onKey = (native: KeyboardEvent) => {
        if (native.key !== "Escape") return;
        native.preventDefault();
        cancelRef.current();
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", cancelRef.current);
      window.addEventListener("keydown", onKey);
      detach.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", cancelRef.current);
        window.removeEventListener("keydown", onKey);
      };
    },
    [aim, release, toWorld],
  );

  const aimKeyboard = useCallback(
    (index: number) => {
      const targets = moveTargets(live.current.seats.length);
      if (targets.length === 0) return;
      const wrapped = ((index % targets.length) + targets.length) % targets.length;
      keyboardIndex.current = wrapped;
      const target = targets[wrapped]!;
      carry.current = moveTargetPoint(target, live.current.seats);
      const held = press.current;
      if (held) held.target = target;
      setDrag((current) => (current ? { ...current, target } : current));
    },
    [],
  );

  const grabByKeyboard = useCallback(
    (agentId: string) => {
      if (!live.current.enabled || press.current !== null) return;
      const feet = live.current.positionOf(agentId);
      press.current = {
        agentId,
        pointerId: null,
        startX: 0,
        startY: 0,
        grip: { x: 0, y: 0 },
        // A keyboard carry is a carry from the first keystroke; there is no
        // travel to wait for, and no click it could be mistaken for.
        moved: true,
        target: null,
      };
      justCarried.current = true;
      if (feet) carry.current = { ...feet };
      setDrag({ agentId, via: "keyboard", target: null });
      const targets = moveTargets(live.current.seats.length);
      const home = live.current.areaOf(agentId);
      const index = targets.findIndex((target) => sameDropTarget(target, home));
      aimKeyboard(index < 0 ? 0 : index);
    },
    [aimKeyboard],
  );

  const step = useCallback(
    (delta: number) => {
      if (press.current === null) return;
      aimKeyboard(keyboardIndex.current + delta);
    },
    [aimKeyboard],
  );

  // A stage that is unmounted mid-carry must not leave listeners on the window.
  useEffect(() => () => detach.current?.(), []);

  // Losing the renderer mid-carry leaves nothing to carry the Agent across.
  useEffect(() => {
    if (!enabled && press.current !== null) cancelRef.current();
  }, [enabled]);

  return useMemo(
    () => ({ drag, carry, justCarried, grab, grabByKeyboard, step, commit, cancel }),
    [cancel, commit, drag, grab, grabByKeyboard, step],
  );
}
