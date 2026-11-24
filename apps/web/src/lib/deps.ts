// Wiring for the real runtime (Next routes). Handlers take WebDeps so tests
// inject fakes; this module builds the production one from env + Postgres.

import { loadConfig, type TokenSecrets } from '@michrazon/core';
import { PostgresDb } from '@michrazon/db';
import { Pool } from 'pg';
import { ResendTransport, SuppressionAwareSender, renderConfirmHtml, renderConfirmText, CONFIRM_SUBJECT, confirmHeaders } from '@michrazon/mail';
import type { WebDeps } from './handlers';
import { createRateLimiter } from './rateLimit';

let cached: WebDeps | null = null;
let pool: Pool | null = null;

export function getWebDeps(env: Record<string, string | undefined> = process.env): WebDeps {
  if (cached) return cached;
  const cfg = loadConfig(env);
  if (!cfg.dbUrlWeb) throw new Error('DB_URL_WEB is required');
  if (!cfg.tokenHmacSecret) throw new Error('TOKEN_HMAC_SECRET is required');
  if (!cfg.appBaseUrl) throw new Error('APP_BASE_URL is required');

  const secrets: TokenSecrets = { [cfg.tokenHmacKid ?? 'k1']: cfg.tokenHmacSecret };
  pool = new Pool({ connectionString: cfg.dbUrlWeb });
  const db = new PostgresDb(pool);

  const sender = new SuppressionAwareSender({
    transport: new ResendTransport({
      apiKey: cfg.resendApiKey ?? '',
      from: `מכרזון <alerts@${cfg.sendingDomain ?? 'example.com'}>`,
      replyTo: cfg.replyTo,
      fetchImpl: async (url, init) => {
        const res = await globalThis.fetch(url, { method: init.method, headers: init.headers, body: init.body });
        return { status: res.status, json: () => res.json() as Promise<unknown> };
      },
    }),
    isSuppressed: async (email) => (await db.getSuppression(email.toLowerCase())) !== null,
  });

  cached = {
    db,
    secrets,
    baseUrl: cfg.appBaseUrl,
    rateLimiter: createRateLimiter(5, 60 * 60 * 1000), // 5 signups/IP/hour
    sendConfirmEmail: async (to, confirmUrl) => {
      await sender.send({
        to,
        subject: CONFIRM_SUBJECT,
        html: renderConfirmHtml({ confirm_url: confirmUrl }),
        text: renderConfirmText({ confirm_url: confirmUrl }),
        headers: confirmHeaders({
          unsubscribeUrl: `${cfg.appBaseUrl}/api/unsubscribe`,
        }),
      });
    },
  };
  return cached;
}
