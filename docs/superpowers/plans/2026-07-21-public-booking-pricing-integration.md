# Public Booking, Pricing, and Payment Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, admin-owned booking system with authoritative pricing, concurrency-safe inventory, ten-minute holds, Razorpay Test Mode payments/refunds, Zoho transactional email, admin pricing/bookings interfaces, and a separate public website integration.

**Architecture:** The production admin Vercel deployment and its existing Supabase/Postgres database own every booking, price, hold, payment, refund, and active night. The separately deployed public website contains no database or provider credentials; its same-origin server routes call a versioned admin API with timestamped, nonce-protected HMAC signatures. Every inventory writer uses one property-scoped PostgreSQL transaction lock plus a partial unique active-night index, and public booking remains disabled until manual-entry/iCal shadow parity passes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, PostgreSQL/Supabase, `postgres`, Zod 4, Vitest, Testing Library, Playwright, Node `crypto`, Razorpay Orders/Webhooks/Refunds APIs, Zoho ZeptoMail API, sanitized static HTML/JavaScript.

---

## Repository and Worktree Rules

- Admin repository: `/Users/retyush/airbnb-operations-calendar`
- Public website worktree: `/Users/retyush/Downloads/webzip_1783892501_single/.worktrees/noir-haus-ui-parity`
- Approved specification: `docs/superpowers/specs/2026-07-21-public-booking-pricing-integration-design.md`
- Never apply a production migration, push `noirhaus/main`, enable public booking, or switch Razorpay to Live Mode without a separate user-confirmed rollout step.
- Preserve the public worktree's existing sanitized-site changes. Commit that verified baseline before adding booking changes.
- Create an isolated admin feature worktree from the commit containing this plan. Do not implement directly on `deploy-noirhaus-main`.

## File Structure

### Admin repository

- Create `supabase/migrations/0007_public_booking.sql` and `.down.sql`: booking, rates, inventory, idempotency, payment, outbox, and audit schema.
- Modify `src/lib/db/migration.test.ts`: migration contract and partial-index assertions.
- Create `vitest.db.config.ts`, `src/test/db-global-setup.ts`, and `src/test/auth-fixture.sql`: real-Postgres integration-test harness.
- Create `src/features/pricing/*`: strict rate schemas, quote calculation, persistence, and admin UI.
- Create `src/features/inventory/*`: date expansion, advisory locking, active-night claims, reconciliation, backfill, and shadow comparison.
- Modify `src/features/calendar/entry-service.ts`: route all manual entry mutations through inventory transactions.
- Modify `src/features/sync/sync-service.ts`: reconcile inbound iCal through the same inventory transaction and surface collisions.
- Create `src/features/internal-api/*`: canonical HMAC signing/verification, nonce persistence, strict schemas, and error mapping.
- Create `src/features/bookings/*`: idempotent booking attempts, public status, hold lifecycle, confirmation, expiry, collision cancellation, and audit events.
- Create `src/features/payments/*`: Razorpay order, webhook, reconciliation, refund, and durable-job adapters.
- Create `src/features/email/*`: Zoho ZeptoMail adapter, templates, outbox, and retries.
- Create admin routes under `src/app/api/internal/v1`, `src/app/api/webhooks/razorpay`, and authenticated pricing/bookings routes.
- Create dashboard pages under `src/app/(dashboard)/pricing` and `src/app/(dashboard)/bookings`.
- Modify `src/features/calendar/*`, `src/components/app-shell.tsx`, and `src/app/globals.css`: display holds, confirmed website bookings, and alerts.
- Modify `.env.example`, `DEPLOYMENT.md`, `ops/crontab.example`; create `ops/trigger-booking-jobs.sh`.

### Public website repository

- Create `src/features/booking-api/*`: matching HMAC client, strict proxy schemas, and admin response mapping.
- Create same-origin routes under `src/app/api/booking/*`.
- Modify `src/proxy.ts` and `src/lib/auth/public-paths.ts`: expose only public pages/assets and booking proxy routes.
- Modify `.env.example`: remove admin/database provider configuration and document only the admin API URL plus HMAC credentials.
- Create `scripts/public-site-assets/booking.js`: availability, guest form, Razorpay Checkout, reconciliation, and confirmation polling.
- Modify `scripts/public-site-assets/catalogue.js`, `scripts/sanitize-public-site.mjs`, and `scripts/public-site-assets/runtime.css`: wire generated pages without directly editing generated HTML.
- Modify `next.config.ts`: Razorpay CSP/frame/connect allowances.
- Extend sanitizer, smoke, unit, and Playwright coverage.

## Stable Cross-Repository Contracts

Use these names consistently throughout all tasks:

```ts
type QuoteRequest = {
  publicRoomSlug: string;
  checkin: string;
  checkout: string;
  guests: number;
};

type CreateBookingRequest = QuoteRequest & {
  guestName: string;
  guestEmail: string;
  guestPhone: string;
};

type PublicBookingStatus =
  | "processing"
  | "payment_pending"
  | "confirmed"
  | "payment_failed"
  | "expired"
  | "cancelled";

type InternalBookingStatus =
  | "processing"
  | "held"
  | "payment_pending"
  | "confirmed"
  | "payment_failed"
  | "expired"
  | "cancelled";

type RefundStatus = "not_required" | "pending" | "processed" | "failed";
```

Public status mapping is fixed: internal `processing` maps to public `processing`; internal `held` and `payment_pending` map to public `payment_pending`; all remaining terminal names map one-to-one. Public responses may expose `RefundStatus` but never an internal UUID or provider secret.

The complete public-room slug contract is:

```text
sage-sunlight-studio
ink-ivory-suite
shade-of-love
midnight-espresso-suite
luxe-urban-nest
emerald-suite
linen-lace-suite
silk-sage
```

The HMAC canonical string is exactly:

```text
UPPERCASE_METHOD\n
CANONICAL_PATH_AND_SORTED_QUERY\n
UNIX_TIMESTAMP_SECONDS\n
NONCE\n
LOWERCASE_SHA256_HEX_OF_RAW_BODY
```

The admin and website must share fixed test vectors for this string. Booking requests never contain `amount`, `price`, `currency`, `discount`, `tax`, or `fee` fields.

Every website-to-admin request uses these exact headers:

```text
X-Noir-Key-Id
X-Noir-Timestamp
X-Noir-Nonce
X-Noir-Signature
Idempotency-Key          # booking creation only
```

