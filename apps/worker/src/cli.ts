import { parseArgs } from 'node:util';
import type { TaskId } from '@michrazon/core';
import type { AlertSink } from '@michrazon/ops';
import { consoleLogger, type WorkerDeps } from './deps.ts';
import { runTickReport } from './tick.ts';

export interface WorkerCliIo {
  build: (env: Record<string, string | undefined>) => {
    deps: WorkerDeps;
    alerts: AlertSink;
    close: () => Promise<void>;
  };
  log?: Pick<typeof consoleLogger, 'info' | 'error'>;
}

/**
 * `node dist/index.js --once [--at=<ISO-8601>]`: run exactly one tick and
 * resolve to the process exit code — 0 when every task that ran finished
 * ok/partial, 1 on a bad flag, missing config, a thrown error or any task
 * whose run was recorded as failed. `--at` overrides the tick clock (smoke
 * tests, manual catch-up of a missed window).
 */
export async function runWorkerCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: WorkerCliIo,
): Promise<0 | 1> {
  const log = io.log ?? consoleLogger;
  let at: Date | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { once: { type: 'boolean' }, at: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    if (values.at !== undefined) {
      at = new Date(values.at);
      if (Number.isNaN(at.getTime())) throw new Error(`--at is not a valid date: ${values.at}`);
    }
  } catch (e) {
    log.error('worker: bad arguments', { error: e instanceof Error ? e.message : String(e) });
    return 1;
  }

  let close: (() => Promise<void>) | undefined;
  try {
    const built = io.build(env);
    close = built.close;
    const now = at ?? built.deps.now();
    const { ran, failed } = await runTickReport(built.deps, built.alerts, now);
    log.info('tick complete', { at: now.toISOString(), ran, failed });
    return failed.length === 0 ? 0 : 1;
  } catch (e) {
    log.error('tick failed', { error: e instanceof Error ? e.message : String(e) });
    return 1;
  } finally {
    await close?.().catch(() => undefined);
  }
}

export type { TaskId };
