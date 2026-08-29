import { HttpError } from "../errors.js";

/** Stable model-plane errors safe to expose at the HTTP boundary. */
export type ModelErrorCode =
  | "MODEL_PROVIDER_NOT_FOUND"
  | "MODEL_PROVIDER_UNAVAILABLE"
  | "MODEL_LIST_FAILED"
  | "MODEL_NOT_FOUND"
  | "MODEL_NOT_SUPPORTED_FOR_WORKER"
  | "MODEL_REASONING_NOT_SUPPORTED"
  | "MODEL_REASONING_EFFORT_INVALID"
  | "MODEL_RUNTIME_CONFIGURATION_INVALID";

export class ModelCatalogError extends HttpError {
  constructor(
    public readonly code: ModelErrorCode,
    statusCode: number,
    message: string,
  ) {
    super(statusCode, message);
    this.name = "ModelCatalogError";
  }
}

