import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatagovBeershevaAdapter, normalizeRecord } from '@michrazon/adapters';
import { makeCtx, makeMockHttp } from '../helpers/mockHttp';

const FIXTURES = join(__dirname, '../fixtures/datagov');
const DATASET = 'https://data.gov.il/dataset/tenders-beersheva';

const datastoreUrl = (resourceId: string, offset: number, limit = 1000) =>
  `https://data.gov.il/api/3/action/datastore_search?resource_id=${encodeURIComponent(
    resourceId,
  )}&limit=${limit}&offset=${offset}`;

describe('datagov-beersheva adapter', () => {
  it('normalizes datastore_search pages and skips records without an id', async () => {
    const rid = 'abc-123';
    const { http, requested } = makeMockHttp({
      [datastoreUrl(rid, 0)]: { body: readFileSync(join(FIXTURES, 'datastore_page1.json'), 'utf8') },
      [datastoreUrl(rid, 2)]: { body: readFileSync(join(FIXTURES, 'datastore_page2.json'), 'utf8') },
    });
    const adapter = new DatagovBeershevaAdapter({ resourceId: rid, datasetUrl: DATASET });
    const out = [];
    for await (const t of adapter.fetchSince(makeCtx(http), new Date(0))) out.push(t);

    expect(requested).toHaveLength(2);
    expect(out).toHaveLength(2);
    expect(adapter.counts).toEqual({ emitted: 2, skipped: 1 });

    const first = out[0]!;
    expect(first.source_id).toBe('datagov_beersheva');
    expect(first.source_tender_id).toBe('55/2026');
    expect(first.title).toBe('פיתוח מערכת ניהול תשתיות');
    expect(first.publisher).toBe('עיריית באר שבע');
    expect(first.published_at).toBe('2026-01-12');
    // 30/01/2026 12:00 Jerusalem (winter, UTC+2) -> 10:00 UTC
    expect(first.submission_deadline).toBe('2026-01-30T10:00:00.000Z');
    expect(first.open_data_fields).toMatchObject({ 'סטטוס': 'פתוח' });
    expect(first.open_data_fields).not.toHaveProperty('_id');
    // unmapped keys never leak into normalized fields
    expect(first).not.toHaveProperty('סטטוס');
  });

  it('parses a single CSV resource file and rejects document-like urls', async () => {
    const fileUrl = 'https://data.gov.il/dataset/tenders-beersheva/resource/data.csv';
    const { http, requested } = makeMockHttp({
      [fileUrl]: {
        body: readFileSync(join(FIXTURES, 'tenders.csv'), 'utf8'),
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      },
    });
    const adapter = new DatagovBeershevaAdapter({ resourceUrl: fileUrl, datasetUrl: DATASET });
    const out = [];
    for await (const t of adapter.fetchSince(makeCtx(http), new Date(0))) out.push(t);

    expect(requested).toEqual([fileUrl]);
    expect(out).toHaveLength(1);
    expect(adapter.counts).toEqual({ emitted: 1, skipped: 1 }); // .pdf url skipped
    expect(out[0]!.source_tender_id).toBe('57/2026');
    // 28/02/2026 15:30 Jerusalem -> 13:30 UTC
    expect(out[0]!.submission_deadline).toBe('2026-02-28T13:30:00.000Z');
  });

  it('falls back to the dataset URL when a record has no link', () => {
    const outcome = normalizeRecord(
      { 'מספר מכרז': '9/2026', 'שם המכרז': 'בדיקה' },
      { datasetUrl: DATASET },
    );
    expect(outcome.tender?.official_url).toBe(DATASET);
  });
});
