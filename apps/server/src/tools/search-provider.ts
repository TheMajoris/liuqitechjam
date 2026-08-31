/** A provider-neutral web-search result. Provider payloads never cross this seam. */
export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export type SearchProviderId = "searxng" | "brave" | "disabled";

export type SearchProviderHealthStatus = "available" | "unavailable" | "disabled";

/** Safe, non-secret provider state suitable for the control-plane UI. */
export interface SearchProviderHealth {
  provider: SearchProviderId;
  status: SearchProviderHealthStatus;
  configured: boolean;
  endpoint: string | null;
  message: string;
  checkedAt: string;
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  search(query: string, count?: number): Promise<SearchResult[]>;
  health(): Promise<SearchProviderHealth>;
}

export class SearchProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SearchProviderError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A deliberate configuration choice that keeps the search tool unavailable. */
export class DisabledSearchProvider implements SearchProvider {
  readonly id = "disabled" as const;

  async search(_query: string, _count?: number): Promise<SearchResult[]> {
    throw new SearchProviderError("Web search is disabled");
  }

  async health(): Promise<SearchProviderHealth> {
    return {
      provider: this.id,
      status: "disabled",
      configured: false,
      endpoint: null,
      message: "Web search is disabled",
      checkedAt: new Date().toISOString(),
    };
  }
}

