import { Pool, type PoolConfig } from 'pg';

export function createPool(config?: PoolConfig): Pool {
  return new Pool(config ?? { connectionString: process.env['DB_URL_WORKER'] });
}
