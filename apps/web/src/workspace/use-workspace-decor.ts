import { useCallback, useEffect, useMemo, useState } from "react";
import { isPerkId, type PerkId } from "./pixi/art/perks";
import type { WorkspaceCrew } from "./pixi/art/avatar-look";

/**
 * How this browser likes to see one Workspace.
 *
 * Kept out of the database on purpose. The room is a projection of backend
 * state — that is what lets a refresh rebuild the scene exactly — and the
 * furniture is not backend state: it changes nothing an Agent can do, nothing
 * a run records, and nothing another person needs to agree with. So it lives
 * where the sidebar and inspector preferences already live, per browser, and a
 * different device simply shows the room in its own arrangement.
 *
 * Stored per Workspace: teams give their rooms different characters, and a
 * global setting would make the last one edited win everywhere.
 */

const KEY_PREFIX = "launchpad.decor.";

export interface WorkspaceDecor {
  perks: ReadonlySet<PerkId>;
  crew: WorkspaceCrew;
}

export interface WorkspaceDecorController extends WorkspaceDecor {
  togglePerk: (perk: PerkId) => void;
  setCrew: (crew: WorkspaceCrew) => void;
  /** Everything off: the plain office the product ships with. */
  reset: () => void;
}

interface StoredDecor {
  perks?: unknown;
  crew?: unknown;
}

const EMPTY: ReadonlySet<PerkId> = new Set<PerkId>();

function storageKey(workspaceId: string | null): string | null {
  return workspaceId ? KEY_PREFIX + workspaceId : null;
}

function read(workspaceId: string | null): WorkspaceDecor {
  const key = storageKey(workspaceId);
  if (key === null || typeof window === "undefined") {
    return { perks: EMPTY, crew: "people" };
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { perks: EMPTY, crew: "people" };
    const parsed = JSON.parse(raw) as StoredDecor;
    const perks = Array.isArray(parsed.perks)
      ? parsed.perks.filter(
          (value): value is PerkId => typeof value === "string" && isPerkId(value),
        )
      : [];
    return {
      perks: new Set(perks),
      crew: parsed.crew === "robots" ? "robots" : "people",
    };
  } catch {
    // A hand-edited or truncated value is a preference, not data worth
    // recovering: fall back to the plain room rather than failing the view.
    return { perks: EMPTY, crew: "people" };
  }
}

export function useWorkspaceDecor(workspaceId: string | null): WorkspaceDecorController {
  const [decor, setDecor] = useState<WorkspaceDecor>(() => read(workspaceId));

  // Switching Workspace re-reads rather than carrying the previous room's
  // arrangement across, which would briefly show the wrong office.
  useEffect(() => {
    setDecor(read(workspaceId));
  }, [workspaceId]);

  // Writing is a side effect, so it stays outside the state updater: React
  // may run an updater twice in development, and a click is a single decision.
  const write = useCallback(
    (next: WorkspaceDecor) => {
      const key = storageKey(workspaceId);
      if (key === null || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ perks: [...next.perks], crew: next.crew }),
        );
      } catch {
        // Private browsing and full quotas both land here. The choice still
        // applies to this session; only remembering it is lost.
      }
    },
    [workspaceId],
  );

  const apply = useCallback(
    (next: WorkspaceDecor) => {
      setDecor(next);
      write(next);
    },
    [write],
  );

  const togglePerk = useCallback(
    (perk: PerkId) => {
      const perks = new Set(decor.perks);
      if (perks.has(perk)) perks.delete(perk);
      else perks.add(perk);
      apply({ ...decor, perks });
    },
    [apply, decor],
  );

  const setCrew = useCallback(
    (crew: WorkspaceCrew) => {
      apply({ ...decor, crew });
    },
    [apply, decor],
  );

  const reset = useCallback(() => {
    apply({ perks: EMPTY, crew: "people" });
  }, [apply]);

  return useMemo(
    () => ({ ...decor, togglePerk, setCrew, reset }),
    [decor, reset, setCrew, togglePerk],
  );
}
