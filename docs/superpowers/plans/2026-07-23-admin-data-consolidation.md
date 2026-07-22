# Admin Data Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe removal of test bookings and a dry-run-first tool that replaces new operational data with old admin data while preserving bookings and pricing.

**Architecture:** Keep test cleanup inside the existing inventory transaction boundary. Implement database consolidation as a one-use Node CLI with a pure planner, explicit dependency-ordered export/import, iCal re-encryption, encrypted snapshots and an `--apply` gate.

**Tech Stack:** Next.js 16, TypeScript, PostgreSQL via `postgres`, Vitest, Supabase schema, AES-GCM secret helpers.

---

### Task 1: Test-only booking cleanup service

**Files:**
- Create: `src/features/bookings/admin-test-cleanup-service.ts`
- Create: `src/features/bookings/admin-test-cleanup-service.db.test.ts`

- [ ] **Step 1: Write failing database tests**

Cover a confirmed `rzp_test_` booking: archive/cancel it, release website inventory, archive its generated local entry, add booking/audit events and create no refund job. Cover rejection for `rzp_live_`, missing authorization and mismatched reference.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/features/bookings/admin-test-cleanup-service.db.test.ts`

Expected: failure because the service does not exist.

- [ ] **Step 3: Implement minimal transactional service**

Use `createInventoryService(sql).withPropertyInventory(...)`; require `razorpay_key_id like 'rzp_test_%'`; set `status='cancelled'`, `cancellation_reason='admin_test_cleanup'`, `refund_status='not_required'`, `archived_at`, `archived_by` and `cancelled_at`; release both website source kinds; archive linked local entries; write `admin_test_booking_removed` events; reconcile affected nights.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/features/bookings/admin-test-cleanup-service.db.test.ts`

Expected: all cleanup tests pass.

- [ ] **Step 5: Commit**

Run: `git add src/features/bookings/admin-test-cleanup-service* && git commit -m "Remove test bookings without refunds"`

### Task 2: Admin API and booking-page action

**Files:**
- Create: `src/app/api/bookings/[bookingId]/remove-test/route.ts`
- Create: `src/app/api/bookings/[bookingId]/remove-test/route.test.ts`
- Create: `src/features/bookings/booking-test-remove-action.tsx`
- Create: `src/features/bookings/booking-test-remove-action.test.tsx`
- Modify: `src/features/bookings/booking-list.tsx`
- Modify: `src/features/bookings/booking-list.test.tsx`

- [ ] **Step 1: Write failing route and UI tests**

Require auth and a typed booking reference body. Assert the button appears only for active test-key bookings, requires exact reference confirmation, and posts to `/remove-test` rather than `/refund`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- 'src/app/api/bookings/[bookingId]/remove-test/route.test.ts' src/features/bookings/booking-test-remove-action.test.tsx src/features/bookings/booking-list.test.tsx`

Expected: failures because the route/action do not exist.

- [ ] **Step 3: Implement route and action**

Map service errors to 404/409/500. Label the action `Remove test booking & unblock dates`; explain that no Razorpay refund is created; reload on success.

- [ ] **Step 4: Verify GREEN**

Run the same targeted test command and expect all tests to pass.

- [ ] **Step 5: Commit**

Run: `git add src/app/api/bookings src/features/bookings && git commit -m "Add admin test booking cleanup action"`

### Task 3: Pure consolidation planner

**Files:**
- Create: `scripts/admin-data-consolidation/planner.mjs`
- Create: `scripts/admin-data-consolidation/planner.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing planner tests**

Provide fixtures with matching property/listing names, preserved bookings/pricing, unmatched booking properties and overlapping inventory. Assert deterministic property/listing maps, no duplicate listing identities, archived fallback booking properties and a hard overlap error.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/admin-data-consolidation/planner.test.mjs`

Expected: failure because the planner does not exist.

- [ ] **Step 3: Implement the pure planner**

Normalize Unicode names and whitespace, match properties by name, match listings by display name then decrypted URL, build source-to-destination ID maps, preserve destination booking dependencies and pricing, and return ordered deletes/inserts plus count expectations.

- [ ] **Step 4: Verify GREEN**

Run: `node --test scripts/admin-data-consolidation/planner.test.mjs`

Expected: all planner tests pass.

- [ ] **Step 5: Commit**

Run: `git add scripts/admin-data-consolidation package.json && git commit -m "Plan deterministic admin data consolidation"`

### Task 4: Dry-run-first migration CLI

**Files:**
- Create: `scripts/consolidate-admin-data.mjs`
- Create: `scripts/admin-data-consolidation/snapshot.mjs`
- Create: `scripts/admin-data-consolidation/snapshot.test.mjs`
- Create: `.env.migration.example`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Write failing snapshot and CLI-contract tests**

Test AES-256-GCM snapshot round-trip, wrong-passphrase failure, required distinct database fingerprints, required keys, default dry run and exact `--apply` confirmation phrase.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/admin-data-consolidation/*.test.mjs`

Expected: failures because snapshot/CLI helpers are absent.

- [ ] **Step 3: Implement export, validation and encrypted backup**

Read `OLD_DATABASE_URL`, `NEW_DATABASE_URL`, `OLD_ICAL_ENCRYPTION_KEY`, `NEW_ICAL_ENCRYPTION_KEY` and `MIGRATION_BACKUP_PASSPHRASE` from an ignored local file. Export explicit source/destination tables, decrypt/re-encrypt iCal URLs, validate schema/fingerprints and write encrypted snapshots with mode `0600`.

- [ ] **Step 4: Implement transaction apply**

In one destination transaction, lock affected tables, preserve booking/payment/pricing subgraphs, delete replaceable operational rows in dependency order, insert/remap old records, rebuild inventory, reset identity sequences and run postconditions. Roll back on any mismatch.

- [ ] **Step 5: Verify GREEN**

Run: `node --test scripts/admin-data-consolidation/*.test.mjs && npm test`

Expected: all unit tests pass; CLI without credentials exits before any connection/write.

- [ ] **Step 6: Commit**

Run: `git add scripts package.json .gitignore .env.migration.example && git commit -m "Add dry-run admin data consolidation tool"`

### Task 5: Verify, merge and deploy admin code

**Files:**
- Verify only

- [ ] **Step 1: Full verification**

Run: `npm run lint && npm run typecheck && npm test && npm run build`

Expected: zero failures.

- [ ] **Step 2: Merge and push**

Merge into `deploy-noirhaus-main`, push `noirhaus/main`, and confirm the old project’s expected failed auto-build does not alter its source database.

- [ ] **Step 3: Deploy canonical admin production**

Deploy `noirhausadmin-booking-preview` to production and confirm migrations/cron and Ready status.

### Task 6: Run live consolidation

**Files:**
- Local ignored credential file only

- [ ] **Step 1: Obtain local credentials**

Populate `.env.migration.local` with both Supabase database URLs, both iCal encryption keys and a backup passphrase. Never print or commit values.

- [ ] **Step 2: Dry run**

Run: `npm run data:consolidate -- --env .env.migration.local`

Expected: source/destination fingerprints differ; count and mapping report contains no unresolved duplicate or inventory overlap.

- [ ] **Step 3: Apply only after dry-run acceptance**

Run: `npm run data:consolidate -- --env .env.migration.local --apply "REPLACE NEW OPERATIONS WITH OLD ADMIN DATA"`

Expected: one committed destination transaction and unchanged source counts.

- [ ] **Step 4: Verify live services**

Check properties, pricing, calendar blocks, iCal sync, bookings, test-removal action, inventory uniqueness and health endpoint. Retain encrypted snapshots until acceptance.
