import { jerusalemDate } from '@michrazon/core';
import type {
  Db,
  SubscriberRow,
  TenderRow,
  TenderClassificationRow,
  DigestRow,
  DigestItemRow,
  DigestDeliveryRow,
  PipelineRunRow,
  SourceRow,
  UpsertTenderInput,
} from '@michrazon/core';

/**
 * In-memory Db for handler/task tests. The subscriber/consent/suppression
 * surface is fully implemented; remaining methods are backed by simple
 * in-memory tables so worker tasks and E2E flows can run against it.
 */
export function makeFakeDb(opts?: { now?: () => Date }) {
  const subscribers: SubscriberRow[] = [];
  const consents: { subscriber_id: string; event: string }[] = [];
  const suppressions = new Map<string, string>();
  const sources = new Map<string, SourceRow>();
  const settings = new Map<string, unknown>();
  const tenders = new Map<string, TenderRow>(); // key: source|tenderId
  const classifications: TenderClassificationRow[] = [];
  const digests = new Map<string, DigestRow>(); // key: digest_date
  const digestItems = new Map<string, DigestItemRow[]>(); // key: digest_id
  const deliveries = new Map<string, DigestDeliveryRow>(); // key: digest|sub
  const runs: PipelineRunRow[] = [];
  const finishedRunDates = new Set<string>();
  const locks = new Set<string>();
  let seq = 0;
  let digestSeq = 0;
  let runSeq = 0;

  const id = (p: string) => `${p}-${++seq}`;
  const now = () => opts?.now?.() ?? new Date();
  const nowIso = () => now().toISOString();

  const db: Db = {
    async withTransaction(fn) {
      return fn(db);
    },
    async getSetting(key) {
      return settings.get(key) ?? null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
    },
    async getSource(sourceId) {
      return sources.get(sourceId) ?? null;
    },
    async listEnabledSources() {
      return [...sources.values()].filter((s) => s.enabled);
    },

    // ---- subscribers ----
    async findSubscriberByEmailNorm(emailNorm) {
      return subscribers.find((s) => s.email_norm === emailNorm) ?? null;
    },
    async getSubscriberById(sid) {
      return subscribers.find((s) => s.id === sid) ?? null;
    },
    async createPendingSubscriber(input) {
      const row: SubscriberRow = {
        id: id('sub'),
        email: input.email,
        email_norm: input.email.toLowerCase(),
        status: 'pending',
        plan: input.plan ?? 'pilot',
        pilot_ends_at: input.pilotEndsAt?.toISOString() ?? null,
        keywords: input.keywords ?? [],
        created_at: nowIso(),
        confirmed_at: null,
        ended_at: null,
      };
      subscribers.push(row);
      return row;
    },
    async updateSubscriberStatus(sid, status) {
      const s = subscribers.find((x) => x.id === sid);
      if (s) s.status = status;
    },
    async confirmSubscriber(sid) {
      const s = subscribers.find((x) => x.id === sid);
      if (s) {
        s.status = 'active';
        s.confirmed_at = nowIso();
      }
    },
    async updateSubscriberKeywords(sid, keywords) {
      const s = subscribers.find((x) => x.id === sid);
      if (s) s.keywords = keywords;
    },
    async appendConsent(input) {
      consents.push({ subscriber_id: input.subscriberId, event: input.event });
    },
    async listDeliverableSubscribers(now) {
      return subscribers.filter(
        (s) =>
          s.status === 'active' &&
          !suppressions.has(s.email_norm) &&
          (s.pilot_ends_at === null || new Date(s.pilot_ends_at) > now),
      );
    },
    async endExpiredPilots(now) {
      let n = 0;
      for (const s of subscribers) {
        if (s.status === 'active' && s.plan === 'pilot' && s.pilot_ends_at && new Date(s.pilot_ends_at) <= now) {
          s.status = 'cancelled';
          s.ended_at = nowIso();
          n += 1;
        }
      }
      return n;
    },
    async purgePendingOlderThan(cutoff) {
      let n = 0;
      for (let i = subscribers.length - 1; i >= 0; i -= 1) {
        const s = subscribers[i]!;
        if (s.status === 'pending' && new Date(s.created_at) < cutoff) {
          subscribers.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },

    // ---- suppression ----
    async getSuppression(emailNorm) {
      const reason = suppressions.get(emailNorm);
      return reason ? { email_norm: emailNorm, reason: reason as never } : null;
    },
    async upsertSuppression(emailNorm, reason) {
      suppressions.set(emailNorm, reason);
    },
    async deleteSuppression(emailNorm) {
      suppressions.delete(emailNorm);
    },

    // ---- tenders ----
    async upsertTender(input: UpsertTenderInput) {
      const key = `${input.source_id}|${input.source_tender_id}`;
      const existing = tenders.get(key);
      if (!existing) {
        const row: TenderRow = {
          id: id('tender'),
          source_id: input.source_id,
          source_tender_id: input.source_tender_id,
          title: input.title,
          publisher: input.publisher ?? null,
          published_at: input.published_at ?? null,
          submission_deadline: input.submission_deadline ?? null,
          official_url: input.official_url,
          open_data_fields: input.open_data_fields ?? null,
          content_hash: input.content_hash,
          first_seen_at: nowIso(),
          last_seen_at: nowIso(),
          retired_at: null,
        };
        tenders.set(key, row);
        return { tender: row, outcome: 'inserted' as const };
      }
      existing.last_seen_at = nowIso();
      if (existing.content_hash === input.content_hash) {
        return { tender: existing, outcome: 'unchanged' as const };
      }
      Object.assign(existing, {
        title: input.title,
        publisher: input.publisher ?? null,
        published_at: input.published_at ?? null,
        submission_deadline: input.submission_deadline ?? null,
        official_url: input.official_url,
        open_data_fields: input.open_data_fields ?? null,
        content_hash: input.content_hash,
      });
      return { tender: existing, outcome: 'updated' as const };
    },
    async getTenderByNaturalKey(sourceId, sourceTenderId) {
      return tenders.get(`${sourceId}|${sourceTenderId}`) ?? null;
    },
    async listTendersFirstSeenSince(since) {
      return [...tenders.values()].filter((t) => new Date(t.first_seen_at) >= since);
    },
    async listUnclassified(limit) {
      const classifiedHashes = new Set(
        classifications.map((c) => `${c.tender_id}|${c.input_hash}`),
      );
      return [...tenders.values()]
        .filter((t) => ![...classifiedHashes].some((k) => k.startsWith(`${t.id}|`)))
        .slice(0, limit);
    },
    async countNewTendersSince(sourceId, since) {
      return [...tenders.values()].filter(
        (t) => t.source_id === sourceId && new Date(t.first_seen_at) >= since,
      ).length;
    },

    // ---- classifications ----
    async insertClassification(row) {
      const c: TenderClassificationRow = { ...row, id: id('cls'), created_at: nowIso() };
      classifications.push(c);
      return c;
    },
    async listDigestEligible(tenderIds, threshold) {
      const out = [];
      for (const tid of tenderIds) {
        const tender = tenders.get([...tenders.values()].find((t) => t.id === tid)
          ? `${[...tenders.values()].find((t) => t.id === tid)!.source_id}|${[...tenders.values()].find((t) => t.id === tid)!.source_tender_id}`
          : '');
        const cls = [...classifications]
          .reverse()
          .find((c) => c.tender_id === tid && c.status === 'ok');
        if (tender && cls && cls.is_relevant && cls.confidence >= threshold && !cls.uncertain) {
          out.push({ tender, classification: cls });
        }
      }
      return out;
    },
    async sumClassificationTokensOnDate(_dateYmd) {
      return {
        input: classifications.reduce((a, c) => a + (c.input_tokens ?? 0), 0),
        output: classifications.reduce((a, c) => a + (c.output_tokens ?? 0), 0),
      };
    },

    // ---- digests & deliveries ----
    async getDigestByDate(digestDate) {
      return digests.get(digestDate) ?? null;
    },
    async createDigest(digestDate) {
      const existing = digests.get(digestDate);
      if (existing) return existing;
      const row: DigestRow = { id: id('digest'), digest_date: digestDate, built_at: nowIso(), item_count: 0 };
      digests.set(digestDate, row);
      void ++digestSeq;
      return row;
    },
    async replaceDigestItems(digestId, items) {
      digestItems.set(digestId, items.map((i) => ({ ...i, digest_id: digestId })));
      for (const d of digests.values()) if (d.id === digestId) d.item_count = items.length;
    },
    async getDigestItems(digestId) {
      return digestItems.get(digestId) ?? [];
    },
    async lastSentDigestDate() {
      const sent = [...deliveries.values()].filter((d) => d.status === 'sent');
      if (sent.length === 0) return null;
      const dates = [...digests.values()]
        .filter((d) => sent.some((s) => s.digest_id === d.id))
        .map((d) => d.digest_date)
        .sort();
      return dates.at(-1) ?? null;
    },
    async queueDelivery(digestId, subscriberId) {
      const key = `${digestId}|${subscriberId}`;
      if (!deliveries.has(key)) {
        deliveries.set(key, {
          digest_id: digestId,
          subscriber_id: subscriberId,
          status: 'queued',
          resend_message_id: null,
          error: null,
          attempts: 0,
          updated_at: nowIso(),
        });
      }
    },
    async listDeliveries(digestId, status) {
      return [...deliveries.values()].filter(
        (d) => d.digest_id === digestId && (!status || d.status === status),
      );
    },
    async markDelivery(digestId, subscriberId, patch) {
      const d = deliveries.get(`${digestId}|${subscriberId}`);
      if (d) {
        if (patch.status) d.status = patch.status;
        if (patch.resendMessageId !== undefined) d.resend_message_id = patch.resendMessageId;
        if (patch.error !== undefined) d.error = patch.error;
        if (patch.attempts !== undefined) d.attempts = patch.attempts;
        d.updated_at = nowIso();
      }
    },

    // ---- pipeline runs & locks ----
    async startRun(kind, sourceId = null) {
      const row: PipelineRunRow = {
        id: ++runSeq,
        kind,
        source_id: sourceId,
        status: 'running',
        started_at: nowIso(),
        finished_at: null,
        counts: {},
        error: null,
      };
      runs.push(row);
      return row.id;
    },
    async finishRun(runId, result) {
      const r = runs.find((x) => x.id === runId);
      if (r) {
        r.status = result.status;
        r.counts = result.counts ?? {};
        r.error = result.error ?? null;
        r.finished_at = nowIso();
        finishedRunDates.add(`${r.kind}|${r.source_id ?? ''}|${jerusalemDate(now())}`);
      }
    },
    async hasFinishedRunOnDate(kind, sourceId, dateYmd) {
      return finishedRunDates.has(`${kind}|${sourceId ?? ''}|${dateYmd}`);
    },
    async lastRunOfKind(kind, sourceId = null) {
      return [...runs].reverse().find((r) => r.kind === kind && r.source_id === sourceId) ?? null;
    },
    async tryAcquireSourceLock(sourceId) {
      if (locks.has(sourceId)) return false;
      locks.add(sourceId);
      return true;
    },
    async releaseSourceLock(sourceId) {
      locks.delete(sourceId);
    },
    async healthCheck() {
      return true;
    },
  };

  return {
    db,
    subscribers,
    consents,
    suppressions,
    sources,
    settings,
    tenders,
    classifications,
    digests,
    deliveries,
    runs,
    finishedRunDates,
    locks,
  };
}
