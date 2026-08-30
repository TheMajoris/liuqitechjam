import type { UsageAvailability, UsageTokenTotals } from "../../types";

/** Compact token/count formatting so a stat tile never wraps. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return (thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)) + "K";
  }
  const millions = value / 1_000_000;
  return (millions < 10 ? millions.toFixed(2) : millions.toFixed(1)) + "M";
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + " s";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes + "m " + String(seconds).padStart(2, "0") + "s";
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const value = (part / whole) * 100;
  return (value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)) + "%";
}

export function formatRelative(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  const elapsed = Date.now() - parsed;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return Math.floor(elapsed / 60_000) + "m ago";
  if (elapsed < 86_400_000) return Math.floor(elapsed / 3_600_000) + "h ago";
  return Math.floor(elapsed / 86_400_000) + "d ago";
}

export function formatDay(date: string): string {
  const parsed = Date.parse(date + "T00:00:00.000Z");
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The server distinguishes "no provider reported usage" from "the total is
 * zero", and the UI has to keep that distinction rather than showing a
 * confident 0 that nobody can act on.
 */
export function tokenCaveat(tokens: UsageTokenTotals, runs: number): string | null {
  if (tokens.availability === "unavailable") {
    return runs === 0
      ? "No runs yet"
      : "The provider reported no token counters for these runs";
  }
  if (tokens.availability === "partial") {
    const missing = runs - tokens.runsReporting;
    return missing > 0
      ? `Partial — ${tokens.runsReporting} of ${runs} runs reported usage`
      : "Partial — some runs reported an incomplete counter set";
  }
  return null;
}

export function availabilityLabel(availability: UsageAvailability): string {
  if (availability === "available") return "Complete";
  if (availability === "partial") return "Partial";
  return "Unavailable";
}
