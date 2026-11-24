import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '@michrazon/db/testing';
import { startTestDb } from '@michrazon/db/testing';
import type { PostgresDb } from '@michrazon/db';

let t: TestDb;
let db: PostgresDb;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('Db port — subscribers, consent, suppression', () => {
  it('creates a pending subscriber, confirms, and appends consent', async () => {
    const sub = await db.createPendingSubscriber({ email: 'Test@Example.com' });
    expect(sub.status).toBe('pending');
    expect(sub.email_norm).toBe('test@example.com');
    await db.appendConsent({ subscriberId: sub.id, event: 'signup_submitted', textVersion: 'v1' });
    await db.confirmSubscriber(sub.id);
    const after = await db.getSubscriberById(sub.id);
    expect(after?.status).toBe('active');
    expect(after?.confirmed_at).not.toBeNull();
  });

  it('listDeliverableSubscribers excludes suppressed and expired pilots', async () => {
    const now = new Date();
    const active = await db.createPendingSubscriber({ email: 'deliver@x.com' });
    await db.confirmSubscriber(active.id);
    const suppressed = await db.createPendingSubscriber({ email: 'supp@x.com' });
    await db.confirmSubscriber(suppressed.id);
    await db.upsertSuppression('supp@x.com', 'unsubscribe');
    const expired = await db.createPendingSubscriber({
      email: 'expired@x.com',
      pilotEndsAt: new Date(now.getTime() - 86_400_000),
    });
    await db.confirmSubscriber(expired.id);

    const list = await db.listDeliverableSubscribers(now);
    const emails = list.map((s) => s.email_norm);
    expect(emails).toContain('deliver@x.com');
    expect(emails).not.toContain('supp@x.com');
    expect(emails).not.toContain('expired@x.com');
  });

  it('suppression upsert is idempotent and deletable', async () => {
    await db.upsertSuppression('re@x.com', 'unsubscribe');
    await db.upsertSuppression('re@x.com', 'unsubscribe');
    expect((await db.getSuppression('re@x.com'))?.reason).toBe('unsubscribe');
    await db.deleteSuppression('re@x.com');
    expect(await db.getSuppression('re@x.com')).toBeNull();
  });
});

describe('Db port — tenders, classifications, digests', () => {
  it('upsertTender: inserted -> unchanged -> updated', async () => {
    const base = {
      source_id: 'datagov_beersheva' as const,
      source_tender_id: 'BS-100',
      title: 'Website rebuild',
      official_url: 'https://data.gov.il/dataset/x/100',
      content_hash: 'h1',
    };
    const first = await db.upsertTender(base);
    expect(first.outcome).toBe('inserted');
    expect((await db.upsertTender(base)).outcome).toBe('unchanged');
    const third = await db.upsertTender({ ...base, content_hash: 'h2', title: 'Website rebuild v2' });
    expect(third.outcome).toBe('updated');
    expect(third.tender.id).toBe(first.tender.id);
  });

  it('classification + digest eligibility + delivery idempotency', async () => {
    const up = await db.upsertTender({
      source_id: 'datagov_beersheva',
      source_tender_id: 'BS-200',
      title: 'AI pilot',
      official_url: 'https://data.gov.il/dataset/x/200',
      content_hash: 'hc',
    });
    const unclassified = await db.listUnclassified(10);
    expect(unclassified.map((x) => x.id)).toContain(up.tender.id);

    const c = await db.insertClassification({
      tender_id: up.tender.id,
      input_hash: 'hc',
      model_id: 'test-model',
      prompt_version: 'v1',
      is_relevant: true,
      confidence: 0.9,
      category: 'ai_ml_automation',
      summary_he: 'סיכום',
      facts_used: ['title'],
      uncertain: false,
      status: 'ok',
      input_tokens: 10,
      output_tokens: 5,
    });
    expect((await db.listUnclassified(10)).map((x) => x.id)).not.toContain(up.tender.id);

    const eligible = await db.listDigestEligible([up.tender.id], 0.8);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.classification.id).toBe(c.id);

    const digest = await db.createDigest('2026-11-24');
    await db.replaceDigestItems(digest.id, [
      { tender_id: up.tender.id, classification_id: c.id, position: 1 },
    ]);
    const sub = await db.createPendingSubscriber({ email: 'd@x.com' });
    await db.confirmSubscriber(sub.id);
    await db.queueDelivery(digest.id, sub.id);
    await db.queueDelivery(digest.id, sub.id); // idempotent
    expect(await db.listDeliveries(digest.id)).toHaveLength(1);
    await db.markDelivery(digest.id, sub.id, { status: 'sent', resendMessageId: 'm1' });
    expect((await db.listDeliveries(digest.id, 'sent'))[0]!.resend_message_id).toBe('m1');
    expect(await db.lastSentDigestDate()).toBe('2026-11-24');
  });
});

describe('Db port — runs, locks, settings, transactions, health', () => {
  it('records pipeline runs and hasFinishedRunOnDate', async () => {
    const id = await db.startRun('ingest', 'datagov_beersheva');
    await db.finishRun(id, { status: 'ok', counts: { fetched: 3, new: 2 } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    expect(await db.hasFinishedRunOnDate('ingest', 'datagov_beersheva', today)).toBe(true);
    expect(await db.hasFinishedRunOnDate('ingest', 'mrgov_listing', today)).toBe(false);
    const last = await db.lastRunOfKind('ingest', 'datagov_beersheva');
    expect(last?.status).toBe('ok');
  });

  it('advisory lock is exclusive per source', async () => {
    expect(await db.tryAcquireSourceLock('datagov_beersheva')).toBe(true);
    expect(await db.tryAcquireSourceLock('datagov_beersheva')).toBe(false);
    await db.releaseSourceLock('datagov_beersheva');
    expect(await db.tryAcquireSourceLock('datagov_beersheva')).toBe(true);
    await db.releaseSourceLock('datagov_beersheva');
  });

  it('settings round-trip', async () => {
    await db.setSetting('relevance_threshold', 0.8);
    expect(await db.getSetting('relevance_threshold')).toBe(0.8);
  });

  it('withTransaction commits on success and rolls back on error', async () => {
    await db.withTransaction(async (tx) => {
      await tx.createPendingSubscriber({ email: 'tx-ok@x.com' });
    });
    expect(await db.findSubscriberByEmailNorm('tx-ok@x.com')).not.toBeNull();

    await expect(
      db.withTransaction(async (tx) => {
        await tx.createPendingSubscriber({ email: 'tx-fail@x.com' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.findSubscriberByEmailNorm('tx-fail@x.com')).toBeNull();
  });

  it('healthCheck', async () => {
    expect(await db.healthCheck()).toBe(true);
  });
});
