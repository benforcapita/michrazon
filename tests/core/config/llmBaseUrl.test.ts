// PRO-805: LLM_BASE_URL is optional, https-only, and reaches the worker's
// ChatCompletionsProvider; unset keeps the OpenAI default. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '@michrazon/core';
import { buildWorkerDeps } from '../../../apps/worker/src/index';

const BASE_ENV = {
  DB_URL_WORKER: 'postgres://user:pw@127.0.0.1:1/none',
  TOKEN_HMAC_SECRET: 'test-secret',
  LLM_API_KEY: 'test-key',
};

const REQ = {
  system: 's',
  user: 'u',
  temperature: 0,
  maxOutputTokens: 10,
  jsonSchema: { type: 'object' },
};

async function urlHitByClassify(env: Record<string, string>): Promise<string> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { deps, close } = buildWorkerDeps({ ...BASE_ENV, ...env });
  try {
    await deps.llm.complete(REQ as Parameters<typeof deps.llm.complete>[0]);
  } finally {
    await close();
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return (fetchMock.mock.calls[0] as unknown as [string])[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadConfig LLM_BASE_URL', () => {
  it('is undefined when unset or empty', () => {
    expect(loadConfig({}).llmBaseUrl).toBeUndefined();
    expect(loadConfig({ LLM_BASE_URL: '' }).llmBaseUrl).toBeUndefined();
  });

  it('reads an https URL and tolerates a trailing slash', () => {
    expect(loadConfig({ LLM_BASE_URL: 'https://openrouter.ai/api/v1' }).llmBaseUrl).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(loadConfig({ LLM_BASE_URL: 'https://openrouter.ai/api/v1/' }).llmBaseUrl).toBe(
      'https://openrouter.ai/api/v1',
    );
  });

  it.each([
    'http://openrouter.ai/api/v1',
    'openrouter.ai/api/v1',
    'not a url',
    'ftp://openrouter.ai/api/v1',
  ])('rejects %s with ConfigError', (value) => {
    expect(() => loadConfig({ LLM_BASE_URL: value })).toThrow(ConfigError);
  });
});

describe('worker LLM provider base URL', () => {
  it('set: classify request goes to <base>/chat/completions', async () => {
    expect(await urlHitByClassify({ LLM_BASE_URL: 'https://openrouter.ai/api/v1' })).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(await urlHitByClassify({ LLM_BASE_URL: 'https://openrouter.ai/api/v1/' })).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });

  it('unset: classify request goes to the OpenAI default', async () => {
    expect(await urlHitByClassify({})).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('invalid: buildWorkerDeps throws ConfigError before any request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() =>
      buildWorkerDeps({ ...BASE_ENV, LLM_BASE_URL: 'http://openrouter.ai/api/v1' }),
    ).toThrow(ConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no tracking headers (HTTP-Referer / X-Title)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { deps, close } = buildWorkerDeps({
      ...BASE_ENV,
      LLM_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    await deps.llm.complete(REQ as Parameters<typeof deps.llm.complete>[0]);
    await close();
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    )[1];
    expect(Object.keys(init.headers).sort()).toEqual(['Authorization', 'Content-Type']);
  });
});
