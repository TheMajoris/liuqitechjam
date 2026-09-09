import { useEffect, useRef } from "react";
import { PERKS } from "./pixi/art/perks";
import type { AgentPlacementController } from "./use-agent-placement";
import type { WorkspaceDecorController } from "./use-workspace-decor";

interface WorkspaceDecorPanelProps {
  decor: WorkspaceDecorController;
  /** Where everyone has been put. Cosmetic in the same way the furniture is. */
  placement?: AgentPlacementController;
  onClose: () => void;
}

/**
 * Furnish the room.
 *
 * Every control here is cosmetic, and the panel says so once rather than
 * repeating it per row. Nothing in it can change what an Agent may do, who is
 * in the room, or how a turn is routed — the crew switch redraws the same
 * Agents in the same seats with the same states.
 */
export function WorkspaceDecorPanel({ decor, placement, onClose }: WorkspaceDecorPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  const chosen = decor.perks.size;

  return (
    <div className="ws-decor-panel" ref={panelRef} role="dialog" aria-label="Room settings">
      <header className="ws-decor-head">
        <div>
          <span className="ws-roster-kicker">Room</span>
          <h3>Make it yours</h3>
        </div>
        <button
          type="button"
          className="ws-inspector-close"
          aria-label="Close room settings"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <p className="ws-decor-note">
        Cosmetic only, and remembered in this browser. Nothing here changes what
        an Agent can do or how turns are routed.
      </p>

      <fieldset className="ws-decor-group">
        <legend>Crew</legend>
        <div className="ws-decor-crew" role="radiogroup" aria-label="Crew">
          <button
            type="button"
            role="radio"
            aria-checked={decor.crew === "people"}
            className={"ws-decor-crew-option" + (decor.crew === "people" ? " is-active" : "")}
            onClick={() => decor.setCrew("people")}
          >
            <strong>People</strong>
            <span>They wander, take breaks, and doze when idle.</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={decor.crew === "robots"}
            className={"ws-decor-crew-option" + (decor.crew === "robots" ? " is-active" : "")}
            onClick={() => decor.setCrew("robots")}
          >
            <strong>Robots</strong>
            <span>They hold their post. No wandering, no naps.</span>
          </button>
        </div>
      </fieldset>

      <fieldset className="ws-decor-group">
        <legend>
          Perks
          <span className="ws-roster-count">{chosen} of {PERKS.length}</span>
        </legend>
        <ul className="ws-decor-perks">
          {PERKS.map((perk) => {
            const on = decor.perks.has(perk.id);
            return (
              <li key={perk.id}>
                <label className={"ws-decor-perk" + (on ? " is-on" : "")}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => decor.togglePerk(perk.id)}
                  />
                  <span className="ws-decor-perk-copy">
                    <strong>{perk.label}</strong>
                    <span>{perk.note}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {/* Where people stand is arranged by dragging them, not from here — but
          an arrangement made by hand needs a way back that does not involve
          remembering where everyone started. */}
      {placement && (
        <fieldset className="ws-decor-group">
          <legend>Seating</legend>
          <p className="ws-decor-note">
            Drag an Agent to move them to another desk or into a zone. They wait
            where you put them, and go where their work takes them.
          </p>
        </fieldset>
      )}

      <div className="ws-decor-actions">
        {placement && (
          <button
            type="button"
            className="button button-ghost"
            disabled={!placement.arranged}
            onClick={placement.reset}
          >
            Put everyone back
          </button>
        )}
        <button
          type="button"
          className="button button-ghost"
          disabled={chosen === 0 && decor.crew === "people"}
          onClick={decor.reset}
        >
          Back to a plain office
        </button>
      </div>
    </div>
  );
}