The first four headers are server-to-server only. `Idempotency-Key` is a UUID created once for an explicit guest submit; the website server preserves it across transport retries and never silently replaces an expired tombstoned key.

### Task 0: Preserve Baselines and Create Isolated Worktrees

**Files:**
- Public: all current static-conversion changes in `codex/noir-haus-ui-parity`
- Admin: no application files yet

- [ ] **Step 1: Verify the current public static-site baseline**

From the public worktree run:

```bash
npm run static:verify
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

Expected: strict asset audit reports zero missing files; sanitizer/smoke tests, unit tests, lint, typecheck, and production build all exit 0.

- [ ] **Step 2: Commit only the verified static-conversion baseline**

Review `git status --short` and `git diff --stat`, confirm every path belongs to the already-approved HTML-first conversion, then run:

```bash
git add -A
git commit -m "Preserve sanitized Noir Haus public site"
```

Expected: `git status --short` is empty in the public worktree.

- [ ] **Step 3: Create the isolated admin implementation worktree**

From `/Users/retyush/airbnb-operations-calendar` run:

```bash
git worktree add /Users/retyush/.config/superpowers/worktrees/airbnb-operations-calendar/public-booking -b feature/public-booking HEAD
```

Expected: the new worktree is on `feature/public-booking` and starts clean.

- [ ] **Step 4: Run the unchanged admin baseline**

From the new admin worktree run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Expected: all commands exit 0 before feature work starts.

### Task 1: Add the Booking and Inventory Migration

**Files:**
- Create: `supabase/migrations/0007_public_booking.sql`
- Create: `supabase/migrations/0007_public_booking.down.sql`
- Modify: `src/lib/db/migration.test.ts`

- [ ] **Step 1: Write the failing migration contract test**

Assert the up migration creates `property_rates`, `property_rate_overrides`, `bookings`, `booking_night_prices`, `inventory_nights`, `booking_attempts`, `api_request_nonces`, `payment_events`, `payment_jobs`, `notification_outbox`, and `booking_events`. Assert it contains this exact reclaimable-night invariant:

```ts
expect(up).toMatch(/create unique index inventory_nights_one_active_owner[\s\S]*\(property_id, stay_date\)[\s\S]*where status = 'active'/i);
expect(up).toMatch(/created_by drop not null/i);
expect(up).toMatch(/created_by is not null or booking_id is not null/i);
expect(down).toMatch(/drop index if exists public\.inventory_nights_one_active_owner/i);
```

Also assert all new tables enable RLS and revoke `anon` and `authenticated` direct access.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `npm test -- src/lib/db/migration.test.ts`

Expected: FAIL because migration `0007` does not exist.

- [ ] **Step 3: Add exact enums and tables**

Use PostgreSQL enums/checks matching the approved states. The essential inventory and idempotency definitions must be:

```sql
create table public.inventory_nights (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id),
  stay_date date not null,
  source_kind text not null check (source_kind in (
    'website_hold', 'website_booking', 'manual_local',
    'airbnb_reservation', 'airbnb_unavailable', 'airbnb_unknown'
  )),
  source_id uuid not null,
  booking_id uuid references public.bookings(id),
  local_entry_id uuid references public.local_calendar_entries(id),
  external_event_id uuid references public.external_calendar_events(id),
  status text not null default 'active' check (status in ('active', 'released')),
  expires_at timestamptz,
  release_reason text,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index inventory_nights_one_active_owner
  on public.inventory_nights (property_id, stay_date)
  where status = 'active';

create table public.booking_attempts (
  idempotency_key uuid primary key,
  request_hash text not null,
  booking_id uuid references public.bookings(id),
  status text not null check (status in ('processing','succeeded','definitive_failure','retryable_failure')),
  durable_step text not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  replay_until timestamptz,
  terminal_http_status integer,
  terminal_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`property_rates.public_room_slug`, booking public reference, Razorpay order/payment/refund IDs, provider event IDs, outbox deduplication keys, and payment-job idempotency identities must be unique. All paise fields are positive integers. Check-in/check-out ordering is enforced. Add `local_calendar_entries.booking_id` unique, drop `created_by` NOT NULL, and add `check (created_by is not null or booking_id is not null)`.

Add a source-target check requiring website sources to use `booking_id`, manual sources to use `local_entry_id`, and Airbnb sources to use `external_event_id`. Exactly one typed target must be present and it must equal `source_id`.

- [ ] **Step 4: Add RLS, indexes, and reversible down migration**

Property-scoped admin read policies use `app_user_can_access_property(property_id)`. Service-only tables have RLS enabled with no client policy. Revoke direct grants. The down migration deletes service-created local entries with null `created_by`, restores `created_by not null`, removes `booking_id`, then drops new objects in reverse dependency order.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npm test -- src/lib/db/migration.test.ts`

Expected: all migration tests PASS.

- [ ] **Step 6: Commit the schema task**

```bash
git add supabase/migrations/0007_public_booking.sql supabase/migrations/0007_public_booking.down.sql src/lib/db/migration.test.ts
git commit -m "Add public booking inventory schema"
```

### Task 2: Add a Real-Postgres Concurrency Test Harness

**Files:**
- Create: `docker-compose.test.yml`
- Create: `vitest.db.config.ts`
- Create: `src/test/auth-fixture.sql`
- Create: `src/test/db-global-setup.ts`
- Create: `src/test/db-test-client.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing database smoke test**

Create `src/test/database-smoke.db.test.ts` that inserts a property, inserts an active inventory night, releases it, and successfully inserts a replacement active row for the same property/date.

```ts
expect(await activeOwners(propertyId, "2026-08-14")).toBe(1);
```

- [ ] **Step 2: Add the isolated PostgreSQL service and test configuration**

Create:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: noirhaus_test
    ports:
      - "55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d noirhaus_test"]
      interval: 2s
      timeout: 2s
      retries: 20
