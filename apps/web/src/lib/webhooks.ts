import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '@michrazon/core';
import { json, type HandlerRequest, type HandlerResult } from './http';
import { CONSENT_TEXT_VERSION } from './handlers';

export interface WebhookDeps {
  db: Db;
  resendWebhookSecret?: string;
  billingWebhookSecret?: string;
  /** billing_enabled — checked per request (settings table is source of truth). */
  isBillingEnabled: () => Promise<boolean>;
  internalHealthToken?: string;
  now?: () => number;
}

// ---------- Svix-style signature verification (Resend webhooks) ----------

const TOLERANCE_MS = 5 * 60 * 1000;

export function verifySvixSignature(args: {
  secret: string;
  msgId: string;
  timestamp: string;
  signatures: string; // e.g. "v1,sig1 v1,sig2"
  body: string;
  now?: number;
}): boolean {
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = args.now ?? Date.now();
  if (Math.abs(now - ts * 1000) > TOLERANCE_MS) return false;

  // whsec_ secrets are base64 after the prefix.
  const secretBytes = args.secret.startsWith('whsec_')
    ? Buffer.from(args.secret.slice(6), 'base64')
    : Buffer.from(args.secret);
  const expected = createHmac('sha256', secretBytes)
    .update(`${args.msgId}.${args.timestamp}.${args.body}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected);
  return args.signatures
    .split(' ')
    .map((s) => s.split(','))
    .filter(([v]) => v === 'v1')
    .some(([, sig]) => {
      const sigBuf = Buffer.from(sig ?? '');
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    });
}

// ---------- Resend webhook: bounce/complaint only (AC-19) ----------

const resendEventSchema = z.object({
  type: z.string(),
  data: z.object({ email: z.string().optional() }).passthrough(),
});

export async function handleResendWebhook(
  req: HandlerRequest & { rawBody?: string },
  deps: WebhookDeps,
): Promise<HandlerResult> {
  if (deps.resendWebhookSecret) {
    const ok = verifySvixSignature({
      secret: deps.resendWebhookSecret,
      msgId: String(req.headers?.['svix-id'] ?? ''),
      timestamp: String(req.headers?.['svix-timestamp'] ?? ''),
      signatures: String(req.headers?.['svix-signature'] ?? ''),
      body: req.rawBody ?? JSON.stringify(req.body ?? {}),
      now: deps.now?.(),
    });
    if (!ok) return json(401, { error: 'invalid signature' });
  }

  const parsed = resendEventSchema.safeParse(req.body);
  if (!parsed.success) return json(400, { error: 'bad payload' });
  const { type, data } = parsed.data;

  // Only suppression events are processed; every other event type gets a
  // 200 with no writes (we are not subscribed to them, and must ignore
  // opened/clicked/delivered even if they arrive).
  if (type !== 'email.bounced' && type !== 'email.complained') {
    return json(200, { ignored: true });
  }
  const email = data.email;
  if (!email) return json(200, { ignored: true });

  const reason = type === 'email.bounced' ? 'bounce' : 'complaint';
  const norm = email.trim().toLowerCase();
  await deps.db.withTransaction(async (tx) => {
    await tx.upsertSuppression(norm, reason);
    const sub = await tx.findSubscriberByEmailNorm(norm);
    if (sub) {
      await tx.updateSubscriberStatus(sub.id, reason === 'bounce' ? 'bounced' : 'complained');
      await tx.appendConsent({
        subscriberId: sub.id,
        event: reason === 'bounce' ? 'bounced' : 'complained',
        textVersion: CONSENT_TEXT_VERSION,
      });
    }
  });
  return json(200, { ok: true });
}

// ---------- Billing webhook: 404 while the legal gate is closed ----------

export async function handleBillingWebhook(
  req: HandlerRequest,
  deps: WebhookDeps,
): Promise<HandlerResult> {
  if (!(await deps.isBillingEnabled())) {
    return json(404, { error: 'not found' });
  }
  // Paid mode is post-MVP; the gate being open means legal review cleared —
  // implementation lands with the billing milestone. Signature-verified stub.
  if (deps.billingWebhookSecret && !req.headers?.['x-webhook-signature']) {
    return json(401, { error: 'invalid signature' });
  }
  return json(501, { error: 'billing not implemented' });
}

// ---------- Health (internal token, coarse status) ----------

export async function handleHealth(
  req: HandlerRequest,
  deps: WebhookDeps,
): Promise<HandlerResult> {
  const token = req.query?.['token'] ?? req.headers?.['authorization']?.replace(/^Bearer /, '');
  if (!deps.internalHealthToken || token !== deps.internalHealthToken) {
    return json(404, { error: 'not found' });
  }
  const dbOk = await deps.db.healthCheck();
  return json(dbOk ? 200 : 503, { db: dbOk });
}
