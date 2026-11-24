import type {
  Db,
  GuardedHttp,
  LlmProvider,
  Logger,
  SourceAdapter,
  SourceId,
  TokenSecrets,
} from '@michrazon/core';
import type { RunRecorder } from '@michrazon/ops';
import type { SuppressionAwareSender } from '@michrazon/mail';

// Everything a task needs; built once in main.ts (prod) or per-test.

export interface WorkerDeps {
  db: Db;
  http: GuardedHttp;
  adapters: Partial<Record<SourceId, SourceAdapter>>;
  llm: LlmProvider;
  sender: SuppressionAwareSender;
  recorder: RunRecorder;
  secrets: TokenSecrets;
  /** Digest rendering inputs. */
  appBaseUrl: string;
  unsubscribeMailto: string;
  publisherBlock: string;
  attributionBySource: (sourceId: SourceId) => Promise<string>;
  llmDailyBudgetTokens: number;
  relevanceThreshold: number;
  log: Logger;
  now(): Date;
}

export const consoleLogger: Logger = {
  debug: (msg, meta) => console.debug(msg, meta ?? ''),
  info: (msg, meta) => console.info(msg, meta ?? ''),
  warn: (msg, meta) => console.warn(msg, meta ?? ''),
  error: (msg, meta) => console.error(msg, meta ?? ''),
};
