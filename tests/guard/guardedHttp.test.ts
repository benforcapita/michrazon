import { describe, expect, it, vi } from 'vitest';
import {
  DocumentFetchForbiddenError,
  ForbiddenContentTypeError,
  GuardedHttpImpl,
  HttpStatusError,
  RateLimitExceededError,
  SourceBlockedError,
  type FetchLike,
  type RawResponse,
} from '@michrazon/core';

const UA = 'MichrazonBot/1.0 (+https://example.test; contact: test@example.test)';

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
  body = 'ok',
): RawResponse & { textCalls: number } {
  const r: RawResponse & { textCalls: number } = {
    status,
    textCalls: 0,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: () => {
      r.textCalls += 1;
      return Promise.resolve(body);
    },
  };
  return r;
}

function makeHttp(opts: {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}) {
  return new GuardedHttpImpl({
    userAgent: UA,
    limits: {
      datagov_beersheva: { minIntervalMs: 5000, maxPerRun: 20 },
      mrgov_listing: { minIntervalMs: 10_000, maxPerRun: 60, jitterMs: 3000 },
    },
    ...opts,
  });
}

const instant = () => Promise.resolve();

describe('GuardedHttp', () => {
  it('sends the identifying User-Agent and returns html for yellow', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      makeResponse(200, { 'content-type': 'text/html' }, '<html>ok</html>'),
    );
    const http = makeHttp({ fetchImpl, sleep: instant });
    const res = await http.get('https://mr.gov.il/listing/1', 'mrgov_listing');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>ok</html>');
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers['user-agent']).toBe(UA);
  });

  it('AC-01: red-host URL throws before any network call', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const http = makeHttp({ fetchImpl, sleep: instant });
    await expect(http.get('https://tel-aviv.gov.il/x', 'datagov_beersheva')).rejects.toThrow();
    await expect(http.get('https://a.jerusalem.muni.il/x', 'datagov_beersheva')).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('AC-03: document URL rejected before any network call', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const http = makeHttp({ fetchImpl, sleep: instant });
    await expect(
      http.get('https://mr.gov.il/ilgstorefront/he/p/attachment/ABC/x.pdf', 'mrgov_listing'),
    ).rejects.toThrow(DocumentFetchForbiddenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('AC-03: pdf content-type rejected before body read', async () => {
    const res = makeResponse(200, { 'content-type': 'application/pdf' });
    const fetchImpl = vi.fn<FetchLike>(async () => res);
    const http = makeHttp({ fetchImpl, sleep: instant });
    await expect(http.get('https://mr.gov.il/listing/1', 'mrgov_listing')).rejects.toThrow(
      ForbiddenContentTypeError,
    );
    expect(res.textCalls).toBe(0);
  });

  it('redirect to a red domain is re-checked and rejected', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('data.gov.il')) {
        return makeResponse(302, { location: 'https://tel-aviv.gov.il/x' });
      }
      return makeResponse(200);
    });
    const http = makeHttp({ fetchImpl, sleep: instant });
    await expect(http.get('https://data.gov.il/x', 'datagov_beersheva')).rejects.toThrow();
    // only one real request was made — the redirect target never fetched
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redirect to a document URL is rejected', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      makeResponse(301, { location: 'https://mr.gov.il/x/attachment/a.pdf' }),
    );
    const http = makeHttp({ fetchImpl, sleep: instant });
    await expect(http.get('https://mr.gov.il/listing/1', 'mrgov_listing')).rejects.toThrow(
      DocumentFetchForbiddenError,
    );
  });

  it('AC-07: enforces max requests per run', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      makeResponse(200, { 'content-type': 'text/csv' }),
    );
    const http = new GuardedHttpImpl({
      userAgent: UA,
      limits: {
        datagov_beersheva: { minIntervalMs: 0, maxPerRun: 2 },
        mrgov_listing: { minIntervalMs: 0, maxPerRun: 2 },
      },
      fetchImpl,
      sleep: instant,
    });
    await http.get('https://data.gov.il/1', 'datagov_beersheva');
    await http.get('https://data.gov.il/2', 'datagov_beersheva');
    await expect(http.get('https://data.gov.il/3', 'datagov_beersheva')).rejects.toThrow(
      RateLimitExceededError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('AC-07: enforces min interval between requests', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn<FetchLike>(async () =>
      makeResponse(200, { 'content-type': 'text/csv' }),
    );
    const http = new GuardedHttpImpl({
      userAgent: UA,
      limits: {
        datagov_beersheva: { minIntervalMs: 5000, maxPerRun: 20 },
        mrgov_listing: { minIntervalMs: 0, maxPerRun: 20 },
      },
      fetchImpl,
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    await http.get('https://data.gov.il/1', 'datagov_beersheva');
    await http.get('https://data.gov.il/2', 'datagov_beersheva');
    expect(sleeps).toEqual([5000]);
  });

  it('AC-07: 403 blocks the source for the run, no bypass', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => makeResponse(403));
    const http = makeHttp({ fetchImpl, sleep: instant });
    await expect(http.get('https://data.gov.il/x', 'datagov_beersheva')).rejects.toThrow(
      SourceBlockedError,
    );
    await expect(http.get('https://data.gov.il/y', 'datagov_beersheva')).rejects.toThrow(
      SourceBlockedError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // blocked source does not retry
  });

  it('429/5xx retries with backoff up to 3 times then fails', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => makeResponse(429));
    const sleeps: number[] = [];
    const http = new GuardedHttpImpl({
      userAgent: UA,
      limits: {
        datagov_beersheva: { minIntervalMs: 0, maxPerRun: 20 },
        mrgov_listing: { minIntervalMs: 0, maxPerRun: 20 },
      },
      fetchImpl,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await expect(http.get('https://data.gov.il/x', 'datagov_beersheva')).rejects.toThrow(
      HttpStatusError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(sleeps).toEqual([30_000, 120_000, 600_000]);
  });

  it('5xx retries then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn<FetchLike>(async () =>
      n++ < 1 ? makeResponse(503) : makeResponse(200, { 'content-type': 'text/csv' }, 'data'),
    );
    const http = makeHttp({ fetchImpl, sleep: instant });
    const res = await http.get('https://data.gov.il/x', 'datagov_beersheva');
    expect(await res.text()).toBe('data');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
