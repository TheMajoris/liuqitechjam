import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { transitions, variants } from "../../motion/motion-tokens";
import { TUTORIAL_STEPS, type TutorialStep } from "./tutorial-steps";
import type { TutorialController } from "./use-tutorial";

interface Spotlight {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 8;
const CARD = { width: 340, gap: 16 };

function measure(selector: string | undefined): Spotlight | null {
  if (!selector || typeof document === "undefined") return null;
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  // A target that has been collapsed away or scrolled out of the layout has no
  // box worth cutting a hole around.
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
}

/** Keep the card on screen whichever side of the target it was asked for. */
function cardPosition(
  spot: Spotlight | null,
  placement: TutorialStep["placement"],
): { top: number; left: number } | null {
  if (!spot) return null;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const height = 250;
  let left =
    placement === "left"
      ? spot.left - CARD.width - CARD.gap
      : placement === "right"
        ? spot.left + spot.width + CARD.gap
        : spot.left + spot.width / 2 - CARD.width / 2;
  let top =
    placement === "top"
      ? spot.top - height - CARD.gap
      : placement === "bottom"
        ? spot.top + spot.height + CARD.gap
        : spot.top;

  // Flip rather than clip when the preferred side has no room.
  if (left + CARD.width > viewportWidth - 12) {
    left = Math.min(spot.left - CARD.width - CARD.gap, viewportWidth - CARD.width - 12);
  }
  if (left < 12) left = Math.min(spot.left + spot.width + CARD.gap, viewportWidth - CARD.width - 12);
  left = Math.max(12, Math.min(left, viewportWidth - CARD.width - 12));
  top = Math.max(12, Math.min(top, viewportHeight - height - 12));
  return { top, left };
}

interface TutorialOverlayProps {
  tutorial: TutorialController;
}

/**
 * The guided tour, as a spotlight over the real interface.
 *
 * It teaches by pointing at the actual controls rather than by describing them
 * in a document, so nothing here can drift out of date without the selector
 * missing — and a missing selector degrades to a centred card rather than a
 * hole in the wrong place. The overlay is inert: it never clicks anything, and
 * it changes no application state.
 */
export function TutorialOverlay({ tutorial }: TutorialOverlayProps) {
  const step = TUTORIAL_STEPS[tutorial.stepIndex];
  const [spot, setSpot] = useState<Spotlight | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  // Measure before paint so the hole and the card appear together.
  useLayoutEffect(() => {
    if (!tutorial.active || !step) return;
    const update = () => setSpot(measure(step.selector));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // Panels animate open, so re-measure briefly after arriving on a step.
    const settle = window.setTimeout(update, 220);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.clearTimeout(settle);
    };
  }, [step, tutorial.active, tutorial.stepIndex]);

  useEffect(() => {
    if (!tutorial.active) return;
    nextRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        tutorial.finish();
      }
      if (event.key === "ArrowRight") tutorial.next();
      if (event.key === "ArrowLeft") tutorial.back();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [tutorial]);

  const position = step ? cardPosition(spot, step.placement) : null;
  const last = tutorial.stepIndex === tutorial.stepCount - 1;

  return (
    <AnimatePresence>
    {tutorial.active && step && (
    <motion.div
      className="tutorial-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorial-title"
      variants={variants.fade}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={transitions.base}
    >
      {/*
        The scrim is one element with a giant spread shadow rather than four
        panels around the target: one box to animate, and the hole tracks the
        target exactly as it moves.
      */}
      <div
        className={"tutorial-scrim" + (spot ? " has-spot" : "")}
        style={
          spot
            ? {
                top: spot.top,
                left: spot.left,
                width: spot.width,
                height: spot.height,
              }
            : undefined
        }
        onClick={tutorial.finish}
      />

      {/* The card travels to the next thing it is pointing at rather than
          teleporting, which is what ties a step to the one before it. Only
          `top`/`left` are animated: the centred fallback positions itself with
          a CSS transform, and writing one here would overwrite it. */}
      <motion.div
        className={"tutorial-card" + (position ? "" : " is-centred")}
        initial={{ opacity: 0, ...(position ?? {}) }}
        animate={{ opacity: 1, ...(position ?? {}) }}
        transition={transitions.base}
      >
        <div className="tutorial-progress" aria-hidden="true">
          {TUTORIAL_STEPS.map((item, index) => (
            <span
              key={item.id}
              className={
                "tutorial-pip" +
                (index < tutorial.stepIndex ? " is-done" : "") +
                (index === tutorial.stepIndex ? " is-current" : "")
              }
            />
          ))}
        </div>

        <div className="tutorial-body">
          <span className="tutorial-count">
            Step {tutorial.stepIndex + 1} of {tutorial.stepCount}
          </span>
          <h2 id="tutorial-title">{step.title}</h2>
          <p>{step.body}</p>
          {step.goal && (
            <p className="tutorial-goal">
              <span aria-hidden="true">▸</span> {step.goal}
            </p>
          )}
        </div>

        <div className="tutorial-actions">
          <button type="button" className="tutorial-skip" onClick={tutorial.finish}>
            {last ? "Close" : "Skip tour"}
          </button>
          <div className="tutorial-nav">
            {tutorial.stepIndex > 0 && (
              <button type="button" className="button button-ghost" onClick={tutorial.back}>
                Back
              </button>
            )}
            <button
              type="button"
              ref={nextRef}
              className="button button-primary"
              onClick={tutorial.next}
            >
              {last ? "Start building" : "Next"}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
    )}
    </AnimatePresence>
  );
}
