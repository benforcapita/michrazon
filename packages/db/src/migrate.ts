// Applies db/migrations/*.sql in filename order, recorded in schema_migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export interface AppliedMigration {
  filename: string;
}

export async function applyMigrations(
  pool: Pool | PoolClient,
  migrationsDir: string,
): Promise<AppliedMigration[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  await pool.query(
    'create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())',
  );
  const done = await pool.query<{ filename: string }>('select filename from schema_migrations');
  const applied = new Set(done.rows.map((r) => r.filename));
  const out: AppliedMigration[] = [];
  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    const client = 'connect' in pool ? await pool.connect() : (pool as PoolClient);
    const release = 'connect' in pool;
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(filename) values ($1)', [filename]);
      await client.query('commit');
      out.push({ filename });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      if (release) (client as PoolClient).release();
    }
  }
  return out;
}
