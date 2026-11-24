import { describe, expect, it } from 'vitest';
import { createToken, type TokenSecrets } from '@michrazon/core';
import {
  handleConfirm,
  handlePrefs,
  handleSubscribe,
  handleUnsubscribe,
  type WebDeps,
} from '../../apps/web/src/lib/handlers';
import { createRateLimiter } from '../../apps/web/src/lib/rateLimit';
import { makeFakeDb } from '../helpers/fakeDb';

const SECRETS: TokenSecrets = { k1: 'test-secret' };

function deps(overrides?: Partial<WebDeps>) {
  const fake = makeFakeDb();
  const sent: { to: string; url: string }[] = [];
  const d: WebDeps = {
    db: fake.db,
    secrets: SECRETS,
    baseUrl: 'https://michrazon.example',
    rateLimiter: createRateLimiter(5, 60_000),
    sendConfirmEmail: async (to, url) => {
      sent.push({ to, url });
    },
    ...overrides,
  };
  return { d, fake, sent };
}

describe('POST /api/subscribe', () => {
  it('creates a pending subscriber and sends a confirm email (AC-13)', async () => {
    const { d, fake, sent } = deps();
    const res = await handleSubscribe({ method: 'POST', body: { email: 'User@Example.com' } }, d);
    expect(res.status).toBe(200);
    expect(fake.subscribers).toHaveLength(1);
    expect(fake.subscribers[0]!.status).toBe('pending');
    expect(fake.subscribers[0]!.email_norm).toBe('user@example.com');
    expect(fake.consents[0]!.event).toBe('signup_submitted');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('/confirm?t=');
  });

  it('answers uniformly for honeypot, invalid email, existing active, and complaint-suppressed', async () => {
    const { d, fake } = deps();
    const a = await handleSubscribe({ method: 'POST', body: { email: 'x@x.com', website: 'spam' } }, d);
    const b = await handleSubscribe({ method: 'POST', body: { email: 'not-an-email' } }, d);
    fake.subscribers.push({
      id: 's1', email: 'a@b.com', email_norm: 'a@b.com', status: 'active', plan: 'pilot',
      pilot_ends_at: null, keywords: [], created_at: '', confirmed_at: null, ended_at: null,
    });
    const c = await handleSubscribe({ method: 'POST', body: { email: 'a@b.com' } }, d);
    fake.suppressions.set('c@c.com', 'complaint');
    const e = await handleSubscribe({ method: 'POST', body: { email: 'c@c.com' } }, d);
    for (const r of [a, b, c, e]) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ message: 'אם הכתובת קיימת, נשלח מייל אישור.' });
    }
    expect(fake.subscribers).toHaveLength(1); // no new rows written
  });

  it('rate limits repeated signups from the same client key', async () => {
    const { d, fake } = deps();
    const req = () => ({ method: 'POST', body: { email: 'n@n.com' }, clientKey: 'k' });
    for (let i = 0; i < 5; i += 1) await handleSubscribe(req(), d);
    fake.subscribers.length = 0;
    await handleSubscribe(req(), d); // 6th — limited, but uniform 200
    expect(fake.subscribers).toHaveLength(0);
  });

  it('never sets cookies in any response (AC-12)', async () => {
    const { d } = deps();
    const res = await handleSubscribe({ method: 'POST', body: { email: 'a@a.com' } }, d);
    expect(res.headers?.['set-cookie']).toBeUndefined();
  });
});

describe('confirm + unsubscribe + prefs', () => {
  async function signup(d: WebDeps, fake: ReturnType<typeof makeFakeDb>) {
    await handleSubscribe({ method: 'POST', body: { email: 'u@u.com' } }, d);
    return fake.subscribers[0]!;
  }

  it('confirms via POST with a valid token; wrong act is rejected (AC-14)', async () => {
    const { d, fake } = deps();
    const sub = await signup(d, fake);
    const bad = createToken({ sub: sub.id, act: 'unsubscribe', secrets: SECRETS });
    const denied = await handleConfirm({ method: 'POST', body: { t: bad } }, d);
    expect(denied.status).toBe(400);
    expect(fake.subscribers[0]!.status).toBe('pending');

    const good = createToken({ sub: sub.id, act: 'confirm', secrets: SECRETS });
    const ok = await handleConfirm({ method: 'POST', body: { t: good } }, d);
    expect(ok.status).toBe(200);
    expect(fake.subscribers[0]!.status).toBe('active');
    expect(fake.consents.at(-1)!.event).toBe('confirmed');
  });

  it('unsubscribes in one transaction: status + suppression + consent (AC-16)', async () => {
    const { d, fake } = deps();
    const sub = await signup(d, fake);
    const token = createToken({ sub: sub.id, act: 'unsubscribe', secrets: SECRETS });
    const res = await handleUnsubscribe({ method: 'POST', body: { t: token } }, d);
    expect(res.status).toBe(200);
    expect(fake.subscribers[0]!.status).toBe('unsubscribed');
    expect(fake.suppressions.get('u@u.com')).toBe('unsubscribe');
    expect(fake.consents.at(-1)!.event).toBe('unsubscribed');
  });

  it('unsubscribe token never expires (AC: no TTL)', async () => {
    const { d, fake } = deps();
    const sub = await signup(d, fake);
    const token = createToken({
      sub: sub.id, act: 'unsubscribe', secrets: SECRETS, now: Date.now() - 10 * 365 * 24 * 3600 * 1000,
    });
    const res = await handleUnsubscribe({ method: 'POST', body: { t: token } }, d);
    expect(res.status).toBe(200);
  });

  it('updates keywords via prefs token only', async () => {
    const { d, fake } = deps();
    const sub = await signup(d, fake);
    const wrong = createToken({ sub: sub.id, act: 'confirm', secrets: SECRETS });
    expect((await handlePrefs({ method: 'POST', body: { t: wrong, keywords: ['a'] } }, d)).status).toBe(400);
    const token = createToken({ sub: sub.id, act: 'prefs', secrets: SECRETS });
    const res = await handlePrefs({ method: 'POST', body: { t: token, keywords: ['devops', 'ai'] } }, d);
    expect(res.status).toBe(200);
    expect(fake.subscribers[0]!.keywords).toEqual(['devops', 'ai']);
  });
});
