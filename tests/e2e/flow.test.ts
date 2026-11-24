// E2E (W2-B): signup -> confirm -> ingest -> classify -> digest build ->
// digest send -> one-click unsubscribe -> next-day digest does NOT send.
// Runs against real embedded Postgres + mocked LLM/transport/adapters.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmProvider, NormalizedTender, OutboundEmail, SourceAdapter } from '@michrazon/core';
import { MemoryAlertSink, RunRecorder } from '@michrazon/ops';
import { SuppressionAwareSender } from '@michrazon/mail';
import { startTestDb, type TestDb } from '@michrazon/db/testing';
import type { PostgresDb } from '@michrazon/db';
import {
  handleConfirm,
  handleSubscribe,
  handleUnsubscribe,
  type WebDeps,
} from '../../apps/web/src/lib/handlers';
import { createRateLimiter } from '../../apps/web/src/lib/rateLimit';
import type { WorkerDeps } from '../../apps/worker/src/deps';
import { runIngest } from '../../apps/worker/src/tasks/ingest';
import { runClassify } from '../../apps/worker/src/tasks/classify';
import { runDigestBuild, runDigestSend } from '../../apps/worker/src/tasks/digest';
import { silentLogger } from '../helpers/mockHttp';

let t: TestDb;
let db: PostgresDb;
const SECRETS = { k1: 'e2e-secret' };

const DAY1 = new Date('2026-01-18T05:00:00Z'); // Sunday
const DAY2 = new Date('2026-01-19T05:00:00Z'); // Monday

const confirmLinks: string[] = [];
const sentMail: OutboundEmail[] = [];

function webDeps(): WebDeps {
  return {
    db,
    secrets: SECRETS,
    baseUrl: 'https://michrazon.example',
    rateLimiter: createRateLimiter(50, 60_000),
    sendConfirmEmail: async (_to, url) => {
      confirmLinks.push(url);
    },
  };
}

function workerDeps(now: Date): WorkerDeps {
  const alerts = new MemoryAlertSink();
  return {
    db,
    http: { get: async () => { throw new Error('no network'); } },
    adapters: {},
    llm: LLM,
    sender: new SuppressionAwareSender({
      transport: { send: async (e) => { sentMail.push(e); return { messageId: `m-${sentMail.length}` }; } },
      isSuppressed: async (e) => (await db.getSuppression(e.toLowerCase())) !== null,
    }),
    recorder: new RunRecorder({ db, alerts, log: silentLogger, now: () => now }),
    secrets: SECRETS,
    appBaseUrl: 'https://michrazon.example',
    unsubscribeMailto: 'unsub@example.com',
    publisherBlock: 'מכרזון',
    attributionBySource: async (sid) => (await db.getSource(sid))?.attribution_text ?? '',
    llmDailyBudgetTokens: 1_000_000,
    relevanceThreshold: 0.8,
    log: silentLogger,
    now: () => now,
  };
}

const LLM: LlmProvider = {
  id: 'mock',
  async complete() {
    return {
      text: JSON.stringify({
        is_relevant: true, confidence: 0.95, category: 'software_dev',
        summary_he: 'מכרז רלוונטי לפיתוח תוכנה.', facts_used: ['title'], uncertain: false,
      }),
      inputTokens: 10, outputTokens: 5, modelId: 'mock',
    };
  },
};

function fixtureAdapter(tenders: NormalizedTender[]): SourceAdapter {
  return {
    id: 'datagov_beersheva',
    tier: 'green',
    counts: { emitted: 0, skipped: 0 },
    async *fetchSince() {
      for (const x of tenders) {
        this.counts.emitted += 1;
        yield x;
      }
    },
  };
}

const TENDER: NormalizedTender = {
  source_id: 'datagov_beersheva',
  source_tender_id: 'E2E-1',
  title: 'פיתוח מערכת ניהול',
  publisher: 'עיריית באר שבע',
  official_url: 'https://data.gov.il/dataset/beersheva-tenders',
};

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
}, 120_000);

afterAll(async () => {
  await t.stop();
}, 60_000);

describe('E2E subscriber lifecycle', () => {
  it('runs the full flow end to end', async () => {
    // 1) subscribe -> pending, confirm mail sent, nothing else
    const w = webDeps();
    const sub = await handleSubscribe({ method: 'POST', body: { email: 'E2E@Example.com' } }, w);
    expect(sub.status).toBe(200);
    const row = await db.findSubscriberByEmailNorm('e2e@example.com');
    expect(row?.status).toBe('pending');
    expect(confirmLinks).toHaveLength(1);

    // 2) confirm via POST token -> active
    const token = new URL(confirmLinks[0]!).searchParams.get('t')!;
    const confirmed = await handleConfirm({ method: 'POST', body: { t: token } }, w);
    expect(confirmed.status).toBe(200);
    expect((await db.getSubscriberById(row!.id))?.status).toBe('active');

    // 3) ingest + classify + build + send (day 1)
    const d1 = workerDeps(DAY1);
    await runIngest(d1, fixtureAdapter([TENDER]));
    await runClassify(d1);
    await runDigestBuild(d1);
    await runDigestSend(d1);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]!.to).toBe('E2E@Example.com');
    expect(sentMail[0]!.headers['List-Unsubscribe']).toContain('/api/unsubscribe?t=');
    expect(sentMail[0]!.html).toContain('למקור הרשמי');

    // 4) one-click unsubscribe -> status + suppression + consent
    const unsubToken = /[?&]t=([^>&]+)/.exec(sentMail[0]!.headers['List-Unsubscribe'] ?? '')?.[1] ?? '';
    const unsub = await handleUnsubscribe(
      { method: 'POST', query: { t: decodeURIComponent(unsubToken) } },
      w,
    );
    expect(unsub.status).toBe(200);
    expect((await db.getSubscriberById(row!.id))?.status).toBe('unsubscribed');
    expect(await db.getSuppression('e2e@example.com')).toMatchObject({ reason: 'unsubscribe' });

    // 5) day 2: new tender, new digest — unsubscribed user gets nothing (AC-17)
    const d2 = workerDeps(DAY2);
    await runIngest(d2, fixtureAdapter([{ ...TENDER, source_tender_id: 'E2E-2' }]));
    await runClassify(d2);
    await runDigestBuild(d2);
    const sentBefore = sentMail.length;
    await runDigestSend(d2);
    expect(sentMail).toHaveLength(sentBefore); // no new mail to the unsubscribed user
  }, 60_000);
});
