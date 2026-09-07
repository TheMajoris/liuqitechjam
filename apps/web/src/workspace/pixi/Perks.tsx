import "./pixi-elements";
import { pixelTexture } from "./art/pixel-texture";
import { PERKS, PERK_PALETTE, type PerkId } from "./art/perks";

interface PerksProps {
  /** Which perks the room currently has. Everything else is not drawn. */
  enabled: ReadonlySet<PerkId>;
}

/**
 * The office perks layer.
 *
 * Static: nothing here is on the ticker, nothing is interactive, and nothing
 * takes part in depth sorting with the Agents — every perk stands in the open
 * floor south of the walking ring, so an Agent can never need to pass in front
 * of one. Drawing it as its own container keeps that guarantee obvious.
 */
export function Perks({ enabled }: PerksProps) {
  if (enabled.size === 0) return null;
  return (
    <pixiContainer>
      {PERKS.filter((perk) => enabled.has(perk.id)).map((perk) => (
        <pixiSprite
          key={perk.id}
          texture={pixelTexture("perk:" + perk.id, perk.grid, PERK_PALETTE)}
          x={perk.x}
          y={perk.y}
          anchor={{ x: 0.5, y: 1 }}
        />
      ))}
    </pixiContainer>
  );
}
