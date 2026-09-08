import type { AppConfig } from "./config.js";
import type {
  RuntimeReconciliationInput,
  RuntimeReconciliationResult,
} from "./types.js";

/** The labels are part of the application-owned runtime contract. */
export const AGENT_RUNTIME_LABEL = "io.codejam.launchpad=agent-runtime";
export const PREVIEW_RUNTIME_LABEL = "io.codejam.launchpad=preview-runtime";
export const INSTANCE_RUNTIME_LABEL = "io.codejam.instance-id";
export const AGENT_ID_RUNTIME_LABEL = "io.codejam.agent-id";
export const PREVIEW_ID_RUNTIME_LABEL = "io.codejam.preview-id";

/** Keep startup recovery bounded even when a broken engine returns junk. */
export const MAX_RECONCILIATION_CONTAINERS = 256;
export const RECONCILIATION_LIST_TIMEOUT_MS = 4_000;
export const RECONCILIATION_INSPECT_TIMEOUT_MS = 4_000;
export const RECONCILIATION_REMOVE_TIMEOUT_MS = 8_000;

export type RuntimeContainerEngineExec = (
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

interface RuntimeLabels {
  [key: string]: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { message?: unknown; stderr?: unknown };
    return [candidate.message, candidate.stderr]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
  }
  return String(error);
}

/**
 * Only an object-specific absence is positive evidence. In particular,
 * `command not found` and engine/daemon failures must remain unresolved.
 */
export function isPositiveRuntimeAbsence(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  if (/command not found|executable file not found|cannot find the file/.test(message)) {
    return false;
  }
  return (
    /no such (object|container|service|name)/.test(message) ||
    /(?:container|object|runtime|service|name)[^\n.]{0,80}(?:not found|was not found|does not exist)/.test(
      message,
    ) ||
    /(?:not found|was not found|does not exist)[^\n.]{0,80}(?:container|object|runtime|service|name)/.test(
      message,
    )
  );
}

function parseLabels(stdout: unknown): RuntimeLabels | null {
  if (typeof stdout !== "string" || stdout.trim().length === 0) return null;
  try {
    const decoded: unknown = JSON.parse(stdout.trim());
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return null;
    }
    const labels: RuntimeLabels = {};
    for (const [key, value] of Object.entries(decoded)) {
      if (typeof value === "string") labels[key] = value;
    }
    return labels;
  } catch {
    return null;
  }
}

function parseContainerIds(stdout: unknown): string[] | null {
  if (typeof stdout !== "string") return null;
  const ids = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return ids.length > MAX_RECONCILIATION_CONTAINERS
    ? null
    : [...new Set(ids)];
}

function activeAgentIds(input: RuntimeReconciliationInput): Set<string> {
  const ids = new Set<string>();
  for (const agent of input.agents) {
    if (agent.status === "busy") ids.add(agent.id);
  }
  for (const run of input.runs) {
    if (run.status === "queued" || run.status === "running") ids.add(run.agentId);
  }
  for (const lease of input.projectLeases) ids.add(lease.agentId);
  return ids;
}

/**
 * Local Codex processes do not carry a durable identity that can be adopted
 * after a restart. Keep stale work gated until an operator verifies and
 * repairs it; a cancelled database row is not proof that a process exited.
 */
export function reconcileLocalProcessStartup(
  input: RuntimeReconciliationInput,
): RuntimeReconciliationResult {
  return {
    provider: "local-process",
    confirmedAgentIds: [],
    confirmedPreviewIds: [],
    unresolvedAgentIds: uniqueSorted(activeAgentIds(input)),
    unresolvedPreviewIds: [],
  };
}

interface RuntimeIdentitySets {
  agentIds: Set<string>;
  previewIds: Set<string>;
}

function identitiesFor(input: RuntimeReconciliationInput): RuntimeIdentitySets {
  return {
    // Inventory is restricted to identities that still exist in committed
    // application state. A deleted Agent's old container is not ours to guess.
    agentIds: new Set(input.agents.map((agent) => agent.id)),
    previewIds: new Set(
      input.previews
        .filter((preview) => preview.runtimeId !== null)
        .map((preview) => preview.id),
    ),
  };
}

interface InventoryKind {
  label: string;
  identityLabel: string;
  identities: Set<string>;
  confirmed: Set<string>;
  unresolved: Set<string>;
}

function inventoryArgs(label: string, instanceId: string): string[] {
  return [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    "label=" + label,
    "--filter",
    "label=" + INSTANCE_RUNTIME_LABEL + "=" + instanceId,
  ];
}

function inspectArgs(runtimeId: string): string[] {
  return ["inspect", runtimeId, "--format", "{{json .Config.Labels}}"];
}

function removeArgs(runtimeId: string): string[] {
  return ["rm", "--force", runtimeId];
}

/**
 * Reconcile disposable container runtimes at the application boundary.
 *
 * The engine is deliberately injected so tests can prove the ownership and
 * uncertainty protocol without touching a live Docker/Podman daemon.
 */
