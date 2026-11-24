// AC-20 on the real Postgres port: unique(email_norm) is enforced here, unlike
// the in-memory fake.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToken, type TokenSecrets } from '@michrazon/core';
import type { TestDb } from '@michrazon/db/testing';
import { startTestDb } from '@michrazon/db/testing';
import {
  handleConfirm,
  handleSubscribe,
  handleUnsubscribe,
  type WebDeps,
} from '../../apps/web/src/lib/handlers';
import { createRateLimiter } from '../../apps/web/src/lib/rateLimit';

const SECRETS: TokenSecrets = { k1: 'test-secret' };
const UNIFORM = { message: 'אם הכתובת קיימת, נשלח מייל אישור.' };

let t: TestDb;
let sent: { to: string; url: string }[];
let d: WebDeps;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);

afterAll(async () => {
  await t.stop();
});

function freshDeps(): WebDeps {
  sent = [];
  d = {
    db: t.db,
    secrets: SECRETS,
    baseUrl: 'https://michrazon.example',
    rateLimiter: createRateLimiter(100, 60_000),
    sendConfirmEmail: async (to, url) => {
      sent.push({ to, url });
    },
  };
  return d;
}

const tokenFromUrl = (url: string): string => decodeURIComponent(url.split('t=')[1]!);

async function consentEvents(subscriberId: string): Promise<string[]> {
  const r = await t.pool.query<{ event: string }>(
    'select event from consents where subscriber_id = $1 order by id',
    [subscriberId],
  );
  return r.rows.map((x) => x.event);
}

async function subscribeConfirmUnsubscribe(email: string): Promise<string> {
  await handleSubscribe({ method: 'POST', body: { email } }, d);
  await handleConfirm({ method: 'POST', body: { t: tokenFromUrl(sent.at(-1)!.url) } }, d);
  const sub = (await t.db.findSubscriberByEmailNorm(email))!;
  const unsub = createToken({ sub: sub.id, act: 'unsubscribe', secrets: SECRETS });
  await handleUnsubscribe({ method: 'POST', body: { t: unsub } }, d);
  return sub.id;
}

describe('AC-20 resubscribe after unsubscribe (Postgres)', () => {
  it('reuses the row, starts a new double opt-in, and keeps the suppression until confirm', async () => {
    freshDeps();
    const id = await subscribeConfirmUnsubscribe('back@x.com');
    expect((await t.db.getSubscriberById(id))?.status).toBe('unsubscribed');
    expect((await t.db.getSuppression('back@x.com'))?.reason).toBe('unsubscribe');
    const mailsBefore = sent.length;

    const res = await handleSubscribe({ method: 'POST', body: { email: 'Back@X.com' } }, d);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(UNIFORM);

    const rows = await t.pool.query('select id from subscribers where email_norm = $1', [
      'back@x.com',
    ]);
    expect(rows.rows).toEqual([{ id }]);
    const pending = await t.db.getSubscriberById(id);
    expect(pending?.status).toBe('pending');
    expect(pending?.ended_at).toBeNull();
    expect(sent.length).toBe(mailsBefore + 1);
    expect(sent.at(-1)!.url).toContain('/confirm?t=');
    expect((await consentEvents(id)).at(-1)).toBe('resubscribe_requested');
    // Not released before the new confirm, and not deliverable.
    expect((await t.db.getSuppression('back@x.com'))?.reason).toBe('unsubscribe');
    const listPending = await t.db.listDeliverableSubscribers(new Date());
    expect(listPending.map((s) => s.id)).not.toContain(id);

    const conf = await handleConfirm(
      { method: 'POST', body: { t: tokenFromUrl(sent.at(-1)!.url) } },
      d,
    );
    expect(conf.status).toBe(200);
    expect((await t.db.getSubscriberById(id))?.status).toBe('active');
    expect(await t.db.getSuppression('back@x.com')).toBeNull();
    const list = await t.db.listDeliverableSubscribers(new Date());
    expect(list.map((s) => s.id)).toContain(id);
    expect(await consentEvents(id)).toEqual([
      'signup_submitted',
      'confirmed',
      'unsubscribed',
      'resubscribe_requested',
      'confirmed',
    ]);
  });

  it('an old confirm token cannot reactivate an unsubscribed address', async () => {
    freshDeps();
    await handleSubscribe({ method: 'POST', body: { email: 'old-token@x.com' } }, d);
    const oldConfirm = tokenFromUrl(sent.at(-1)!.url);
    await handleConfirm({ method: 'POST', body: { t: oldConfirm } }, d);
    const sub = (await t.db.findSubscriberByEmailNorm('old-token@x.com'))!;
    const unsub = createToken({ sub: sub.id, act: 'unsubscribe', secrets: SECRETS });
    await handleUnsubscribe({ method: 'POST', body: { t: unsub } }, d);

    const res = await handleConfirm({ method: 'POST', body: { t: oldConfirm } }, d);
    expect(res.status).toBe(400);
    expect((await t.db.getSubscriberById(sub.id))?.status).toBe('unsubscribed');
    expect((await t.db.getSuppression('old-token@x.com'))?.reason).toBe('unsubscribe');
  });

  it('a complaint suppression is never released: no row change, no mail', async () => {
    freshDeps();
    const id = await subscribeConfirmUnsubscribe('angry@x.com');
    await t.db.upsertSuppression('angry@x.com', 'complaint');
    const mailsBefore = sent.length;

    const res = await handleSubscribe({ method: 'POST', body: { email: 'angry@x.com' } }, d);
    expect(res.body).toEqual(UNIFORM);
    expect(sent.length).toBe(mailsBefore);
    expect((await t.db.getSubscriberById(id))?.status).toBe('unsubscribed');
    expect((await t.db.getSuppression('angry@x.com'))?.reason).toBe('complaint');
    expect((await consentEvents(id)).at(-1)).toBe('unsubscribed');
  });

  it('a stale resubscribe request reverts to unsubscribed instead of deleting the row', async () => {
    freshDeps();
    const id = await subscribeConfirmUnsubscribe('stale@x.com');
    await handleSubscribe({ method: 'POST', body: { email: 'stale@x.com' } }, d);
    expect((await t.db.getSubscriberById(id))?.status).toBe('pending');

    await t.db.purgePendingOlderThan(new Date(Date.now() + 60_000));
    const after = await t.db.getSubscriberById(id);
    expect(after?.status).toBe('unsubscribed');
    expect(after?.ended_at).not.toBeNull();
    expect(await consentEvents(id)).toContain('resubscribe_requested');
    expect((await t.db.getSuppression('stale@x.com'))?.reason).toBe('unsubscribe');
  });
});
