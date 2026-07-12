# Airbnb Operations Calendar

Internal operations application for Airbnb iCal synchronization, local blocks,
private notes, and a single-team cleaning queue.

## Detected/selected stack

- Next.js App Router with TypeScript
- Supabase Auth
- Supabase-managed Postgres with SQL migrations
- Vitest, Testing Library, and Playwright
- Vercel application hosting; an external server calls the protected sync route

## Local setup

1. Copy `.env.example` to `.env.local` and provide Supabase/Postgres values.
2. Run the SQL files in `supabase/migrations` in filename order.
3. Run `npm install` and `npm run dev`.

`DEMO_MODE=true` provides synthetic, non-persistent data for local interface QA.
It must not be enabled in a production deployment.

Production setup, server cron installation, and the controlled one-listing pilot
are documented in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Phase 0 audit

This is a new repository, so there were no reusable components, migrations, or
user changes to preserve. Production rollout depends on Supabase credentials,
Vercel configuration, the external cron host, and a synthetic/test Airbnb iCal
URL. A real one-listing pilot remains an operator-controlled deployment step.
