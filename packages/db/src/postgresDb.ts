// Postgres implementation of the W0 `Db` port (MZ-W1-A). The only place raw
// SQL lives in the codebase.

import type { Pool, PoolClient } from 'pg';
import type {
  ConsentEvent,
  Db,
  DeliveryStatus,
  DigestDeliveryRow,
  DigestEligibleItem,
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
  UpsertTenderInput,
  UpsertTenderOutcome,
} from '@michrazon/core';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export class PostgresDb implements Db {
  constructor(private readonly q: Queryable) {}

  static fromPool(pool: Pool): PostgresDb {
    return new PostgresDb(pool);
  }

  async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // If we already hold a client (nested call), reuse it; the outermost
    // withTransaction owns BEGIN/COMMIT.
    const isClient = 'release' in this.q;
    const client = isClient ? (this.q as PoolClient) : await (this.q as Pool).connect();
    try {
      if (!isClient) await client.query('begin');
      const tx = new PostgresDb(client);
      const result = await fn(tx);
      if (!isClient) await client.query('commit');
      return result;
    } catch (err) {
      if (!isClient) await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      if (!isClient) (client as PoolClient).release();
    }
  }

  // ---- settings ----
  async getSetting(key: string): Promise<unknown | null> {
    const r = await this.q.query<{ value: unknown }>('select value from settings where key = $1', [
      key,
    ]);
    return r.rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.q.query(
      'insert into settings(key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value',
      [key, JSON.stringify(value)],
    );
  }

  // ---- sources ----
  async getSource(id: string): Promise<SourceRow | null> {
    const r = await this.q.query<SourceRow>('select * from sources where id = $1', [id]);
    return r.rows[0] ?? null;
  }

  async listEnabledSources(): Promise<SourceRow[]> {
    const r = await this.q.query<SourceRow>('select * from sources where enabled order by id');
    return r.rows;
  }

  // ---- subscribers & consent ----
  async findSubscriberByEmailNorm(emailNorm: string): Promise<SubscriberRow | null> {
    const r = await this.q.query<SubscriberRow>(
      'select * from subscribers where email_norm = $1',
      [emailNorm.toLowerCase().trim()],
    );
    return r.rows[0] ?? null;
  }

  async getSubscriberById(id: string): Promise<SubscriberRow | null> {
    const r = await this.q.query<SubscriberRow>('select * from subscribers where id = $1', [id]);
    return r.rows[0] ?? null;
  }

  async createPendingSubscriber(input: {
    email: string;
    plan?: PlanType;
    pilotEndsAt?: Date | null;
    keywords?: string[];
  }): Promise<SubscriberRow> {
    const r = await this.q.query<SubscriberRow>(
      `insert into subscribers(email, plan, pilot_ends_at, keywords)
       values ($1, coalesce($2::plan_type, 'pilot'), $3, coalesce($4::text[], '{}'::text[]))
       returning *`,
      [input.email, input.plan ?? null, input.pilotEndsAt ?? null, input.keywords ?? null],
    );
    return r.rows[0]!;
  }

  async updateSubscriberStatus(id: string, status: SubscriberStatus): Promise<void> {
    const terminal = ['unsubscribed', 'cancelled', 'bounced', 'complained'].includes(status);
    await this.q.query(
      `update subscribers set status = $2::subscriber_status,
         ended_at = case when $3 then now() else ended_at end
       where id = $1`,
      [id, status, terminal],
    );
  }

  async confirmSubscriber(id: string): Promise<void> {
    await this.q.query(
      `update subscribers set status = 'active', confirmed_at = coalesce(confirmed_at, now())
       where id = $1`,
      [id],
    );
  }

  async updateSubscriberKeywords(id: string, keywords: string[]): Promise<void> {
    await this.q.query('update subscribers set keywords = $2::text[] where id = $1', [id, keywords]);
  }

  async appendConsent(input: {
    subscriberId: string;
    event: ConsentEvent;
    textVersion: string;
  }): Promise<void> {
    await this.q.query(
      'insert into consents(subscriber_id, event, text_version) values ($1, $2::consent_event, $3)',
      [input.subscriberId, input.event, input.textVersion],
    );
  }

  async endExpiredPilots(now: Date): Promise<number> {
    const r = await this.q.query(
      `update subscribers set status = 'cancelled', ended_at = now()
       where status = 'active' and plan = 'pilot' and pilot_ends_at is not null and pilot_ends_at <= $1`,
      [now.toISOString()],
    );
    return r.rowCount ?? 0;
  }

  async listDeliverableSubscribers(now: Date): Promise<SubscriberRow[]> {
    const r = await this.q.query<SubscriberRow>(
      `select * from subscribers s
       where s.status = 'active'
         and (s.plan <> 'pilot' or s.pilot_ends_at is null or s.pilot_ends_at > $1)
         and not exists (select 1 from suppressions x where x.email_norm = s.email_norm)
       order by s.created_at`,
      [now],
    );
    return r.rows;
  }

  async purgePendingOlderThan(cutoff: Date): Promise<number> {
    const r = await this.q.query(
      `delete from subscribers where status = 'pending' and created_at < $1`,
      [cutoff],
    );
    return r.rowCount ?? 0;
  }

  // ---- suppression ----
  async getSuppression(
    emailNorm: string,
  ): Promise<{ email_norm: string; reason: SuppressionReason } | null> {
    const r = await this.q.query<{ email_norm: string; reason: SuppressionReason }>(
      'select email_norm, reason from suppressions where email_norm = $1',
      [emailNorm.toLowerCase().trim()],
    );
    return r.rows[0] ?? null;
  }

  async upsertSuppression(emailNorm: string, reason: SuppressionReason): Promise<void> {
    await this.q.query(
      `insert into suppressions(email_norm, reason) values ($1, $2)
       on conflict (email_norm) do update set reason = excluded.reason`,
      [emailNorm.toLowerCase().trim(), reason],
    );
  }

  async deleteSuppression(emailNorm: string): Promise<void> {
    await this.q.query('delete from suppressions where email_norm = $1', [
      emailNorm.toLowerCase().trim(),
    ]);
  }

  // ---- tenders ----
  async upsertTender(
    input: UpsertTenderInput,
  ): Promise<{ tender: TenderRow; outcome: UpsertTenderOutcome }> {
    const existing = await this.getTenderByNaturalKey(input.source_id, input.source_tender_id);
    if (!existing) {
      const r = await this.q.query<TenderRow>(
        `insert into tenders(source_id, source_tender_id, title, publisher, published_at,
                             submission_deadline, official_url, open_data_fields, content_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) returning *`,
        [
          input.source_id,
          input.source_tender_id,
          input.title,
          input.publisher ?? null,
          input.published_at ?? null,
          input.submission_deadline ?? null,
          input.official_url,
          input.open_data_fields ? JSON.stringify(input.open_data_fields) : null,
          input.content_hash,
        ],
      );
      return { tender: r.rows[0]!, outcome: 'inserted' };
    }
    if (existing.content_hash === input.content_hash) {
      const r = await this.q.query<TenderRow>(
        'update tenders set last_seen_at = now() where id = $1 returning *',
        [existing.id],
      );
      return { tender: r.rows[0]!, outcome: 'unchanged' };
    }
    const r = await this.q.query<TenderRow>(
      `update tenders set title=$2, publisher=$3, published_at=$4, submission_deadline=$5,
         official_url=$6, open_data_fields=$7::jsonb, content_hash=$8, last_seen_at=now()
       where id = $1 returning *`,
      [
        existing.id,
        input.title,
        input.publisher ?? null,
        input.published_at ?? null,
        input.submission_deadline ?? null,
        input.official_url,
        input.open_data_fields ? JSON.stringify(input.open_data_fields) : null,
        input.content_hash,
      ],
    );
    return { tender: r.rows[0]!, outcome: 'updated' };
  }

  async getTenderByNaturalKey(
    sourceId: string,
    sourceTenderId: string,
  ): Promise<TenderRow | null> {
    const r = await this.q.query<TenderRow>(
      'select * from tenders where source_id = $1 and source_tender_id = $2',
      [sourceId, sourceTenderId],
    );
    return r.rows[0] ?? null;
  }

  async listTendersFirstSeenSince(since: Date): Promise<TenderRow[]> {
    const r = await this.q.query<TenderRow>(
      'select * from tenders where first_seen_at >= $1 and retired_at is null order by first_seen_at',
      [since],
    );
    return r.rows;
  }

  async listUnclassified(limit: number): Promise<TenderRow[]> {
    const r = await this.q.query<TenderRow>(
      `select * from tenders t
       where t.retired_at is null
         and not exists (
           select 1 from tender_classifications c
           where c.tender_id = t.id and c.input_hash = t.content_hash and c.status = 'ok')
       order by t.first_seen_at
       limit $1`,
      [limit],
    );
    return r.rows;
  }

  async countNewTendersSince(sourceId: string, since: Date): Promise<number> {
    const r = await this.q.query<{ n: string }>(
      'select count(*)::text as n from tenders where source_id = $1 and first_seen_at >= $2',
      [sourceId, since],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  // ---- classifications ----
  async insertClassification(
    row: Omit<TenderClassificationRow, 'id' | 'created_at'>,
  ): Promise<TenderClassificationRow> {
    const r = await this.q.query<TenderClassificationRow>(
      `insert into tender_classifications(
         tender_id, input_hash, model_id, prompt_version, is_relevant, confidence,
         category, summary_he, facts_used, uncertain, status, input_tokens, output_tokens)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13) returning *`,
      [
        row.tender_id,
        row.input_hash,
        row.model_id,
        row.prompt_version,
        row.is_relevant,
        row.confidence,
        row.category,
        row.summary_he,
        row.facts_used,
        row.uncertain,
        row.status,
        row.input_tokens,
        row.output_tokens,
      ],
    );
    return r.rows[0]!;
  }

  async sumClassificationTokensOnDate(dateYmd: string) {
    const r = await this.q.query(
      `select coalesce(sum(input_tokens),0)::int as input, coalesce(sum(output_tokens),0)::int as output
       from tender_classifications where created_at::date = $1::date`,
      [dateYmd],
    );
    const row = r.rows[0] as { input: number; output: number } | undefined;
    return { input: row?.input ?? 0, output: row?.output ?? 0 };
  }

  async listDigestEligible(tenderIds: string[], threshold: number): Promise<DigestEligibleItem[]> {
    if (tenderIds.length === 0) return [];
    const r = await this.q.query<{ tender: TenderRow; classification: TenderClassificationRow }>(
      `select
         row_to_json(t.*) as tender,
         row_to_json(c.*) as classification
       from tenders t
       join tender_classifications c
         on c.tender_id = t.id and c.input_hash = t.content_hash
       where t.id = any($1::uuid[])
         and c.status = 'ok'
         and c.is_relevant
         and not c.uncertain
         and c.confidence >= $2
       order by c.confidence desc`,
      [tenderIds, threshold],
    );
    return r.rows;
  }

  // ---- digests ----
  async getDigestByDate(digestDate: string): Promise<DigestRow | null> {
    const r = await this.q.query<DigestRow>('select * from digests where digest_date = $1', [
      digestDate,
    ]);
    return r.rows[0] ?? null;
  }

  async createDigest(digestDate: string): Promise<DigestRow> {
    const r = await this.q.query<DigestRow>(
      `insert into digests(digest_date, built_at) values ($1, now())
       on conflict (digest_date) do update set digest_date = excluded.digest_date
       returning *`,
      [digestDate],
    );
    return r.rows[0]!;
  }

  async replaceDigestItems(
    digestId: string,
    items: Omit<DigestItemRow, 'digest_id'>[],
  ): Promise<void> {
    await this.q.query('delete from digest_items where digest_id = $1', [digestId]);
    for (const item of items) {
      await this.q.query(
        'insert into digest_items(digest_id, tender_id, classification_id, position) values ($1,$2,$3,$4)',
        [digestId, item.tender_id, item.classification_id, item.position],
      );
    }
    await this.q.query('update digests set item_count = $2 where id = $1', [
      digestId,
      items.length,
    ]);
  }

  async getDigestItems(digestId: string): Promise<DigestItemRow[]> {
    const r = await this.q.query<DigestItemRow>(
      'select * from digest_items where digest_id = $1 order by position',
      [digestId],
    );
    return r.rows;
  }

  async lastSentDigestDate(): Promise<string | null> {
    const r = await this.q.query<{ d: string }>(
      `select max(digest_date)::text as d from digests g
       where exists (select 1 from digest_deliveries v
                     where v.digest_id = g.id and v.status = 'sent')`,
    );
    return r.rows[0]?.d ?? null;
  }

  // ---- deliveries ----
  async queueDelivery(digestId: string, subscriberId: string): Promise<void> {
    await this.q.query(
      `insert into digest_deliveries(digest_id, subscriber_id) values ($1, $2)
       on conflict (digest_id, subscriber_id) do nothing`,
      [digestId, subscriberId],
    );
  }

  async listDeliveries(digestId: string, status?: DeliveryStatus): Promise<DigestDeliveryRow[]> {
    if (status === undefined) {
      const r = await this.q.query<DigestDeliveryRow>(
        'select * from digest_deliveries where digest_id = $1',
        [digestId],
      );
      return r.rows;
    }
    const r = await this.q.query<DigestDeliveryRow>(
      'select * from digest_deliveries where digest_id = $1 and status = $2::delivery_status',
      [digestId, status],
    );
    return r.rows;
  }

  async markDelivery(
    digestId: string,
    subscriberId: string,
    patch: {
      status: DeliveryStatus;
      resendMessageId?: string;
      error?: string;
      attempts?: number;
    },
  ): Promise<void> {
    await this.q.query(
      `update digest_deliveries set status = $3::delivery_status,
         resend_message_id = coalesce($4, resend_message_id),
         error = coalesce($5, error),
         attempts = coalesce($6, attempts),
         updated_at = now()
       where digest_id = $1 and subscriber_id = $2`,
      [
        digestId,
        subscriberId,
        patch.status,
        patch.resendMessageId ?? null,
        patch.error ?? null,
        patch.attempts ?? null,
      ],
    );
  }

  // ---- pipeline runs ----
  async startRun(kind: RunKind, sourceId?: string | null, task?: string | null): Promise<number> {
    const r = await this.q.query<{ id: string }>(
      'insert into pipeline_runs(kind, source_id, task) values ($1::run_kind, $2, $3) returning id',
      [kind, sourceId ?? null, task ?? null],
    );
    return Number(r.rows[0]!.id);
  }

  async finishRun(
    id: number,
    result: { status: RunStatus; counts?: Record<string, number>; error?: string },
  ): Promise<void> {
    await this.q.query(
      `update pipeline_runs set status = $2::run_status, finished_at = now(),
         counts = coalesce($3::jsonb, counts), error = $4
       where id = $1`,
      [id, result.status, result.counts ? JSON.stringify(result.counts) : null, result.error ?? null],
    );
  }

  async hasFinishedRunOnDate(
    kind: RunKind,
    sourceId: string | null,
    dateYmd: string,
    task?: string | null,
  ): Promise<boolean> {
    const r = await this.q.query<{ exists: boolean }>(
      `select exists(
         select 1 from pipeline_runs
         where kind = $1::run_kind
           and source_id is not distinct from $2
           and task is not distinct from $4
           and finished_at is not null
           and status <> 'failed'
           and (finished_at at time zone 'Asia/Jerusalem')::date = $3::date
       ) as exists`,
      [kind, sourceId, dateYmd, task ?? null],
    );
    return r.rows[0]?.exists ?? false;
  }

  async lastRunOfKind(kind: RunKind, sourceId?: string | null): Promise<PipelineRunRow | null> {
    const r = await this.q.query<PipelineRunRow>(
      `select * from pipeline_runs
       where kind = $1::run_kind and source_id is not distinct from $2
       order by started_at desc limit 1`,
      [kind, sourceId ?? null],
    );
    return r.rows[0] ?? null;
  }

  // ---- advisory lock ----
  // Session-level pg advisory lock requires holding a dedicated client.
  private readonly locks = new Map<string, PoolClient>();

  async tryAcquireSourceLock(sourceId: string): Promise<boolean> {
    if (this.locks.has(sourceId)) return false;
    const pool = this.q as Pool;
    if (!('connect' in pool)) {
      // Single-client Db (inside a transaction): can't hold a separate session.
      throw new Error('tryAcquireSourceLock requires a pool-backed Db');
    }
    const client = await pool.connect();
    const r = await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as ok',
      [`michrazon:${sourceId}`],
    );
    if (!r.rows[0]?.ok) {
      client.release();
      return false;
    }
    this.locks.set(sourceId, client);
    return true;
  }

  async releaseSourceLock(sourceId: string): Promise<void> {
    const client = this.locks.get(sourceId);
    if (!client) return;
    this.locks.delete(sourceId);
    try {
      await client.query('select pg_advisory_unlock(hashtext($1))', [`michrazon:${sourceId}`]);
    } finally {
      client.release();
    }
  }

  // ---- health ----
  async healthCheck(): Promise<boolean> {
    try {
      await this.q.query('select 1');
      return true;
    } catch {
      return false;
    }
  }
}
