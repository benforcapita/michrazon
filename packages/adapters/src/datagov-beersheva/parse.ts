// Parsing helpers for the datagov-beersheva adapter: minimal RFC-4180 CSV,
// CKAN datastore_search JSON, and Israeli/ISO date normalization.

/** Parse CSV text into an array of row objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  const header = rows.shift() ?? [];
  return rows.map((cells) =>
    Object.fromEntries(header.map((h, idx) => [h.trim(), cells[idx] ?? ''])),
  );
}

export interface DatastorePage {
  records: Record<string, unknown>[];
  total: number;
}

/** Parse a CKAN `datastore_search` response body. Throws on API failure. */
export function parseDatastoreResponse(body: string): DatastorePage {
  const json = JSON.parse(body) as {
    success?: boolean;
    error?: { message?: string };
    result?: { records?: Record<string, unknown>[]; total?: number };
  };
  if (json.success === false) {
    throw new Error(`datastore_search failed: ${json.error?.message ?? 'unknown'}`);
  }
  const result = json.result ?? {};
  return {
    records: Array.isArray(result.records) ? result.records : [],
    total: typeof result.total === 'number' ? result.total : (result.records?.length ?? 0),
  };
}

const IL_DATE = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Normalize a date-ish value from a source record.
 * Returns `{ date }` (YYYY-MM-DD) when only a date is present, or
 * `{ dateTime }` (UTC ms components) when a wall time is present.
 * Supports DD/MM/YYYY, DD.MM.YYYY, and ISO 8601. Returns null on garbage.
 */
export function parseIsraeliDate(
  value: unknown,
): { kind: 'date'; year: number; month: number; day: number; hour?: number; minute?: number } | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  const d = new Date(s);
  if (ISO_DATE.test(s) && !Number.isNaN(d.getTime())) {
    return { kind: 'date', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  const m = IL_DATE.exec(s);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const rest = s.slice(m[0].length).trim();
  let hour: number | undefined;
  let minute: number | undefined;
  const t = /(\d{1,2}):(\d{2})/.exec(rest);
  if (t) {
    hour = Number(t[1]);
    minute = Number(t[2]);
  }
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { kind: 'date', year, month, day, hour, minute };
}

export const isoDate = (y: number, m: number, d: number): string =>
  `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d
    .toString()
    .padStart(2, '0')}`;
