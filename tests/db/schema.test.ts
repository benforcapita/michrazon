import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb, type TestDb } from '@michrazon/db/testing';

let t: TestDb;
let pool: Pool;

beforeAll(async () => {
  t = await startTestDb();
  pool = t.pool;
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('schema constraints', () => {
  it('seeds only the two allowed sources, both disabled', async () => {
    const r = await pool.query('select id, tier, enabled from sources order by id');
    expect(r.rows.map((x) => x.id)).toEqual(['datagov_beersheva', 'mrgov_listing']);
    expect(r.rows.every((x) => x.enabled === false)).toBe(true);
  });

  it('AC-01 (DB side): rejects red hosts in sources', async () => {
    await expect(
      pool.query(
        `insert into sources(id,tier,host,enabled,min_interval_s,max_requests_per_run,attribution_text)
         values ('tlv','green','tel-aviv.gov.il',false,5,10,'x')`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `insert into sources(id,tier,host,enabled,min_interval_s,max_requests_per_run,attribution_text)
         values ('jlm','green','x.jerusalem.muni.il',false,5,10,'x')`,
      ),
    ).rejects.toThrow();
  });

  it('AC-03 (DB side): tenders.official_url CHECK rejects document-like URLs', async () => {
    for (const url of [
      'https://mr.gov.il/x/booklet.pdf',
      'https://mr.gov.il/x/attachment/ABC',
      'https://mr.gov.il/x/price.docx',
    ]) {
      await expect(
        pool.query(
          `insert into tenders(source_id,source_tender_id,title,official_url,content_hash)
           values ('mrgov_listing',$1,'t',$2,'h')`,
          [`t-${Math.random()}`, url],
        ),
      ).rejects.toThrow();
    }
    // a normal listing URL passes
    await expect(
      pool.query(
        `insert into tenders(source_id,source_tender_id,title,official_url,content_hash)
         values ('mrgov_listing','ok-1','t','https://mr.gov.il/officestenders/Pages/officetender.aspx?p=1','h')`,
      ),
    ).resolves.toBeDefined();
  });

  it('yellow source rows may not carry open_data_fields (trigger)', async () => {
    await expect(
      pool.query(
        `insert into tenders(source_id,source_tender_id,title,official_url,content_hash,open_data_fields)
         values ('mrgov_listing','y-1','t','https://mr.gov.il/listing/1','h','{"a":1}')`,
      ),
    ).rejects.toThrow(/yellow source/);
    // green may carry them
    await expect(
      pool.query(
        `insert into tenders(source_id,source_tender_id,title,official_url,content_hash,open_data_fields)
         values ('datagov_beersheva','g-1','t','https://data.gov.il/dataset/x','h','{"a":1}')`,
      ),
    ).resolves.toBeDefined();
  });

  it('AC-22: billing_enabled=true fails while legal_gate_cleared_at is null', async () => {
    await expect(
      pool.query(`update settings set value = 'true' where key = 'billing_enabled'`),
    ).rejects.toThrow(/legal_gate_cleared_at/);
    // once the gate is set, enabling succeeds
    await pool.query(`update settings set value = '"2026-11-24T00:00:00Z"' where key = 'legal_gate_cleared_at'`);
    await expect(
      pool.query(`update settings set value = 'true' where key = 'billing_enabled'`),
    ).resolves.toBeDefined();
  });
});

describe('RLS', () => {
  it('AC-29: RLS is enabled on every app table', async () => {
    const tables = [
      'sources',
      'tenders',
      'tender_classifications',
      'subscribers',
      'consents',
      'suppressions',
      'digests',
      'digest_items',
      'digest_deliveries',
      'pipeline_runs',
      'settings',
    ];
    const r = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relname = any($1::text[])`,
      [tables],
    );
    const map = Object.fromEntries(r.rows.map((x) => [x.relname, x.relrowsecurity]));
    for (const table of tables) expect(map[table], table).toBe(true);
  });

  it('AC-29: anon role cannot read app tables', async () => {
    await expect(pool.query('set role anon; select count(*) from tenders')).rejects.toThrow();
    await expect(pool.query('set role authenticated; select count(*) from subscribers')).rejects.toThrow();
  });
});

describe('schema lint', () => {
  it('no document-body columns exist anywhere', async () => {
    const r = await pool.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and column_name ~* '(pdf|booklet|document|attachment)_?(body|blob|text|content)'`,
    );
    expect(r.rows).toEqual([]);
  });

  it('no IP / user-agent / session / cookie columns (zero tracking)', async () => {
    const r = await pool.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and column_name ~* '^(ip|ip_address|user_agent|ua|session|session_id|referrer|cookie)'`,
    );
    expect(r.rows).toEqual([]);
  });
});
