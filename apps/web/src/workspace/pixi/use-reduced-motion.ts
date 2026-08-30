import { useCallback, useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether the viewer asked for less motion.
 *
 * The room is a status display, so when this is true every loop stops and
 * Agents move between stations instantly: the same information, without the
 * animation. Nothing about *what* is shown changes.
 */
export function useReducedMotion(): boolean {
  const subscribe = useCallback((notify: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
    const media = window.matchMedia(QUERY);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== "undefined" && Boolean(window.matchMedia)
        ? window.matchMedia(QUERY).matches
        : false,
    () => false,
  );
}
