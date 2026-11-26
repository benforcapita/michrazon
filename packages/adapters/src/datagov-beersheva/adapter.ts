import type {
  AdapterContext,
  NormalizedTender,
  SourceAdapter,
} from '@michrazon/core';
import type { AdapterRunCounts } from '../runCounts.ts';
import type { DatagovFieldMap } from './fieldMap.ts';
import { normalizeRecord } from './fieldMap.ts';
import { parseCsv, parseDatastoreResponse } from './parse.ts';
import { datagovTenderSchema } from './schema.ts';

const CKAN_DATASTORE = 'https://data.gov.il/api/3/action/datastore_search';
const PAGE_SIZE = 1000;

export interface DatagovBeershevaOptions {
  /** CKAN resource id for datastore_search paging (primary path). */
  resourceId?: string;
  /**
   * Direct single-file resource URL (CSV or JSON) — the LLD-preferred "one
   * file per day" path. Used when set; takes precedence over resourceId.
   */
  resourceUrl?: string;
  /** Dataset page URL — fallback official_url + provenance. */
  datasetUrl: string;
  fieldMap?: Partial<DatagovFieldMap>;
  openDataAllowlist?: readonly string[];
}



/**
 * datagov-beersheva (green). Reads the Beer Sheva tenders dataset once per
 * day via the official CKAN API or a single resource file. Every request
 * goes through ctx.http (guard + rate limit); no direct fetch.
 */
export class DatagovBeershevaAdapter implements SourceAdapter {
  readonly id = 'datagov_beersheva' as const;
  readonly tier = 'green' as const;
  readonly counts: AdapterRunCounts = { emitted: 0, skipped: 0 };

  constructor(private readonly opts: DatagovBeershevaOptions) {}

  async *fetchSince(
    ctx: AdapterContext,
    _since: Date,
  ): AsyncIterable<NormalizedTender> {
    this.counts.emitted = 0;
    this.counts.skipped = 0;
    const records = this.opts.resourceUrl
      ? this.fromFile(ctx)
      : this.fromDatastore(ctx);
    for await (const record of records) {
      const outcome = normalizeRecord(record, {
        datasetUrl: this.opts.datasetUrl,
        fieldMap: this.opts.fieldMap,
        openDataAllowlist: this.opts.openDataAllowlist,
      });
      if (!outcome.tender) {
        this.counts.skipped += 1;
        ctx.log.warn('datagov record skipped', { reason: outcome.skipped });
        continue;
      }
      // Schema gate: anything outside the contract fails loudly here.
      const parsed = datagovTenderSchema.safeParse(outcome.tender);
      if (!parsed.success) {
        this.counts.skipped += 1;
        ctx.log.warn('datagov record failed schema', {
          issues: parsed.error.issues.map((i) => i.path.join('.')),
        });
        continue;
      }
      this.counts.emitted += 1;
      yield parsed.data;
    }
  }

  private async *fromFile(ctx: AdapterContext): AsyncIterable<Record<string, unknown>> {
    const res = await ctx.http.get(this.opts.resourceUrl as string, this.id);
    const body = await res.text();
    const ct = (res.headers['content-type'] ?? '').toLowerCase();
    const url = this.opts.resourceUrl as string;
    if (ct.includes('json') || /\.json(\?|#|$)/i.test(url)) {
      // CKAN resource files are JSON arrays or {records:[...]} exports.
      const json = JSON.parse(body) as unknown;
      const records = Array.isArray(json)
        ? json
        : ((json as { records?: unknown[] }).records ?? []);
      for (const r of records as Record<string, unknown>[]) yield r;
    } else {
      for (const r of parseCsv(body)) yield r;
    }
  }

  private async *fromDatastore(ctx: AdapterContext): AsyncIterable<Record<string, unknown>> {
    if (!this.opts.resourceId) throw new Error('datagov adapter: no resourceId or resourceUrl configured');
    let offset = 0;
    for (;;) {
      const url = `${CKAN_DATASTORE}?resource_id=${encodeURIComponent(this.opts.resourceId)}&limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await ctx.http.get(url, this.id);
      const page = parseDatastoreResponse(await res.text());
      for (const r of page.records) yield r;
      offset += page.records.length;
      if (page.records.length === 0 || offset >= page.total) break;
    }
  }
}

export const createDatagovBeershevaAdapter = (opts: DatagovBeershevaOptions) =>
  new DatagovBeershevaAdapter(opts);