```

Configure Vitest to include only `src/**/*.db.test.ts`, use one worker with file parallelism disabled, require `TEST_DATABASE_URL`, and run a global setup that recreates isolated `public`/`auth` schemas, creates a minimal `auth.users`/`auth.uid()` fixture, and applies migrations `0001` through `0007`. Export `resetDb()` from `db-test-client.ts`; every DB test calls it in `beforeEach` so test state never leaks.

Add:

```json
"test:db": "vitest run --config vitest.db.config.ts"
```

- [ ] **Step 3: Run against an isolated PostgreSQL database and verify GREEN**

Run:

```bash
docker compose -f docker-compose.test.yml up -d --wait
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
```

Expected: smoke test PASS. Never point `TEST_DATABASE_URL` at the production Supabase database.

- [ ] **Step 4: Commit the database harness**

```bash
git add package.json package-lock.json docker-compose.test.yml vitest.db.config.ts src/test/auth-fixture.sql src/test/db-global-setup.ts src/test/db-test-client.ts src/test/database-smoke.db.test.ts
git commit -m "Add booking database integration tests"
```

### Task 3: Implement Authoritative Pricing and the Pricing Admin Page

**Files:**
- Create: `src/features/pricing/pricing-schema.ts`
- Create: `src/features/pricing/pricing-schema.test.ts`
- Create: `src/features/pricing/quote.ts`
- Create: `src/features/pricing/quote.test.ts`
- Create: `src/features/pricing/pricing-service.ts`
- Create: `src/features/pricing/pricing-service.db.test.ts`
- Create: `src/features/pricing/pricing-manager.tsx`
- Create: `src/features/pricing/pricing-manager.test.tsx`
- Create: `src/app/(dashboard)/pricing/page.tsx`
- Create: `src/app/api/pricing/route.ts`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/app-shell.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing pure pricing tests**

Cover weekday, Friday, Saturday, Sunday, and override precedence in India stay dates:

```ts
expect(priceNight("2026-08-07", rates, new Map()).source).toBe("weekend"); // Friday
expect(priceNight("2026-08-08", rates, new Map()).source).toBe("weekend"); // Saturday
expect(priceNight("2026-08-09", rates, new Map()).source).toBe("weekday"); // Sunday
expect(priceNight("2026-08-08", rates, new Map([["2026-08-08", 123400]])).source).toBe("override");
```

Assert strict schemas reject zero/negative paise, duplicate/malformed slugs, over-capacity guests, and request fields named `amount`, `price`, `currency`, `discount`, `tax`, or `fee`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/features/pricing`

Expected: FAIL because pricing modules do not exist.

- [ ] **Step 3: Implement pure quote calculation**

Export `enumerateStayDates(checkin, checkout)` and:

```ts
export type NightQuote = { date: string; amountPaise: number; source: "override" | "weekend" | "weekday" };
export function buildQuote(dates: string[], rates: PropertyRates, overrides: Map<string, number>): {
  currency: "INR"; nights: NightQuote[]; totalPaise: number;
};
```

Use date-only parsing; never floating-point rupee math.

- [ ] **Step 4: Implement authorized persistence and audit**

`getQuoteForSlug`, `listPricingForUser`, `saveBaseRates`, `saveDateOverride`, and `clearDateOverride` must resolve property membership server-side and write `audit_log` without copying full guest or secret data.

The database test must configure the eight fixed public slugs from the Stable Cross-Repository Contracts, prove each resolves to exactly one active property/rate row with a positive guest limit and both positive base prices, and prove an unmapped, disabled, or incomplete row cannot be quoted.

- [ ] **Step 5: Write and run failing UI tests**

Assert one property per row, weekday/weekend fields, effective date cells, override create/edit/clear requests, pending-button guards, mobile horizontal scrolling, and no mutation in demo mode.

Run: `npm test -- src/features/pricing/pricing-manager.test.tsx src/components/app-shell.test.tsx`

Expected: FAIL until page, navigation, and manager exist.

- [ ] **Step 6: Build `/pricing` and authenticated API**

Follow the existing `PropertiesPage`/`PropertyManager` pattern. Add `Pricing` to desktop and mobile navigation. The API requires `requireUser()`, parses strict Zod input, and maps forbidden/not-found/validation failures to 403/404/400.

- [ ] **Step 7: Verify pricing GREEN**

Run:

```bash
npm test -- src/features/pricing src/components/app-shell.test.tsx
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
npm run typecheck
```

Expected: pure, component, database tests and typecheck PASS.

- [ ] **Step 8: Commit pricing**

```bash
git add src/features/pricing src/app/'(dashboard)'/pricing src/app/api/pricing src/components/app-shell.tsx src/components/app-shell.test.tsx src/app/globals.css
git commit -m "Add authoritative property pricing"
```

### Task 4: Build the Shared Inventory Transaction Service

**Files:**
- Create: `src/features/inventory/inventory-types.ts`
- Create: `src/features/inventory/date-range.ts`
- Create: `src/features/inventory/date-range.test.ts`
- Create: `src/features/inventory/inventory-service.ts`
- Create: `src/features/inventory/inventory-service.db.test.ts`
- Create: `src/features/inventory/inventory-mode.ts`
- Create: `src/features/inventory/inventory-mode.test.ts`

- [ ] **Step 1: Write failing date and concurrency tests**

Cover checkout-exclusive expansion, all-or-nothing multi-night claims, simultaneous claims for the same property/date, released-night reclamation, expired-hold cleanup, and separate properties claiming the same date.

The critical concurrent assertion is:

```ts
const results = await Promise.allSettled([
  claimStayNights(first),
  claimStayNights(second),
]);
expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
expect(await activeOwners(propertyId, "2026-08-14")).toBe(1);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- src/features/inventory/date-range.test.ts src/features/inventory/inventory-mode.test.ts
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
```

Expected: FAIL because inventory modules do not exist.

- [ ] **Step 3: Implement one transaction boundary**

Expose only focused functions:

```ts
withPropertyInventory(propertyId, callback)
claimStayNights(tx, claim)
releaseSourceNights(tx, sourceKind, sourceId, reason)
releaseExpiredHolds(tx, propertyId, now)
reconcilePropertyNights(tx, propertyId, startDate, endDate)
```

`withPropertyInventory` must begin a transaction and execute:

```sql
select pg_advisory_xact_lock(hashtextextended(${propertyId}, 0));
```

before cleanup, reads, or writes. Translate the partial-index violation to `INVENTORY_UNAVAILABLE`, but keep the index as the fallback rather than the primary flow.

- [ ] **Step 4: Implement explicit mode parsing**

`INVENTORY_LEDGER_MODE` accepts only `shadow` or `enforced`; production defaults to `shadow` when absent. Unit tests must prove invalid values fail startup rather than silently enabling enforcement.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the commands from Step 2 again.

Expected: all inventory tests PASS, including the real concurrent transaction test.

- [ ] **Step 6: Commit inventory core**

```bash
git add src/features/inventory
git commit -m "Add serialized nightly inventory ledger"
```

### Task 5: Refactor Manual Entries Behind Inventory

