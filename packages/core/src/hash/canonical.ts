// Canonical JSON for content hashing (LLD §7): sorted keys, trimmed strings,
// whitespace-normalized, dates in ISO. Produces sha256 hex.
import { createHash } from 'node:crypto';

export function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function canon(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return normalizeWhitespace(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = canon((value as Record<string, unknown>)[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canon(value));
}

export function contentHash(fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(fields), 'utf8').digest('hex');
}
