import type { FormEvent } from "react";
import { Spinner } from "./Spinner";

interface AuthScreenProps {
  required: boolean | null;
  error: string | null;
  busy: boolean;
  token: string;
  onTokenChange: (value: string) => void;
  onUnlock: (event: FormEvent) => void;
}

export function AuthScreen({
  required,
  error,
  busy,
  token,
  onTokenChange,
  onUnlock,
}: AuthScreenProps) {
  if (required === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">LQAM</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (!required) return null;

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={onUnlock}>
        <div className="brand-mark">A</div>
        <span className="eyebrow">LQAM</span>
        <h1>Enter the access token</h1>
        <p>This shared demo token is configured by the platform operator.</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <label>
          Access token
          <input
            autoFocus
            type="password"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button className="button button-primary" disabled={busy || !token.trim()}>
          {busy ? <Spinner /> : "Open LQAM"}
        </button>
      </form>
    </main>
  );
}
