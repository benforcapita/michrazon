-- 0001_init.sql — Michrazon schema (LLD §3) + RLS + billing legal-gate trigger.
create extension if not exists pgcrypto;

-- ---------- enums ----------
create type source_tier as enum ('green','yellow');           -- red never stored as a source
create type subscriber_status as enum
  ('pending','active','unsubscribed','cancelled','bounced','complained');
create type plan_type as enum ('pilot','paid');
create type consent_event as enum
  ('signup_submitted','confirmed','unsubscribed','cancelled','bounced','complained','resubscribe_requested');
create type run_kind as enum ('ingest','classify','digest','housekeeping');
create type run_status as enum ('running','ok','partial','failed');
create type delivery_status as enum ('queued','sent','failed','skipped_suppressed');

-- ---------- sources ----------
create table sources (
  id            text primary key,                 -- e.g. 'datagov_beersheva', 'mrgov_listing'
  tier          source_tier not null,
  host          text not null,                    -- must match allowlist in code (double check)
  enabled       boolean not null default false,
  min_interval_s integer not null check (min_interval_s >= 1),
  max_requests_per_run integer not null check (max_requests_per_run between 1 and 500),
  attribution_text text not null,                 -- shown in email footer
  notes         text,
  -- DB-level backstop for RED sources (code allowlist is primary control)
  constraint no_red_hosts check (
    host !~* '(^|\.)tel-aviv\.gov\.il$' and host !~* '(^|\.)jerusalem\.muni\.il$'
  )
);

-- ---------- tenders (facts only) ----------
create table tenders (
  id              uuid primary key default gen_random_uuid(),
  source_id       text not null references sources(id),
  source_tender_id text not null,                 -- tender ID as published by the source
  title           text not null,
  publisher       text,
  published_at    date,
  submission_deadline timestamptz,
  official_url    text not null,                  -- link to official listing page (not an attachment)
  -- extra facts allowed ONLY for green sources (open data); null for yellow
  open_data_fields jsonb,                         -- validated by adapter schema; never for yellow
  content_hash    text not null,                  -- sha256 over canonical allowlisted fields
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  retired_at      timestamptz,
  unique (source_id, source_tender_id),
  constraint official_url_not_document check (
    official_url !~* '\.(pdf|docx?|xlsx?|zip|rar)(\?|#|$)' and official_url !~* '/attachment/'
  )
);
create index tenders_first_seen on tenders(first_seen_at desc);
create index tenders_hash on tenders(content_hash);

-- trigger: yellow-source rows may not carry open_data_fields
create function enforce_yellow_facts_only() returns trigger language plpgsql as $$
begin
  if (select tier from sources where id = new.source_id) = 'yellow'
     and new.open_data_fields is not null then
    raise exception 'yellow source: only listing facts allowed';
  end if;
  return new;
end $$;
create trigger trg_yellow_facts before insert or update on tenders
  for each row execute function enforce_yellow_facts_only();

-- ---------- classifications ----------
create table tender_classifications (
  id             uuid primary key default gen_random_uuid(),
  tender_id      uuid not null references tenders(id) on delete cascade,
  input_hash     text not null,                   -- = tenders.content_hash at classification time
  model_id       text not null,
  prompt_version text not null,
  is_relevant    boolean not null,
  confidence     numeric(3,2) not null check (confidence between 0 and 1),
  category       text not null,
  summary_he     text,                            -- <= 280 chars; null if not relevant
  facts_used     text[] not null,
  uncertain      boolean not null default false,
  status         text not null check (status in ('ok','needs_review','failed')),
  input_tokens   integer, output_tokens integer,
  created_at     timestamptz not null default now(),
  unique (tender_id, input_hash, prompt_version)
);

-- ---------- subscribers ----------
create table subscribers (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  email_norm    text generated always as (lower(btrim(email))) stored,
  status        subscriber_status not null default 'pending',
  plan          plan_type not null default 'pilot',
  pilot_ends_at timestamptz,
  keywords      text[] not null default '{}',
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  ended_at      timestamptz,
  unique (email_norm)
);

create table consents (                           -- append-only consent ledger
  id            bigserial primary key,
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  event         consent_event not null,
  at            timestamptz not null default now(),
  text_version  text not null                     -- version of consent wording shown
  -- deliberately NO ip / user_agent columns (zero tracking). See "Open question" LLD-Q2.
);

create table suppressions (                       -- survives subscriber deletion
  email_norm    text primary key,
  reason        text not null check (reason in ('unsubscribe','cancel','bounce','complaint','manual')),
  created_at    timestamptz not null default now()
);

-- ---------- digests ----------
create table digests (
  id          uuid primary key default gen_random_uuid(),
  digest_date date not null unique,               -- Asia/Jerusalem calendar date
  built_at    timestamptz,
  item_count  integer not null default 0
);
create table digest_items (
  digest_id   uuid references digests(id) on delete cascade,
  tender_id   uuid references tenders(id),
  classification_id uuid references tender_classifications(id),
  position    integer not null,
  primary key (digest_id, tender_id)
);
create table digest_deliveries (
  digest_id     uuid references digests(id) on delete cascade,
  subscriber_id uuid references subscribers(id) on delete cascade,
  status        delivery_status not null default 'queued',
  resend_message_id text,
  error         text,
  attempts      integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (digest_id, subscriber_id)          -- idempotency: no double send
);

-- ---------- ops ----------
create table pipeline_runs (
  id          bigserial primary key,
  kind        run_kind not null,
  source_id   text references sources(id),
  status      run_status not null default 'running',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  counts      jsonb not null default '{}'::jsonb,   -- fetched/new/updated/skipped/errors
  error       text
);
create table settings (
  key   text primary key,
  value jsonb not null
);
insert into settings(key,value) values
  ('mode','"pilot"'),
  ('billing_enabled','false'),
  ('legal_gate_cleared_at','null'),
  ('relevance_threshold','null');                  -- TBD: calibrated in week 2

-- ---------- billing legal gate (AC-22) ----------
-- billing_enabled may not be set to true while legal_gate_cleared_at is null.
create function enforce_billing_gate() returns trigger language plpgsql as $$
declare gate jsonb;
begin
  if new.key = 'billing_enabled' and new.value = 'true'::jsonb then
    select value into gate from settings where key = 'legal_gate_cleared_at';
    if gate is null or gate = 'null'::jsonb then
      raise exception 'billing_enabled requires legal_gate_cleared_at (lawyer review)';
    end if;
  end if;
  return new;
end $$;
create trigger trg_billing_gate before insert or update on settings
  for each row execute function enforce_billing_gate();

-- ---------- seed sources (disabled until enabled by a deliberate change) ----------
insert into sources(id,tier,host,enabled,min_interval_s,max_requests_per_run,attribution_text) values
 ('datagov_beersheva','green','data.gov.il',false,5,20,
  'מקור הנתונים: data.gov.il, מאגר "מכרזים בעיר באר שבע", ברישיון הנתונים הפתוחים. שירות פרטי, אינו קשור לגוף ממשלתי.'),
 ('mrgov_listing','yellow','mr.gov.il',false,10,60,
  'פרטי המכרז מוצגים כעובדות מעמוד הרישום ב-mr.gov.il, עם קישור למקור. שירות פרטי, אינו קשור לגוף ממשלתי.');
