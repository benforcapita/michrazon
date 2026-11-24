import { describe, expect, it } from 'vitest';
import {
  createJevSystemOneClient,
  DEFAULT_JEV_MIN_CONFIDENCE,
  isDigestEligible,
  JevClassifier,
  KeywordClassifier,
  KeywordFallbackClassifier,
  type JevSystemOneRequest,
} from '@michrazon/llm';
import type { ClassificationInput } from '@michrazon/llm';
import { silentLogger } from '../helpers/mockHttp';

const INPUT: ClassificationInput = {
  source_tier: 'green',
  title: 'פיתוח מערכת ניהול תשתיות',
  publisher: 'עיריית באר שבע',
  published_at: '2026-01-12',
  submission_deadline: '2026-01-30T10:00:00.000Z',
};

function jevBody(opts: {
  relevance?: string;
  confidence?: number;
  category?: string;
} = {}) {
  const { relevance = 'relevant', confidence = 0.9, category = 'software_dev' } = opts;
  return {
    model: 'jev-1.14.0',
    answers: {
      relevance: {
        type: 'choice',
        choice: relevance,
        confidence,
        probabilities: { relevant: confidence, not_relevant: 1 - confidence },
      },
      category: {
        type: 'choice',
        choice: category,
        confidence: 0.85,
        probabilities: { [category]: 0.85 },
      },
    },
    usage: { input_tokens: 120, output_tokens: 30 },
  };
}

function mockJev(respond: (req: JevSystemOneRequest) => unknown) {
  const calls: JevSystemOneRequest[] = [];
  return {
    calls,
    systemOne: async (req: JevSystemOneRequest) => {
      calls.push(req);
      return respond(req);
    },
  };
}

describe('JevClassifier (TypeSafe system_one)', () => {
  it('maps choice answers onto ClassificationResult', async () => {
    const { systemOne, calls } = mockJev(() => jevBody());
    const cls = new JevClassifier({ systemOne });
    const out = await cls.classify(INPUT);

    expect(out.status).toBe('ok');
    expect(out.result).toMatchObject({
      is_relevant: true,
      category: 'software_dev',
      confidence: 0.9,
      summary_he: null,
      uncertain: false,
    });
    expect(out.result?.facts_used).toContain('title');
    expect(out.result?.facts_used).toContain('publisher');
    expect(out.inputTokens).toBe(120);
    expect(out.outputTokens).toBe(30);
    expect(out.modelId).toBe('jev-1.14.0');
    expect(isDigestEligible(out, DEFAULT_JEV_MIN_CONFIDENCE)).toBe(true);

    // one request, two Choice questions, facts-only state
    expect(calls).toHaveLength(1);
    const q = calls[0]!.questions as Record<string, { type: string; criteria: Record<string, unknown> }>;
    expect(q['relevance']?.type).toBe('choice');
    expect(Object.keys(q['relevance']!.criteria)).toEqual(['relevant', 'not_relevant']);
    expect(q['category']?.type).toBe('choice');
    const state = calls[0]!.state as Record<string, unknown>;
    expect(state['title']).toBe(INPUT.title);
    expect(state['publisher']).toBe(INPUT.publisher);
  });

  it('never sends open_data_fields for yellow sources', async () => {
    const { systemOne, calls } = mockJev(() => jevBody());
    const cls = new JevClassifier({ systemOne });
    await cls.classify({
      source_tier: 'yellow',
      title: 'מכרז',
      open_data_fields: { leaked: '<html>page body</html>' },
    });
    const state = calls[0]!.state as Record<string, unknown>;
    expect(state).not.toHaveProperty('open_data_fields');
    expect(JSON.stringify(state)).not.toContain('page body');
  });

  it('marks below-threshold confidence uncertain → not digest eligible', async () => {
    const { systemOne } = mockJev(() => jevBody({ confidence: 0.4 }));
    const cls = new JevClassifier({ systemOne, minConfidence: 0.55 });
    const out = await cls.classify(INPUT);
    expect(out.status).toBe('ok');
    expect(out.result?.is_relevant).toBe(true);
    expect(out.result?.uncertain).toBe(true);
    expect(isDigestEligible(out, 0.55)).toBe(false);
  });

  it('maps not_relevant to is_relevant=false, other_not_relevant category', async () => {
    const { systemOne } = mockJev(() =>
      jevBody({ relevance: 'not_relevant', confidence: 0.95 }),
    );
    const cls = new JevClassifier({ systemOne });
    const out = await cls.classify(INPUT);
    expect(out.result?.is_relevant).toBe(false);
    expect(out.result?.category).toBe('other_not_relevant');
    expect(out.result?.summary_he).toBeNull();
    expect(isDigestEligible(out, 0.55)).toBe(false);
  });

  it('throws on malformed responses so the fallback can take over', async () => {
    const { systemOne } = mockJev(() => ({ answers: {} }));
    const cls = new JevClassifier({ systemOne });
    await expect(cls.classify(INPUT)).rejects.toThrow();
  });
});

