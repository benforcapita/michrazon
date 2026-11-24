// Test-only helper: spins up an ephemeral Postgres cluster (embedded-postgres),
// applies db/migrations, and returns a ready Db + pool. Not for production use.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { applyMigrations } from './migrate';
import { PostgresDb } from './postgresDb';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

export interface TestDb {
  pg: EmbeddedPostgres;
  pool: Pool;
  db: PostgresDb;
  connectionString: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('could not allocate a free port');
  return port;
}

export async function startTestDb(): Promise<TestDb> {
  const databaseDir = mkdtempSync(join(tmpdir(), 'michrazon-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  const connectionString = `postgres://postgres:postgres@localhost:${port}/postgres`;
  const pool = new Pool({ connectionString });
  await applyMigrations(pool, MIGRATIONS_DIR);
  const db = new PostgresDb(pool);
  return {
    pg,
    pool,
    db,
    connectionString,
    async stop() {
      await pool.end().catch(() => undefined);
      await pg.stop().catch(() => undefined);
      rmSync(databaseDir, { recursive: true, force: true });
    },
  };
}