**Files:**
- Create: `src/features/calendar/entry-service.db.test.ts`
- Modify: `src/features/calendar/entry-service.ts`
- Modify: `src/app/api/local-entries/route.ts`
- Modify: `src/features/calendar/calendar-workspace.test.tsx`

- [ ] **Step 1: Write failing manual-entry regression/concurrency tests**

Cover create, date-changing update, archive, `allowOverlap`, operation overrides, audit writes, and concurrency against a website-style hold. Assert a manual archive releases its ledger rows and reconciliation promotes any still-active external source.

- [ ] **Step 2: Run existing and new tests to verify RED without regressions**

Run:

```bash
npm test -- src/features/calendar/local-entry-schema.test.ts src/features/calendar/calendar-workspace.test.tsx
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
```

Expected: existing tests remain GREEN; new DB tests fail because entry writes bypass inventory.

- [ ] **Step 3: Move overlap checking inside the property transaction**

Remove the pre-transaction `hasOverlap` decision. Inside `withPropertyInventory`, validate the listing, mutate the raw local entry, then reconcile the old and new date ranges. In `shadow` mode, retain current overlap behavior and log `inventory_shadow_mismatch`; in `enforced` mode, inventory conflict returns `OVERLAP`.

- [ ] **Step 4: Preserve existing API behavior**

The route must continue returning 409 `overlap`, 403 `forbidden`, 404 `not_found`, and 400 field errors. No public booking status is exposed through this authenticated route.

- [ ] **Step 5: Verify manual regression GREEN**

Run the commands from Step 2 plus `npm run typecheck`.

Expected: manual-entry UI/unit tests, real DB concurrency tests, and typecheck PASS.

- [ ] **Step 6: Commit manual inventory integration**

```bash
git add src/features/calendar/entry-service.ts src/features/calendar/entry-service.db.test.ts src/app/api/local-entries/route.ts src/features/calendar/calendar-workspace.test.tsx
git commit -m "Serialize manual entries through inventory"
```

### Task 6: Refactor iCal Reconciliation and Add Shadow Backfill

**Files:**
- Create: `src/features/inventory/backfill-service.ts`
- Create: `src/features/inventory/backfill-service.db.test.ts`
- Create: `src/features/inventory/shadow-service.ts`
- Create: `src/features/inventory/shadow-service.test.ts`
- Create: `scripts/backfill-booking-inventory.mjs`
- Modify: `src/features/sync/sync-service.ts`
- Modify: `src/features/sync/sync-service-contract.test.ts`
- Modify: `src/features/sync/reconcile.test.ts`

- [ ] **Step 1: Write failing backfill and sync tests**

Seed overlapping raw sources and assert deterministic backfill precedence: Airbnb reservation, manual local entry, then unavailable/unknown. Assert newly imported reservations report website collisions, unavailable/unknown displace only unpaid holds, and archiving a winning event promotes the next active raw source.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/features/sync src/features/inventory/shadow-service.test.ts
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
```

Expected: new tests FAIL; existing sync/parser/history tests remain GREEN.

- [ ] **Step 3: Reconcile each listing under the property lock**

Load the listing's `property_id`, compute affected old/new date bounds, and persist raw `external_calendar_events` plus inventory reconciliation in one property transaction. Keep the existing outer global sync lock and network-fetch concurrency; only database application is serialized per property.

- [ ] **Step 4: Implement backfill and shadow comparison**

`backfill-service.ts` must be idempotent. The script requires `DATABASE_URL`, refuses to run when `NODE_ENV=production` unless `CONFIRM_BOOKING_BACKFILL=yes`, prints counts only, and writes no guest data to stdout. `shadow-service.ts` compares current raw-source occupancy with ledger occupancy and writes redacted `inventory_shadow_mismatch` audit entries.

- [ ] **Step 5: Verify GREEN and existing iCal behavior**

Run:

```bash
npm test -- src/features/sync src/lib/ical src/features/calendar/external-history-query.test.ts
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
npm run typecheck
```

Expected: parser, history, sync, backfill, promotion, and collision-detection tests PASS.

- [ ] **Step 6: Commit iCal inventory integration**

```bash
git add src/features/sync src/features/inventory scripts/backfill-booking-inventory.mjs
git commit -m "Reconcile Airbnb events into inventory"
```

### Checkpoint A: Inventory Parity Gate

- [ ] Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:e2e`.
- [ ] Run `npm run test:db` against the isolated test database.
- [ ] Review manual-entry and iCal diffs specifically; public booking work must not begin until all existing tests and new concurrency tests pass.
- [ ] Do not apply migration `0007` to production yet.

### Task 7: Implement HMAC, Nonce, and Idempotency Infrastructure

**Files:**
- Create: `src/features/internal-api/hmac.ts`
- Create: `src/features/internal-api/hmac.test.ts`
- Create: `src/features/internal-api/test-vectors.ts`
- Create: `src/features/internal-api/request-auth.ts`
- Create: `src/features/internal-api/request-auth.db.test.ts`
- Create: `src/features/bookings/attempt-service.ts`
- Create: `src/features/bookings/attempt-service.db.test.ts`
- Modify: `src/lib/auth/public-paths.ts`
- Modify: `src/lib/auth/public-paths.test.ts`

- [ ] **Step 1: Write fixed-vector and tamper tests**

Use one hard-coded secret, raw JSON body, timestamp, nonce, path, and expected hex signature. Assert method/path/query/body changes fail. Assert timestamps outside plus-or-minus five minutes fail and comparisons do not use plain `===` on signatures.

- [ ] **Step 2: Write failing nonce/lease DB tests**

Cover atomic nonce replay rejection, ten-minute nonce cleanup, same-key/same-body terminal replay for 30 minutes, same-key/different-body 409, live 60-second lease 202 with `Retry-After`, stale atomic takeover, retryable progress resume, and permanent tombstone 409 after replay expiry.

- [ ] **Step 3: Verify RED**

Run:

```bash
npm test -- src/features/internal-api
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
```

- [ ] **Step 4: Implement canonical signing and request authentication**

Export `canonicalRequest`, `signInternalRequest`, and `verifyInternalSignature`. `authenticateInternalRequest(request)` must read the raw body once, verify key ID/timestamp/HMAC, atomically insert the nonce, enforce a per-key request cap, and only then return the raw body for strict Zod parsing.

- [ ] **Step 5: Implement atomic attempt acquisition**

Use a single `insert ... on conflict do nothing` for first acquisition and a conditional update for stale takeover:

