import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { Agent } from "../../api/contracts";
import { Spinner } from "../../shared/ui/states";

const DEFAULT_INSTRUCTIONS =
  "Help me build and test software in this workspace. Keep changes small and explain the result.";

export function CreateAgentForm({
  onCreated,
  onClose,
}: {
  onCreated: (agent: Agent) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      });
      onCreated(agent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={onClose}
      role="presentation"
    >
      <form
        ref={dialogRef}
        className="modal"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
      >
        <div className="modal-heading">
          <div>
            <span className="panel-eyebrow">New workspace</span>
            <h2 id="create-agent-title">Create an agent</h2>
            <p>Each agent gets a persistent folder and a resumable Codex session.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>

        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}

        <label className="field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
          />
        </label>
        <label className="field">
          <span>Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
          />
        </label>
        <label className="field">
          <span>Instructions</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={5}
            maxLength={10000}
          />
        </label>

        <div className="modal-footer">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || name.trim() === ""}
          >
            {busy ? <Spinner label="Creating" /> : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}
