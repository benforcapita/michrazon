import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DisabledSourceError,
  FORBIDDEN_MRGOV_KEYS,
  MrGovFacts,
  MrGovListingAdapter,
  petahTikvaSource,
} from '@michrazon/adapters';
import { makeCtx, makeMockHttp } from '../helpers/mockHttp';

const LISTING_HTML = readFileSync(join(__dirname, '../fixtures/mrgov/listing.html'), 'utf8');
const ROBOTS_URL = 'https://mr.gov.il/robots.txt';
const pageUrl = (p: number) => `https://mr.gov.il/ilgstorefront/he/tenders?page=${p}`;

const adapter = (extra?: ConstructorParameters<typeof MrGovListingAdapter>[0]) =>
  new MrGovListingAdapter({ listingPageUrl: pageUrl, ...extra });

describe('mrgov-listing adapter (facts-only)', () => {
  it('emits only MrGovFacts fields and skips document/invalid items', async () => {
    const { http, requested } = makeMockHttp({
      [ROBOTS_URL]: { status: 200, body: '<html>homepage redirect</html>' },
      [pageUrl(1)]: { body: LISTING_HTML, headers: { 'content-type': 'text/html' } },
      [pageUrl(2)]: { body: '<html><body></body></html>', headers: { 'content-type': 'text/html' } },
    });
    const out = [];
    for await (const t of adapter().fetchSince(makeCtx(http), new Date(0))) out.push(t);

    expect(requested).toEqual([ROBOTS_URL, pageUrl(1), pageUrl(2)]);
    expect(out).toHaveLength(2);
    const t = out[0]!;
    expect(t.source_id).toBe('mrgov_listing');
    expect(t.source_tender_id).toBe('2026-014');
    expect(t.title).toBe('פיתוח מערכת ניהול פניות תושבים');
    expect(t.publisher).toBe('משרד הכלכלה');
    expect(t.published_at).toBe('2026-01-10');
    // 15/02/2026 13:00 Jerusalem -> 11:00 UTC
    expect(t.submission_deadline).toBe('2026-02-15T11:00:00.000Z');
    expect(t.official_url).toBe('https://mr.gov.il/ilgstorefront/he/p/tender/2026-014');
    // no field beyond the strict contract, and never a forbidden key
    for (const k of Object.keys(t)) {
      expect(FORBIDDEN_MRGOV_KEYS).not.toContain(k);
    }
    expect(MrGovFacts.safeParse(t).success).toBe(true);
    expect(t).not.toHaveProperty('open_data_fields');
  });

  it('stops paginating when a known tender id is reached', async () => {
    const { http, requested } = makeMockHttp({
      [ROBOTS_URL]: { status: 200, body: '' },
      [pageUrl(1)]: { body: LISTING_HTML, headers: { 'content-type': 'text/html' } },
    });
    const out = [];
    for await (const t of adapter({ knownIds: new Set(['2026-015']) }).fetchSince(makeCtx(http), new Date(0)))
      out.push(t);
    expect(out.map((t) => t.source_tender_id)).toEqual(['2026-014']);
    expect(requested).toEqual([ROBOTS_URL, pageUrl(1)]); // page 2 never fetched
  });

  it('halts the run when a real robots.txt disallows the listing path', async () => {
    const { http, requested } = makeMockHttp({
      [ROBOTS_URL]: { body: 'User-agent: *\nDisallow: /ilgstorefront/\n' },
    });
    const out = [];
    for await (const t of adapter().fetchSince(makeCtx(http), new Date(0))) out.push(t);
    expect(out).toHaveLength(0);
    expect(requested).toEqual([ROBOTS_URL]); // no listing requests
  });

  it('proceeds when robots.txt redirects away (absent)', async () => {
    // mock returns url === requested url; an HTML robots body counts as absent
    const m2 = makeMockHttp({
      [ROBOTS_URL]: { status: 200, body: '<html></html>' },
      [pageUrl(1)]: { body: LISTING_HTML, headers: { 'content-type': 'text/html' } },
      [pageUrl(2)]: { body: '<html><body></body></html>', headers: { 'content-type': 'text/html' } },
    });
    const out = [];
    for await (const t of adapter().fetchSince(makeCtx(m2.http), new Date(0))) out.push(t);
    expect(out).toHaveLength(2);
    expect(m2.requested).toContain(ROBOTS_URL);
  });
});

describe('disabled source stubs', () => {
  it('throw DisabledSourceError and are never enabled', () => {
    expect(petahTikvaSource.enabled).toBe(false);
    expect(() => petahTikvaSource.fetchSince()).toThrow(DisabledSourceError);
  });
});
