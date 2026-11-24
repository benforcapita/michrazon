import type {
  Db,
  SubscriberRow,
} from '@michrazon/core';

/** In-memory Db for web handler tests. Unused methods throw loudly. */
export function makeFakeDb() {
  const subscribers: SubscriberRow[] = [];
  const consents: { subscriber_id: string; event: string }[] = [];
  const suppressions = new Map<string, string>();
  let seq = 0;

  const unimplemented = (name: string) => () => {
    throw new Error(`fakeDb.${name} not implemented`);
  };

  const db: Db = {
    async withTransaction(fn) {
      return fn(db);
    },
    getSetting: unimplemented('getSetting'),
    setSetting: unimplemented('setSetting'),
    getSource: unimplemented('getSource'),
    listEnabledSources: unimplemented('listEnabledSources'),
    async findSubscriberByEmailNorm(emailNorm) {
      return subscribers.find((s) => s.email_norm === emailNorm) ?? null;
    },
    async getSubscriberById(id) {
      return subscribers.find((s) => s.id === id) ?? null;
    },
    async createPendingSubscriber(input) {
      seq += 1;
      const row: SubscriberRow = {
        id: `sub-${seq}`,
        email: input.email,
        email_norm: input.email.toLowerCase(),
        status: 'pending',
        plan: input.plan ?? 'pilot',
        pilot_ends_at: null,
        keywords: input.keywords ?? [],
        created_at: new Date().toISOString(),
        confirmed_at: null,
        ended_at: null,
      };
      subscribers.push(row);
      return row;
    },
    async updateSubscriberStatus(id, status) {
      const s = subscribers.find((x) => x.id === id);
      if (s) s.status = status;
    },
    async confirmSubscriber(id) {
      const s = subscribers.find((x) => x.id === id);
      if (s) {
        s.status = 'active';
        s.confirmed_at = new Date().toISOString();
      }
    },
    async updateSubscriberKeywords(id, keywords) {
      const s = subscribers.find((x) => x.id === id);
      if (s) s.keywords = keywords;
    },
    async appendConsent(input) {
      consents.push({ subscriber_id: input.subscriberId, event: input.event });
    },
    listDeliverableSubscribers: unimplemented('listDeliverableSubscribers'),
    purgePendingOlderThan: unimplemented('purgePendingOlderThan'),
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
    upsertTender: unimplemented('upsertTender'),
    getTenderByNaturalKey: unimplemented('getTenderByNaturalKey'),
    listTendersFirstSeenSince: unimplemented('listTendersFirstSeenSince'),
    listUnclassified: unimplemented('listUnclassified'),
    countNewTendersSince: unimplemented('countNewTendersSince'),
    insertClassification: unimplemented('insertClassification'),
    listDigestEligible: unimplemented('listDigestEligible'),
    getDigestByDate: unimplemented('getDigestByDate'),
    createDigest: unimplemented('createDigest'),
    replaceDigestItems: unimplemented('replaceDigestItems'),
    getDigestItems: unimplemented('getDigestItems'),
    lastSentDigestDate: unimplemented('lastSentDigestDate'),
    queueDelivery: unimplemented('queueDelivery'),
    listDeliveries: unimplemented('listDeliveries'),
    markDelivery: unimplemented('markDelivery'),
    startRun: unimplemented('startRun'),
    finishRun: unimplemented('finishRun'),
    hasFinishedRunOnDate: unimplemented('hasFinishedRunOnDate'),
    lastRunOfKind: unimplemented('lastRunOfKind'),
    tryAcquireSourceLock: unimplemented('tryAcquireSourceLock'),
    releaseSourceLock: unimplemented('releaseSourceLock'),
    healthCheck: unimplemented('healthCheck'),
  };

  return { db, subscribers, consents, suppressions };
}