export async function reconcileOwnedContainerRuntimes(
  config: Pick<AppConfig, "runtimeInstanceId">,
  input: RuntimeReconciliationInput,
  execEngine: RuntimeContainerEngineExec,
): Promise<RuntimeReconciliationResult> {
  const identities = identitiesFor(input);
  const kinds: InventoryKind[] = [
    {
      label: AGENT_RUNTIME_LABEL,
      identityLabel: AGENT_ID_RUNTIME_LABEL,
      identities: identities.agentIds,
      confirmed: new Set<string>(),
      unresolved: new Set<string>(),
    },
    {
      label: PREVIEW_RUNTIME_LABEL,
      identityLabel: PREVIEW_ID_RUNTIME_LABEL,
      identities: identities.previewIds,
      confirmed: new Set<string>(),
      unresolved: new Set<string>(),
    },
  ];

  for (const kind of kinds) {
    if (kind.identities.size === 0) continue;

    let listed: string[] | null;
    try {
      const result = await execEngine(
        inventoryArgs(kind.label, config.runtimeInstanceId),
        RECONCILIATION_LIST_TIMEOUT_MS,
      );
      listed = parseContainerIds(result.stdout);
    } catch {
      listed = null;
    }
    if (listed === null) {
      // We cannot prove absence for any persisted identity when inventory
      // itself failed or exceeded the bounded candidate count.
      for (const identity of kind.identities) kind.unresolved.add(identity);
      continue;
    }

    // A successful, instance-scoped inventory proves absence for identities
    // that do not appear in it, subject to the per-candidate confirmation below.
    for (const identity of kind.identities) kind.confirmed.add(identity);

    for (const runtimeId of listed) {
      let labels: RuntimeLabels | null;
      try {
        const inspected = await execEngine(
          inspectArgs(runtimeId),
          RECONCILIATION_INSPECT_TIMEOUT_MS,
        );
        labels = parseLabels(inspected.stdout);
      } catch (error) {
        // The candidate is already known to be in the configured instance,
        // but its identity is not trustworthy when inspect fails. Preserve all
        // persisted identities rather than guessing which one it belongs to.
        if (!isPositiveRuntimeAbsence(error)) {
          for (const identity of kind.identities) {
            kind.confirmed.delete(identity);
            kind.unresolved.add(identity);
          }
        }
        continue;
      }
      if (labels === null) {
        for (const identity of kind.identities) {
          kind.confirmed.delete(identity);
          kind.unresolved.add(identity);
        }
        continue;
      }
      const runtimeLabelValue = kind.label.slice(kind.label.indexOf("=") + 1);
      if (
        labels["io.codejam.launchpad"] !== runtimeLabelValue ||
        labels[INSTANCE_RUNTIME_LABEL] !== config.runtimeInstanceId
      ) {
        // The list was filtered, but the inspect result is the final ownership
        // witness. Never remove a container whose labels do not match exactly.
        for (const identity of kind.identities) {
          kind.confirmed.delete(identity);
          kind.unresolved.add(identity);
        }
        continue;
      }
      const identity = labels[kind.identityLabel];
      if (!identity) {
        // A matching platform/instance label without an identity label could
        // belong to any persisted owner. Preserve every owner gate rather
        // than treating malformed ownership evidence as positive absence.
        for (const persistedIdentity of kind.identities) {
          kind.confirmed.delete(persistedIdentity);
          kind.unresolved.add(persistedIdentity);
        }
        continue;
      }
      if (!kind.identities.has(identity)) {
        // Same-instance containers for deleted/other application identities
        // remain untouched by design.
        continue;
      }

      let removeFailed = false;
      try {
        await execEngine(removeArgs(runtimeId), RECONCILIATION_REMOVE_TIMEOUT_MS);
      } catch (error) {
        if (!isPositiveRuntimeAbsence(error)) removeFailed = true;
      }
      if (removeFailed) {
        kind.confirmed.delete(identity);
        kind.unresolved.add(identity);
        continue;
      }

      // A successful rm is not enough: verify that the object is absent. A
      // generic inspect failure is unresolved, while an object-specific
      // not-found is positive evidence of cleanup.
      try {
        await execEngine(
          inspectArgs(runtimeId),
          RECONCILIATION_INSPECT_TIMEOUT_MS,
        );
        kind.confirmed.delete(identity);
        kind.unresolved.add(identity);
      } catch (error) {
        if (isPositiveRuntimeAbsence(error)) {
          // Uncertainty is sticky for the whole identity. A later duplicate
          // runtime candidate cannot prove that an earlier cleanup failure was
          // safe, so it must never clear the recovery gate.
          if (!kind.unresolved.has(identity)) kind.confirmed.add(identity);
        } else {
          kind.confirmed.delete(identity);
          kind.unresolved.add(identity);
        }
      }
    }
  }

  return {
    provider: "container",
    confirmedAgentIds: uniqueSorted(kinds[0]!.confirmed),
    confirmedPreviewIds: uniqueSorted(kinds[1]!.confirmed),
    unresolvedAgentIds: uniqueSorted(kinds[0]!.unresolved),
    unresolvedPreviewIds: uniqueSorted(kinds[1]!.unresolved),
  };
}
