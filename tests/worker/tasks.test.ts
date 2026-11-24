import { describe, expect, it } from 'vitest';
import type { LlmProvider, NormalizedTender, OutboundEmail, SourceAdapter } from '@michrazon/core';
import { MemoryAlertSink, RunRecorder } from '@michrazon/ops';
import { SuppressionAwareSender } from '@michrazon/mail';
import type { WorkerDeps } from '../../apps/worker/src/deps';
import { runIngest } from '../../apps/worker/src/tasks/ingest';
import { runClassify } from '../../apps/worker/src/tasks/classify';
import { runDigestBuild, runDigestSend } from '../../apps/worker/src/tasks/digest';
import { runHousekeeping } from '../../apps/worker/src/tasks/housekeeping';
import { runTick } from '../../apps/worker/src/tick';
import { makeFakeDb } from '../helpers/fakeDb';
import { silentLogger } from '../helpers/mockHttp';

const NOW = new Date('2026-01-18T05:10:00Z'); // Sun 05:10 UTC = 07:10 JLM? (winter +2 => 07:10)

function adapterWith(tenders: NormalizedTender[], id: 'datagov_beersheva' | 'mrgov_listing' = 'datagov_beersheva'): SourceAdapter {
  return {
    id,
    tier: id === 'datagov_beersheva' ? 'green' : 'yellow',
    counts: { emitted: 0, skipped: 0 },
    async *fetchSince() {
      for (const t of tenders) {
        this.counts.emitted += 1;
        yield t;
      }
    },
  };
}

const GOOD_LLM: LlmProvider = {
  id: 'mock',
  async complete() {
    return {
      text: JSON.stringify({
        is_relevant: true, confidence: 0.95, category: 'software_dev',
        summary_he: 'מכרז רלוונטי.', facts_used: ['title'], uncertain: false,
      }),
      inputTokens: 10, outputTokens: 5, modelId: 'mock',
    };
  },
};

function workerDeps(overrides?: Partial<WorkerDeps>) {
  const fake = makeFakeDb({ now: () => NOW });
  const sent: OutboundEmail[] = [];
  const alerts = new MemoryAlertSink();
  const sender = new SuppressionAwareSender({
    transport: { send: async (e) => { sent.push(e); return { messageId: 'm-1' }; } },
    isSuppressed: async (e) => (await fake.db.getSuppression(e.toLowerCase())) !== null,
  });
  const deps: WorkerDeps = {
    db: fake.db,
    http: { get: async () => { throw new Error('no network in tests'); } },
    adapters: {},
    llm: GOOD_LLM,
    sender,
    recorder: new RunRecorder({ db: fake.db, alerts, log: silentLogger, now: () => NOW }),
    secrets: { k1: 'secret' },
    appBaseUrl: 'https://michrazon.example',
    unsubscribeMailto: 'unsub@example.com',
    publisherBlock: 'מכרזון',
    attributionBySource: async () => 'attribution',
    llmDailyBudgetTokens: 1000,
    relevanceThreshold: 0.8,
    log: silentLogger,
    now: () => NOW,
    ...overrides,
  };
  return { deps, fake, sent, alerts };
}

const TENDER: NormalizedTender = {
  source_id: 'datagov_beersheva',
  source_tender_id: 'T-1',
  title: 'פיתוח מערכת',
  official_url: 'https://data.gov.il/dataset/x',
};

describe('ingest task', () => {
  it('upserts normalized tenders with content hash (idempotent on rerun)', async () => {
    const { deps, fake } = workerDeps();
    const adapter = adapterWith([TENDER]);
    const res = await runIngest(deps, adapter);
    expect(res?.status).toBe('ok');
    expect(fake.tenders.size).toBe(1);
    expect(fake.tenders.get('datagov_beersheva|T-1')!.content_hash).toBeTruthy();

    // second run same day: skipped by pipeline_runs idempotency
    const again = await runIngest(deps, adapter);
    expect(again).toBeNull();
    expect(fake.tenders.size).toBe(1);
  });
});

describe('classify task', () => {
  it('classifies unclassified tenders and enforces the daily budget (AC-25)', async () => {
    const { deps, fake, alerts } = workerDeps({ llmDailyBudgetTokens: 15 });
    await runIngest(deps, adapterWith([TENDER, { ...TENDER, source_tender_id: 'T-2', title: 'אתר' }]));
    const res = await runClassify(deps);
    expect(res?.status).toBe('partial'); // budget exhausted mid-batch
    expect(alerts.alerts.length).toBeGreaterThan(0);
    expect(fake.classifications.length).toBeGreaterThan(0);
  });
});

describe('digest build + send', () => {
  it('builds a digest from eligible tenders and sends once per subscriber (AC-26)', async () => {
    const { deps, fake, sent } = workerDeps();
    await runIngest(deps, adapterWith([TENDER]));
    await runClassify(deps);
    // active subscriber
    const sub = await fake.db.createPendingSubscriber({ email: 'u@u.com' });
    await fake.db.confirmSubscriber(sub.id);

    const build = await runDigestBuild(deps);
    expect(build?.status).toBe('ok');
    const today = '2026-01-18';
    const digest = await fake.db.getDigestByDate(today);
    expect(digest?.item_count).toBe(1);

    const send = await runDigestSend(deps);
    expect(send?.status).toBe('ok');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const delivery = (await fake.db.listDeliveries(digest!.id))[0]!;
    expect(delivery.status).toBe('sent');

    // re-running send is idempotent — nothing queued left
    const resend = await runDigestSend(deps);
    expect(resend).toBeNull(); // run recorded already today
    expect(sent).toHaveLength(1);
  });
});

describe('housekeeping', () => {
  it('purges stale pendings and ends expired pilots', async () => {
    const { deps, fake } = workerDeps();
    const old = await fake.db.createPendingSubscriber({ email: 'old@o.com' });
    old.created_at = new Date(NOW.getTime() - 8 * 24 * 3600 * 1000).toISOString();
    const pilot = await fake.db.createPendingSubscriber({ email: 'p@p.com', pilotEndsAt: new Date(NOW.getTime() - 1000) });
    await fake.db.confirmSubscriber(pilot.id);

    const res = await runHousekeeping(deps);
    expect(res?.status).toBe('ok');
    expect(res?.counts['purged_pending']).toBe(1);
    expect(res?.counts['pilots_ended']).toBe(1);
  });
});

describe('tick dispatch', () => {
  it('runs only tasks inside their Jerusalem window', async () => {
    const { deps } = workerDeps();
    deps.adapters['datagov_beersheva'] = adapterWith([]);
    const alerts = new MemoryAlertSink();
    // 2026-01-18 is Sunday; 03:00 UTC = 05:00 JLM (winter) -> ingest window
    const at0500 = await runTick(deps, alerts, new Date('2026-01-18T03:00:00Z'));
    expect(at0500).toEqual(['ingest_datagov_beersheva']);
    // classify window 06:00 JLM = 04:00 UTC
    const at0600 = await runTick(deps, alerts, new Date('2026-01-18T04:00:00Z'));
    expect(at0600).toEqual(['classify']);
  });
});
