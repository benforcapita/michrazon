import { isInWindow, TASK_WINDOWS, type TaskId } from '@michrazon/core';
import type { AlertSink } from '@michrazon/ops';
import type { WorkerDeps } from './deps';
import { runClassify } from './tasks/classify';
import { runDigestBuild, runDigestRetry, runDigestSend } from './tasks/digest';
import { runHousekeeping, runStalenessCheck } from './tasks/housekeeping';
import { runIngest } from './tasks/ingest';

// One cron tick: for every task whose Jerusalem window contains `now`, run it
// once. Per-day idempotency lives in RunRecorder (pipeline_runs), so a tick
// hitting the same window twice is a no-op.

export async function runTick(deps: WorkerDeps, alerts: AlertSink, now: Date): Promise<TaskId[]> {
  const ran: TaskId[] = [];
  const maybe = async (id: TaskId, fn: () => Promise<unknown>) => {
    if (!isInWindow(TASK_WINDOWS[id], now)) return;
    await fn();
    ran.push(id);
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
  return ran;
}
