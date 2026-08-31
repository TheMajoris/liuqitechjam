import type { AppConfig } from "../config.js";
import { BraveSearchAdapter } from "./brave-search-adapter.js";
import { SearXngSearchAdapter } from "./searxng-search-adapter.js";
import {
  DisabledSearchProvider,
  type SearchProvider,
} from "./search-provider.js";

/** Build the configured provider without exposing provider credentials to tools. */
export function createSearchProvider(config: Pick<
  AppConfig,
  | "searchProvider"
  | "braveSearchApiKey"
  | "braveSearchTimeoutMs"
  | "braveSearchMaxResults"
  | "searxngUrl"
  | "searxngTimeoutMs"
  | "searxngMaxResults"
  | "searxngMaxResponseBytes"
>): SearchProvider {
  switch (config.searchProvider) {
    case "brave":
      return new BraveSearchAdapter({
        apiKey: config.braveSearchApiKey,
        timeoutMs: config.braveSearchTimeoutMs,
        maxResults: config.braveSearchMaxResults,
      });
    case "searxng":
      return new SearXngSearchAdapter({
        endpoint: config.searxngUrl,
        timeoutMs: config.searxngTimeoutMs,
        maxResults: config.searxngMaxResults,
        maxResponseBytes: config.searxngMaxResponseBytes,
      });
    case "disabled":
      return new DisabledSearchProvider();
  }
}

