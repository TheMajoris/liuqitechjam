import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { transitions } from "./motion-tokens";

/**
 * One motion policy for the whole shell.
 *
 * `reducedMotion="user"` is the important part: it reads the same
 * `prefers-reduced-motion` setting the stylesheet already honours, and drops
 * every transform and layout animation while keeping opacity. A viewer who
 * asked for less motion gets the same information, arriving without travel —
 * which is the policy the room (`use-reduced-motion.ts`) has always applied.
 *
 * Setting the default transition here rather than on each component means a
 * component that specifies nothing still moves in the app's own vocabulary.
 */
export function AppMotion({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={transitions.base}>
      {children}
    </MotionConfig>
  );
}
