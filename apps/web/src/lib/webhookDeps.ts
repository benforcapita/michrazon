import { loadConfig } from '@michrazon/core';
import type { WebhookDeps } from './webhooks';
import { getWebDeps } from './deps';

let cached: WebhookDeps | null = null;

export function getWebhookDeps(env: Record<string, string | undefined> = process.env): WebhookDeps {
  if (cached) return cached;
  const cfg = loadConfig(env);
  const { db } = getWebDeps(env);
  cached = {
    db,
    resendWebhookSecret: cfg.resendWebhookSecret,
    billingWebhookSecret: cfg.billingWebhookSecret,
    isBillingEnabled: async () => (await db.getSetting('billing_enabled')) === true,
    internalHealthToken: cfg.internalHealthToken,
  };
  return cached;
}
