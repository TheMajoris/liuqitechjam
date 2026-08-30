/**
 * Process-local circuit for the Permit policy directory.
 *
 * The gate starts closed. A reconciler opens it only after every requested
 * Permit write and verification has completed. Any failed or partial sync
 * closes it again so an in-process caller can never authorize against a
 * directory whose relationship to the repository is unknown.
 */
export type PermitSynchronizationState = "unready" | "ready" | "failed";

export class PermitSynchronizationGate {
  private state: PermitSynchronizationState = "unready";

  isReady(): boolean {
    return this.state === "ready";
  }

  getState(): PermitSynchronizationState {
    return this.state;
  }

  /** Close the circuit before beginning a full reconciliation attempt. */
  begin(): void {
    this.state = "unready";
  }

  /** Open only after the caller has completed the entire reconciliation. */
  markReady(): void {
    this.state = "ready";
  }

  /** Permanently close the current process until a later full retry succeeds. */
  markFailed(): void {
    this.state = "failed";
  }
}

export interface PermitSynchronizationGateLike {
  isReady(): boolean;
  begin(): void;
  markReady(): void;
  markFailed(): void;
}
