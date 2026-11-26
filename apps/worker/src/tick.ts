import { isInWindow, TASK_WINDOWS, type TaskId } from '@michrazon/core';
import type { AlertSink, RunResult } from '@michrazon/ops';
import type { WorkerDeps } from './deps.ts';
import { runClassify } from './tasks/classify.ts';
import { runDigestBuild, runDigestRetry, runDigestSend } from './tasks/digest.ts';
import { runHousekeeping, runStalenessCheck } from './tasks/housekeeping.ts';
import { runIngest } from './tasks/ingest.ts';

// One cron tick: for every task whose Jerusalem window contains `now`, run it
// once. Per-day idempotency lives in RunRecorder (pipeline_runs), so a tick
// hitting the same window twice is a no-op.

export interface TickReport {
  ran: TaskId[];
  /** Tasks whose run was recorded with status `failed`. */
  failed: TaskId[];
}

export async function runTick(deps: WorkerDeps, alerts: AlertSink, now: Date): Promise<TaskId[]> {
  return (await runTickReport(deps, alerts, now)).ran;
}

export async function runTickReport(deps: WorkerDeps, alerts: AlertSink, now: Date): Promise<TickReport> {
  const ran: TaskId[] = [];
  const failed: TaskId[] = [];
  const maybe = async (id: TaskId, fn: () => Promise<RunResult | null>) => {
    if (!isInWindow(TASK_WINDOWS[id], now)) return;
    const result = await fn();
    ran.push(id);
    if (result?.status === 'failed') failed.push(id);
  };

  const datagov = deps.adapters['datagov_beersheva'];
  if (datagov) await maybe('ingest_datagov_beersheva', () => runIngest(deps, datagov));
  const mrgov = deps.adapters['mrgov_listing'];
  if (mrgov) await maybe('ingest_mrgov_listing', () => runIngest(deps, mrgov));
  await maybe('classify', () => runClassify(deps));
  await maybe('digest_build', () => runDigestBuild(deps));
  await maybe('digest_send', () => runDigestSend(deps));
  await maybe('digest_retry', () => runDigestRetry(deps));
  await maybe('housekeeping', () => runHousekeeping(deps));
  await maybe('staleness_check', () => runStalenessCheck(deps, alerts));
  return { ran, failed };
}
