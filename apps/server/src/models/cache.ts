export interface ModelListCacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

/**
 * In-memory cache for safe model descriptors. Values contain no credentials;
 * the registry instance is recreated when application configuration changes.
 */
export class ModelListCache<T> {
  private readonly entries = new Map<string, ModelListCacheEntry<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) return undefined;
    return entry.value;
  }

  /** Read an expired value for stale-on-provider-failure fallback. */
  getStale(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    const createdAt = this.now();
    this.entries.set(key, {
      value,
      createdAt,
      expiresAt: createdAt + Math.max(1, ttlMs),
    });
  }

  clear(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(key);
  }
}
