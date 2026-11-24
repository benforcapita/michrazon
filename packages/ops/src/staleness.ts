import type { Db } from '@michrazon/core';
import type { AlertSink } from './alerts';

// "No new tenders in 3 days" ops check (LLD §11, 08:45 daily).

export const STALE_DAYS = 3;

export interface StalenessReport {
  sourceId: string;
  newTenders: number;
  stale: boolean;
}

export async function checkSourceStaleness(
  db: Db,
  alerts: AlertSink,
  now: Date,
  days = STALE_DAYS,
): Promise<StalenessReport[]> {
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const reports: StalenessReport[] = [];
  for (const source of await db.listEnabledSources()) {
    const count = await db.countNewTendersSince(source.id, since);
    const stale = count === 0;
    reports.push({ sourceId: source.id, newTenders: count, stale });
    if (stale) {
      await alerts.send({
        subject: `no new tenders from ${source.id} in ${days} days`,
        body: `source=${source.id}\nnew tenders since ${since.toISOString()}=${count}\nThe source may be down or its markup changed.`,
        severity: 'warn',
      });
    }
  }
  return reports;
}
