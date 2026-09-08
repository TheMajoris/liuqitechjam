import type { Transition, Variant } from "motion/react";

/**
 * The app's motion vocabulary, in one place.
 *
 * The stylesheet already had a motion language before any of this existed:
 * `--ease-out`, durations between 140ms and 260ms, and entries that fade while
 * travelling 6px or 14px. These constants restate exactly that, so a panel
 * animated in JavaScript and a button animated in CSS move the same way. The
 * point of Framer Motion here is not a second language — it is the half of the
 * first one CSS cannot express: exits, height-to-auto, and shared elements
 * that travel between components.
 *
 * Everything is deliberately quick. Motion in an operations console is there
 * to say what moved where, not to be admired; anything a reader has to wait
 * out is a cost, so nothing here runs longer than the stylesheet's slowest
 * transition.
 */

/** `--ease-out` in the stylesheet, as control points. */
export const EASE_OUT = [0.32, 0.72, 0, 1] as const;

/** Seconds. Mirrors the 140/200/260ms the stylesheet transitions in. */
export const DURATION = {
  /** Hovers, presses, and anything tracking a pointer. */
  fast: 0.14,
  /** The default: disclosures, list items, tab panels. */
  base: 0.2,
  /** Full panels and dialogs, which travel further. */
  slow: 0.26,
} as const;

/** Pixels. The stylesheet's own entry distances. */
export const OFFSET = {
  /** A nudge, for something appearing in place. */
  hair: 4,
  /** `tutorial-in`: content arriving in a settled layout. */
  small: 6,
  /** `sidecar-in` / `settings-dock-in`: a panel arriving from an edge. */
  panel: 14,
} as const;

export const transitions = {
  fast: { duration: DURATION.fast, ease: EASE_OUT },
  base: { duration: DURATION.base, ease: EASE_OUT },
  slow: { duration: DURATION.slow, ease: EASE_OUT },
  /**
   * Shared-element travel — an active-tab marker moving between tabs.
   * A spring rather than a curve because the distance changes with the
   * layout, and a fixed duration makes a short hop crawl and a long one race.
   */
  travel: { type: "spring", stiffness: 520, damping: 42, mass: 1 },
} as const satisfies Record<string, Transition>;

interface MotionVariant {
  initial: Variant;
  animate: Variant;
  exit: Variant;
}

/**
 * Every exit carries this.
 *
 * An element being animated out is still in the DOM and still hit-testable,
 * so a second click inside the exit window lands on a control the reader has
 * already dismissed — confirming a delete twice, or submitting a form again.
 * Before any of this, an unmount was instant and there was nothing left to
 * click; taking the element out of hit-testing the moment it starts leaving
 * restores that. `pointer-events` is not interpolated, so motion applies it
 * on the first frame of the exit.
 */
const LEAVING = { pointerEvents: "none" } as const;

/**
 * Where a thing comes from and where it goes.
 *
 * Direction carries meaning: a sidecar leaves toward the edge it docks to, a
 * dialog recedes rather than sliding, and content appearing inside a settled
 * layout barely moves at all. Reversing an exit through the entry path is what
 * makes dismissal feel like the undo of opening.
 */
export const variants = {
  /** For something that is simply there or not: no travel to explain. */
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, ...LEAVING },
  },
  /** `tutorial-in`: content arriving within a layout that is not moving. */
  rise: {
    initial: { opacity: 0, y: OFFSET.small },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: OFFSET.hair, ...LEAVING },
  },
  /** `settings-dock-in`: a panel docked to the left edge. */
  dockLeft: {
    initial: { opacity: 0, x: -OFFSET.panel },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -OFFSET.panel, ...LEAVING },
  },
  /** `sidecar-in`: a panel docked to the right edge. */
  dockRight: {
    initial: { opacity: 0, x: OFFSET.panel },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: OFFSET.panel, ...LEAVING },
  },
  /**
   * A dialog. It recedes on the way out rather than dropping, because it
   * belongs to the layer above the page rather than to the page.
   */
  modal: {
    initial: { opacity: 0, y: OFFSET.small, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, scale: 0.985, ...LEAVING },
  },
  /** A row joining or leaving a list it shares with its neighbours. */
  row: {
    initial: { opacity: 0, y: -OFFSET.hair },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, ...LEAVING },
  },
} as const satisfies Record<string, MotionVariant>;
