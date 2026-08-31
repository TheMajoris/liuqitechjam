import type { UsageDailyPoint } from "../../types";
import { formatCount, formatDay } from "./usage-format";

type Metric = "runs" | "totalTokens" | "toolCalls";

interface UsageSparklineProps {
  points: UsageDailyPoint[];
  metric: Metric;
  label: string;
}

/**
 * Day-bucketed activity bars.
 *
 * Deliberately not a charting library: the series is short, zero-filled by the
 * server, and the only reading a viewer needs is relative height plus an exact
 * value on hover.
 */
export function UsageSparkline({ points, metric, label }: UsageSparklineProps) {
  const peak = points.reduce((max, point) => Math.max(max, point[metric]), 0);
  const total = points.reduce((sum, point) => sum + point[metric], 0);

  return (
    <figure className="usage-spark" aria-label={label}>
      <figcaption className="usage-spark-head">
        <span>{label}</span>
        <strong>{formatCount(total)}</strong>
      </figcaption>
      {peak === 0 ? (
        <p className="usage-spark-empty">No activity in this window.</p>
      ) : (
        <div className="usage-spark-bars" role="img" aria-label={`${label} by day`}>
          {points.map((point) => {
            const value = point[metric];
            return (
              <div
                key={point.date}
                className={"usage-spark-bar" + (value === 0 ? " is-empty" : "")}
                // A non-zero day always shows a stub so it reads as present.
                style={{ height: value === 0 ? "2px" : Math.max(6, (value / peak) * 100) + "%" }}
                title={`${formatDay(point.date)} · ${formatCount(value)} ${label.toLowerCase()}`}
              />
            );
          })}
        </div>
      )}
      <div className="usage-spark-axis" aria-hidden="true">
        <span>{points[0] ? formatDay(points[0].date) : ""}</span>
        <span>{points.at(-1) ? formatDay(points[points.length - 1]!.date) : ""}</span>
      </div>
    </figure>
  );
}
