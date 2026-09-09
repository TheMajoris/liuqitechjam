import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  Rectangle,
  type Container,
  type FederatedPointerEvent,
  type Graphics,
  type Sprite,
} from "pixi.js";
import { useTick } from "@pixi/react";
import "./pixi-elements";
import {
  accessoryTexture,
  avatarLook,
  bodyTexture,
  faceTexture,
  figureHairTexture,
  figureOutfitTexture,
  handsTexture,
  type WorkspaceCrew,
} from "./art/avatar-look";
import {
  ACCESSORY_OFFSET,
  FACE_OFFSET,
  FIGURE_HAIR_OFFSET,
  FIGURE_OUTFIT_OFFSET,
  HANDS_OFFSET,
} from "./art/sprites";
import { agentPresentation } from "./agent-presentation";
import { useReducedMotion } from "./use-reduced-motion";
import { AgentIndicator } from "./AgentIndicator";
import { ModelResourceIndicator } from "./ModelResourceIndicator";
import { idleTuning, nextIdleAction } from "./idle-behaviour";
import { SCENE } from "./scene-theme";
import {
  routeToPoint,
  walkRoute,
  type WorkspaceSeat,
  type WorldPoint,
} from "../workspace-layout";
import type {
  WorkspaceAgentViewModel,
  WorkspaceStation,
} from "../workspace-view-model";

/**
 * A route to this Agent's own corner of the lounge.
 *
 * `STATION_POINTS.lounge` is a single tile, so several Agents taking a break
 * at once would stand inside each other. The offset is derived from the ID and
 * stays well within the lounge zone.
 */
function loungeRoute(seat: WorkspaceSeat, from: WorldPoint, agentId: string): WorldPoint[] {
  const route = walkRoute(seat, from, "lounge");
  const last = route.at(-1);
  if (!last) return route;
  const spread = idleTuning(agentId);
  return [
    ...route.slice(0, -1),
    { x: last.x + (spread.phaseMs % 33) - 16, y: last.y + (spread.walkSpeed % 13) - 6 },
  ];
}

/** Feet at the origin, so `y` doubles as the depth-sorting key. */
// Include the status bubbles and resource mark above the avatar in the same
// hover target. The HTML plate then supplies the readable hover/focus details
// even though those marks are drawn inside the Pixi canvas.
const HIT_AREA = new Rectangle(-12, -42, 24, 44);
/**
 * Frames the body only, measured from the feet.
 *
 * It stops below the activity bubble at -28: a halo tall enough to reach the
 * badges above the head cuts straight through them.
 */
const HALO_HEIGHT = 26;
const WALK_FRAME_MS = 150;
const CELEBRATION_MS = 1000;

/* ---- Being carried. -------------------------------------------------- *
 *
 * Three numbers decide how a picked-up Agent feels, and all three are
 * integrated per frame against real elapsed time rather than per tick, so the
 * motion is identical on a 60Hz panel and a 144Hz one — a drag that is
 * two-and-a-half times faster on a gaming monitor is the classic way this goes
 * wrong, and it is invisible on the machine it was written on.
 */

/** How high off the floor a carried Agent rides, in world pixels. */
const LIFT_HEIGHT = 9;
/**
 * Lift spring, deliberately under-damped — a damping ratio around one half.
 *
 * The overshoot is the point. Rising, the Agent goes a touch past its carry
 * height and settles back; landing, it dips a pixel or so below the floor line
 * before coming to rest, which is what reads as weight. A critically damped
 * spring is smooth and puts the Agent down like a decal. Integrated
 * semi-implicitly, which is unconditionally stable at every frame length this
 * clamps to.
 */
const LIFT_STIFFNESS = 320;
const LIFT_DAMPING = 18;
/**
 * How quickly the Agent catches up with the pointer, as an exponential rate.
 *
 * `1/18` of a second of lag: enough that the body trails the hand carrying it,
 * little enough that it never feels like it is being dragged through treacle.
 */
