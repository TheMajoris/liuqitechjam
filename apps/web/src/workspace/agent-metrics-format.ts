import type { AgentMetrics } from "../types";
import { formatDuration } from "../components/insights/usage-format";

/** "1m 05s" for anything a minute or longer; falls back to seconds/ms below that. */
export function formatElapsed(ms: number): string {
  return formatDuration(ms);
}

export function formatTokensPerSecond(value: number | null, missingLabel = "—"): string {
  if (value === null || !Number.isFinite(value)) return missingLabel;
  return value.toFixed(1) + " tok/s";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return (value < 10 ? value.toFixed(1) : Math.round(value)) + " " + units[unitIndex];
}

export function formatMemory(memBytes: number, memLimitBytes: number | null): string {
  const used = formatBytes(memBytes);
  if (memLimitBytes === null) return used;
  return used + " / " + formatBytes(memLimitBytes);
}

export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return (value < 10 ? value.toFixed(1) : Math.round(value)) + "%";
}

function formatTokenCount(value: number | null | undefined, missingLabel: string): string {
  return typeof value === "number" ? String(value) : missingLabel;
}

export interface AgentMetricsRow {
  label: string;
  value: string;
}

/**
 * Flattens one Agent's metrics snapshot into display rows. Container rows are
 * omitted when the sandbox reported nothing, and "—" stands in for any value
 * the runtime has not reported yet rather than a fabricated number.
 */
export function metricsRows(metrics: AgentMetrics | null): AgentMetricsRow[] {
  if (!metrics) return [];
  const rows: AgentMetricsRow[] = [];

  rows.push({ label: "State", value: metrics.lifecycle });
  rows.push({
    label: "Elapsed",
    value: metrics.currentRun ? formatElapsed(metrics.currentRun.elapsedMs) : "—",
  });
  rows.push({
    label: "Model",
    value: (metrics.model ?? "—") + (metrics.fallbackUsed ? " (fallback)" : ""),
  });
  rows.push({
    label: "Tok/s",
    value:
      formatTokensPerSecond(
        metrics.tokens.tokensPerSecondLastRun,
        metrics.currentRun ? "Live — awaiting usage" : "Not reported",
      ) +
      " last / " +
      formatTokensPerSecond(
        metrics.tokens.tokensPerSecondAvg,
        metrics.currentRun ? "Live — awaiting usage" : "Not reported",
      ) +
      " avg",
  });
  const missingTokenLabel = metrics.tokens.sessionAvailability === "unavailable"
    ? metrics.currentRun
      ? "Live — awaiting usage"
      : "Not reported"
    : "—";
  rows.push({
    label: "Tokens in/out",
    value:
      formatTokenCount(metrics.tokens.session.inputTokens, missingTokenLabel) +
      " / " +
      formatTokenCount(metrics.tokens.session.outputTokens, missingTokenLabel),
  });
  rows.push({
    label: "Tools",
    value: metrics.tools.calls + " calls / " + metrics.tools.denied + " denied",
  });
  rows.push({
    label: "Commands / files",
    value: metrics.tools.sandboxCommands + " / " + metrics.tools.filesChanged,
  });

  if (metrics.container) {
    rows.push({ label: "CPU", value: formatPct(metrics.container.cpuPct) });
    rows.push({
      label: "Mem",
      value: formatMemory(metrics.container.memBytes, metrics.container.memLimitBytes),
    });
    rows.push({
      label: "PIDs",
      value: metrics.container.pids === null ? "—" : String(metrics.container.pids),
    });
  }

  if (metrics.lastError) {
    rows.push({ label: "Last error", value: metrics.lastError });
  }

  return rows;
}
