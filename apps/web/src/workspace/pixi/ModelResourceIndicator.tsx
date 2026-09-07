import { useCallback } from "react";
import type { Graphics } from "pixi.js";
import "./pixi-elements";
import {
  modelResourceCapacityLabel,
  modelResourceQuotaPercent,
  modelResourceQuotaTone,
  modelResourceStatusGlyph,
} from "../../model-resource-format";
import type { ModelResourceSnapshot } from "../../types";
import { SCENE } from "./scene-theme";

/** Width of the capacity meter inside the badge, in world units. */
const METER_WIDTH = 8;

function endpointStatusColour(status: ModelResourceSnapshot["endpointStatus"]): number {
  switch (status) {
    case "running":
      return SCENE.green;
    case "degraded":
      return SCENE.muted;
    case "unavailable":
      return SCENE.red;
    case "stopped":
      return SCENE.muted;
    default:
      return SCENE.ink;
  }
}

function quotaColour(tone: ReturnType<typeof modelResourceQuotaTone>): number | null {
  switch (tone) {
    case "healthy":
      return SCENE.green;
    case "warning":
      return SCENE.amber;
    case "critical":
      return SCENE.red;
    default:
      return null;
  }
}

/**
 * A deliberately quiet, static Pixi badge. The accessible HTML plate and
 * inspector carry the words and counters; this mark only lets a viewer spot
 * endpoint state while watching the room.
 */
export function ModelResourceIndicator({ resource }: { resource: ModelResourceSnapshot | null }) {
  const draw = useCallback(
    (graphics: Graphics) => {
      graphics.clear();
      if (!resource) return;
      const endpointColour =
        resource.endpointStatus === "unavailable"
          ? SCENE.red
          : resource.freshness === "fresh"
            ? endpointStatusColour(resource.endpointStatus)
            : SCENE.muted;
      const capacityColour = quotaColour(modelResourceQuotaTone(resource));
      // Explicit fresh quota can override the healthy endpoint colour. Stale
      // quota is ignored so an old snapshot cannot produce a false warning.
      const endpointUnavailable = resource.endpointStatus === "unavailable" || resource.endpointStatus === "stopped";
      const colour = endpointUnavailable ? endpointColour : capacityColour ?? endpointColour;
      graphics
        .roundRect(-9, -5, 18, 8, 2)
        .fill({ color: SCENE.shadow, alpha: 0.12 })
        .roundRect(-9, -6, 18, 8, 2)
        .fill({ color: SCENE.white, alpha: 0.94 })
        .stroke({ width: 1, color: colour, alpha: resource.freshness === "stale" ? 0.55 : 0.9 });
      // A glyph-shaped mark keeps the badge meaningful for stopped, stale, or
      // unknown resources without pretending that it is a capacity meter.
      const glyph = modelResourceStatusGlyph(resource.endpointStatus);
      if (glyph === "●") {
        graphics.rect(-6, -3, 3, 3).fill(colour);
      } else if (glyph === "▲") {
        graphics.rect(-6, -3, 3, 1).fill(colour).rect(-5, -2, 1, 2).fill(colour);
      } else if (glyph === "✕") {
        graphics.rect(-6, -3, 1, 4).fill(colour).rect(-4, -3, 1, 4).fill(colour);
      } else if (glyph === "■") {
        graphics.rect(-6, -3, 3, 3).fill(colour);
      } else {
        graphics.rect(-6, -3, 3, 1).fill(colour).rect(-5, -2, 1, 2).fill(colour);
      }
      // Remaining capacity reads as a proportional meter rather than a lone
      // tick, so the badge matches the bar on the plate instead of looking
      // like an unexplained mark.
      const percent = modelResourceQuotaPercent(resource);
      if (capacityColour !== null && percent !== null && !endpointUnavailable) {
        graphics.rect(-1, -3, METER_WIDTH, 3).fill({ color: SCENE.muted, alpha: 0.28 });
        const filled = Math.max(percent > 0 ? 1 : 0, Math.round((METER_WIDTH * percent) / 100));
        if (filled > 0) graphics.rect(-1, -3, filled, 3).fill(capacityColour);
      }
    },
    [resource],
  );

  if (!resource) return null;
  return (
    <pixiContainer
      /*
       * Above the head is a stack, not a slot: this badge, then the activity
       * bubble at -40..-28, then the Agent. Both used to be drawn at the same
       * height, so a working Agent's bubble and its quota meter landed on top
       * of one another. The position is fixed rather than conditional on a
       * bubble being present, so the badge never hops as activity changes.
       */
      y={-48}
      label={modelResourceCapacityLabel(resource)}
    >
      <pixiGraphics draw={draw} />
    </pixiContainer>
  );
}
