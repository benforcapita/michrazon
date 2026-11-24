import type { Db, Logger, RunKind } from '@michrazon/core';
import { jerusalemDate } from '@michrazon/core';
import type { AlertSink } from './alerts';

// Pipeline run recorder (LLD §13): every scheduled task is wrapped in a
// pipeline_runs row; failures and partials raise an ops alert; ingest runs
// take the per-source advisory lock and check same-day idempotency.

export interface RunRecorderDeps {
  db: Db;
  alerts: AlertSink;
  log: Logger;
  now?: () => Date;
}

export interface RunResult {
  status: 'ok' | 'partial' | 'failed';
  counts?: Record<string, number>;
  error?: string;
}

export class RunRecorder {
  constructor(private readonly deps: RunRecorderDeps) {}

  /**
   * Execute `fn` as one pipeline run. Returns null when today's run already
   * finished (idempotent skip) or the source lock is held.
   */
  async runOnce(
    kind: RunKind,
    sourceId: string | null,
    fn: () => Promise<RunResult>,
    task?: string | null,
  ): Promise<RunResult | null> {
    const { db, alerts, log } = this.deps;
    const today = jerusalemDate((this.deps.now?.() ?? new Date()));

    if (await db.hasFinishedRunOnDate(kind, sourceId, today, task ?? null)) {
      log.info('run already finished today, skipping', { kind, sourceId, task, date: today });
      return null;
    }
    if (sourceId) {
      const locked = await db.tryAcquireSourceLock(sourceId);
      if (!locked) {
        log.warn('source lock held, skipping run', { kind, sourceId });
        return null;
      }
    }

    const runId = await db.startRun(kind, sourceId, task ?? null);
    let result: RunResult;
    try {
      result = await fn();
    } catch (e) {
      result = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    await db.finishRun(runId, { status: result.status, counts: result.counts, error: result.error });
    if (sourceId) await db.releaseSourceLock(sourceId);

    if (result.status !== 'ok') {
      await alerts.send({
        subject: `pipeline ${kind}${sourceId ? `/${sourceId}` : ''} ${result.status}`,
        body: `run=${runId} date=${today}\nstatus=${result.status}\nerror=${result.error ?? '-'}\ncounts=${JSON.stringify(result.counts ?? {})}`,
        severity: result.status === 'failed' ? 'critical' : 'warn',
      });
    }
    return result;
  }
}

/** §13: >30% skipped records means a structural parser change — fail loudly. */
export function skipRate(result: { emitted: number; skipped: number }): number {
  const total = result.emitted + result.skipped;
  return total === 0 ? 0 : result.skipped / total;
}

export const MAX_SKIP_RATE = 0.3;
