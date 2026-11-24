// Asia/Jerusalem clock + task windows (LLD §11). Railway cron ticks every 30
// minutes; these helpers answer "are we in this task's window?" and "what is
// today's Jerusalem date?" — DST-safe via Intl (no manual offset math).

export const JERUSALEM_TZ = 'Asia/Jerusalem';

export interface LocalParts {
  date: string; // YYYY-MM-DD
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=Sun .. 6=Sat
  hour: number;
  minute: number;
  minuteOfDay: number;
}

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: JERUSALEM_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

export function jerusalemParts(now: Date): LocalParts {
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const hour = Number(parts['hour']);
  const minute = Number(parts['minute']);
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    weekday: weekdayMap[parts['weekday'] ?? ''] ?? -1,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  };
}

export function jerusalemDate(now: Date): string {
  return jerusalemParts(now).date;
}

// ---------- task windows ----------
// Cron ticks every 30 minutes; a task "runs" when the tick lands inside
// [startMinuteOfDay, startMinuteOfDay + TICK_MINUTES).

export const TICK_MINUTES = 30;

const SUNDAY_TO_THURSDAY = [0, 1, 2, 3, 4] as const;

export interface TaskWindow {
  id: string;
  /** Asia/Jerusalem local start, minutes after midnight. */
  startMinuteOfDay: number;
  /** Allowed weekdays (0=Sun). Empty = every day. */
  days: readonly number[];
}

const hm = (h: number, m: number) => h * 60 + m;

export const TASK_WINDOWS = {
  ingest_datagov_beersheva: { id: 'ingest_datagov_beersheva', startMinuteOfDay: hm(5, 0), days: [] },
  ingest_mrgov_listing: { id: 'ingest_mrgov_listing', startMinuteOfDay: hm(5, 20), days: [] },
  classify: { id: 'classify', startMinuteOfDay: hm(6, 0), days: [] },
  digest_build: { id: 'digest_build', startMinuteOfDay: hm(7, 0), days: SUNDAY_TO_THURSDAY },
  digest_send: { id: 'digest_send', startMinuteOfDay: hm(7, 30), days: SUNDAY_TO_THURSDAY },
  digest_retry: { id: 'digest_retry', startMinuteOfDay: hm(8, 30), days: SUNDAY_TO_THURSDAY },
  housekeeping: { id: 'housekeeping', startMinuteOfDay: hm(3, 0), days: [] },
  staleness_check: { id: 'staleness_check', startMinuteOfDay: hm(8, 45), days: [] },
} as const satisfies Record<string, TaskWindow>;

export type TaskId = keyof typeof TASK_WINDOWS;

/**
 * Is `now` inside the task's window? Window covers [start, start+TICK) local
 * time on an allowed weekday.
 */
export function isInWindow(task: TaskWindow, now: Date): boolean {
  const p = jerusalemParts(now);
  if (task.days.length > 0 && !task.days.includes(p.weekday)) return false;
  const sinceStart = p.minuteOfDay - task.startMinuteOfDay;
  return sinceStart >= 0 && sinceStart < TICK_MINUTES;
}

/** True when the task should run this tick (window open). Caller checks
 * `pipeline_runs` for whether today's run already happened. */
export function shouldRunTask(task: TaskWindow, now: Date): boolean {
  return isInWindow(task, now);
}