```sql
update public.booking_attempts
set lease_token = ${newToken}, lease_expires_at = now() + interval '60 seconds', updated_at = now()
where idempotency_key = ${key}
  and status in ('processing', 'retryable_failure')
  and lease_expires_at <= now()
returning *;
```

Never rerun a side effect without reading `durable_step` and stored provider identifiers.

- [ ] **Step 6: Expose only signed public admin paths**

Add `/api/internal/v1/*` and `/api/webhooks/razorpay` to the admin proxy allowlist. Keep dashboard routes session-protected. Public-path tests must prove near-match paths remain private.

- [ ] **Step 7: Verify GREEN and commit**

Run focused unit/DB tests and typecheck, then:

```bash
git add src/features/internal-api src/features/bookings/attempt-service* src/lib/auth/public-paths*
git commit -m "Secure internal booking requests"
```

### Task 8: Implement Quotes, Holds, Booking Creation, and Razorpay Orders

**Files:**
- Create: `src/features/bookings/booking-schema.ts`
- Create: `src/features/bookings/booking-schema.test.ts`
- Create: `src/features/bookings/booking-service.ts`
- Create: `src/features/bookings/booking-service.db.test.ts`
- Create: `src/features/payments/razorpay-client.ts`
- Create: `src/features/payments/razorpay-client.test.ts`
- Create: `src/app/api/internal/v1/availability/route.ts`
- Create: `src/app/api/internal/v1/bookings/route.ts`
- Create: `src/app/api/internal/v1/bookings/[reference]/route.ts`

- [ ] **Step 1: Write strict API schema tests**

Assert valid slugs/dates/guest fields pass and every client-supplied price-like field fails because schemas use `.strict()`. Assert checkout is exclusive, past dates fail in India time, and guests above `max_guests` fail.

- [ ] **Step 2: Write failing booking DB tests**

Cover authoritative price recomputation, immutable `booking_night_prices`, ten-minute hold expiry, all nights claimed atomically, simultaneous booking attempts, idempotent replay, no Razorpay order when the hold fails, immediate release after a definitive order-creation failure, and retained/recoverable inventory after an ambiguous order timeout.

- [ ] **Step 3: Write failing Razorpay adapter tests with injected fetch**

Assert Basic auth, integer paise amount, `INR`, `partial_payment: false`, unique booking receipt, order lookup by receipt after ambiguous timeout, fetch-order payments, and redacted errors.

- [ ] **Step 4: Verify RED**

Run focused booking/payment tests and `npm run test:db`.

- [ ] **Step 5: Implement quote and hold transaction**

Expose:

```ts
quoteAvailability(input: QuoteRequest): Promise<QuoteResponse>
createBooking(input: CreateBookingRequest, idempotencyKey: string): Promise<CheckoutResponse>
getPublicBookingStatus(reference: string): Promise<{ status: PublicBookingStatus; refundStatus: RefundStatus }>
```

`createBooking` acquires the attempt, enters `withPropertyInventory`, recomputes the quote, writes booking/night snapshots, claims all nights with `expires_at = now() + interval '10 minutes'`, commits, then creates the provider order. Persist `durable_step` before and after every external side effect.

A definitive Razorpay order-creation rejection reacquires the property lock, marks the booking `payment_failed`, and releases its hold immediately. A timeout or unknown transport outcome remains retryable, retains the hold, and follows receipt recovery; it is never treated as definitive failure.

- [ ] **Step 6: Implement crash recovery by receipt**

On stale/retryable recovery, if durable state says hold exists but order ID is missing, query Razorpay `GET /v1/orders?receipt=...`. Attach the one matching order after amount/currency/receipt validation; create only when none exists.

- [ ] **Step 7: Implement signed routes and error mapping**

Return 200 quote, 201 checkout, 202 live lease, 400 validation, 401 signature, 409 unavailable/idempotency conflict/expired key, and 503 retryable dependency failure. Responses contain no internal UUIDs, guest PII, provider secrets, or stack traces.

- [ ] **Step 8: Verify GREEN and commit**

Run unit/DB tests, lint, typecheck, then:

```bash
git add src/features/bookings src/features/payments src/app/api/internal/v1
git commit -m "Create idempotent booking holds and orders"
```

### Task 9: Implement Webhooks, Payment Reconciliation, and Hold Expiry

**Files:**
- Create: `src/features/payments/razorpay-webhook.ts`
- Create: `src/features/payments/razorpay-webhook.test.ts`
- Create: `src/features/payments/payment-reconciliation.ts`
- Create: `src/features/payments/payment-reconciliation.db.test.ts`
- Create: `src/features/bookings/hold-expiry.ts`
- Create: `src/features/bookings/hold-expiry.db.test.ts`
- Create: `src/app/api/webhooks/razorpay/route.ts`
- Create: `src/app/api/internal/v1/bookings/[reference]/reconcile/route.ts`

- [ ] **Step 1: Write failing signature/event tests**

