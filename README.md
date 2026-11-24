# michrazon — מכרזון

Hebrew daily email alerts for new Israeli public tenders relevant to **software, digital and AI vendors** (small dev shops, agencies, freelancers), each with a short AI summary and a link to the official source.

## Status
- **Design approved for ticketing only. Development has NOT started.** Every implementation ticket waits for Ben's explicit go.
- Design: HLD + LLD tracked on Linear `PRO-771`.
- Repo is **public only for the duration of active development** (free GitHub Actions); it goes back to private when the project ends.

## Hard constraints (enforced in code, not only in process)
- Sources: `data.gov.il` (GREEN, with attribution). `mr.gov.il` (YELLOW): listing facts + official link only. Never fetch, store or summarize tender booklets/PDFs.
- **Excluded:** Tel Aviv-Yafo (`tel-aviv.gov.il`) and Jerusalem. Never crawled.
- **Zero tracking:** no open tracking, no click tracking, no sessions, no analytics.
- Double opt-in, one-click unsubscribe (RFC 8058), immediate suppression.
- Billing stays behind a feature flag (OFF) until a lawyer has reviewed the `mr.gov.il` terms.

## Contribution rules
- PRs are opened by `devin-ai-integration` only; replacement PRs rebase on `main`.
- Small PRs, one owned path set per ticket, green CI + proof.

## License
MIT

## Monorepo layout

pnpm + TypeScript workspace. Packages and apps:

- `packages/core` — types, config, `Db` port, source guard, http, rate limiter, hash, tokens, clock
- `packages/adapters` — `datagov-beersheva`, `mrgov-listing`, disabled stubs
- `packages/llm` — classifier/summarizer behind a provider port
- `packages/mail` — RTL templates + suppression-aware Resend sender (tracking OFF)
- `packages/ops` — pipeline run recorder + ops alerts
- `packages/db` — Postgres implementation of the `Db` port
- `apps/web` — Vercel Next.js public flows + webhooks + health
- `apps/worker` — Railway worker (ingest / classify / digest / housekeeping)
- `db/migrations` — Postgres/Supabase schema
- `tests` — unit, contract, db, e2e, compliance

## Scripts

- `pnpm lint` — eslint (adapters may not call global `fetch`; `ctx.http` only)
- `pnpm typecheck` — `tsc --noEmit` across workspace
- `pnpm test` — vitest
- `pnpm ci:secret-scan` — tracked-file secret scan
- `pnpm ci:guard` — red-domain (AC-01/T-GUARD-1) and 2021-dataset (AC-06) greps
