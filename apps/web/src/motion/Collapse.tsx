import { motion } from "motion/react";
import type { ReactNode } from "react";
import { transitions } from "./motion-tokens";

/**
 * A section that grows open and shrinks shut, in place.
 *
 * `height: "auto"` is one of the few CSS values Motion can animate to
 * directly — it measures the content first, then tweens from the current
 * height to that measurement. `overflow: hidden` keeps the content from
 * flashing outside the collapsed box while it does.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <motion.div
      initial={false}
      animate={{ height: open ? "auto" : 0 }}
      transition={transitions.base}
      style={{ overflow: "hidden" }}
    >
      {children}
    </motion.div>
  );
}
