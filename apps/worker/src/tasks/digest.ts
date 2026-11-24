import { createToken, jerusalemDate, type SourceId } from '@michrazon/core';
import {
  digestHeaders,
  digestSubject,
  renderDigestHtml,
  renderDigestText,
  type DigestItemView,
} from '@michrazon/mail';
import type { RunResult } from '@michrazon/ops';
import type { WorkerDeps } from '../deps';

const MAX_SEND_ATTEMPTS = 3;

const sourceLabel = (id: string): string =>
  id === 'datagov_beersheva' ? 'data.gov.il (נתונים פתוחים)' : 'mr.gov.il (רישום מכרזים)';

const heDate = (ymd: string): string => ymd.split('-').reverse().join('.');

/** Build today's digest from tenders first seen since the last sent digest. */
export async function runDigestBuild(deps: WorkerDeps): Promise<RunResult | null> {
  return deps.recorder.runOnce('digest', null, async (): Promise<RunResult> => {
    const today = jerusalemDate(deps.now());
    if (await deps.db.getDigestByDate(today)) {
      return { status: 'ok', counts: { items: 0, already_built: 1 } };
    }
    const since = (await deps.db.lastSentDigestDate()) ?? '1970-01-01';
    const tenders = await deps.db.listTendersFirstSeenSince(new Date(`${since}T00:00:00Z`));
    const eligible = await deps.db.listDigestEligible(
      tenders.map((t) => t.id),
      deps.relevanceThreshold,
    );

    const digest = await deps.db.createDigest(today);
    await deps.db.replaceDigestItems(
      digest.id,
      eligible.map((e, i) => ({
        tender_id: e.tender.id,
        classification_id: e.classification.id,
        position: i,
      })),
    );
    let queued = 0;
    for (const sub of await deps.db.listDeliverableSubscribers(deps.now())) {
      await deps.db.queueDelivery(digest.id, sub.id);
      queued += 1;
    }
    return { status: 'ok', counts: { items: eligible.length, queued } };
  }, 'build');
}

async function sendDeliveries(
  deps: WorkerDeps,
  statuses: { queuedOnly?: boolean; failedRetry?: boolean },
): Promise<RunResult> {
  const today = jerusalemDate(deps.now());
  const digest = await deps.db.getDigestByDate(today);
  if (!digest) return { status: 'ok', counts: { sent: 0, no_digest: 1 } };

  const items = await deps.db.getDigestItems(digest.id);
  const eligible = await deps.db.listDigestEligible(
    items.map((i) => i.tender_id),
    deps.relevanceThreshold,
  );
  const views: DigestItemView[] = eligible.map((e) => ({
    title: e.tender.title,
    tender_id: e.tender.source_tender_id,
    publisher: e.tender.publisher ?? undefined,
    published: e.tender.published_at ?? undefined,
    deadline: e.tender.submission_deadline?.slice(0, 10),
    summary_he: e.classification.summary_he,
    official_url: e.tender.official_url,
    source_label: sourceLabel(e.tender.source_id),
  }));
  const attributions = [...new Set(eligible.map((e) => e.tender.source_id))];
  const attributionTexts: string[] = [];
  for (const sid of attributions) attributionTexts.push(await deps.attributionBySource(sid as SourceId));

  const dateHe = heDate(today);
  const deliveries = statuses.queuedOnly
    ? await deps.db.listDeliveries(digest.id, 'queued')
    : (await deps.db.listDeliveries(digest.id, 'failed')).filter(
        (d) => d.attempts < MAX_SEND_ATTEMPTS,
      );

  const counts: Record<string, number> = { sent: 0, failed: 0, skipped_suppressed: 0 };
  for (const delivery of deliveries) {
    const sub = await deps.db.getSubscriberById(delivery.subscriber_id);
    if (!sub || sub.status !== 'active') {
      await deps.db.markDelivery(digest.id, delivery.subscriber_id, { status: 'skipped_suppressed' });
      counts['skipped_suppressed'] = (counts['skipped_suppressed'] ?? 0) + 1;
      continue;
    }
    // Re-check suppression at send time (AC-17: race-safe, fail closed).
    const unsubToken = createToken({ sub: sub.id, act: 'unsubscribe', secrets: deps.secrets });
    const prefsToken = createToken({ sub: sub.id, act: 'prefs', secrets: deps.secrets });
    const unsubscribeUrl = `${deps.appBaseUrl}/api/unsubscribe?t=${encodeURIComponent(unsubToken)}`;
    const view = {
      date_he: dateHe,
      items: views,
      attributions: attributionTexts,
      unsubscribe_url: unsubscribeUrl,
      prefs_url: `${deps.appBaseUrl}/prefs?t=${encodeURIComponent(prefsToken)}`,
      publisher_block: deps.publisherBlock,
    };
    try {
      const res = await deps.sender.send({
        to: sub.email,
        subject: digestSubject(views.length, dateHe),
        html: renderDigestHtml(view),
        text: renderDigestText(view),
        headers: digestHeaders({ unsubscribeUrl, unsubscribeMailto: deps.unsubscribeMailto }),
      });
      if (res.sent) {
        await deps.db.markDelivery(digest.id, sub.id, {
          status: 'sent',
          resendMessageId: res.messageId,
          attempts: delivery.attempts + 1,
        });
        counts['sent'] = (counts['sent'] ?? 0) + 1;
      } else {
        await deps.db.markDelivery(digest.id, sub.id, {
          status: 'skipped_suppressed',
          attempts: delivery.attempts + 1,
        });
        counts['skipped_suppressed'] = (counts['skipped_suppressed'] ?? 0) + 1;
      }
    } catch (e) {
      await deps.db.markDelivery(digest.id, sub.id, {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
        attempts: delivery.attempts + 1,
      });
      counts['failed'] = (counts['failed'] ?? 0) + 1;
    }
  }
  return { status: (counts['failed'] ?? 0) > 0 ? 'partial' : 'ok', counts };
}

export async function runDigestSend(deps: WorkerDeps): Promise<RunResult | null> {
  return deps.recorder.runOnce('digest', null, () => sendDeliveries(deps, { queuedOnly: true }), 'send');
}

export async function runDigestRetry(deps: WorkerDeps): Promise<RunResult | null> {
  return deps.recorder.runOnce('digest', null, () => sendDeliveries(deps, { failedRetry: true }), 'retry');
}
