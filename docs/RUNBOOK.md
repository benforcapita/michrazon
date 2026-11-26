# Michrazon runbook (MVP)

Operational guide for deploy and day-2. Nothing here is automatic — every
step is a deliberate action by Ben.

## Architecture

- `apps/web` (Vercel): public pages + API. No cookies, sessions, analytics.
- `apps/worker` (Railway cron `*/30 * * * *`): one tick dispatches tasks whose
  Asia/Jerusalem window is open. Task windows: housekeeping 03:00, ingest
  datagov 05:00 + mrgov 05:20, classify 06:00, digest build 07:00 + send 07:30
  + retry 08:30 (Sun–Thu), staleness 08:45.
- Postgres (Supabase): RLS deny-all; app connects with service role.
- Resend: transactional mail. **Open/click tracking must be off on the
  sending domain** — the deploy check fails otherwise (AC-11).

## First deploy checklist

1. Create Postgres (Supabase). Apply `db/migrations` in order.
2. Vercel project → root `apps/web`. Env: `APP_BASE_URL`, `DB_URL_WEB`,
   `TOKEN_HMAC_SECRET`, `TOKEN_HMAC_KID`, `RESEND_API_KEY` (send-limited key if
   available), `RESEND_WEBHOOK_SECRET`, `SENDING_DOMAIN`, `REPLY_TO`,
   `INTERNAL_HEALTH_TOKEN`.
3. Railway service → `apps/worker` (config in `apps/worker/railway.json`):
   build `pnpm build:worker` (tsc → `dist/` for the worker and its workspace
   packages), start `node --conditions=dist dist/index.js --once` (same as
   `pnpm --filter @michrazon/worker start`), cron `*/30 * * * *`. Env: `DB_URL_WORKER`,
   `TOKEN_HMAC_SECRET`, `TOKEN_HMAC_KID`, `RESEND_API_KEY`, `LLM_*`,
   `DATAGOV_*`, `MRGOV_LISTING_URL`, `SENDING_DOMAIN`, `OPS_ALERT_TO`,
   `UA_PRODUCT_URL`, `UA_CONTACT`.
4. Resend: verify sending domain; subscribe webhook to `email.bounced` +
   `email.complained` ONLY; point it at `/api/webhooks/resend`.
   Run the domain tracking check (`checkDomainTracking` /
   `assertTrackingOff`) — deploy fails closed if tracking is on.
5. Enable a source deliberately: `update sources set enabled = true where id =
   'datagov_beersheva'` — staging first per LLD §17.
6. Smoke (staging DB, sends nothing): `pnpm build:worker`, then from
   `apps/worker` run
   `node --conditions=dist dist/index.js --once --at=<a Sun–Thu 07:10 Asia/Jerusalem instant>`
   (e.g. `--at=2026-01-18T05:10:00Z`). Only the digest build window is open
   at that time, so it builds the digest and sends no mail. Exit 0 = every
   task that ran finished ok/partial; exit 1 = bad flag, missing config, DB
   unreachable or a task recorded `failed`. `--at` only moves the tick clock.
   CI runs the same command against an ephemeral Postgres
   (`tests/worker/start.test.ts`).

## Legal gate (AC-21/22)

`settings.billing_enabled` stays `false` until lawyer review; setting it true
while `legal_gate_cleared_at` is null fails in DB trigger AND in
`loadConfig`/`assertBillingGate`. After review: set
`legal_gate_cleared_at`, then `billing_enabled`.

## Classifier (PRO-812)

The pilot worker classifies with **TypeSafe Jev** (`LLM_PROVIDER=jev`) via the
System One HTTP API — no extra runtime or build step; it is plain `fetch` from
the Node worker. If Jev errors, the key is unset, or the API is down, each
tender falls back to a **keyword-only** classifier; the classify run is then
recorded `partial` with the reason on `pipeline_runs` (warn alert to
`OPS_ALERT_TO`). It never fails the tick.

Worker env (Railway → michrazon → worker → Variables; Ben fills values):

- `LLM_PROVIDER=jev`
- `TYPESAFE_API_KEY=` — secret, empty key created for Ben to paste
- `TYPESAFE_MODEL=` — optional; unset uses the service default model
- `JEV_MIN_CONFIDENCE=0.55` — digest confidence gate for the jev path
- `JEV_TIMEOUT_MS=15000` — bound on each TypeSafe call; a hang aborts and
  falls back to the keyword classifier (`partial` run, never blocks the tick)
- `SUMMARIES_ENABLED=false` — pilot digests render title, publisher,
  deadline and listing link only; stored `summary_he` is never sent
- `LLM_API_KEY` is **not required** for the jev path (leave unset)

To create the empty placeholder keys on Railway (writes the non-secret
values, leaves `TYPESAFE_*` empty for Ben):

```sh
RAILWAY_TOKEN=<token> node scripts/railway/create-worker-env-stubs.ts
# preview only:
node scripts/railway/create-worker-env-stubs.ts --dry-run
```

Variable changes may trigger a redeploy of the worker service — run it when
a restart of the cron tick is acceptable. If a project-scoped token can't
resolve names, pass `RAILWAY_PROJECT_ID` / `RAILWAY_ENVIRONMENT_ID` /
`RAILWAY_SERVICE_ID` explicitly.

Set `LLM_PROVIDER=chat_completions` + `LLM_API_KEY` + `LLM_MODEL` to use the
OpenAI-compatible path instead (kept in-tree, not the pilot path).

## Monitoring

- `GET /api/health?token=$INTERNAL_HEALTH_TOKEN` → `{db:true}` (404 without it).
- `pipeline_runs` is the source of truth: failed/partial runs page
  `OPS_ALERT_TO` via `EmailAlertSink`.
- Daily staleness check (08:45) alerts when a source yields zero new tenders
  for 3 days.
- LLM spend: `select sum(input_tokens), sum(output_tokens) from
  tender_classifications where created_at::date = current_date`.

## Failure modes (LLD §13)

- Source 403/blocked → source stops for the run, alert, no bypass.
- >30% skipped records → run fails (markup change) + alert.
- `LLM_DAILY_BUDGET` reached → classify stops, alert, next run resumes.
- Resend failure → `attempts++`, retried in the 08:30 window (max 3).
- DB down → worker run fails and the process exits 1; no send ever skips the suppression check.

## Key rotation

`TOKEN_HMAC_SECRET` supports `kid` rotation: add `TOKEN_HMAC_KID=k2` + new
secret value on both apps, keep old secret under `k1` until old tokens expire
(48h confirm / 30d prefs; unsubscribe tokens never expire — keep `k1` until
you accept older unsubscribe links breaking).
