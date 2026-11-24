import { describe, expect, it } from 'vitest';
import type { LlmCompleteRequest, LlmProvider } from '@michrazon/core';
import {
  buildUserPrompt,
  checkDailyBudget,
  classifyTender,
  isDigestEligible,
  postCheck,
  PROMPT_VERSION,
} from '@michrazon/llm';
import type { ClassificationInput } from '@michrazon/llm';

function mockProvider(respond: (req: LlmCompleteRequest) => string): {
  provider: LlmProvider;
  calls: LlmCompleteRequest[];
} {
  const calls: LlmCompleteRequest[] = [];
  return {
    calls,
    provider: {
      id: 'mock',
      async complete(req) {
        calls.push(req);
        return { text: respond(req), inputTokens: 100, outputTokens: 50, modelId: 'mock-1' };
      },
    },
  };
}

const INPUT: ClassificationInput = {
  source_tier: 'green',
  title: 'פיתוח מערכת ניהול תשתיות',
  publisher: 'עיריית באר שבע',
  published_at: '2026-01-12',
  submission_deadline: '2026-01-30T10:00:00.000Z',
};

const GOOD = JSON.stringify({
  is_relevant: true,
  confidence: 0.9,
  category: 'software_dev',
  summary_he: 'מכרז לפיתוח מערכת ניהול תשתיות עבור עיריית באר שבע.',
  facts_used: ['title', 'publisher'],
  uncertain: false,
});

describe('classifyTender', () => {
  it('accepts a valid structured response on first attempt', async () => {
    const { provider, calls } = mockProvider(() => GOOD);
    const out = await classifyTender(provider, INPUT);
    expect(out.status).toBe('ok');
    expect(out.result?.category).toBe('software_dev');
    expect(out.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.temperature).toBe(0);
    expect(isDigestEligible(out)).toBe(true);
  });

  it('retries once with a correction hint then marks needs_review', async () => {
    const { provider, calls } = mockProvider(() => 'not json at all');
    const out = await classifyTender(provider, INPUT);
    expect(out.status).toBe('needs_review');
    expect(out.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.system).toContain('החזר JSON תקין');
  });

  it('recovers when the retry returns valid JSON', async () => {
    let n = 0;
    const { provider } = mockProvider(() => (++n === 1 ? 'garbage' : GOOD));
    const out = await classifyTender(provider, INPUT);
    expect(out.status).toBe('ok');
    expect(out.attempts).toBe(2);
  });

  it('rejects extra keys outside the strict schema', async () => {
    const { provider } = mockProvider(() =>
      JSON.stringify({ ...JSON.parse(GOOD), page_text: 'leak' }),
    );
    const out = await classifyTender(provider, INPUT);
    expect(out.status).toBe('needs_review');
  });

  it('needs_review when is_relevant=false but summary is present', async () => {
    const { provider } = mockProvider(() =>
      JSON.stringify({ ...JSON.parse(GOOD), is_relevant: false }),
    );
    const out = await classifyTender(provider, INPUT);
    expect(out.status).toBe('needs_review');
  });
});

describe('post-check rules (LLD §8.4)', () => {
  const user = buildUserPrompt(INPUT);
  const ok = JSON.parse(GOOD);

  it('flags fabricated numbers in the summary', () => {
    const bad = { ...ok, summary_he: 'מכרז בשווי 500000 שקל לפיתוח מערכת.' };
    expect(postCheck(bad, INPUT, user)).toMatch(/numbers/);
  });

  it('accepts numbers that appear in the input facts', () => {
    const fine = { ...ok, summary_he: 'מכרז שפורסם ב-2026 לפיתוח מערכת.' };
    expect(postCheck(fine, INPUT, user)).toBeNull();
  });

  it('rejects open_data_fields in facts_used for yellow sources', () => {
    const yellow: ClassificationInput = { source_tier: 'yellow', title: 'מכרז' };
    const bad = { ...ok, facts_used: ['title', 'open_data_fields'] };
    expect(postCheck(bad, yellow, buildUserPrompt(yellow))).toMatch(/yellow/);
  });

  it('blocks threshold terms in yellow summaries', () => {
    const yellow: ClassificationInput = { source_tier: 'yellow', title: 'מכרז' };
    const bad = { ...ok, summary_he: 'מכרז הכולל תנאי סף וערבות.' };
    expect(postCheck(bad, yellow, buildUserPrompt(yellow))).toMatch(/threshold|ערבות|סף/);
  });
});

describe('prompt builder', () => {
  it('strips open_data_fields for yellow sources (AC-04)', () => {
    const user = buildUserPrompt({
      source_tier: 'yellow',
      title: 'מכרז',
      open_data_fields: { injected: 'page html leak' },
    });
    const facts = JSON.parse(user);
    expect(facts).not.toHaveProperty('open_data_fields');
    expect(user).not.toContain('page html leak');
  });

  it('is versioned', () => {
    expect(PROMPT_VERSION).toBe('v1');
  });
});

describe('budget gate', () => {
  it('allows spend below the daily cap and blocks at the cap', () => {
    expect(checkDailyBudget(1000, 5000).allowed).toBe(true);
    expect(checkDailyBudget(5000, 5000).allowed).toBe(false);
  });
});
