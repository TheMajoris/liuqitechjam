/**
 * One status vocabulary for agents, runs, orchestrations, stages and spans.
 * `tone` maps a status string onto a colour band; the label is shown verbatim.
 */
export type StatusTone =
  | "neutral"
  | "active"
  | "good"
  | "warn"
  | "bad"
  | "idle";

const TONE_BY_STATUS: Record<string, StatusTone> = {
  // agents
  ready: "good",
  busy: "active",
  stopped: "idle",
  error: "bad",
  // runs / orchestrations / stages
  queued: "neutral",
  pending: "idle",
  running: "active",
  in_progress: "active",
  completed: "good",
  ok: "good",
  failed: "bad",
  cancelled: "idle",
  blocked: "warn",
  degraded: "warn",
  unknown: "neutral",
};

export function toneForStatus(status: string): StatusTone {
  return TONE_BY_STATUS[status] ?? "neutral";
}

export function StatusPill({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const tone = toneForStatus(status);
  return (
    <span className={`status-pill tone-${tone}`}>
      <span className="status-pill-dot" aria-hidden="true" />
      {label ?? status}
    </span>
  );
}
