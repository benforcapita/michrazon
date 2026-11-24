import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  changedFields,
  contentHash,
  isDeadlineOnlyChange,
  preferGreen,
  secondaryDedupKey,
  tenderContentHash,
} from '@michrazon/core';

describe('canonical hashing (AC-09)', () => {
  it('is stable across key order and whitespace noise', () => {
    const a = tenderContentHash({
      source_id: 'datagov_beersheva',
      source_tender_id: '1',
      title: '  בניית   אתר ',
      publisher: 'עיריית  באר שבע',
      published_at: '2026-11-01',
      official_url: 'https://data.gov.il/x',
    });
    const b = tenderContentHash({
      official_url: 'https://data.gov.il/x',
      published_at: '2026-11-01',
      publisher: 'עיריית באר שבע',
      title: 'בניית אתר',
      source_tender_id: '1',
      source_id: 'datagov_beersheva',
    });
    expect(a).toBe(b);
  });

  it('differs when any allowlisted field changes', () => {
    const base = {
      source_id: 'datagov_beersheva',
      source_tender_id: '1',
      title: 't',
      official_url: 'https://data.gov.il/x',
    };
    expect(tenderContentHash({ ...base, title: 't2' })).not.toBe(tenderContentHash(base));
  });

  it('canonicalJson sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(contentHash({ x: { b: 1, a: 2 } })).toBe(contentHash({ x: { a: 2, b: 1 } }));
  });
});

describe('secondary dedup + change classification', () => {
  it('same title+publisher+date gives the same cross-source key', () => {
    const x = secondaryDedupKey({ title: 'מכרז א', publisher: 'משרד', published_at: '2026-11-01' });
    const y = secondaryDedupKey({ title: ' מכרז  א ', publisher: 'משרד', published_at: '2026-11-01' });
    expect(x).toBe(y);
  });

  it('preferGreen picks the data.gov.il instance', () => {
    const dg = { source_id: 'datagov_beersheva', title: 't' };
    const mr = { source_id: 'mrgov_listing', title: 't' };
    expect(preferGreen(mr, dg).source_id).toBe('datagov_beersheva');
    expect(preferGreen(dg, mr).source_id).toBe('datagov_beersheva');
  });

  it('deadline-only change is marked as update; other changes are new classifications', () => {
    const prev = { title: 't', submission_deadline: '2026-12-01T12:00:00+02:00' };
    const same = { title: 't', submission_deadline: '2026-12-01T12:00:00+02:00' };
    const deadlineOnly = { title: 't', submission_deadline: '2026-12-08T12:00:00+02:00' };
    const titleChange = { title: 't2', submission_deadline: '2026-12-01T12:00:00+02:00' };
    expect(changedFields(prev, same)).toEqual([]);
    expect(isDeadlineOnlyChange(prev, deadlineOnly)).toBe(true);
    expect(isDeadlineOnlyChange(prev, titleChange)).toBe(false);
  });
});
