import type {
  AdapterContext,
  GuardedHttp,
  GuardedResponse,
  Logger,
  SourceId,
} from '@michrazon/core';

export interface MockRoute {
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

/** Records every request; throws on unmapped URLs so tests catch surprise I/O. */
export function makeMockHttp(routes: Record<string, MockRoute>): {
  http: GuardedHttp;
  requested: string[];
} {
  const requested: string[] = [];
  const http: GuardedHttp = {
    async get(url: string, _sourceId: SourceId): Promise<GuardedResponse> {
      requested.push(url);
      const route = routes[url];
      if (!route) throw new Error(`unmocked URL: ${url}`);
      return {
        status: route.status ?? 200,
        url,
        headers: route.headers ?? {},
        text: async () => route.body,
      };
    },
  };
  return { http, requested };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function makeCtx(http: GuardedHttp, now = new Date('2026-01-15T08:00:00Z')): AdapterContext {
  return { http, now: () => now, log: silentLogger };
}
