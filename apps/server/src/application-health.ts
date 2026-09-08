import type {
  Storage,
  StorageFatalFailure,
  StorageFatalHandler,
} from "./store.js";

export const STORAGE_UNAVAILABLE_CODE = "STORAGE_UNAVAILABLE" as const;
export const STORAGE_UNAVAILABLE_MESSAGE = "Persistent storage is unavailable" as const;

export interface ApplicationHealthContract {
  isHealthy(): boolean;
}

/**
 * Sanitized evidence for a lifecycle failure that needs operator attention.
 *
 * Storage failures use the separate fatal callback above because they make the
 * whole application unavailable. A run or lease cleanup failure can be scoped
 * to one resource, so it is retained here without pretending that unrelated
 * healthy resources are unavailable too.
 */
export interface ApplicationLifecycleFailure {
  readonly code:
    | "EXECUTION_FINALIZATION_FAILED"
    | "RUNTIME_CANCELLATION_FAILED"
    | "PROJECT_LEASE_RELEASE_FAILED";
  readonly message: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly projectId?: string;
}

export interface ApplicationLifecycleFailureSink {
  reportLifecycleFailure(failure: ApplicationLifecycleFailure): void;
}

export interface HealthyApplicationStatus {
  readonly ok: true;
  readonly service: string;
  readonly storage: "ok";
}

export interface UnhealthyApplicationStatus {
  readonly ok: false;
  readonly service: string;
  readonly storage: "unavailable";
  readonly errorCode: typeof STORAGE_UNAVAILABLE_CODE;
}

export type ApplicationHealthStatus =
  | HealthyApplicationStatus
  | UnhealthyApplicationStatus;

/**
 * Application-owned availability state. Storage adapters only publish a
 * sanitized fatal signal; this object owns the HTTP/readiness projection and
 * the lifecycle listeners that later execution cleanup can subscribe to.
 */
export class ApplicationHealth
  implements ApplicationHealthContract, ApplicationLifecycleFailureSink
{
  private failure: StorageFatalFailure | null = null;
  private readonly fatalListeners = new Set<StorageFatalHandler>();
  private readonly lifecycleFailureRecords: ApplicationLifecycleFailure[] = [];
  private readonly lifecycleFailureKeys = new Set<string>();

  constructor(private readonly service = "lqam-server") {}

  /** Stable callback suitable for passing to a storage adapter. */
  readonly handleStorageFailure: StorageFatalHandler = () => {
    if (this.failure !== null) return;
    // Normalize even a malformed adapter notification so no driver detail can
    // cross the application boundary through a health or lifecycle consumer.
    this.failure = {
      code: STORAGE_UNAVAILABLE_CODE,
      message: STORAGE_UNAVAILABLE_MESSAGE,
    };
    for (const listener of this.fatalListeners) {
      try {
        listener(this.failure);
      } catch {
        // Lifecycle listeners must not prevent availability from becoming
        // unhealthy or cause the storage driver's failure path to throw.
      }
    }
  };

  /** Connect an optional storage publisher to this application-owned state. */
  attachStorage(storage: Pick<Storage, "setFatalHandler">): void {
    storage.setFatalHandler?.(this.handleStorageFailure);
  }

  /** Subscribe to the first fatal storage transition for future quiescing. */
  onStorageFatal(listener: StorageFatalHandler): () => void {
    this.fatalListeners.add(listener);
    if (this.failure !== null) {
      try {
        listener(this.failure);
      } catch {
        // See handleStorageFailure: one cleanup consumer cannot mask the
        // application-wide unhealthy state.
      }
    }
    return () => {
      this.fatalListeners.delete(listener);
    };
  }

  isHealthy(): boolean {
    return this.failure === null;
  }

  /** Alias useful at call sites that describe the positive gate explicitly. */
  isAvailable(): boolean {
    return this.isHealthy();
  }

  /**
   * Retain sanitized execution/cleanup evidence for operator and test seams.
   * The failure is deliberately not converted into a storage outage: a
   * Project-specific recovery gate can remain precise while other resources
   * continue to report the real storage health.
   */
  reportLifecycleFailure(failure: ApplicationLifecycleFailure): void {
    const key = [
      failure.code,
      failure.projectId ?? "",
      failure.runId ?? "",
      failure.agentId ?? "",
    ].join("\u0000");
    if (this.lifecycleFailureKeys.has(key)) return;
    this.lifecycleFailureKeys.add(key);
    this.lifecycleFailureRecords.push({ ...failure });
  }

  lifecycleFailures(): readonly ApplicationLifecycleFailure[] {
    return this.lifecycleFailureRecords.map((failure) => ({ ...failure }));
  }

  status(): ApplicationHealthStatus {
    if (this.failure !== null) {
      return {
        ok: false,
        service: this.service,
        storage: "unavailable",
        errorCode: STORAGE_UNAVAILABLE_CODE,
      };
    }
    return { ok: true, service: this.service, storage: "ok" };
  }
}
