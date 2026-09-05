import type { UsageDailyPoint } from "../../types";
import { formatCount, formatDay } from "./usage-format";

type Metric = "runs" | "totalTokens" | "toolCalls";

interface UsageSparklineSeriesPoint {
  key: string;
  value: number;
  title?: string;
}

interface UsageSparklineProps {
  /** Day-bucketed usage rows; paired with `metric` to pick a field. */
  points?: UsageDailyPoint[];
  metric?: Metric;
  /** A caller-provided series, for data that isn't day-bucketed usage rows. */
  series?: UsageSparklineSeriesPoint[];
  label: string;
  /** Formats the caption total and each bar's tooltip. Defaults to `formatCount`. */
  formatValue?: (value: number) => string;
  /** Axis start/end labels for a generic `series`; day-bucketed points derive their own. */
  axisLabels?: [string, string];
}

/**
 * A short bar sparkline.
 *
 * Deliberately not a charting library: the series is short and the only
 * reading a viewer needs is relative height plus an exact value on hover.
 * Accepts either day-bucketed usage rows (`points` + `metric`, the original
 * shape) or a generic `series` for anything else shaped as a short run of
 * numbers, such as a live container metric.
 */
export function UsageSparkline({
  points,
  metric,
  series,
  label,
  formatValue = formatCount,
  axisLabels,
}: UsageSparklineProps) {
  const data: UsageSparklineSeriesPoint[] =
    series ??
    (points ?? []).map((point) => {
      const value = point[metric as Metric];
      return {
        key: point.date,
        value,
        title: `${formatDay(point.date)} · ${formatCount(value)} ${label.toLowerCase()}`,
      };
    });
  const peak = data.reduce((max, point) => Math.max(max, point.value), 0);
  const total = data.reduce((sum, point) => sum + point.value, 0);
  const [axisStart, axisEnd] =
    axisLabels ??
    (points && points.length > 0
      ? [formatDay(points[0]!.date), formatDay(points[points.length - 1]!.date)]
      : ["", ""]);

  return (
    <figure className="usage-spark" aria-label={label}>
      <figcaption className="usage-spark-head">
        <span>{label}</span>
        <strong>{formatValue(total)}</strong>
      </figcaption>
      {peak === 0 ? (
        <p className="usage-spark-empty">No activity in this window.</p>
      ) : (
        <div className="usage-spark-bars" role="img" aria-label={`${label} by day`}>
          {data.map((point) => (
            <div
              key={point.key}
              className={"usage-spark-bar" + (point.value === 0 ? " is-empty" : "")}
              // A non-zero day always shows a stub so it reads as present.
              style={{ height: point.value === 0 ? "2px" : Math.max(6, (point.value / peak) * 100) + "%" }}
              title={point.title ?? formatValue(point.value)}
            />
          ))}
        </div>
      )}
      <div className="usage-spark-axis" aria-hidden="true">
        <span>{axisStart}</span>
        <span>{axisEnd}</span>
      </div>
    </figure>
  );
}
