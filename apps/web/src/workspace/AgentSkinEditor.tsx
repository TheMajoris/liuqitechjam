import { useState } from "react";
import type { AgentAccessory, AgentAppearance } from "../types";
import {
  HAIR_COUNT,
  SKIN_COUNT,
  resolveAppearance,
} from "./pixi/art/avatar-look";

const ACCESSORIES: ReadonlyArray<{ id: AgentAccessory; label: string }> = [
  { id: "none", label: "None" },
  { id: "glasses", label: "Glasses" },
  { id: "headset", label: "Headset" },
  { id: "cap", label: "Cap" },
];

/** Hues offered as swatches. The wheel is continuous; these are the presets. */
const HUES: readonly number[] = [8, 32, 52, 104, 168, 200, 232, 268, 300, 336];

interface AgentSkinEditorProps {
  agentId: string;
  agentName: string;
  appearance: AgentAppearance | null;
  disabled: boolean;
  onChange: (appearance: AgentAppearance) => Promise<void>;
}

/**
 * Character customization for one Agent.
 *
 * Purely cosmetic, and the control says so: nothing here can change what an
 * Agent is allowed to do. Each change is a merge patch, so picking a hat keeps
 * the hair and skin the Agent already had.
 */
export function AgentSkinEditor({
  agentId,
  agentName,
  appearance,
  disabled,
  onChange,
}: AgentSkinEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = resolveAppearance(agentId, appearance);

  const apply = (change: AgentAppearance) => {
    setError(null);
    setBusy(true);
    void onChange(change)
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : "Could not save the look");
      })
      .finally(() => setBusy(false));
  };

  const locked = disabled || busy;

  return (
    <section className="ws-inspector-block ws-skin" aria-label={`Appearance for ${agentName}`}>
      <h4>Appearance</h4>
      <p className="ws-skin-note">Cosmetic only — this never changes what the Agent can do.</p>

      <div className="ws-skin-row">
        <span className="ws-skin-label" id={`skin-shirt-${agentId}`}>Shirt</span>
        <div className="ws-skin-swatches" role="group" aria-labelledby={`skin-shirt-${agentId}`}>
          {HUES.map((hue) => (
            <button
              key={hue}
              type="button"
              className={"ws-skin-swatch" + (current.hue === hue ? " is-active" : "")}
              style={{ background: `hsl(${hue} 48% 54%)` }}
              aria-label={`Shirt hue ${hue}`}
              aria-pressed={current.hue === hue}
              disabled={locked}
              onClick={() => apply({ hue })}
            />
          ))}
        </div>
      </div>

      <div className="ws-skin-row">
        <span className="ws-skin-label" id={`skin-hair-${agentId}`}>Hair</span>
        <div className="ws-skin-swatches" role="group" aria-labelledby={`skin-hair-${agentId}`}>
          {Array.from({ length: HAIR_COUNT }, (_, index) => (
            <button
              key={index}
              type="button"
              className={"ws-skin-chip" + (current.hair === index ? " is-active" : "")}
              aria-label={`Hair style ${index + 1}`}
              aria-pressed={current.hair === index}
              disabled={locked}
              onClick={() => apply({ hair: index })}
            >
              {index + 1}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-skin-row">
        <span className="ws-skin-label" id={`skin-tone-${agentId}`}>Skin</span>
        <div className="ws-skin-swatches" role="group" aria-labelledby={`skin-tone-${agentId}`}>
          {Array.from({ length: SKIN_COUNT }, (_, index) => (
            <button
              key={index}
              type="button"
              className={"ws-skin-chip" + (current.skin === index ? " is-active" : "")}
              aria-label={`Skin tone ${index + 1}`}
              aria-pressed={current.skin === index}
              disabled={locked}
              onClick={() => apply({ skin: index })}
            >
              {index + 1}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-skin-row">
        <span className="ws-skin-label" id={`skin-acc-${agentId}`}>Accessory</span>
        <div className="ws-skin-swatches" role="group" aria-labelledby={`skin-acc-${agentId}`}>
          {ACCESSORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={"ws-skin-chip is-wide" + (current.accessory === item.id ? " is-active" : "")}
              aria-pressed={current.accessory === item.id}
              disabled={locked}
              onClick={() => apply({ accessory: item.id })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="ws-inline-error" role="alert">{error}</p>}
    </section>
  );
}
