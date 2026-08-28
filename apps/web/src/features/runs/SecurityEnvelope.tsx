import type { Run, Span } from "../../api/contracts";

type NodeState = "sealed" | "ok" | "active" | "revoked" | "error" | "pending";

interface EnvelopeNode {
  key: string;
  label: string;
  state: NodeState;
  detail: string;
}

const TONE_CLASS: Record<NodeState, string> = {
  sealed: "tone-good",
  ok: "tone-good",
  active: "tone-active",
  revoked: "tone-idle",
  error: "tone-bad",
  pending: "tone-neutral",
};

function spansOfKind(spans: Span[], prefix: string): Span[] {
  return spans.filter((s) => s.kind === prefix || s.kind.startsWith(prefix));
}

function worst(spans: Span[]): NodeState {
  if (spans.length === 0) return "pending";
  if (spans.some((s) => s.status === "error")) return "error";
  if (spans.some((s) => s.status === "in_progress")) return "active";
  return "ok";
}

/**
 * The signature vertical rail: Workspace → Runtime → Lease → Gateway → Provider.
 * Every node's state is derived from redacted telemetry spans for this run — it
 * never renders a lease value, a token, or a provider key.
 */
export function SecurityEnvelope({
  run,
  spans,
}: {
  run: Run | null;
  spans: Span[];
}) {
  const runtimeSpans = spansOfKind(spans, "runtime.");
  const leaseSpans = spansOfKind(spans, "gateway.lease");
  const revokeSpans = spansOfKind(spans, "gateway.revoke");
  const denySpans = spans.filter((s) => s.kind === "security.deny");
  const killSpans = spans.filter((s) => s.kind === "security.kill");
  const gatewayReqSpans = spansOfKind(spans, "gateway.request");
  const providerSpans = spansOfKind(spans, "provider.responses");

  const cleaned = runtimeSpans.some(
    (s) => s.kind === "runtime.cleanup" && s.status === "ok",
  );

  let leaseState: NodeState = "pending";
  let leaseDetail = "No lease issued for this run yet.";
  if (revokeSpans.length > 0 || killSpans.length > 0) {
    leaseState = "revoked";
    leaseDetail = "Lease revoked — the runtime can no longer reach the provider.";
  } else if (denySpans.length > 0) {
    leaseState = "error";
    leaseDetail = "A request was denied before any provider call.";
  } else if (leaseSpans.length > 0) {
    leaseState = worst(leaseSpans) === "error" ? "error" : "ok";
    leaseDetail =
      "Opaque, run-scoped lease issued. Bound to run, agent, provider, model and expiry.";
  }

  const nodes: EnvelopeNode[] = [
    {
      key: "workspace",
      label: "Workspace",
      state: run?.projectId ? "ok" : "sealed",
      detail: run?.projectId
        ? "Shared project workspace mounted for this run."
        : "Isolated agent workspace. No provider credential is written here.",
    },
    {
      key: "runtime",
      label: "Runtime",
      state: cleaned ? "sealed" : worst(runtimeSpans),
      detail: cleaned
        ? "Runtime terminated and cleaned up."
        : runtimeSpans.length === 0
          ? "Runtime not launched yet."
          : "Disposable runtime on the gateway-only network. Env allowlist excludes secrets.",
    },
    {
      key: "lease",
      label: "Lease",
      state: leaseState,
      detail: leaseDetail,
    },
    {
      key: "gateway",
      label: "Gateway",
      state: worst(gatewayReqSpans),
      detail:
        gatewayReqSpans.length === 0
          ? "No gateway requests recorded."
          : "Trusted sidecar validates the lease and injects the real credential.",
    },
    {
      key: "provider",
      label: "Provider",
      state: worst(providerSpans),
      detail:
        providerSpans.length === 0
          ? "Provider not contacted."
          : "Responses-compatible provider reached only through the gateway.",
    },
  ];

  return (
    <div className="envelope" aria-label="Security Envelope">
      <ol className="envelope-rail">
        {nodes.map((node, index) => (
          <li key={node.key} className={`envelope-node ${TONE_CLASS[node.state]}`}>
            <span className="envelope-marker" aria-hidden="true" />
            <div className="envelope-node-body">
              <span className="envelope-node-head">
                <span className="envelope-node-label">{node.label}</span>
                <span className="envelope-node-state">{node.state}</span>
              </span>
              <span className="envelope-node-detail">{node.detail}</span>
            </div>
            {index < nodes.length - 1 ? (
              <span className="envelope-connector" aria-hidden="true" />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
