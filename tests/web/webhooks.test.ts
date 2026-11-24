import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  handleBillingWebhook,
  handleHealth,
  handleResendWebhook,
  verifySvixSignature,
  type WebhookDeps,
} from '../../apps/web/src/lib/webhooks';
import { makeFakeDb } from '../helpers/fakeDb';

const SECRET_RAW = Buffer.from('test-wh-secret');

function svixHeaders(body: string, now = Date.now()): Record<string, string> {
  const id = 'msg_1';
  const ts = String(Math.floor(now / 1000));
  const sig = createHmac('sha256', SECRET_RAW).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

function deps(overrides?: Partial<WebhookDeps>) {
  const fake = makeFakeDb();
  const d: WebhookDeps = {
    db: fake.db,
    resendWebhookSecret: `whsec_${SECRET_RAW.toString('base64')}`,
    isBillingEnabled: async () => false,
    internalHealthToken: 'internal-tok',
    ...overrides,
  };
  return { d, fake };
}

describe('svix signature', () => {
  it('verifies a valid signature and rejects a forged one', () => {
    const body = '{"type":"email.bounced"}';
    const h = svixHeaders(body);
    expect(
      verifySvixSignature({
        secret: `whsec_${SECRET_RAW.toString('base64')}`,
        msgId: h['svix-id']!,
        timestamp: h['svix-timestamp']!,
        signatures: h['svix-signature']!,
        body,
      }),
    ).toBe(true);
    expect(
      verifySvixSignature({
        secret: `whsec_${SECRET_RAW.toString('base64')}`,
        msgId: h['svix-id']!,
        timestamp: h['svix-timestamp']!,
        signatures: 'v1,forged',
        body,
      }),
    ).toBe(false);
  });
});

describe('POST /api/webhooks/resend (AC-19)', () => {
  it('writes suppression + status + consent for bounce', async () => {
    const { d, fake } = deps();
    fake.subscribers.push({
      id: 's1', email: 'u@u.com', email_norm: 'u@u.com', status: 'active', plan: 'pilot',
      pilot_ends_at: null, keywords: [], created_at: '', confirmed_at: null, ended_at: null,
    });
    const body = JSON.stringify({ type: 'email.bounced', data: { email: 'u@u.com' } });
    const res = await handleResendWebhook(
      { method: 'POST', body: JSON.parse(body), rawBody: body, headers: svixHeaders(body) },
      d,
    );
    expect(res.status).toBe(200);
    expect(fake.suppressions.get('u@u.com')).toBe('bounce');
    expect(fake.subscribers[0]!.status).toBe('bounced');
    expect(fake.consents.at(-1)!.event).toBe('bounced');
  });

  it('suppresses on complaint', async () => {
    const { d, fake } = deps();
    const body = JSON.stringify({ type: 'email.complained', data: { email: 'c@c.com' } });
    await handleResendWebhook(
      { method: 'POST', body: JSON.parse(body), rawBody: body, headers: svixHeaders(body) },
      d,
    );
    expect(fake.suppressions.get('c@c.com')).toBe('complaint');
  });

  it('ignores opened/clicked/delivered with no writes', async () => {
    const { d, fake } = deps();
    for (const type of ['email.opened', 'email.clicked', 'email.delivered']) {
      const body = JSON.stringify({ type, data: { email: 'x@x.com' } });
      const res = await handleResendWebhook(
        { method: 'POST', body: JSON.parse(body), rawBody: body, headers: svixHeaders(body) },
        d,
      );
      expect(res.status).toBe(200);
    }
    expect(fake.suppressions.size).toBe(0);
    expect(fake.consents).toHaveLength(0);
  });

  it('rejects an invalid signature', async () => {
    const { d } = deps();
    const body = JSON.stringify({ type: 'email.bounced', data: { email: 'u@u.com' } });
    const res = await handleResendWebhook(
      { method: 'POST', body: JSON.parse(body), rawBody: body, headers: { 'svix-id': 'm', 'svix-timestamp': '1', 'svix-signature': 'v1,bad' } },
      d,
    );
    expect(res.status).toBe(401);
  });
});

describe('billing webhook gate (AC-22)', () => {
  it('404s while billing_enabled=false', async () => {
    const { d } = deps();
    const res = await handleBillingWebhook({ method: 'POST' }, d);
    expect(res.status).toBe(404);
  });

  it('is a signed stub once the gate opens', async () => {
    const { d } = deps({ isBillingEnabled: async () => true, billingWebhookSecret: 's' });
    expect((await handleBillingWebhook({ method: 'POST' }, d)).status).toBe(401);
    expect(
      (await handleBillingWebhook({ method: 'POST', headers: { 'x-webhook-signature': 'x' } }, d)).status,
    ).toBe(501);
  });
});

describe('GET /api/health', () => {
  it('404s without the internal token; reports db status with it', async () => {
    const { d, fake } = deps();
    expect((await handleHealth({ method: 'GET', query: {} }, d)).status).toBe(404);
    fake.db.healthCheck = async () => true;
    const res = await handleHealth({ method: 'GET', query: { token: 'internal-tok' } }, d);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ db: true });
  });
});
