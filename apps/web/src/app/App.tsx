import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "../api/client";
import type { SystemInfo } from "../api/contracts";
import { Spinner } from "../shared/ui/states";
import { AppRoutes } from "./routes";

type AuthPhase = "checking" | "locked" | "open";

export default function App() {
  const [phase, setPhase] = useState<AuthPhase>("checking");
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const loadSystem = useCallback(async () => {
    const info = await api.system();
    if (mounted.current) setSystem(info);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mounted.current) return;
        if (required) {
          setPhase("locked");
        } else {
          await loadSystem();
          if (mounted.current) setPhase("open");
        }
      })
      .catch((reason) => {
        if (mounted.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      mounted.current = false;
    };
  }, [loadSystem]);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(tokenInput);
    try {
      await loadSystem();
      setTokenInput("");
      setPhase("open");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("That access token was not accepted.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      setAuthToken("");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "checking") {
    return (
      <main className="gate">
        <section className="gate-card" aria-live="polite">
          <span className="gate-mark" aria-hidden="true">
            ⛨
          </span>
          <span className="gate-eyebrow">Secretless Control Plane</span>
          <h1>Connecting to the control plane</h1>
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : (
            <Spinner label="Connecting" />
          )}
        </section>
      </main>
    );
  }

  if (phase === "locked") {
    return (
      <main className="gate">
        <form className="gate-card" onSubmit={unlock}>
          <span className="gate-mark" aria-hidden="true">
            ⛨
          </span>
          <span className="gate-eyebrow">Secretless Control Plane</span>
          <h1>Enter the access token</h1>
          <p className="gate-lead">
            The shared control-plane bearer token is configured by the operator.
            It is never a provider credential.
          </p>
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <label className="field">
            <span>Access token</span>
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              required
            />
          </label>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || !tokenInput.trim()}
          >
            {busy ? <Spinner label="Unlocking" /> : "Open control plane"}
          </button>
        </form>
      </main>
    );
  }

  return <AppRoutes system={system} />;
}
