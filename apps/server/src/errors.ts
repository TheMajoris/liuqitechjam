export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

/**
 * A runner may use this only when it knows that no model work was started.
 *
 * Model fallbacks are intentionally not inferred from generic runtime/tool
 * failures: retrying those can repeat side effects in a workspace. Keeping a
 * dedicated error type makes the retry decision an explicit runner signal.
 */
export class RetryableModelError extends Error {
  readonly retryableModel = true;

  constructor(message = "Worker model is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableModelError";
  }
}
