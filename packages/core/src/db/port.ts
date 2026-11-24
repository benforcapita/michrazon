// The `Db` port (interface only — W0). The Postgres implementation lives in
// packages/db (MZ-W1-A). Web and worker code against this port; no raw SQL
// outside packages/db.

import type { SourceId } from '../types';
import type {
  ConsentEvent,
  DeliveryStatus,
  DigestDeliveryRow,
  DigestItemRow,
  DigestRow,
  PipelineRunRow,
  PlanType,
  RunKind,
  RunStatus,
  SourceRow,
  SubscriberRow,
  SubscriberStatus,
  SuppressionReason,
  TenderClassificationRow,
  TenderRow,
} from './rows';

export type UpsertTenderOutcome = 'inserted' | 'unchanged' | 'updated';

export interface UpsertTenderInput {
  source_id: SourceId;
  source_tender_id: string;
  title: string;
  publisher?: string | null;
  published_at?: string | null;
  submission_deadline?: string | null;
  official_url: string;
  open_data_fields?: Record<string, unknown> | null;
  content_hash: string;
}

export interface DigestEligibleItem {
  tender: TenderRow;
  classification: TenderClassificationRow;
}

export interface Db {
  /** Run `fn` inside a single DB transaction; commits on success, rolls back on throw. */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;

  // ---- settings / flags ----
  getSetting(key: string): Promise<unknown | null>;
  setSetting(key: string, value: unknown): Promise<void>;

  // ---- sources ----
  getSource(id: string): Promise<SourceRow | null>;
  listEnabledSources(): Promise<SourceRow[]>;

  // ---- subscribers & consent ----
  findSubscriberByEmailNorm(emailNorm: string): Promise<SubscriberRow | null>;
  getSubscriberById(id: string): Promise<SubscriberRow | null>;
  createPendingSubscriber(input: {
    email: string;
    plan?: PlanType;
    pilotEndsAt?: Date | null;
    keywords?: string[];
  }): Promise<SubscriberRow>;
  updateSubscriberStatus(id: string, status: SubscriberStatus): Promise<void>;
  confirmSubscriber(id: string): Promise<void>; // -> active + confirmed_at
  updateSubscriberKeywords(id: string, keywords: string[]): Promise<void>;
  appendConsent(input: {
    subscriberId: string;
    event: ConsentEvent;
    textVersion: string;
  }): Promise<void>;
  listDeliverableSubscribers(now: Date): Promise<SubscriberRow[]>; // active, pilot not expired
  /** Pilot ended -> cancelled. Returns rows cancelled (housekeeping, AC-23). */
  endExpiredPilots(now: Date): Promise<number>;
  purgePendingOlderThan(cutoff: Date): Promise<number>; // housekeeping

  // ---- suppression ----
  getSuppression(emailNorm: string): Promise<{ email_norm: string; reason: SuppressionReason } | null>;
  upsertSuppression(emailNorm: string, reason: SuppressionReason): Promise<void>;
  /** Removes suppression; only lawful for 'unsubscribe'/'cancel' reasons — caller re-checks. */
  deleteSuppression(emailNorm: string): Promise<void>;

  // ---- tenders ----
  upsertTender(input: UpsertTenderInput): Promise<{ tender: TenderRow; outcome: UpsertTenderOutcome }>;
  getTenderByNaturalKey(sourceId: string, sourceTenderId: string): Promise<TenderRow | null>;
  /** Tenders first seen since `since` (digest membership window, LLD §11). */
  listTendersFirstSeenSince(since: Date): Promise<TenderRow[]>;
  /** Tenders lacking an 'ok' classification for their current content hash. */
  listUnclassified(limit: number): Promise<TenderRow[]>;
  countNewTendersSince(sourceId: string, since: Date): Promise<number>;

  // ---- classifications ----
  insertClassification(
    row: Omit<TenderClassificationRow, 'id' | 'created_at'>,
  ): Promise<TenderClassificationRow>;
  /** Relevant, ok-status, confidence >= threshold, not uncertain — for digest build. */
  listDigestEligible(tenderIds: string[], threshold: number): Promise<DigestEligibleItem[]>;
  /** Token spend for the LLM daily budget (LLD §8.5) on a Jerusalem date. */
  sumClassificationTokensOnDate(dateYmd: string): Promise<{ input: number; output: number }>;

  // ---- digests ----
  getDigestByDate(digestDate: string): Promise<DigestRow | null>;
  createDigest(digestDate: string): Promise<DigestRow>; // unique on digest_date
  replaceDigestItems(digestId: string, items: Omit<DigestItemRow, 'digest_id'>[]): Promise<void>;
  getDigestItems(digestId: string): Promise<DigestItemRow[]>;
  lastSentDigestDate(): Promise<string | null>;

  // ---- deliveries (idempotency via PK (digest_id, subscriber_id)) ----
  queueDelivery(digestId: string, subscriberId: string): Promise<void>; // no-op if exists
  listDeliveries(digestId: string, status?: DeliveryStatus): Promise<DigestDeliveryRow[]>;
  markDelivery(
    digestId: string,
    subscriberId: string,
    patch: { status: DeliveryStatus; resendMessageId?: string; error?: string; attempts?: number },
  ): Promise<void>;

  // ---- pipeline runs ----
  startRun(kind: RunKind, sourceId?: string | null, task?: string | null): Promise<number>;
  finishRun(
    id: number,
    result: { status: RunStatus; counts?: Record<string, number>; error?: string },
  ): Promise<void>;
  /** Whether a run of `kind` (and optional source) already finished on `dateYmd` (Asia/Jerusalem). */
  hasFinishedRunOnDate(kind: RunKind, sourceId: string | null, dateYmd: string, task?: string | null): Promise<boolean>;
  lastRunOfKind(kind: RunKind, sourceId?: string | null): Promise<PipelineRunRow | null>;

  // ---- per-source advisory lock (LLD §7: no concurrent ingest per host) ----
  tryAcquireSourceLock(sourceId: string): Promise<boolean>;
  releaseSourceLock(sourceId: string): Promise<void>;

  // ---- health ----
  healthCheck(): Promise<boolean>;
}
