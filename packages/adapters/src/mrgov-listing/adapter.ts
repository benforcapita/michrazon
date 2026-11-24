import type {
  AdapterContext,
  NormalizedTender,
  SourceAdapter,
} from '@michrazon/core';
import type { AdapterRunCounts } from '../runCounts';
import type { MrGovParserConfig } from './parse';
import { DEFAULT_PARSER, normalizeListingItem, parseListing } from './parse';
import { checkRobots } from './robots';
import { MrGovFacts } from './schema';

export interface MrGovListingOptions {
  /** Listing page URL for page N (1-based), newest first. */
  listingPageUrl: (page: number) => string;
  /** Listing path prefix checked against robots.txt Disallow. */
  listingPath?: string;
  parser?: Partial<MrGovParserConfig>;
  /** Stop paginating once one of these tender ids appears (incremental). */
  knownIds?: ReadonlySet<string>;
  maxPages?: number;
}



const DEFAULT_MAX_PAGES = 10;

/**
 * mrgov-listing (yellow). Emits ONLY the MrGovFacts contract fields plus a
 * link to the official page — never document content (LLD §6). Behaves as
 * if robots.txt exists; stops if a real robots file disallows the listing.
 */
export class MrGovListingAdapter implements SourceAdapter {
  readonly id = 'mrgov_listing' as const;
  readonly tier = 'yellow' as const;
  readonly counts: AdapterRunCounts = { emitted: 0, skipped: 0 };

  constructor(private readonly opts: MrGovListingOptions) {}

  async *fetchSince(
    ctx: AdapterContext,
    _since: Date,
  ): AsyncIterable<NormalizedTender> {
    this.counts.emitted = 0;
    this.counts.skipped = 0;

    const listingPath = this.opts.listingPath ?? new URL(this.opts.listingPageUrl(1)).pathname;
    const robots = await checkRobots(ctx, [listingPath]);
    if (!robots.allowed) {
      ctx.log.warn('mrgov ingest stopped by robots.txt', { reason: robots.reason });
      return;
    }

    const cfg: MrGovParserConfig = { ...DEFAULT_PARSER, ...this.opts.parser };
    const maxPages = this.opts.maxPages ?? DEFAULT_MAX_PAGES;
    const known = this.opts.knownIds;

    let sawKnown = false;
    for (let page = 1; page <= maxPages && !sawKnown; page += 1) {
      const res = await ctx.http.get(this.opts.listingPageUrl(page), this.id);
      const items = parseListing(await res.text(), cfg);
      if (items.length === 0) break;
      for (const raw of items) {
        const outcome = normalizeListingItem(raw, res.url);
        if (!outcome.item) {
          this.counts.skipped += 1;
          ctx.log.warn('mrgov item skipped', { reason: outcome.skipped });
          continue;
        }
        // Facts-only gate: .strict() rejects anything beyond the contract.
        const parsed = MrGovFacts.safeParse({ source_id: this.id, ...outcome.item });
        if (!parsed.success) {
          this.counts.skipped += 1;
          ctx.log.warn('mrgov item failed facts schema', {
            issues: parsed.error.issues.map((i) => i.path.join('.')),
          });
          continue;
        }
        if (known?.has(parsed.data.source_tender_id)) {
          sawKnown = true;
          break;
        }
        this.counts.emitted += 1;
        yield parsed.data;
      }
    }
  }
}

export const createMrGovListingAdapter = (opts: MrGovListingOptions) =>
  new MrGovListingAdapter(opts);
