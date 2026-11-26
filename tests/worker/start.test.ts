// PRO-800: the documented worker start path (railway.json startCommand ==
// apps/worker `pnpm start`) must build with tsc and run one tick from dist/.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDb, type TestDb } from '@michrazon/db/testing';
import type { WorkerDeps } from '../../apps/worker/src/deps';
import { runWorkerCli } from '../../apps/worker/src/cli';
import { MemoryAlertSink } from '@michrazon/ops';
import { silentLogger } from '../helpers/mockHttp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER_DIR = join(ROOT, 'apps/worker');
// Sun 2026-01-18 07:10 Asia/Jerusalem: only the digest_build window is open.
const DIGEST_BUILD_AT = '2026-01-18T05:10:00Z';

const railway = JSON.parse(readFileSync(join(WORKER_DIR, 'railway.json'), 'utf8')) as {
  build: { buildCommand: string };
  deploy: { startCommand: string };
};
const workerPkg = JSON.parse(readFileSync(join(WORKER_DIR, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function runStart(extraArgs: string[], env: Record<string, string>) {
  const [cmd, ...args] = railway.deploy.startCommand.split(' ');
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      cmd!,
      [...args, ...extraArgs],
      { cwd: WORKER_DIR, env: { PATH: process.env.PATH ?? '', ...env } },
      (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

describe('worker start path (compiled dist)', () => {
  let tdb: TestDb;

  beforeAll(async () => {
    execFileSync('pnpm', ['run', 'build:worker'], { cwd: ROOT, stdio: 'pipe' });
    tdb = await startTestDb();
  }, 180_000);

  afterAll(async () => {
    await tdb?.stop();
  });

  it('railway.json, package.json start and the runbook agree on one compiled command', () => {
    expect(railway.deploy.startCommand).toBe('node --conditions=dist dist/index.js --once');
    expect(workerPkg.scripts['start']).toBe(railway.deploy.startCommand);
    expect(railway.build.buildCommand).toBe('pnpm build:worker');
    expect(railway.deploy.startCommand).not.toMatch(/src\/index\.ts|tsx/);
    const runbook = readFileSync(join(ROOT, 'docs/RUNBOOK.md'), 'utf8');
    expect(runbook).toContain(railway.deploy.startCommand);
    expect(runbook).toContain(railway.build.buildCommand);
    // The worker smoke path is a real `--once` tick. The only `--dry-run` left
    // in the runbook is the Railway env-stub preview from PRO-812, which is a
    // different command (`create-worker-env-stubs.ts --dry-run`).
    expect(runbook).not.toMatch(/worker [`']?--once[`']? dry-run/i);
    expect(runbook).not.toMatch(/dry-run prints the digest/i);
  });

  it('--once runs one full tick against Postgres and exits 0', async () => {
    const env = { DB_URL_WORKER: tdb.connectionString, TOKEN_HMAC_SECRET: 'smoke-secret' };
    const res = await runStart([`--at=${DIGEST_BUILD_AT}`], env);
    expect(res.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('tick complete');
    expect(res.stdout).toContain('digest_build');

    const runs = await tdb.pool.query<{ kind: string; status: string }>(
      `select kind::text, status::text from pipeline_runs order by id`,
    );
    expect(runs.rows).toEqual([{ kind: 'digest', status: 'ok' }]);

    // Same window again: idempotent skip, still exit 0, no new run row.
    const again = await runStart([`--at=${DIGEST_BUILD_AT}`], env);
    expect(again.code).toBe(0);
    const count = await tdb.pool.query<{ n: string }>(
      `select count(*)::text as n from pipeline_runs`,
    );
    expect(count.rows[0]!.n).toBe('1');
  }, 60_000);

  it('exits 1 when required config is missing (fails on config, not module resolution)', async () => {
    const res = await runStart([], {});
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('DB_URL_WORKER is required');
    expect(res.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  }, 30_000);

  it('exits 1 when the database is unreachable', async () => {
    const res = await runStart([`--at=${DIGEST_BUILD_AT}`], {
      DB_URL_WORKER: 'postgres://postgres:postgres@127.0.0.1:1/postgres',
      TOKEN_HMAC_SECRET: 'smoke-secret',
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('tick failed');
  }, 30_000);

  it('exits 1 on an unknown flag or an invalid --at', async () => {
    expect((await runStart(['--dry-run'], {})).code).toBe(1);
    expect((await runStart(['--at=not-a-date'], {})).code).toBe(1);
  }, 30_000);
});

describe('runWorkerCli exit codes', () => {
  const build = (status: 'ok' | 'partial' | 'failed') => () => ({
    deps: {
      adapters: {},
      now: () => new Date(DIGEST_BUILD_AT),
      recorder: { runOnce: async () => ({ status }) },
    } as unknown as WorkerDeps,
    alerts: new MemoryAlertSink(),
    close: async () => undefined,
  });

  it.each([
    ['ok', 0],
    ['partial', 0],
    ['failed', 1],
  ] as const)('task status %s -> exit %d', async (status, code) => {
    expect(await runWorkerCli(['--once'], {}, { build: build(status), log: silentLogger })).toBe(
      code,
    );
  });

  it('closes the pool even when the tick throws', async () => {
    let closed = false;
    const code = await runWorkerCli(
      [],
      {},
      {
        build: () => ({
          deps: {
            adapters: {},
            now: () => new Date(DIGEST_BUILD_AT),
            recorder: {
              runOnce: async () => {
                throw new Error('boom');
              },
            },
          } as unknown as WorkerDeps,
          alerts: new MemoryAlertSink(),
          close: async () => {
            closed = true;
          },
        }),
        log: silentLogger,
      },
    );
    expect(code).toBe(1);
    expect(closed).toBe(true);
  });
});
