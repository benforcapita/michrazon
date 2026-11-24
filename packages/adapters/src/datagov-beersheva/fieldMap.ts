import { isDocumentLike, jerusalemWallToUtc } from '@michrazon/core';
import { isoDate, parseIsraeliDate } from './parse';
import type { DatagovTender } from './schema';

// Field mapping (LLD §4.1, "מיפוי שדות: TBD"): the exact CKAN column names are
// dataset-dependent, so each normalized field accepts an ordered list of
// candidate source keys (Hebrew + English + underscored variants).

export interface DatagovFieldMap {
  source_tender_id: readonly string[];
  title: readonly string[];
  publisher: readonly string[];
  published_at: readonly string[];
  submission_deadline: readonly string[];
  official_url: readonly string[];
}

export const DEFAULT_FIELD_MAP: DatagovFieldMap = {
  source_tender_id: [
    'מספר מכרז',
    'מספר_מכרז',
    'מספר מכרז במנהל הרכש',
    'מס/פר מכרז',
    'tender_id',
    'tender_number',
    'מס׳ מכרז',
    'מס׳_מכרז',
  ],
  title: [
    'שם המכרז',
    'שם_המכרז',
    'נושא המכרז',
    'כותרת',
    'tender_name',
    'title',
    'שם',
  ],
  publisher: ['מפרסם', 'גורם מפרסם', 'publisher', 'יחידה', 'אגף'],
  published_at: [
    'תאריך פרסום',
    'תאריך_פרסום',
    'תאריך פתיחה',
    'publish_date',
    'published_at',
  ],
  submission_deadline: [
    'מועד אחרון להגשה',
    'מועד_אחרון_להגשה',
    'מועד אחרון להגשת הצעה',
    'תאריך הגשה',
    'submission_deadline',
    'deadline',
  ],
  official_url: ['קישור', 'לינק', 'url', 'link', 'official_url'],
};

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');

function pick(record: Record<string, unknown>, candidates: readonly string[]): unknown {
  const lookup = new Map(Object.keys(record).map((k) => [norm(k), k]));
  for (const c of candidates) {
    const key = lookup.get(norm(c));
    if (key !== undefined && record[key] !== '' && record[key] != null) return record[key];
  }
  return undefined;
}

export interface NormalizeOutcome {
  tender?: DatagovTender;
  skipped?: 'missing_id' | 'missing_title' | 'document_url';
}

export interface NormalizeOptions {
  datasetUrl: string;
  fieldMap?: Partial<DatagovFieldMap>;
  /** Source keys allowed into open_data_fields; default: all unmapped keys. */
  openDataAllowlist?: readonly string[];
}

/**
 * Map one raw CKAN record to a normalized tender. Fails closed: a record
 * missing id/title or pointing at a document is skipped, never emitted.
 */
export function normalizeRecord(
  record: Record<string, unknown>,
  opts: NormalizeOptions,
): NormalizeOutcome {
  const map: DatagovFieldMap = { ...DEFAULT_FIELD_MAP, ...opts.fieldMap };

  const id = pick(record, map.source_tender_id);
  if (id == null || String(id).trim() === '') return { skipped: 'missing_id' };

  const titleRaw = pick(record, map.title);
  const title = titleRaw == null ? '' : norm(String(titleRaw));
  if (!title) return { skipped: 'missing_title' };

  let officialUrl = pick(record, map.official_url);
  officialUrl = officialUrl == null ? '' : String(officialUrl).trim();
  let url: URL;
  try {
    url = new URL(officialUrl || opts.datasetUrl);
  } catch {
    url = new URL(opts.datasetUrl);
  }
  if (isDocumentLike(url)) return { skipped: 'document_url' };

  const tender: DatagovTender = {
    source_id: 'datagov_beersheva',
    source_tender_id: String(id).trim(),
    title,
    official_url: url.href,
  };

  const publisher = pick(record, map.publisher);
  if (publisher != null && String(publisher).trim() !== '') {
    tender.publisher = norm(String(publisher));
  }

  const published = parseIsraeliDate(pick(record, map.published_at));
  if (published) {
    tender.published_at = isoDate(published.year, published.month, published.day);
  }

  const rawDeadline = pick(record, map.submission_deadline);
  if (rawDeadline != null && String(rawDeadline).trim() !== '') {
    const s = String(rawDeadline).trim();
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) tender.submission_deadline = d.toISOString();
    } else {
      const p = parseIsraeliDate(s);
      if (p) {
        // Date-only deadlines close at end of day, Asia/Jerusalem wall time.
        const utc = jerusalemWallToUtc(p.year, p.month, p.day, p.hour ?? 23, p.minute ?? 59);
        tender.submission_deadline = utc.toISOString();
      }
    }
  }

  const mapped = new Set(
    [
      ...map.source_tender_id,
      ...map.title,
      ...map.publisher,
      ...map.published_at,
      ...map.submission_deadline,
      ...map.official_url,
    ].map(norm),
  );
  const allow = opts.openDataAllowlist?.map(norm);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k.startsWith('_') || v === '' || v == null) continue; // CKAN internals (_id)
    const nk = norm(k);
    if (mapped.has(nk)) continue;
    if (allow && !allow.includes(nk)) continue;
    extra[k] = v;
  }
  if (Object.keys(extra).length > 0) tender.open_data_fields = extra;

  return { tender };
}
