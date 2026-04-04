type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export class TTLCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();

  constructor(private readonly defaultTtlMs = 30_000) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.defaultTtlMs): V {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    return value;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  async getOrSet(key: K, factory: () => Promise<V>, ttlMs = this.defaultTtlMs): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await factory();
    return this.set(key, value, ttlMs);
  }
}
