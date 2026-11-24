// LLD §5 — closed allowlist + denylist. Denylist is checked FIRST, so a red
// domain can never be served even if it lands in the allowlist (T-GUARD-1).
import type { SourceId } from '../types';
import {
  DeniedSourceError,
  DocumentFetchForbiddenError,
  ForbiddenContentTypeError,
  InsecureSchemeError,
  NotAllowlistedError,
} from './errors';

export const ALLOWLIST = ['data.gov.il', 'mr.gov.il'] as const;
export const DENYLIST = ['tel-aviv.gov.il', 'jerusalem.muni.il'] as const;

const DOCUMENT_PATH_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar)$/i;
const ATTACHMENT_PATH_RE = /\/attachment\//i;
const BOOKLET_PATH_RE = /\/ilgstorefront\/.*\/p\/attachment\//i;

const FORBIDDEN_YELLOW_CONTENT_RE =
  /^application\/(pdf|octet-stream|msword|vnd\.|zip|x-zip)/i;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

export function isDocumentLike(url: URL): boolean {
  const path = url.pathname;
  return (
    DOCUMENT_PATH_RE.test(path) ||
    ATTACHMENT_PATH_RE.test(path) ||
    BOOKLET_PATH_RE.test(path)
  );
}

export function assertAllowed(url: URL, sourceId: SourceId): void {
  const host = url.hostname.toLowerCase();
  if (DENYLIST.some((d) => hostMatches(host, d))) throw new DeniedSourceError(host);
  if (!ALLOWLIST.some((a) => hostMatches(host, a))) throw new NotAllowlistedError(host);
  if (url.protocol !== 'https:') throw new InsecureSchemeError(url.protocol);
  if (sourceId === 'mrgov_listing' && isDocumentLike(url)) {
    throw new DocumentFetchForbiddenError(url.href);
  }
}

export interface ResponseHeaderSource {
  get(name: string): string | null;
}

/**
 * Checked BEFORE the body is read (LLD §5). For yellow sources the response
 * must be text/html; any document-like type or attachment disposition is
 * rejected so the connection can be aborted immediately.
 */
export function assertResponseHeaders(headers: ResponseHeaderSource, sourceId: SourceId): void {
  const disposition = headers.get('content-disposition');
  if (disposition && /attachment/i.test(disposition)) {
    throw new DocumentFetchForbiddenError('response declares Content-Disposition: attachment');
  }
  const contentType = headers.get('content-type');
  if (sourceId === 'mrgov_listing') {
    if (contentType === null || !/^text\/html/i.test(contentType.trim())) {
      throw new ForbiddenContentTypeError(contentType);
    }
    return;
  }
  if (contentType !== null && FORBIDDEN_YELLOW_CONTENT_RE.test(contentType.trim())) {
    throw new ForbiddenContentTypeError(contentType);
  }
}
