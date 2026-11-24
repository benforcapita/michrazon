// GuardedHttp — the ONLY network I/O path for adapters (LLD §4 rule 2, §5, §7).
// Every request goes through: allowlist/denylist guard, document rejection,
// per-host rate limit, identifying User-Agent, redirect re-checks, response
// content-type checks (before body read), and 429/5xx backoff. A 403 blocks
// the source for the rest of the run and is never bypassed.

import {
  assertAllowed,
  assertResponseHeaders,
  SourceBlockedError,
} from '../guard/index';
import { PerHostRateLimiter } from '../rateLimiter/index';
import type { GuardedHttp, GuardedResponse, SourceId } from '../types';

export interface RawResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; redirect: 'manual' },
) => Promise<RawResponse>;

export interface SourceHttpLimits {
  minIntervalMs: number;
  maxPerRun: number;
  jitterMs?: number;
}

export interface GuardedHttpDeps {
  /** Identifying UA per LLD §7, e.g. 'MichrazonBot/1.0 (+<url>; contact: <addr>)'. */
  userAgent: string;
  limits: Record<SourceId, SourceHttpLimits>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rand?: () => number;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE = (s: number) => s === 429 || s >= 500;
const BACKOFF_MS = [30_000, 120_000, 600_000]; // 30s, 2m, 10m — max 3 retries
const MAX_ATTEMPTS = 1 + BACKOFF_MS.length;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    headers: init.headers,
    redirect: init.redirect,
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: res.status,
    headers: { get: (name: string) => res.headers.get(name) },
    text: () => res.text(),
  };
};

export class GuardedHttpImpl implements GuardedHttp {
  private readonly limiters = new Map<SourceId, PerHostRateLimiter>();
  private readonly blocked = new Set<SourceId>();
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GuardedHttpDeps) {
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
    this.sleep = deps.sleep ?? defaultSleep;
    for (const [id, limits] of Object.entries(deps.limits) as [SourceId, SourceHttpLimits][]) {
      this.limiters.set(
        id,
        new PerHostRateLimiter(limits, id, {
          now: deps.now,
          sleep: deps.sleep,
          rand: deps.rand,
        }),
      );
    }
  }

  isBlocked(sourceId: SourceId): boolean {
    return this.blocked.has(sourceId);
  }

  async get(url: string, sourceId: SourceId): Promise<GuardedResponse> {
    if (this.blocked.has(sourceId)) throw new SourceBlockedError(sourceId);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this.requestWithRedirects(url, sourceId);
      } catch (err) {
        if (err instanceof HttpStatusError) {
          if (err.status === 403) {
            this.blocked.add(sourceId);
            throw new SourceBlockedError(sourceId);
          }
          if (RETRYABLE(err.status) && attempt < MAX_ATTEMPTS) {
            await this.sleep(BACKOFF_MS[attempt - 1]!);
            continue;
          }
        }
        throw err;
      }
    }
  }

  private async requestWithRedirects(url: string, sourceId: SourceId): Promise<GuardedResponse> {
    const limiter = this.limiters.get(sourceId);
    if (!limiter) throw new Error(`no rate limits configured for source ${sourceId}`);

    let current = new URL(url);
    const maxRedirects = this.deps.maxRedirects ?? 5;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      assertAllowed(current, sourceId); // before ANY network call, every hop
      await limiter.acquire();
      const res = await this.fetchImpl(current.href, {
        headers: { 'user-agent': this.deps.userAgent },
        redirect: 'manual',
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new HttpStatusError(res.status);
        current = new URL(location, current); // re-checked on next loop hop
        continue;
      }

      if (res.status >= 400) throw new HttpStatusError(res.status);

      assertResponseHeaders(res.headers, sourceId); // before body read
      return {
        status: res.status,
        url: current.href,
        headers: headersToRecord(res.headers),
        text: () => res.text(),
      };
    }
    throw new Error(`too many redirects (>${maxRedirects})`);
  }
}

export class HttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`http status ${status}`);
    this.name = 'HttpStatusError';
  }
}

function headersToRecord(headers: { get(name: string): string | null }): Record<string, string> {
  const record: Record<string, string> = {};
  for (const name of ['content-type', 'content-disposition', 'etag', 'last-modified']) {
    const v = headers.get(name);
    if (v !== null) record[name] = v;
  }
  return record;
}