Verify the raw request body against `RAZORPAY_WEBHOOK_SECRET`, reject altered payloads, and deduplicate provider event IDs. Cover `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, late authorization, and out-of-order duplicates.

- [ ] **Step 2: Write failing hold-state tests**

Assert:

- captured/paid confirms and creates one linked direct reservation;
- authorized retains inventory and sets `payment_pending` without confirmation;
- definitive failed payment releases immediately;
- checkout dismissal reconciles provider state before release;
- network ambiguity retains the hold;
- expiry performs a final provider check;
- late captured payment after released expiry never reclaims occupied inventory and enqueues a refund job.

- [ ] **Step 3: Verify RED**

Run focused payment tests and `npm run test:db`.

- [ ] **Step 4: Implement idempotent reconciliation**

Every provider event first inserts `payment_events` under a unique event ID. Confirmation runs inside `withPropertyInventory`, converts hold rows to confirmed website-booking rows, and inserts one `local_calendar_entries` direct reservation linked by `booking_id` with `sync_to_airbnb = true`.

- [ ] **Step 5: Implement dismissal and expiry rules**

`reconcileBooking(reference, trigger)` fetches the stored order and its payments. Only confirmed no-attempt/failed state releases. Authorized state retains inventory while capture/status reconciliation continues. Captured/paid confirms. Unknown transport result is retryable and does not release.

- [ ] **Step 6: Verify GREEN and commit**

Run unit/DB tests and typecheck, then:

```bash
git add src/features/payments src/features/bookings/hold-expiry* src/app/api/webhooks src/app/api/internal/v1/bookings
git commit -m "Reconcile payments and expire safe holds"
```

### Task 10: Implement Airbnb-Wins Cancellation, Refunds, and Zoho Outbox

**Files:**
- Create: `src/features/bookings/cancellation-service.ts`
- Create: `src/features/bookings/cancellation-service.db.test.ts`
- Create: `src/features/payments/refund-service.ts`
- Create: `src/features/payments/refund-service.test.ts`
- Create: `src/features/email/zeptomail-client.ts`
- Create: `src/features/email/zeptomail-client.test.ts`
- Create: `src/features/email/templates.ts`
- Create: `src/features/email/templates.test.ts`
- Create: `src/features/email/outbox-service.ts`
- Create: `src/features/email/outbox-service.db.test.ts`
- Modify: `src/features/sync/sync-service.ts`

- [ ] **Step 1: Write the failing Airbnb-collision transaction test**

Seed a confirmed website booking and imported genuine `event_type = 'reservation'`. Assert one transaction produces:

```ts
expect(booking.status).toBe("cancelled");
expect(booking.cancellationReason).toBe("airbnb_collision");
expect(activeOwner.sourceKind).toBe("airbnb_reservation");
expect(localEntry.active).toBe(false);
expect(refundJob.action).toBe("refund_full_payment");
expect(alert.action).toBe("airbnb_collision");
```

Also cover an unpaid hold (no refund), unavailable/unknown overlapping a confirmed website booking (alert only), and collision retries (no duplicate refund or email).

- [ ] **Step 2: Write failing refund lifecycle tests**

Assert full-source refund requests are idempotently reconciled; pending sends “refund initiated,” `refund.processed` sends a separate confirmation, and `refund.failed` sets failed plus admin alert. Never call a pending refund confirmed.

- [ ] **Step 3: Write failing ZeptoMail/outbox tests**

Assert `Authorization: Zoho-enczapikey ...`, verified sender, HTML/text bodies, deduplication keys, exponential retry, provider message ID, and no tokens/PII in logs. Cover confirmation, admin new booking, no-refund collision cancellation, refund-initiated collision, refund-processed, late-payment refund, and refund-failure admin alert templates.

- [ ] **Step 4: Implement collision-only shared cancellation**

Export only:

```ts
cancelWebsiteBookingForAirbnbCollision(tx, bookingId, externalEventId)
```

No route or UI exposes it. It marks `cancelled`/`airbnb_collision`, releases website rows, archives the linked local entry, claims Airbnb rows, creates the refund job when needed, and writes `booking_events` plus `audit_log`.

- [ ] **Step 5: Implement refund and email jobs outside DB transactions**

Use leased `payment_jobs` and `notification_outbox` rows. Query provider state before repeating an ambiguous refund. Update booking refund status only from verified API/webhook state. Do not hold a database transaction open during Razorpay or Zoho calls.

- [ ] **Step 6: Wire genuine sync collisions**

Only the parser's `reservation` event type calls the cancellation service. Preserve unavailable/unknown alert-only behavior for confirmed website bookings.

- [ ] **Step 7: Verify GREEN and commit**

Run booking/sync/payment/email unit and DB tests, then:

```bash
git add src/features/bookings src/features/payments src/features/email src/features/sync/sync-service.ts
git commit -m "Cancel and refund Airbnb booking collisions"
```

### Task 11: Add Admin Bookings and Master Schedule States

**Files:**
- Create: `src/features/bookings/admin-booking-service.ts`
- Create: `src/features/bookings/booking-list.tsx`
- Create: `src/features/bookings/booking-list.test.tsx`
- Create: `src/app/(dashboard)/bookings/page.tsx`
- Create: `src/app/api/bookings/route.ts`
- Modify: `src/features/calendar/calendar-types.ts`
- Modify: `src/features/calendar/calendar-service.ts`
- Modify: `src/features/calendar/calendar-workspace.tsx`
- Modify: `src/features/calendar/calendar-workspace.test.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/app-shell.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing authorized booking-list tests**

Assert property membership filters rows; search matches public reference, guest name, or email; detail shows immutable nights, total, payment/refund IDs, outbox state, and booking events; no cancellation action is rendered.

- [ ] **Step 2: Write failing calendar-state tests**

Assert active holds render amber **Payment in progress** with expiry, confirmed website bookings render as direct reservations, collision/refund failures render alerts, and released/expired rows are absent from occupancy.

- [ ] **Step 3: Verify RED**

Run component/calendar tests.

- [ ] **Step 4: Implement `/bookings` and authenticated reads**

Follow existing server-page authorization. Return private booking data only to property members, with `cache-control: private, no-store` on API responses.

- [ ] **Step 5: Extend calendar data without exposing PII**

Calendar summaries may expose public reference and operational state to the authenticated UI but must not place guest contact data in workspace-version payloads, audit summaries, or outbound iCal.

- [ ] **Step 6: Verify GREEN and commit**

Run component tests, full calendar tests, lint/typecheck, then commit all listed files with:

```bash
git add src/features/bookings/admin-booking-service.ts src/features/bookings/booking-list.tsx src/features/bookings/booking-list.test.tsx src/app/'(dashboard)'/bookings src/app/api/bookings src/features/calendar src/components/app-shell.tsx src/components/app-shell.test.tsx src/app/globals.css
git commit -m "Add booking operations interfaces"
```

### Task 12: Add Durable Job Cron, Health, Configuration, and Monitoring Hooks

**Files:**
- Create: `src/features/bookings/job-runner.ts`
- Create: `src/features/bookings/job-runner.test.ts`
- Create: `src/app/api/bookings/cron/route.ts`
- Create: `ops/trigger-booking-jobs.sh`
- Modify: `ops/crontab.example`
- Modify: `src/app/api/health/route.ts`
- Modify: `src/lib/auth/public-paths.ts`
- Modify: `src/lib/auth/public-paths.test.ts`
- Modify: `.env.example`
- Modify: `DEPLOYMENT.md`

- [ ] **Step 1: Write failing job-runner tests**

Use a fixed clock and assert each run processes bounded batches of expired holds, payment reconciliation jobs, refund jobs, outbox messages, nonce cleanup, and stale processing leases. Assert one failing job does not abort unrelated jobs.

- [ ] **Step 2: Implement protected one-minute job route**

Use a dedicated `BOOKING_CRON_SECRET`, constant-time comparison, bounded execution, and structured count-only output. Add it to the public-path allowlist only because the route verifies its own secret.