const FOLLOW_RATE = 18;
/** A frame this long is a stalled tab, not slow motion: integrate as if it were 50ms. */
const MAX_FRAME_MS = 50;
/** How far the body leans into the direction it is being pulled, in world pixels. */
const MAX_LEAN = 3;

interface AgentSpriteProps {
  agent: WorkspaceAgentViewModel;
  seat: WorkspaceSeat;
  /** Where this Agent belongs: its desk, its posting, or the zone its work implies. */
  anchor: WorldPoint;
  /** The effective station, which a posting can change while the Agent is idle. */
  station: WorkspaceStation;
  hovered: boolean;
  /** True while this Agent is being carried, by pointer or by keyboard. */
  carried?: boolean;
  /** The live carry point, read on the ticker so a drag costs no renders. */
  carry?: RefObject<WorldPoint>;
  /** People or robots. A room-wide choice, passed down unchanged. */
  crew?: WorkspaceCrew;
  onSelect: (agentId: string) => void;
  onHoverChange: (agentId: string | null) => void;
  /** A press on the Agent, which may or may not become a carry. */
  onGrab?: (agentId: string, event: FederatedPointerEvent) => void;
  /** Where this Agent stands right now, reported every frame it is drawn. */
  onPositionChange?: (agentId: string, x: number, y: number) => void;
}

/**
 * One Agent in the room.
 *
 * All motion runs on the Pixi ticker against refs; React re-renders this
 * component only when the Agent's *logical* state changes, so animation never
 * costs a render and never costs a request. The state machine is deliberately
 * small: walk to a station, stand there, and play the pose the middleware's
 * activity implies.
 */
