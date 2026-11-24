// Dedup helpers (LLD §7): natural key, cross-source secondary key, and
// "what changed" comparisons for classification invalidation.
import { canonicalJson, contentHash, normalizeWhitespace } from './canonical';

/** Fields that make up the content hash for a normalized tender. */
export const TENDER_HASH_FIELDS = [
  'source_id',
  'source_tender_id',
  'title',
  'publisher',
  'published_at',
  'submission_deadline',
  'official_url',
  'open_data_fields',
] as const;

export function tenderContentHash(fields: {
  source_id: string;
  source_tender_id: string;
  title: string;
  publisher?: string | null;
  published_at?: string | null;
  submission_deadline?: string | null;
  official_url: string;
  open_data_fields?: Record<string, unknown> | null;
}): string {
  const subset: Record<string, unknown> = {};
  for (const key of TENDER_HASH_FIELDS) {
    subset[key] = (fields as Record<string, unknown>)[key] ?? null;
  }
  return contentHash(subset);
}

/** Secondary cross-source dedup key: normalize(title)+publisher+published_at. */
export function secondaryDedupKey(input: {
  title: string;
  publisher?: string | null;
  published_at?: string | null;
}): string {
  const title = normalizeWhitespace(input.title).toLowerCase();
  const publisher = normalizeWhitespace(input.publisher ?? '').toLowerCase();
  const published = (input.published_at ?? '').slice(0, 10);
  return contentHash({ title, publisher, published });
}

export interface DedupedTenderLike {
  source_id: string;
  title: string;
  publisher?: string | null;
  published_at?: string | null;
}

/**
 * When the same tender appears in both sources, the GREEN (open-licence)
 * instance is preferred (LLD §7).
 */
export function preferGreen<T extends DedupedTenderLike>(a: T, b: T): T {
  return a.source_id === 'datagov_beersheva' ? a : b;
}

/** Which allowlisted fields differ between two tender fact sets. */
export function changedFields(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  fields: readonly string[] = TENDER_HASH_FIELDS,
): string[] {
  const changed: string[] = [];
  for (const f of fields) {
    if (canonicalJson(prev[f] ?? null) !== canonicalJson(next[f] ?? null)) changed.push(f);
  }
  return changed;
}

/** Deadline-only changes re-enter the digest marked as "עודכן" (LLD §7). */
export function isDeadlineOnlyChange(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const changed = changedFields(prev, next);
  return changed.length === 1 && changed[0] === 'submission_deadline';
}