- [ ] **Step 3: Implement readiness without leaking configuration**

`/api/health` returns only coarse `status`, timezone, database readiness, and booking-worker freshness. It never identifies missing secret values by name in production.

- [ ] **Step 4: Document exact environment and cron values**

Admin `.env.example` adds HMAC current/previous key IDs and secrets, Razorpay Test Mode key/secret/webhook secret, ZeptoMail token/sender, admin email, `BOOKING_CRON_SECRET`, `INVENTORY_LEDGER_MODE=shadow`, and `PUBLIC_BOOKING_ENABLED=false`.

Add a one-minute crontab trigger separate from the 15-minute Airbnb sync.

- [ ] **Step 5: Verify and commit operations support**

Run job/security/public-path tests, shell syntax check `sh -n ops/trigger-booking-jobs.sh`, and typecheck. Then commit:

```bash
git add src/features/bookings/job-runner.ts src/features/bookings/job-runner.test.ts src/app/api/bookings/cron src/app/api/health/route.ts src/lib/auth/public-paths.ts src/lib/auth/public-paths.test.ts ops/trigger-booking-jobs.sh ops/crontab.example .env.example DEPLOYMENT.md
git commit -m "Operate booking reconciliation jobs"
```

### Checkpoint B: Backend Test Mode Gate

- [ ] Run all admin unit, database, lint, typecheck, build, and Playwright tests.
- [ ] Verify `PUBLIC_BOOKING_ENABLED=false` returns a controlled 503 from internal booking creation while pricing/admin pages remain usable.
- [ ] Verify webhook, refund, and email adapters with fake transport and Razorpay Test Mode fixtures.
- [ ] Public website work must not begin until this checkpoint is GREEN.

### Task 13: Build the Public Website's Thin Signed Proxy

