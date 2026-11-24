// Per-host rate limiting (LLD §7): minimum interval between requests, optional
// jitter, and a per-run request cap. Injectable clock/sleep for tests.
import { RateLimitExceededError } from '../guard/errors';

export interface RateLimitOptions {
  minIntervalMs: number;
  maxPerRun: number;
  jitterMs?: number; // uniform 0..jitterMs added to each interval
}

export interface RateLimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PerHostRateLimiter {
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private count = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly host: string,
    deps: RateLimiterDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.rand = deps.rand ?? Math.random;
  }

  /** Waits until a request may be issued, then consumes one request slot. */
  async acquire(): Promise<void> {
    if (this.count >= this.opts.maxPerRun) {
      throw new RateLimitExceededError(this.host);
    }
    const jitter = this.opts.jitterMs ? this.rand() * this.opts.jitterMs : 0;
    const earliest = this.lastRequestAt + this.opts.minIntervalMs + jitter;
    const waitMs = earliest - this.now();
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastRequestAt = this.now();
    this.count += 1;
  }

  get requestsUsed(): number {
    return this.count;
  }
}
