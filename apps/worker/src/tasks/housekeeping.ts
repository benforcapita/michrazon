import type { RunResult } from '@michrazon/ops';
import { checkSourceStaleness } from '@michrazon/ops';
import type { WorkerDeps } from '../deps';
import type { AlertSink } from '@michrazon/ops';

const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;

/** Nightly 03:00 housekeeping: purge expired pendings, end expired pilots. */
export async function runHousekeeping(deps: WorkerDeps): Promise<RunResult | null> {
  return deps.recorder.runOnce('housekeeping', null, async () => {
    const purged = await deps.db.purgePendingOlderThan(
      new Date(deps.now().getTime() - PENDING_TTL_MS),
    );
    const cancelled = await deps.db.endExpiredPilots(deps.now());
    const dbOk = await deps.db.healthCheck();
    return {
      status: dbOk ? 'ok' : 'failed',
      counts: { purged_pending: purged, pilots_ended: cancelled, db_ok: dbOk ? 1 : 0 },
      error: dbOk ? undefined : 'db health check failed',
    };
  });
}

/** 08:45 daily: alert when a source produced nothing for 3 days. */
export async function runStalenessCheck(deps: WorkerDeps, alerts: AlertSink): Promise<RunResult | null> {
  return deps.recorder.runOnce('housekeeping', 'staleness', () =>
    checkSourceStaleness(deps.db, alerts, deps.now()).then((reports) => ({
      status: 'ok' as const,
      counts: { stale_sources: reports.filter((r) => r.stale).length },
    })),
  );
}