**Files (public website repository):**
- Create: `src/features/booking-api/hmac.ts`
- Create: `src/features/booking-api/hmac.test.ts`
- Create: `src/features/booking-api/client.ts`
- Create: `src/features/booking-api/client.test.ts`
- Create: `src/features/booking-api/schemas.ts`
- Create: `src/app/api/booking/availability/route.ts`
- Create: `src/app/api/booking/create/route.ts`
- Create: `src/app/api/booking/status/[reference]/route.ts`
- Create: `src/app/api/booking/reconcile/[reference]/route.ts`
- Modify: `src/proxy.ts`
- Modify: `src/lib/auth/public-paths.ts`
- Modify: `src/lib/auth/public-paths.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Copy the approved fixed HMAC vectors into website tests**

The website signature test must produce the exact same expected hex as the admin test. Add request-schema tests proving price-like fields and unknown keys are rejected before proxying.

- [ ] **Step 2: Write failing proxy-client tests**

Inject `fetch` and assert timestamp, random nonce, body hash, signature, `Idempotency-Key`, timeout, no automatic retry with a new key, and exact mapping of 202/400/401/409/503 responses. Assert logs never include body, guest fields, or secret.

- [ ] **Step 3: Implement the server-only client**

Read only `ADMIN_BOOKING_API_URL`, `BOOKING_API_KEY_ID`, and `BOOKING_API_HMAC_SECRET`. The browser must never receive these values. Forward raw JSON using the canonical signature and preserve the same idempotency key on retry.

- [ ] **Step 4: Implement same-origin routes**

Parse strict input, cap body size, call the admin client, and return only the approved public responses with `cache-control: no-store`. Status/reconcile routes validate the non-sequential public reference before forwarding.

- [ ] **Step 5: Close the inherited admin surface**

Change the public deployment proxy to allow only `/`, `/book-now`, `/booking-confirmation`, eight room routes, static asset prefixes, health, and `/api/booking/*`. Return 404 for inherited admin/login/sync/iCal routes. Remove Supabase/database/sync values from the public `.env.example`; no production public deployment receives them.

- [ ] **Step 6: Verify GREEN and commit public proxy**

Run unit tests, public-path tests, lint, typecheck, and build, then commit with:

```bash
git add src/features/booking-api src/app/api/booking src/proxy.ts src/lib/auth/public-paths.ts src/lib/auth/public-paths.test.ts .env.example
git commit -m "Add secure public booking proxy"
```

### Task 14: Wire Sanitized Pages to Availability and Guest Booking

**Files (public website repository):**
- Create: `scripts/public-site-assets/booking.js`
- Create: `scripts/test-public-booking.mjs`
- Modify: `scripts/public-site-assets/catalogue.js`
- Modify: `scripts/public-site-assets/runtime.css`
- Modify: `scripts/sanitize-public-site.mjs`
- Modify: `scripts/test-public-sanitizer.mjs`
- Modify: `scripts/smoke-public-interactions.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing sanitizer assertions**

Assert regenerated Book Now HTML loads `booking.js`, all room links expose a parseable room slug, every room-page booking form has `data-room-booking`, and confirmation HTML contains a live status mount. Assert the eight-room rail remains one horizontal row with all localized images.

- [ ] **Step 2: Write failing browser-module smoke tests**

With JSDOM, fake `fetch` and a fake `window.Razorpay`. Cover:

- Book Now date submit dispatches one availability request;
- each card shows available/unavailable and authoritative total;
- unavailable rooms cannot open guest entry;
- room pages restore query dates and retain their own slug;
- guest submit generates one UUID and double-click reuses it;
- validation errors focus the first invalid field;
- a 202 response polls with the same attempt;
- a 409 expired idempotency key requires an explicit new submit.

- [ ] **Step 3: Verify RED**

Run: `npm run static:smoke`

Expected: FAIL because booking runtime/hooks do not exist.

- [ ] **Step 4: Extend the sanitizer, not generated HTML**

Add `transformRoomBookingForm` for `page.id.startsWith("room-")`, append a confirmation mount only for `booking-confirmation`, and load `booking.js` on Book Now, all room pages, and confirmation. Keep generated `public/noir-haus-site/**` entirely reproducible through `npm run static:build`.

- [ ] **Step 5: Implement availability and accessible guest UI**

`catalogue.js` remains responsible for date validation/link propagation and dispatches a `noir:availability-request` event. `booking.js` calls same-origin APIs, decorates existing cards without rearranging them, creates an accessible dialog for name/email/phone/guests, prevents duplicate submission, and displays hold expiry.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npm run static:verify
npm test
npm run lint
npm run typecheck
npm run build
```

Expected: strict static audit remains zero-missing, existing visual smoke tests and new booking smoke tests PASS.

Commit source scripts, tests, config, and regenerated output together with:

```bash
git add scripts/public-site-assets/booking.js scripts/public-site-assets/catalogue.js scripts/public-site-assets/runtime.css scripts/sanitize-public-site.mjs scripts/test-public-booking.mjs scripts/test-public-sanitizer.mjs scripts/smoke-public-interactions.mjs package.json public/noir-haus-site
git commit -m "Wire public pages to booking availability"
```

### Task 15: Integrate Razorpay Checkout and Confirmation Polling

**Files (public website repository):**
- Modify: `scripts/public-site-assets/booking.js`
- Modify: `scripts/public-site-assets/runtime.css`
- Modify: `scripts/test-public-booking.mjs`
- Modify: `next.config.ts`
- Create: `e2e/public-booking.spec.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write failing Checkout lifecycle tests**

Cover checkout options using only returned public key/order/amount/currency; successful handler calls reconcile; `ondismiss` calls reconcile; lost network shows pending rather than failed; definitive failure releases; confirmation page polls `processing`/`payment_pending` until terminal; cancelled collision displays the server message without claiming a confirmed refund while `refundStatus=pending`.

- [ ] **Step 2: Add least-privilege Razorpay CSP**

Allow the official Checkout script, Razorpay API/connect origins, and Razorpay frames required by Standard Checkout. Keep `default-src 'self'`, `object-src 'none'`, and `frame-ancestors 'none'`. Do not add wildcard script or `unsafe-eval` in production.

- [ ] **Step 3: Implement Checkout loading and state handling**

Load `https://checkout.razorpay.com/v1/checkout.js` once. Never pass a secret or client-computed price. Redirect to `/booking-confirmation/?reference=...` only after the booking reference is durable; the confirmation page remains server-status driven.

- [ ] **Step 4: Add Playwright UI tests with mocked same-origin APIs**

Intercept `/api/booking/*`; verify the real sanitized DOM preserves the header, eight-room rail, room galleries, guest dialog, Checkout invocation shim, pending state, confirmed state, and collision/refund wording across mobile/tablet/desktop.

- [ ] **Step 5: Verify GREEN and commit**

Run static verification, unit tests, `npm run test:e2e`, lint, typecheck, and build. Commit with:

```bash
git add scripts/public-site-assets/booking.js scripts/public-site-assets/runtime.css scripts/test-public-booking.mjs next.config.ts e2e/public-booking.spec.ts playwright.config.ts public/noir-haus-site
git commit -m "Complete Razorpay public booking experience"
```

### Task 16: Full Cross-System Verification and Deployment Runbook

**Files:**
- Admin Modify: `DEPLOYMENT.md`
- Admin Create: `docs/booking-test-mode-runbook.md`
- Public Modify: `README.md`
- Public Create: `docs/booking-test-mode-runbook.md`

- [ ] **Step 1: Run complete admin verification**

```bash
npm test
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test npm run test:db
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

Expected: all commands exit 0.

- [ ] **Step 2: Run complete public verification**

```bash
npm run static:verify
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

Expected: zero unresolved assets and all commands exit 0.

- [ ] **Step 3: Document staged environment setup**

The runbook gives exact Vercel environment variable names, HMAC rotation order, Razorpay Test Mode webhook events, Zoho verified sender setup, Vercel/WAF rate limits, external one-minute cron, health monitors, rollback order, and explicit confirmation that the public deployment has no Supabase/database/provider secrets.

- [ ] **Step 4: Commit the verified runbooks**

In the admin worktree:

```bash
git add DEPLOYMENT.md docs/booking-test-mode-runbook.md
git commit -m "Document booking Test Mode rollout"
```

In the public worktree:

```bash
git add README.md docs/booking-test-mode-runbook.md
git commit -m "Document public booking Test Mode rollout"
```

- [ ] **Step 5: Deploy admin production code with booking disabled**

After user authorization: back up Supabase, apply `0007`, deploy admin with `INVENTORY_LEDGER_MODE=shadow` and `PUBLIC_BOOKING_ENABLED=false`, run the idempotent backfill, and monitor shadow mismatch logs through at least one complete Airbnb sync cycle plus manual create/edit/archive smoke tests.

- [ ] **Step 6: Enforce inventory only after parity**

After zero unexplained mismatches and regression approval, set `INVENTORY_LEDGER_MODE=enforced`, redeploy admin, rerun manual/iCal smoke tests, and keep public booking disabled.

- [ ] **Step 7: Deploy isolated Preview environments for Test Mode acceptance**

After user authorization, deploy an admin Vercel Preview with `INVENTORY_LEDGER_MODE=enforced`, `PUBLIC_BOOKING_ENABLED=true`, dedicated Preview HMAC keys, Razorpay Test Mode credentials/webhook, and Zoho credentials. Deploy the public Vercel Preview pointing only to that admin Preview. Keep both Production deployments at `PUBLIC_BOOKING_ENABLED=false`; do not point the public Preview at the production admin origin.

Before testing, use the authenticated Pricing page to map all eight fixed room slugs to their intended properties and enter an owner-approved guest limit plus weekday and Friday/Saturday prices. Do not invent launch prices; every row must pass the completeness query before it is enabled.

Run:

1. public search and authoritative quote;
2. ten-minute amber hold in admin;
3. Test Mode payment and confirmed booking;
4. linked direct reservation and outbound iCal busy event;
5. guest/admin Zoho delivery;
6. modal dismissal/no-attempt release;
7. network ambiguity retained until reconciliation;
8. expired hold release and night reclamation;
9. genuine Airbnb-reservation collision, website cancellation, full refund lifecycle, correct two-stage email, and admin alert;
10. webhook/job/email retries without duplicate side effects.

- [ ] **Step 8: Stop before Production public enablement**

Present Preview verification evidence to the user. Do not set Production `PUBLIC_BOOKING_ENABLED=true`, change the Production public site to an enabled admin origin, or switch Razorpay to Live Mode until the user separately approves those production state changes.

- [ ] **Step 9: Final diff and branch readiness**

In both repositories run `git diff --check`, `git status --short`, and show the commit list. Use superpowers:requesting-code-review before merge and superpowers:finishing-a-development-branch after all checks pass.

- [ ] **Step 10: Tear down the isolated test database**

From the admin worktree run:

```bash
docker compose -f docker-compose.test.yml down -v
```

Expected: the local `noirhaus_test` container and volume are removed; no production resource is touched.
