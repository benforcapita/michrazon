#!/usr/bin/env node
// Michrazon worker entrypoint (Railway cron, every 30 min, Asia/Jerusalem).
// `node dist/index.js --once` runs a single tick — used by Railway cron and
// for the local dry-run smoke path.

import { GuardedHttpImpl, loadConfig, type SourceHttpLimits, type SourceId, type TokenSecrets } from '@michrazon/core';
import { PostgresDb } from '@michrazon/db';
import { DatagovBeershevaAdapter, MrGovListingAdapter } from '@michrazon/adapters';
import { EmailAlertSink, RunRecorder } from '@michrazon/ops';
import { ResendTransport, SuppressionAwareSender } from '@michrazon/mail';
import { Pool } from 'pg';
import { consoleLogger, type WorkerDeps } from './deps';
import { ChatCompletionsProvider } from './llmProvider';
import { runTick } from './tick';

const DEFAULT_SOURCE_LIMITS: Record<SourceId, SourceHttpLimits> = {
  datagov_beersheva: { minIntervalMs: 5_000, maxPerRun: 20 },
  mrgov_listing: { minIntervalMs: 10_000, jitterMs: 3_000, maxPerRun: 60 },
};

export function buildWorkerDeps(env: Record<string, string | undefined>): {
  deps: WorkerDeps;
  alerts: EmailAlertSink;
  close: () => Promise<void>;
} {
  const cfg = loadConfig(env);
  if (!cfg.dbUrlWorker) throw new Error('DB_URL_WORKER is required');
  if (!cfg.tokenHmacSecret) throw new Error('TOKEN_HMAC_SECRET is required');

  const pool = new Pool({ connectionString: cfg.dbUrlWorker });
  const db = new PostgresDb(pool);
  const secrets: TokenSecrets = { [cfg.tokenHmacKid ?? 'k1']: cfg.tokenHmacSecret };

  const fetchJson = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const res = await globalThis.fetch(url, { method: init.method, headers: init.headers, body: init.body });
    return { status: res.status, json: () => res.json() as Promise<unknown> };
  };

  const transport = new ResendTransport({
    apiKey: cfg.resendApiKey ?? '',
    from: `מכרזון <alerts@${cfg.sendingDomain ?? 'example.com'}>`,
    replyTo: cfg.replyTo,
    fetchImpl: fetchJson,
  });
  const sender = new SuppressionAwareSender({
    transport,
    isSuppressed: async (email) => (await db.getSuppression(email.toLowerCase())) !== null,
  });
  const alerts = new EmailAlertSink(
    transport,
    cfg.opsAlertTo ?? 'ops@example.com',
    `מכרזון ops <alerts@${cfg.sendingDomain ?? 'example.com'}>`,
  );

  const http = new GuardedHttpImpl({
    userAgent: `MichrazonBot/1.0 (+${cfg.uaProductUrl ?? 'https://example.com'}; contact: ${cfg.uaContact ?? 'contact@example.com'})`,
    limits: DEFAULT_SOURCE_LIMITS,
  });

  const deps: WorkerDeps = {
    db,
    http,
    adapters: {
      ...(cfg.datagovDatasetUrl || cfg.datagovResourceUrl || cfg.datagovResourceId
        ? {
            datagov_beersheva: new DatagovBeershevaAdapter({
              resourceId: cfg.datagovResourceId,
              resourceUrl: cfg.datagovResourceUrl,
              datasetUrl: cfg.datagovDatasetUrl ?? cfg.datagovResourceUrl ?? '',
            }),
          }
        : {}),
      ...(cfg.mrgovListingUrl
        ? {
            mrgov_listing: new MrGovListingAdapter({
              listingPageUrl: (p) =>
                cfg.mrgovListingUrl!.includes('{page}')
                  ? cfg.mrgovListingUrl!.replace('{page}', String(p))
                  : `${cfg.mrgovListingUrl}${cfg.mrgovListingUrl!.includes('?') ? '&' : '?'}page=${p}`,
            }),
          }
        : {}),
    },
    llm: new ChatCompletionsProvider({
      apiKey: cfg.llmApiKey ?? '',
      model: cfg.llmModel ?? 'gpt-4o-mini',
      fetchImpl: fetchJson,
      id: cfg.llmProvider ?? 'chat_completions',
    }),
    sender,
    recorder: new RunRecorder({ db, alerts, log: consoleLogger }),
    secrets,
    appBaseUrl: cfg.appBaseUrl ?? 'https://example.com',
    unsubscribeMailto: `unsubscribe@${cfg.sendingDomain ?? 'example.com'}`,
    publisherBlock: 'מכרזון',
    attributionBySource: async (sourceId) =>
      ((await db.getSource(sourceId))?.attribution_text ?? ''),
    llmDailyBudgetTokens: cfg.llmDailyBudget ?? 100_000,
    relevanceThreshold: 0.8,
    log: consoleLogger,
    now: () => new Date(),
  };
  return { deps, alerts, close: async () => pool.end() };
}

const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  const { deps, alerts, close } = buildWorkerDeps(process.env);
  try {
    const ran = await runTick(deps, alerts, deps.now());
    consoleLogger.info('tick complete', { ran });
  } finally {
    await close();
  }
}
