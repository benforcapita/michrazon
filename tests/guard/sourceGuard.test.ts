import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWLIST,
  assertAllowed,
  assertResponseHeaders,
  DENYLIST,
  DeniedSourceError,
  DocumentFetchForbiddenError,
  ForbiddenContentTypeError,
  InsecureSchemeError,
  isDocumentLike,
  NotAllowlistedError,
} from '@michrazon/core';

describe('assertAllowed', () => {
  it('accepts allowlisted https hosts', () => {
    expect(() =>
      assertAllowed(new URL('https://data.gov.il/dataset/x'), 'datagov_beersheva'),
    ).not.toThrow();
    expect(() =>
      assertAllowed(new URL('https://mr.gov.il/listing/1'), 'mrgov_listing'),
    ).not.toThrow();
    // subdomains of allowlisted hosts are allowed
    expect(() =>
      assertAllowed(new URL('https://www.data.gov.il/x'), 'datagov_beersheva'),
    ).not.toThrow();
  });

  it('AC-01 / T-GUARD-2: red domains and subdomains throw DeniedSourceError', () => {
    for (const url of [
      'https://tel-aviv.gov.il/tenders',
      'https://www.tel-aviv.gov.il/x',
      'https://jerusalem.muni.il/x',
      'https://bids.jerusalem.muni.il/x',
      'https://TEL-AVIV.GOV.IL/x',
    ]) {
      expect(() => assertAllowed(new URL(url), 'datagov_beersheva'), url).toThrow(
        DeniedSourceError,
      );
    }
  });

  it('denylist wins even if a red domain is added to the allowlist (T-GUARD-1)', () => {
    const mutableAllow = ALLOWLIST as unknown as string[];
    mutableAllow.push('tel-aviv.gov.il');
    try {
      expect(() =>
        assertAllowed(new URL('https://tel-aviv.gov.il/x'), 'datagov_beersheva'),
      ).toThrow(DeniedSourceError);
    } finally {
      mutableAllow.pop();
    }
    expect(DENYLIST).toContain('tel-aviv.gov.il');
    expect(DENYLIST).toContain('jerusalem.muni.il');
  });

  it('non-allowlisted hosts throw NotAllowlistedError', () => {
    expect(() => assertAllowed(new URL('https://haifa.muni.il/x'), 'datagov_beersheva')).toThrow(
      NotAllowlistedError,
    );
    expect(() => assertAllowed(new URL('https://example.com'), 'datagov_beersheva')).toThrow(
      NotAllowlistedError,
    );
    expect(() => assertAllowed(new URL('https://michrazim.org.il'), 'datagov_beersheva')).toThrow(
      NotAllowlistedError,
    );
  });

  it('non-https schemes throw InsecureSchemeError', () => {
    expect(() => assertAllowed(new URL('http://data.gov.il/x'), 'datagov_beersheva')).toThrow(
      InsecureSchemeError,
    );
  });

  it('document-like URLs are rejected for mrgov_listing before any fetch', () => {
    for (const url of [
      'https://mr.gov.il/x/booklet.pdf',
      'https://mr.gov.il/ilgstorefront/he/p/attachment/ABC/x.pdf',
      'https://mr.gov.il/list/attachment/42',
      'https://mr.gov.il/files/price-list.xlsx',
      'https://mr.gov.il/files/a.zip',
    ]) {
      expect(isDocumentLike(new URL(url)), url).toBe(true);
      expect(() => assertAllowed(new URL(url), 'mrgov_listing'), url).toThrow(
        DocumentFetchForbiddenError,
      );
    }
    // the same URL is allowed for datagov (different rule set)
    expect(() =>
      assertAllowed(new URL('https://data.gov.il/dataset/x/resource.csv'), 'datagov_beersheva'),
    ).not.toThrow();
    // a normal listing page is fine
    expect(() =>
      assertAllowed(
        new URL('https://mr.gov.il/officestenders/Pages/officetender.aspx?id=1'),
        'mrgov_listing',
      ),
    ).not.toThrow();
  });
});

describe('assertResponseHeaders (before body read)', () => {
  const headers = (map: Record<string, string>) => ({ get: (n: string) => map[n.toLowerCase()] ?? null });

  it('yellow: requires text/html, rejects document content types', () => {
    for (const ct of ['application/pdf', 'application/octet-stream', 'application/msword', 'application/vnd.ms-excel']) {
      expect(() => assertResponseHeaders(headers({ 'content-type': ct }), 'mrgov_listing'), ct).toThrow(
        ForbiddenContentTypeError,
      );
    }
    expect(() =>
      assertResponseHeaders(headers({ 'content-type': 'application/json' }), 'mrgov_listing'),
    ).toThrow(ForbiddenContentTypeError);
    expect(() =>
      assertResponseHeaders(headers({ 'content-type': 'text/html; charset=utf-8' }), 'mrgov_listing'),
    ).not.toThrow();
  });

  it('any source: Content-Disposition attachment is rejected', () => {
    expect(() =>
      assertResponseHeaders(
        headers({ 'content-type': 'text/html', 'content-disposition': 'attachment; filename="x.pdf"' }),
        'mrgov_listing',
      ),
    ).toThrow(DocumentFetchForbiddenError);
    expect(() =>
      assertResponseHeaders(
        headers({ 'content-disposition': 'attachment' }),
        'datagov_beersheva',
      ),
    ).toThrow(DocumentFetchForbiddenError);
  });

  it('green: csv/json/xml pass, document types are rejected', () => {
    for (const ct of ['text/csv', 'application/json', 'application/xml', 'text/plain']) {
      expect(() =>
        assertResponseHeaders(headers({ 'content-type': ct }), 'datagov_beersheva'), ct,
      ).not.toThrow();
    }
    expect(() =>
      assertResponseHeaders(headers({ 'content-type': 'application/pdf' }), 'datagov_beersheva'),
    ).toThrow(ForbiddenContentTypeError);
  });
});

describe('no test actually hits the network', () => {
  it('sanity: this suite never calls fetch', () => {
    expect(vi.isMockFunction(fetch)).toBe(false); // all mocks are local in guardedHttp.test.ts
  });
});
