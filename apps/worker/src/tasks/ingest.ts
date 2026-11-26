import { tenderContentHash } from '@michrazon/core';
import { MAX_SKIP_RATE, skipRate } from '@michrazon/ops';
import type { SourceAdapter } from '@michrazon/core';
import type { WorkerDeps } from '../deps.ts';
import type { RunResult } from '@michrazon/ops';

export async function runIngest(deps: WorkerDeps, adapter: SourceAdapter): Promise<RunResult | null> {
  return deps.recorder.runOnce('ingest', adapter.id, async () => {
    const counts: Record<string, number> = {
      inserted: 0, updated: 0, unchanged: 0, emitted: 0, skipped: 0,
    };
    const ctx = { http: deps.http, now: deps.now, log: deps.log };
    for await (const t of adapter.fetchSince(ctx, new Date(0))) {
      const { outcome } = await deps.db.upsertTender({
        source_id: t.source_id,
        source_tender_id: t.source_tender_id,
        title: t.title,
        publisher: t.publisher ?? null,
        published_at: t.published_at ?? null,
        submission_deadline: t.submission_deadline ?? null,
        official_url: t.official_url,
        open_data_fields: t.open_data_fields ?? null,
        content_hash: tenderContentHash({ ...t, open_data_fields: t.open_data_fields ?? null }),
      });
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    counts['emitted'] = adapter.counts.emitted;
    counts['skipped'] = adapter.counts.skipped;

    // §13: >30% skipped = structural change -> failed + alert.
    if (skipRate(adapter.counts) > MAX_SKIP_RATE) {
      return {
        status: 'failed',
        counts,
        error: `skip rate ${(skipRate(adapter.counts) * 100).toFixed(0)}% exceeds ${MAX_SKIP_RATE * 100}% — source markup likely changed`,
      };
    }
    return { status: 'ok', counts };
  });
}
