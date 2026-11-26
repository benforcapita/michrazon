import { isDocumentLike, jerusalemWallToUtc } from '@michrazon/core';
import { isoDate, parseIsraeliDate } from '../datagov-beersheva/parse.ts';

// Listing-page parsing (LLD §4.2). The real mr.gov.il DOM is TBD, so every
// pattern is configurable; the defaults match the storefront markup shape we
// observed (tender cards linking to /ilgstorefront/... detail pages).

export interface MrGovParserConfig {
  /** Global regex matching one tender item block in the listing HTML. */
  itemBlock: RegExp;
  /** First capture group = detail-page href within a block. */
  href: RegExp;
  /** Optional per-field extractors (first capture group) within a block. */
  tenderId?: RegExp;
  title?: RegExp;
  publisher?: RegExp;
  publishedAt?: RegExp;
  deadline?: RegExp;
}

export const DEFAULT_PARSER: MrGovParserConfig = {
  itemBlock: /<article\b[^>]*\bclass="[^"]*\btender\b[^"]*"[\s\S]*?<\/article>/gi,
  href: /<a\b[^>]*\bhref="([^"]+)"/i,
  tenderId: /\bdata-tender-id="([^"]+)"/i,
  title: /<a\b[^>]*\bhref="[^"]+"[^>]*>([\s\S]*?)<\/a>/i,
  publisher: /\bclass="[^"]*\bpublisher\b[^"]*"[^>]*>([\s\S]*?)</i,
  publishedAt: /\bclass="[^"]*\bpublished\b[^"]*"[^>]*>([\s\S]*?)</i,
  deadline: /\bclass="[^"]*\bdeadline\b[^"]*"[^>]*>([\s\S]*?)</i,
};

export interface RawListingItem {
  href: string;
  block: string;
  fields: Record<string, string | undefined>;
}

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '');

export const cleanText = (s: string | undefined): string | undefined => {
  if (s == null) return undefined;
  const out = stripTags(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return out === '' ? undefined : out;
};

/** Extract raw item blocks + fields from one listing page. */
export function parseListing(html: string, cfg: MrGovParserConfig = DEFAULT_PARSER): RawListingItem[] {
  const items: RawListingItem[] = [];
  const re = new RegExp(cfg.itemBlock.source, cfg.itemBlock.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const hrefMatch = cfg.href.exec(block);
    if (!hrefMatch?.[1]) continue;
    const fields: Record<string, string | undefined> = {};
    for (const key of ['tenderId', 'title', 'publisher', 'publishedAt', 'deadline'] as const) {
      const pattern = cfg[key];
      fields[key] = pattern ? cleanText(pattern.exec(block)?.[1]) : undefined;
    }
    items.push({ href: hrefMatch[1], block, fields });
  }
  return items;
}

export interface NormalizedListingItem {
  source_tender_id: string;
  title: string;
  publisher?: string;
  published_at?: string;
  submission_deadline?: string;
  official_url: string;
}

export type ListingSkip = 'no_href' | 'document_url' | 'missing_id' | 'missing_title';

export interface ListingOutcome {
  item?: NormalizedListingItem;
  skipped?: ListingSkip;
}

const DEFAULT_TENDER_ID_FROM_URL = /(\d{4,}|[0-9]{1,4}\/[0-9]{2,4})(?=[/?#]|$)/;

/**
 * Normalize one raw listing item to listing facts. Fails closed: no tender
 * number or no title => skip; a document-like detail URL => skip.
 */
export function normalizeListingItem(
  raw: RawListingItem,
  baseUrl: string,
  tenderIdFromUrl: RegExp = DEFAULT_TENDER_ID_FROM_URL,
): ListingOutcome {
  let url: URL;
  try {
    url = new URL(raw.href, baseUrl);
  } catch {
    return { skipped: 'no_href' };
  }
  if (isDocumentLike(url)) return { skipped: 'document_url' };

  const id = raw.fields.tenderId ?? tenderIdFromUrl.exec(url.pathname)?.[1];
  if (!id || id.length > 64) return { skipped: 'missing_id' };

  const title = raw.fields.title;
  if (!title) return { skipped: 'missing_title' };

  const item: NormalizedListingItem = {
    source_tender_id: id.slice(0, 64),
    title: title.slice(0, 500),
    official_url: url.href.slice(0, 1000),
  };
  if (raw.fields.publisher) item.publisher = raw.fields.publisher.slice(0, 200);

  const published = parseIsraeliDate(raw.fields.publishedAt);
  if (published) item.published_at = isoDate(published.year, published.month, published.day);

  if (raw.fields.deadline) {
    const p = parseIsraeliDate(raw.fields.deadline);
    if (p) {
      item.submission_deadline = jerusalemWallToUtc(
        p.year, p.month, p.day, p.hour ?? 23, p.minute ?? 59,
      ).toISOString();
    }
  }
  return { item };
}