export function AgentSprite({
  agent,
  seat,
  anchor,
  station,
  hovered,
  carried = false,
  carry,
  crew = "people",
  onSelect,
  onHoverChange,
  onGrab,
  onPositionChange,
}: AgentSpriteProps) {
  const look = avatarLook(agent.agentId, agent.appearance);
  const presentation = agentPresentation(agent.activity);
  const reducedMotion = useReducedMotion();
  // Robots hold their post. Wandering, coffee breaks, and dozing are what make
  // the people feel alive; switching them off is the whole point of the mode,
  // so it is treated exactly like the reduced-motion preference already is.
  const stillCrew = crew === "robots";
  const figureHair = stillCrew ? null : figureHairTexture(agent.agentId, agent.appearance);
  const figureOutfit = stillCrew ? null : figureOutfitTexture(agent.agentId, agent.appearance);

  const containerRef = useRef<Container>(null);
  /** Everything above the floor. Lifting this leaves the shadow behind. */
  const liftRef = useRef<Container>(null);
  /** The cast shadow, which stays on the ground and shrinks as the Agent rises. */
  const groundRef = useRef<Container>(null);
  const bodyRef = useRef<Sprite>(null);
  const handsRef = useRef<Sprite>(null);
  const faceRef = useRef<Sprite>(null);
  const sleepBadgeRef = useRef<Container>(null);
  const pulseRef = useRef<Graphics>(null);

  // Timing is this Agent's own, so a roomful of them never moves as one body.
  const tuning = useMemo(() => idleTuning(agent.agentId), [agent.agentId]);

  const position = useRef<WorldPoint>({ ...anchor });
  const route = useRef<WorldPoint[]>([]);
  const clock = useRef(tuning.phaseMs);
  const celebrateUntil = useRef(0);
  /** When the Agent last had something to do. Drives wander, then dozing. */
  const idleSince = useRef(performance.now());
  const nextWanderAt = useRef(0);
  const dozing = useRef(false);
  /** Away from the desk on a break or a nap, due back when the clock says so. */
  const onBreak = useRef(false);
  const breakUntil = useRef(0);
  const napUntil = useRef(0);
  /** How far off the floor the Agent is, 0 to 1, and the spring carrying it there. */
  const lift = useRef(0);
  const liftVelocity = useRef(0);

  // `idle` is the only activity that decays into wandering and then sleep, so
  // every other activity resets the clock and wakes the Agent up.
  const isIdle = agent.activity === "idle";
  useEffect(() => {
    if (isIdle) {
      idleSince.current = performance.now();
      nextWanderAt.current = performance.now() + tuning.wanderIntervalMs;
      return;
    }
    idleSince.current = performance.now();
    dozing.current = false;
    onBreak.current = false;
  }, [isIdle, station, tuning.wanderIntervalMs]);

  /*
   * Being picked up suspends the Agent's own life.
   *
   * Whatever it was walking towards is abandoned — the hand carrying it now
   * decides where it goes — and any nap or coffee break ends, because it is
   * about to be standing somewhere else entirely. Putting it down restarts the
   * idle clock so a freshly placed Agent has a spell of pottering about rather
   * than dozing off in the spot it just landed in.
   */
  useEffect(() => {
    if (!carried) return;
    route.current = [];
    dozing.current = false;
    onBreak.current = false;
    return () => {
      const now = performance.now();
      idleSince.current = now;
      nextWanderAt.current = now + tuning.wanderIntervalMs;
    };
  }, [carried, tuning.wanderIntervalMs]);

  // A change of anchor — a new station, a new desk, or a drop into a zone — is
  // the only thing that makes an Agent walk. The route is recomputed from
  // wherever the Agent currently stands, so an interrupted walk resolves
  // cleanly, and so does being set down somewhere it did not expect to be.
  //
  // Switching to robots is also a reason to recompute: whoever was dozing in
  // the lounge has to come back to their post, and the flags that put them
  // there must be cleared or the new sprite would stand at its desk asleep.
  useEffect(() => {
    if (stillCrew) {
      dozing.current = false;
      onBreak.current = false;
      napUntil.current = 0;
      breakUntil.current = 0;
    }
    // A carried Agent has no route: it is wherever the pointer is. This also
    // covers the release — `carried` turning false runs this effect again, so
    // an Agent let go over bare corridor walks home rather than hanging there.
    if (carried) return;
    const next = routeToPoint(position.current, anchor);
    if (reducedMotion) {
      // Arrive rather than travel: the destination is the information.
      const destination = next.at(-1);
      if (destination) position.current = { ...destination };
      route.current = [];
      return;
    }
    route.current = next;
  }, [anchor.x, anchor.y, carried, reducedMotion, stillCrew]);

  useEffect(() => {
    if (agent.activity === "success" && !reducedMotion) {
      celebrateUntil.current = performance.now() + CELEBRATION_MS;
    }
  }, [agent.activity, reducedMotion]);

  useTick((ticker) => {
    const container = containerRef.current;
    if (!container) return;
    clock.current += ticker.deltaMS;
    const frameMs = Math.min(ticker.deltaMS, MAX_FRAME_MS);
    const dt = frameMs / 1000;

    /*
     * Carrying beats everything below.
     *
     * The carry point is read straight off the ref the drag hook writes, and
     * the Agent eases towards it rather than snapping to it — the lag is what
     * makes a sprite feel like an object being moved rather than a cursor with
     * a costume on. The easing is exponential against elapsed time, so it is
     * the same on every refresh rate.
     */
    let lean = 0;
    if (carried && carry) {
      const goal = carry.current;
      const gap = goal.x - position.current.x;
      if (reducedMotion) {
        position.current = { x: goal.x, y: goal.y };
      } else {
        const alpha = 1 - Math.exp(-FOLLOW_RATE * dt);
        position.current = {
          x: position.current.x + gap * alpha,
          y: position.current.y + (goal.y - position.current.y) * alpha,
        };
        // The trailing distance *is* the speed, so the lean comes free.
        lean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, gap * 0.3));
      }
      route.current = [];
    }

    let remaining = carried ? 0 : (tuning.walkSpeed * frameMs) / 1000;
    while (remaining > 0 && route.current.length > 0) {
      const target = route.current[0]!;
      const dx = target.x - position.current.x;
      const dy = target.y - position.current.y;
      const distance = Math.abs(dx) + Math.abs(dy);
      if (distance <= remaining) {
        position.current = { x: target.x, y: target.y };
        route.current = route.current.slice(1);
        remaining -= distance;
        continue;
      }
      // Legs are axis-aligned, so only one component moves at a time.
      if (dx !== 0) position.current.x += Math.sign(dx) * Math.min(remaining, Math.abs(dx));
      else position.current.y += Math.sign(dy) * Math.min(remaining, Math.abs(dy));
      remaining = 0;
    }

    // Idle life: drift around the pod for a while, then go and sleep. The
    // decision itself is a pure function, so the behaviour is unit-tested
    // rather than only observable by watching the room. An Agent that has been
    // posted to a zone is not at its desk, so it simply holds the post — which
    // is exactly what putting it there asked for.
    if (!reducedMotion && !stillCrew && !carried) {
      const now = performance.now();
      const action = nextIdleAction({
        isIdle,
        atDesk: station === "desk",
        walking: route.current.length > 0,
        dozing: dozing.current,
        napUntil: napUntil.current,
        onBreak: onBreak.current,
        breakUntil: breakUntil.current,
        idleForMs: now - idleSince.current,
        dozeAfterMs: tuning.dozeAfterMs,
        now,
        nextWanderAt: nextWanderAt.current,
        wander: seat.wander,
        random: Math.random,
      });
      if (action.kind === "wander") {
        // Jittered, so two Agents that once moved together drift apart again.
        nextWanderAt.current = now + tuning.wanderIntervalMs * (0.7 + Math.random() * 0.8);
        route.current = [action.point];
      } else if (action.kind === "pause") {
        nextWanderAt.current = now + action.forMs;
      } else if (action.kind === "break") {
        onBreak.current = true;
        breakUntil.current = now + action.forMs;
        route.current = loungeRoute(seat, position.current, agent.agentId);
      } else if (action.kind === "doze") {
        dozing.current = true;
        napUntil.current = now + action.forMs;
        route.current = loungeRoute(seat, position.current, agent.agentId);
      } else if (action.kind === "wake") {
        dozing.current = false;
        onBreak.current = false;
        // The idle clock restarts at the desk, so a nap is followed by a spell
        // of pottering about rather than by falling straight back to sleep.
        idleSince.current = now;
        nextWanderAt.current = now + tuning.wanderIntervalMs;
        route.current = routeToPoint(position.current, anchor);
      }
    }

    container.label = agent.name + '|' + station + '|' + route.current.length + '|' + Math.round(position.current.x) + ',' + Math.round(position.current.y);
    const walking = route.current.length > 0;
    const asleep = dozing.current && !walking;
    const body = bodyRef.current;
    if (body) {
      const frame = walking
        ? Math.floor(clock.current / WALK_FRAME_MS) % 2 === 0
          ? "walkA"
          : "walkB"
        : "stand";
      const texture = bodyTexture(agent.agentId, frame, agent.appearance);
      if (body.texture !== texture) body.texture = texture;
    }

    const hands = handsRef.current;
    if (hands) {
      // Nobody types while being carried across the room.
      hands.visible = presentation.typing && !walking && !carried;
      if (hands.visible && !reducedMotion) {
        const texture = handsTexture(
          agent.agentId,
          Math.floor(clock.current / 130) % 2 === 0 ? "a" : "b",
          agent.appearance,
          crew,
        );
        if (hands.texture !== texture) hands.texture = texture;
      }
    }

    let offsetY = presentation.slumped || asleep ? 1 : 0;
    if (!walking && !reducedMotion && presentation.breathing !== "none") {
      const period = asleep ? 3400 : presentation.breathing === "slow" ? 2600 : 1700;
      offsetY += Math.sin((clock.current / period) * Math.PI * 2) > 0 ? -1 : 0;
    }
    const celebrating = performance.now() < celebrateUntil.current;
    if (celebrating) {
      const progress = 1 - (celebrateUntil.current - performance.now()) / CELEBRATION_MS;
      offsetY -= Math.round(3 * Math.abs(Math.sin(progress * Math.PI * 2)));
    }

    /*
     * The lift, and the shadow it leaves behind.
     *
     * Only the body rises; the cast shadow stays flat on the floor and pulls
     * in, which is what tells the eye the Agent is above the ground rather
     * than simply further up the room. Every offset is rounded to a whole
     * world pixel, because the room is pixel art at an integer scale and a
     * sprite drawn on a half-pixel is the one thing that would actually look
     * rough here.
     */
    const liftGoal = carried ? 1 : 0;
    if (reducedMotion) {
      lift.current = liftGoal;
      liftVelocity.current = 0;
    } else if (lift.current !== liftGoal || liftVelocity.current !== 0) {
      liftVelocity.current +=
        (liftGoal - lift.current) * LIFT_STIFFNESS * dt - liftVelocity.current * LIFT_DAMPING * dt;
      lift.current += liftVelocity.current * dt;
      // Settled: park the spring exactly, so it stops costing anything.
      if (Math.abs(liftGoal - lift.current) < 0.002 && Math.abs(liftVelocity.current) < 0.02) {
        lift.current = liftGoal;
        liftVelocity.current = 0;
      }
    }

    const raised = lift.current;
    const lifted = liftRef.current;
    if (lifted) {
      lifted.y = -Math.round(raised * LIFT_HEIGHT);
      lifted.x = Math.round(lean);
    }
    const ground = groundRef.current;
    if (ground) {
      // Clamped, because the spring dips below zero on landing and a shadow
      // that grows past its own size on impact reads as a mistake.
      const settled = Math.max(0, Math.min(1, raised));
      const shrink = 1 - settled * 0.3;
      ground.scale.set(shrink, shrink);
      ground.alpha = 1 - settled * 0.45;
    }

    container.x = Math.round(position.current.x);
    container.y = Math.round(position.current.y + offsetY);
    // A carried Agent is above the furniture, whatever floor it happens to be
    // over: it is in someone's hand, not in the room.
    container.zIndex = carried
      ? 10_000 + Math.round(position.current.y)
      : Math.round(position.current.y);
    // The HTML name plate is not part of the scene graph, so it is told where
    // this Agent is rather than being parented to it.
    onPositionChange?.(agent.agentId, position.current.x, position.current.y);

    const face = faceRef.current;
    if (face) {
      const texture = faceTexture(
        agent.agentId,
        asleep ? "sleep" : presentation.face,
        agent.appearance,
        crew,
      );
      if (face.texture !== texture) face.texture = texture;
    }
    const sleepBadge = sleepBadgeRef.current;
    if (sleepBadge) sleepBadge.visible = asleep;

    const pulse = pulseRef.current;
    if (pulse) {
      pulse.alpha = !agent.isSupervisorChoice
        ? 0
        : reducedMotion
          ? 0.5
          : 0.3 + 0.35 * (0.5 + 0.5 * Math.sin((clock.current / 900) * Math.PI * 2));
    }
  });

  const drawGround = useCallback(
    (graphics: Graphics) => {
      graphics.clear();
      graphics.ellipse(0, 0, 9, 3).fill({ color: SCENE.shadow, alpha: 0.16 });
      if (agent.isCurrentParticipant) {
        graphics
          .ellipse(0, 0, 13, 5)
          .stroke({ width: 2, color: look.accent, alpha: 0.9 })
          .ellipse(0, 0, 13, 5)
          .fill({ color: look.accent, alpha: 0.14 });
      }
      if (agent.isSelected) {
        graphics.ellipse(0, 0, 16, 6).stroke({ width: 1, color: SCENE.ink, alpha: 0.75 });
      } else if (hovered) {
        graphics.ellipse(0, 0, 16, 6).stroke({ width: 1, color: SCENE.ink, alpha: 0.32 });
      }
    },
    [agent.isCurrentParticipant, agent.isSelected, hovered, look.accent],
  );

  /**
   * A halo behind the body, not a ring on the floor.
   *
   * A seated Agent's feet are behind their desk, so the ground ellipse that
   * marked hover was drawn where nobody could see it. This sits at body height
   * and reads whatever the Agent is standing on or behind.
   */
  const drawHalo = useCallback(
    (graphics: Graphics) => {
      graphics.clear();
      if (!hovered && !agent.isSelected) return;
      const accent = agent.isSelected ? SCENE.ink : look.accent;
      graphics
        .roundRect(-13, -HALO_HEIGHT, 26, HALO_HEIGHT + 4, 7)
        .fill({ color: accent, alpha: agent.isSelected ? 0.2 : 0.16 })
        .roundRect(-13, -HALO_HEIGHT, 26, HALO_HEIGHT + 4, 7)
        .stroke({ width: 1, color: accent, alpha: agent.isSelected ? 0.9 : 0.6 });
    },
    [agent.isSelected, hovered, look.accent],
  );

  const drawPulse = useCallback(
    (graphics: Graphics) => {
      graphics.clear().ellipse(0, 0, 19, 7).stroke({ width: 1, color: look.accent });
    },
    [look.accent],
  );

  return (
    <pixiContainer
      ref={containerRef}
      x={anchor.x}
      y={anchor.y}
      // Pointing at an Agent brings it fully forward, whatever its state.
      alpha={
        hovered || agent.isSelected || carried
          ? 1
          : presentation.dimmed || !agent.available
            ? 0.6
            : 1
      }
      eventMode="static"
      cursor={carried ? "grabbing" : "grab"}
      hitArea={HIT_AREA}
      onPointerDown={(event: FederatedPointerEvent) => onGrab?.(agent.agentId, event)}
      // A press that turned into a carry is not a click: the Agent was being
      // moved, and opening its details on top of that would be a second,
      // unasked-for answer to one gesture.
      onPointerTap={() => {
        if (!carried) onSelect(agent.agentId);
      }}
      onPointerOver={() => onHoverChange(agent.agentId)}
      onPointerOut={() => onHoverChange(null)}
    >
      {/* On the floor, and staying there while the Agent is carried above it. */}
      <pixiContainer ref={groundRef}>
        <pixiGraphics ref={pulseRef} draw={drawPulse} alpha={0} />
        <pixiGraphics draw={drawGround} />
      </pixiContainer>
      <pixiContainer ref={liftRef}>
        <pixiGraphics draw={drawHalo} />
        <pixiSprite
          ref={bodyRef}
          texture={bodyTexture(agent.agentId, "stand", agent.appearance, crew)}
          anchor={{ x: 0.5, y: 1 }}
        />
        {/* Figure overlays sit between the body and the face, so long hair falls
            behind the features and a hem covers the trousers without hiding the
            legs the walk cycle animates. */}
        {figureOutfit && (
          <pixiSprite
            texture={figureOutfit}
            x={FIGURE_OUTFIT_OFFSET.x - 8}
            y={FIGURE_OUTFIT_OFFSET.y - 24}
          />
        )}
        {figureHair && (
          <pixiSprite
            texture={figureHair}
            x={FIGURE_HAIR_OFFSET.x - 8}
            y={FIGURE_HAIR_OFFSET.y - 24}
          />
        )}
        {/* The robot's own head carries its antenna and visor; a hat or a pair
            of glasses on top of that reads as a rendering mistake. */}
        {!stillCrew && (
          <pixiSprite
            texture={accessoryTexture(agent.agentId, agent.appearance)}
            x={ACCESSORY_OFFSET.x - 8}
            y={ACCESSORY_OFFSET.y - 24}
          />
        )}
        <pixiSprite
          ref={faceRef}
          texture={faceTexture(agent.agentId, presentation.face, agent.appearance, crew)}
          x={FACE_OFFSET.x - 8}
          y={FACE_OFFSET.y - 24}
        />
        <pixiSprite
          ref={handsRef}
          texture={handsTexture(agent.agentId, "a", agent.appearance, crew)}
          x={HANDS_OFFSET.x - 8}
          y={HANDS_OFFSET.y - 24}
          visible={false}
        />
        <pixiContainer y={-28}>
          <AgentIndicator kind={presentation.indicator} />
        </pixiContainer>
        <ModelResourceIndicator resource={agent.modelResource} />
        <pixiContainer ref={sleepBadgeRef} y={-28} visible={false}>
          <AgentIndicator kind="sleep" />
        </pixiContainer>
      </pixiContainer>
    </pixiContainer>
  );
}