describe('createJevSystemOneClient', () => {
  it('rejects when TYPESAFE_API_KEY is missing', async () => {
    const client = createJevSystemOneClient({
      fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
    });
    await expect(
      client({ state: {}, questions: {} }),
    ).rejects.toThrow('TYPESAFE_API_KEY');
  });

  it('posts to /v1/systemone with bearer auth and the model when set', async () => {
    const seen: { url?: string; init?: { headers: Record<string, string>; body: string } } = {};
    const client = createJevSystemOneClient({
      apiKey: 'k',
      model: 'jev-latest',
      fetchImpl: async (url, init) => {
        seen.url = url;
        seen.init = init;
        return { status: 200, json: async () => ({ answers: {} }) };
      },
    });
    await client({ state: { title: 'x' }, questions: {} });
    expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen.init?.headers['Authorization']).toBe('Bearer k');
    expect(JSON.parse(seen.init!.body)['model']).toBe('jev-latest');
  });

  it('surfaces API errors as thrown errors', async () => {
    const client = createJevSystemOneClient({
      apiKey: 'k',
      fetchImpl: async () => ({
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      }),
    });
    await expect(client({ state: {}, questions: {} })).rejects.toThrow('401');
  });
});

describe('KeywordClassifier fallback', () => {
  const cls = new KeywordClassifier();

  it('clearly relevant titles classify relevant at fallback confidence', async () => {
    const out = await cls.classify({ source_tier: 'green', title: 'פיתוח מערכת מידע לעירייה' });
    expect(out.result?.is_relevant).toBe(true);
    expect(out.result?.uncertain).toBe(false);
    expect(isDigestEligible(out, DEFAULT_JEV_MIN_CONFIDENCE)).toBe(true);
  });

  it('clearly irrelevant titles classify not relevant', async () => {
    const out = await cls.classify({ source_tier: 'green', title: 'רכש ציוד משרדי וריהוט' });
    expect(out.result?.is_relevant).toBe(false);
    expect(out.result?.uncertain).toBe(false);
  });

  it('ambiguous or signal-free titles are uncertain → excluded from digest', async () => {
    const out = await cls.classify({ source_tier: 'green', title: 'מכרז פומבי מספר 12' });
    expect(out.result?.uncertain).toBe(true);
    expect(isDigestEligible(out, DEFAULT_JEV_MIN_CONFIDENCE)).toBe(false);
    const mixed = await cls.classify({
      source_tier: 'green',
      title: 'פיתוח תוכנה ורכש ציוד משרדי',
    });
    expect(mixed.result?.uncertain).toBe(true);
  });
});

describe('KeywordFallbackClassifier', () => {
  it('falls back on provider errors and never throws', async () => {
    const cls = new KeywordFallbackClassifier(
      new JevClassifier({
        systemOne: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
      new KeywordClassifier(),
      silentLogger,
    );
    const out = await cls.classify({ source_tier: 'green', title: 'פיתוח תוכנה' });
    expect(out.status).toBe('ok');
    expect(out.modelId).toBe('keyword_fallback');
    expect(out.fallbackReason).toContain('ECONNREFUSED');
    expect(out.result?.is_relevant).toBe(true);
  });

  it('falls back when the api key is missing', async () => {
    const cls = new KeywordFallbackClassifier(
      new JevClassifier({
        systemOne: createJevSystemOneClient({
          fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
        }),
      }),
      new KeywordClassifier(),
      silentLogger,
    );
    const out = await cls.classify({ source_tier: 'green', title: 'רכש ציוד משרדי' });
    expect(out.fallbackReason).toContain('TYPESAFE_API_KEY');
    expect(out.result?.is_relevant).toBe(false);
  });
});
