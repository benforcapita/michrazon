import { describe, expect, it } from 'vitest';
import type { SourceRow } from '@michrazon/core';
import { MemoryAlertSink, MAX_SKIP_RATE, RunRecorder, checkSourceStaleness, skipRate } from '@michrazon/ops';
import { makeFakeDb } from '../helpers/fakeDb';
import { silentLogger } from '../helpers/mockHttp';

function dbWithRuns() {
  const fake = makeFakeDb();
  const runs: { id: number; kind: string; source: string | null; status?: string }[] = [];
  const finishedDates = new Set<string>();
  const locks = new Set<string>();
  let seq = 0;
  fake.db.startRun = async (kind, sourceId = null) => {
    seq += 1;
    runs.push({ id: seq, kind, source: sourceId });
    return seq;
  };
  fake.db.finishRun = async (id, result) => {
    const r = runs.find((x) => x.id === id);
    if (r) r.status = result.status;
    if (r) finishedDates.add(`${r.kind}|${r.source ?? ''}|2026-01-15`);
  };
  fake.db.hasFinishedRunOnDate = async (kind, sourceId, dateYmd) =>
    finishedDates.has(`${kind}|${sourceId ?? ''}|${dateYmd}`);
  fake.db.tryAcquireSourceLock = async (id) => !locks.has(id) && (locks.add(id), true);
  fake.db.releaseSourceLock = async (id) => void locks.delete(id);
  return { fake, runs, locks };
}

const NOW = new Date('2026-01-15T06:00:00Z');

describe('RunRecorder', () => {
  it('records ok runs and sends no alert', async () => {
    const { fake, runs } = dbWithRuns();
    const alerts = new MemoryAlertSink();
    const rec = new RunRecorder({ db: fake.db, alerts, log: silentLogger, now: () => NOW });
    const res = await rec.runOnce('ingest', 'datagov_beersheva', async () => ({ status: 'ok', counts: { emitted: 3 } }));
    expect(res?.status).toBe('ok');
    expect(runs[0]!.status).toBe('ok');
    expect(alerts.alerts).toHaveLength(0);
  });

  it('alerts on failure and releases the lock', async () => {
    const { fake, runs, locks } = dbWithRuns();
    const alerts = new MemoryAlertSink();
    const rec = new RunRecorder({ db: fake.db, alerts, log: silentLogger, now: () => NOW });
    const res = await rec.runOnce('ingest', 'mrgov_listing', async () => {
      throw new Error('403 blocked');
    });
    expect(res?.status).toBe('failed');
    expect(runs[0]!.status).toBe('failed');
    expect(alerts.alerts[0]!.severity).toBe('critical');
    expect(locks.size).toBe(0);
  });

  it('is idempotent within the same Jerusalem date', async () => {
    const { fake } = dbWithRuns();
    const alerts = new MemoryAlertSink();
    const rec = new RunRecorder({ db: fake.db, alerts, log: silentLogger, now: () => NOW });
    await rec.runOnce('digest', null, async () => ({ status: 'ok' }));
    const second = await rec.runOnce('digest', null, async () => ({ status: 'ok' }));
    expect(second).toBeNull();
  });
});

describe('staleness check', () => {
  it('alerts when a source produced nothing for 3 days', async () => {
    const fake = makeFakeDb();
    fake.db.listEnabledSources = async (): Promise<SourceRow[]> => [
      {
        id: 'mrgov_listing', tier: 'yellow', host: 'mr.gov.il', enabled: true,
        min_interval_s: 10, max_requests_per_run: 60, attribution_text: 'x', notes: null,
      },
    ];
    fake.db.countNewTendersSince = async () => 0;
    const alerts = new MemoryAlertSink();
    const reports = await checkSourceStaleness(fake.db, alerts, NOW);
    expect(reports[0]!.stale).toBe(true);
    expect(alerts.alerts[0]!.subject).toContain('mrgov_listing');
  });
});

describe('skip-rate gate (LLD §13)', () => {
  it('flags structural parser change above 30% skipped', () => {
    expect(skipRate({ emitted: 3, skipped: 2 })).toBeGreaterThan(MAX_SKIP_RATE);
    expect(skipRate({ emitted: 9, skipped: 1 })).toBeLessThan(MAX_SKIP_RATE);
    expect(skipRate({ emitted: 0, skipped: 0 })).toBe(0);
  });
});
