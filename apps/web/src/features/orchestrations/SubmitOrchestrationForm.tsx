import { useMemo, useState } from "react";
import { api } from "../../api/client";
import type { Orchestration, Project, Provider } from "../../api/contracts";
import { Spinner } from "../../shared/ui/states";

export function SubmitOrchestrationForm({
  projects,
  providers,
  defaultProjectId,
  onSubmitted,
  onCancel,
}: {
  projects: Project[];
  providers: Provider[];
  defaultProjectId?: string;
  onSubmitted: (orchestration: Orchestration) => void;
  onCancel: () => void;
}) {
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status === "active"),
    [projects],
  );
  const [projectId, setProjectId] = useState(
    defaultProjectId ?? activeProjects[0]?.id ?? "",
  );
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete =
    projectId !== "" && providerId !== "" && prompt.trim().length > 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!complete) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.createOrchestration(
        { projectId, prompt: prompt.trim(), providerId },
        idempotencyKey.trim() || undefined,
      );
      onSubmitted(view.orchestration);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel form-panel" onSubmit={submit} aria-label="Submit orchestration">
      <h2>Submit orchestration</h2>
      <p className="panel-lead">
        Admits one FIFO job. Planner → Builder → Reviewer run in order over the
        project&apos;s shared workspace; status is owned by the control plane.
      </p>

      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}

      {activeProjects.length === 0 ? (
        <p className="field-note">
          No active projects. Create one on the Projects page first.
        </p>
      ) : null}

      <div className="field-row">
        <label className="field">
          <span>Project</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          >
            <option value="">Select a project…</option>
            {activeProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            required
          >
            <option value="">Select a provider…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
                {p.live ? " (live)" : " (mock)"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          maxLength={20000}
          placeholder="Implement and review the requested change."
          required
        />
      </label>

      <label className="field">
        <span>Idempotency key (optional)</span>
        <div className="field-inline">
          <input
            value={idempotencyKey}
            onChange={(e) => setIdempotencyKey(e.target.value)}
            placeholder="Reuse to return the original orchestration"
          />
          <button
            type="button"
            className="button button-ghost"
            onClick={() =>
              setIdempotencyKey(
                globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
              )
            }
          >
            Generate
          </button>
        </div>
      </label>

      <div className="panel-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || !complete}
        >
          {busy ? <Spinner label="Submitting" /> : "Submit orchestration"}
        </button>
      </div>
    </form>
  );
}
