import { describe, expect, it } from 'vitest';
import {
  isInWindow,
  jerusalemDate,
  jerusalemParts,
  TASK_WINDOWS,
} from '@michrazon/core';

// Israel: IST = UTC+2 (winter), IDT = UTC+3 (summer).
// 2026 DST: starts Fri 27 Mar, ends Sun 25 Oct.
const utc = (iso: string) => new Date(iso);

describe('Asia/Jerusalem clock (AC-27)', () => {
  it('converts UTC to Jerusalem wall time, winter and summer', () => {
    // Winter (IST +2): 03:00 UTC = 05:00 Jerusalem
    expect(jerusalemParts(utc('2026-01-15T03:00:00Z'))).toMatchObject({ hour: 5, minute: 0 });
    // Summer (IDT +3): 02:00 UTC = 05:00 Jerusalem
    expect(jerusalemParts(utc('2026-07-15T02:00:00Z'))).toMatchObject({ hour: 5, minute: 0 });
  });

  it('jerusalemDate gives the local calendar date', () => {
    // 22:30 UTC in winter = 00:30 next day in Jerusalem
    expect(jerusalemDate(utc('2026-01-15T22:30:00Z'))).toBe('2026-01-16');
    // 21:30 UTC in summer = 00:30 next day
    expect(jerusalemDate(utc('2026-07-15T21:30:00Z'))).toBe('2026-07-16');
  });
});

describe('task windows', () => {
  it('ingest datagov at 05:00 daily (winter UTC 03:00)', () => {
    const task = TASK_WINDOWS.ingest_datagov_beersheva;
    expect(isInWindow(task, utc('2026-01-15T03:00:00Z'))).toBe(true); // 05:00 JLM
    expect(isInWindow(task, utc('2026-01-15T03:15:00Z'))).toBe(true); // 05:15 JLM
    expect(isInWindow(task, utc('2026-01-15T03:30:00Z'))).toBe(false); // 05:30 JLM
    expect(isInWindow(task, utc('2026-01-15T02:59:00Z'))).toBe(false); // 04:59 JLM
  });

  it('ingest mrgov at 05:20 — fires on the first tick inside its window', () => {
    const task = TASK_WINDOWS.ingest_mrgov_listing;
    expect(isInWindow(task, utc('2026-01-15T03:19:00Z'))).toBe(false); // 05:19 JLM
    expect(isInWindow(task, utc('2026-01-15T03:30:00Z'))).toBe(true); // 05:30 JLM tick
    expect(isInWindow(task, utc('2026-01-15T03:49:00Z'))).toBe(true); // 05:49 JLM
    expect(isInWindow(task, utc('2026-01-15T03:50:00Z'))).toBe(false); // 05:50 JLM
  });

  it('digest build/send run Sun–Thu only', () => {
    const build = TASK_WINDOWS.digest_build;
    const send = TASK_WINDOWS.digest_send;
    // Sunday 2026-01-18: 07:00 JLM = 05:00 UTC (winter)
    expect(isInWindow(build, utc('2026-01-18T05:00:00Z'))).toBe(true);
    // Friday 2026-01-16: 07:00 JLM — not a send day
    expect(isInWindow(build, utc('2026-01-16T05:00:00Z'))).toBe(false);
    // Thursday ok; Saturday not
    expect(isInWindow(build, utc('2026-01-15T05:00:00Z'))).toBe(true); // Thu
    expect(isInWindow(build, utc('2026-01-17T05:00:00Z'))).toBe(false); // Sat
    // send window 07:30
    expect(isInWindow(send, utc('2026-01-18T05:30:00Z'))).toBe(true);
    expect(isInWindow(send, utc('2026-01-16T05:30:00Z'))).toBe(false);
  });

  it('housekeeping runs every day at 03:00', () => {
    const task = TASK_WINDOWS.housekeeping;
    expect(isInWindow(task, utc('2026-01-17T01:00:00Z'))).toBe(true); // Sat 03:00 JLM
    expect(isInWindow(task, utc('2026-01-18T01:00:00Z'))).toBe(true); // Sun
  });
});

describe('DST transition days', () => {
  it('spring forward (27 Mar 2026): 05:00 JLM = 02:00 UTC', () => {
    // day before (IST +2)
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-03-26T03:00:00Z'))).toBe(true);
    // transition day (IDT +3)
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-03-27T02:00:00Z'))).toBe(true);
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-03-27T03:00:00Z'))).toBe(false);
  });

  it('fall back (25 Oct 2026): 05:00 JLM = 03:00 UTC', () => {
    // day before (IDT +3)
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-10-24T02:00:00Z'))).toBe(true);
    // transition day (IST +2)
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-10-25T03:00:00Z'))).toBe(true);
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-10-25T02:00:00Z'))).toBe(false);
  });

  it('windows do not double-fire on the fall-back extra hour', () => {
    // On fall-back day, 05:00 JLM happens once (03:00 UTC). The tick at
    // 03:30 UTC is 05:30 JLM — outside the [05:00,05:30) window.
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-10-25T03:00:00Z'))).toBe(true);
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-10-25T03:30:00Z'))).toBe(false);
    expect(isInWindow(TASK_WINDOWS.ingest_datagov_beersheva, utc('2026-10-25T03:29:59Z'))).toBe(true);
  });
});
