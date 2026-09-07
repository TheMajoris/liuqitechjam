import { useCallback, useEffect, useMemo, useState } from "react";
import { TUTORIAL_STEPS } from "./tutorial-steps";

const SEEN_KEY = "launchpad.tutorial.seen";

/**
 * Whether this browser has been through the tour.
 *
 * Per browser rather than per account: the tour teaches this interface, and a
 * person on a new machine is looking at it for the first time again. A read
 * that throws — private mode, blocked site data — is treated as "seen" so a
 * blocked browser is never trapped opening the tour on every load.
 */
function readSeen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === "true";
  } catch {
    return true;
  }
}

function writeSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "true");
  } catch {
    // Remembering is a convenience; failing to remember must not break the app.
  }
}

export interface TutorialController {
  /** True while the overlay should be on screen. */
  active: boolean;
  stepIndex: number;
  stepCount: number;
  /** False until the first-run check has settled, so nothing flashes. */
  seen: boolean;
  start: () => void;
  next: () => void;
  back: () => void;
  /** Leave the tour and remember that it was offered. */
  finish: () => void;
}

/**
 * Drive the guided tour.
 *
 * It opens itself once, on a first visit, and only when the app is ready to be
 * toured — a tour that starts while the shell is still loading points at
 * controls that have not rendered. After that it is entirely on demand.
 */
export function useTutorial(ready: boolean): TutorialController {
  const [seen, setSeen] = useState(readSeen);
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!ready || seen || active) return;
    // One frame of grace so the sidebar and room have laid out and their
    // targets can actually be measured.
    const timer = window.setTimeout(() => setActive(true), 400);
    return () => window.clearTimeout(timer);
  }, [active, ready, seen]);

  const finish = useCallback(() => {
    setActive(false);
    setStepIndex(0);
    setSeen(true);
    writeSeen();
  }, []);

  const start = useCallback(() => {
    setStepIndex(0);
    setActive(true);
  }, []);

  const next = useCallback(() => {
    setStepIndex((current) => {
      if (current >= TUTORIAL_STEPS.length - 1) {
        finish();
        return current;
      }
      return current + 1;
    });
  }, [finish]);

  const back = useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1));
  }, []);

  return useMemo(
    () => ({
      active,
      stepIndex,
      stepCount: TUTORIAL_STEPS.length,
      seen,
      start,
      next,
      back,
      finish,
    }),
    [active, back, finish, next, seen, start, stepIndex],
  );
}
