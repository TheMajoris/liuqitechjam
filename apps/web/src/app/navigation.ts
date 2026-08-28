export interface NavDestination {
  to: string;
  label: string;
  /** Single-glyph mark for the collapsed rail. */
  glyph: string;
  /** Short description for the tooltip / aria. */
  hint: string;
}

/** The six deep-linkable destinations, in IA order (plan §12). */
export const NAV_DESTINATIONS: readonly NavDestination[] = [
  {
    to: "/projects",
    label: "Projects",
    glyph: "▣",
    hint: "Role-assigned agent groups and their shared workspace",
  },
  {
    to: "/agents",
    label: "Agents",
    glyph: "◈",
    hint: "Agent lifecycle and the Playground",
  },
  {
    to: "/providers",
    label: "Providers",
    glyph: "⇄",
    hint: "Gateway-managed model providers",
  },
  {
    to: "/orchestrations",
    label: "Orchestrations",
    glyph: "≣",
    hint: "FIFO Planner → Builder → Reviewer runs",
  },
  {
    to: "/runs",
    label: "Runs",
    glyph: "⊞",
    hint: "Correlated runs and the Run Inspector",
  },
  {
    to: "/security",
    label: "Security",
    glyph: "⛨",
    hint: "Kill Switch posture and the Security Envelope",
  },
];
