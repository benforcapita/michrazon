-- 0002_rls.sql — deny-all RLS. All access goes through server-side code
-- (service role / dedicated roles). The browser never talks to the DB.
--
-- Supabase ships `anon`/`authenticated` roles; a plain Postgres does not, so
-- they are created only when missing.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

alter table sources enable row level security;
alter table tenders enable row level security;
alter table tender_classifications enable row level security;
alter table subscribers enable row level security;
alter table consents enable row level security;
alter table suppressions enable row level security;
alter table digests enable row level security;
alter table digest_items enable row level security;
alter table digest_deliveries enable row level security;
alter table pipeline_runs enable row level security;
alter table settings enable row level security;
-- No policies for anon/authenticated => deny all by default.

revoke all on all tables in schema public from anon, authenticated;
