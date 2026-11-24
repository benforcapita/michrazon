// In-memory sliding-window rate limiter (LLD §12, §14). Nothing is
// persisted; state dies with the process — deliberately, for privacy.

export interface RateLimiter {
  allow(key: string, now?: number): boolean;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, now: number = Date.now()): boolean {
      const cutoff = now - windowMs;
      const list = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (list.length >= limit) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      // Best-effort bound on map growth; evicts cold keys without timers.
      if (hits.size > 10_000) {
        for (const [k, v] of hits) {
          if (v.every((t) => t <= cutoff)) hits.delete(k);
        }
      }
      return true;
    },
  };
}
