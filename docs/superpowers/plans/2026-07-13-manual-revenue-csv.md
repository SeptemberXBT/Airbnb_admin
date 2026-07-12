# Manual Revenue CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture guest/payment data on manual calendar entries and export exact per-night revenue in a private date-by-property CSV.

**Architecture:** Supabase stores total payment as nullable `numeric(12,2)` while the existing private booking name becomes the guest name. Pure export functions operate in integer paise, and a protected server endpoint supplies a downloadable CSV. Calendar UI adds the fields and a responsive export dialog.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, PostgreSQL/Supabase, Zod, date-fns, Vitest, Testing Library, Playwright.

---

### Task 1: Payment Migration and Input Contract

**Files:**
- Create: `supabase/migrations/0005_manual_entry_payment.sql`
- Create: `supabase/migrations/0005_manual_entry_payment.down.sql`
- Modify: `src/lib/db/migration.test.ts`
- Modify: `src/features/calendar/local-entry-schema.ts`
- Modify: `src/features/calendar/local-entry-schema.test.ts`

- [ ] **Step 1: Write failing migration and schema tests**

Assert migration `0005` adds nullable `payment_amount numeric(12,2)` with a nonnegative check and the down migration drops it. Add schema expectations that `paymentAmount: 12500.50` and null are accepted, while negative and values above `9_999_999_999.99` are rejected.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/lib/db/migration.test.ts src/features/calendar/local-entry-schema.test.ts`

Expected: FAIL because migration `0005` and `paymentAmount` do not exist.

- [ ] **Step 3: Add migration files**

```sql
alter table public.local_calendar_entries
  add column payment_amount numeric(12,2)
  check (payment_amount >= 0);
```

The down migration drops `payment_amount`. Do not modify guest-name storage because `private_booking_name` already exists.

- [ ] **Step 4: Extend input validation**

Add `paymentAmount: z.number().finite().min(0).max(9_999_999_999.99).optional().nullable()` to `localEntrySchema`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --run src/lib/db/migration.test.ts src/features/calendar/local-entry-schema.test.ts`

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0005_manual_entry_payment.sql supabase/migrations/0005_manual_entry_payment.down.sql src/lib/db/migration.test.ts src/features/calendar/local-entry-schema.ts src/features/calendar/local-entry-schema.test.ts
git commit -m "Add manual entry payment storage"
```

### Task 2: Payment Persistence and Calendar Data

**Files:**
- Modify: `src/features/calendar/entry-service.ts`
- Modify: `src/features/calendar/calendar-service.ts`
- Modify: `src/features/calendar/calendar-types.ts`
- Modify: `src/features/calendar/demo-calendar.ts`
- Modify: `src/features/calendar/calendar-window.test.ts`

- [ ] **Step 1: Add payment to calendar type fixtures and verify RED**

Add `paymentAmount: string | null` to test entries and expect version serialization to change when payment changes. Run typecheck before production edits.

Run: `npm run typecheck`

Expected: FAIL because `CalendarEntry` and producers do not yet expose payment.

- [ ] **Step 2: Persist payment in create and update**

Add `payment_amount` to local entry INSERT/UPDATE and pass `input.paymentAmount ?? null`. Include only a boolean `paymentRecorded` in audit details; do not duplicate the private amount in audit JSON.

- [ ] **Step 3: Read exact numeric values**

Select `e.payment_amount::text` in `calendar-service.ts` and expose it as `paymentAmount`. Set Airbnb and demo entries to null except a dedicated synthetic direct fixture if needed for UI tests.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- --run src/features/calendar/calendar-window.test.ts src/features/calendar/local-entry-schema.test.ts && npm run typecheck`

Expected: tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/calendar/entry-service.ts src/features/calendar/calendar-service.ts src/features/calendar/calendar-types.ts src/features/calendar/demo-calendar.ts src/features/calendar/calendar-window.test.ts
git commit -m "Persist manual guest payments"
```

### Task 3: Exact CSV Builder

**Files:**
- Create: `src/features/calendar/manual-booking-export.ts`
- Create: `src/features/calendar/manual-booking-export.test.ts`

- [ ] **Step 1: Write failing export tests**

Create fixtures for two properties and manual entries. Assert:

```ts
expect(splitPaymentAcrossNights("1000.00", "2026-07-13", "2026-07-16")).toEqual([
  ["2026-07-13", 33334],
  ["2026-07-14", 33333],
  ["2026-07-15", 33333],
]);
```

Also assert checkout day is excluded, a partial export keeps the original full-stay allocation, empty dates remain rows, overlaps join with ` | `, commas/quotes escape correctly, and values beginning `=`, `+`, `-`, or `@` receive a leading apostrophe.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/features/calendar/manual-booking-export.test.ts`

Expected: FAIL because the export module does not exist.

- [ ] **Step 3: Implement integer-paise allocation**

Parse numeric strings without floating arithmetic, enumerate checkout-exclusive nights, divide paise by night count, and allocate remainder to earliest nights. Expose `splitPaymentAcrossNights`, `formatInr`, and `buildManualBookingsCsv`.

- [ ] **Step 4: Implement safe CSV serialization**

Build `Date` plus sorted property columns. Escape every field with doubled quotes where needed. Protect spreadsheet-formula prefixes before CSV escaping. Format populated values according to the approved guest/payment rules.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test -- --run src/features/calendar/manual-booking-export.test.ts`

Expected: all allocation and serialization tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/calendar/manual-booking-export.ts src/features/calendar/manual-booking-export.test.ts
git commit -m "Build exact manual revenue CSV"
```

### Task 4: Protected Export API

**Files:**
- Create: `src/features/calendar/export-range-schema.ts`
- Create: `src/features/calendar/export-range-schema.test.ts`
- Create: `src/features/calendar/manual-booking-export-service.ts`
- Create: `src/app/api/manual-bookings-export/route.ts`

- [ ] **Step 1: Write failing range-validation tests**

Assert inclusive one-day and 366-day ranges pass, reversed and 367-day ranges fail, and malformed dates fail.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run src/features/calendar/export-range-schema.test.ts`

Expected: FAIL because the schema does not exist.

- [ ] **Step 3: Implement export range schema**

Parse `start` and `end` ISO dates, require `end >= start`, and require inclusive day count at most 366.

- [ ] **Step 4: Implement authorized export query**

Query active properties joined to `property_members` for `userId`. Query active `blocked` and `direct_reservation` entries that overlap `[start, end + 1 day)`, select exact payment text, and pass results to `buildManualBookingsCsv`.

- [ ] **Step 5: Implement CSV route**

Require the user, validate query parameters, and return CSV with:

```ts
headers: {
  "content-type": "text/csv; charset=utf-8",
  "content-disposition": `attachment; filename="noir-haus-manual-bookings-${start}-to-${end}.csv"`,
  "cache-control": "private, no-store",
}
```

Return 400 for invalid ranges and the existing generic 500 body for other failures.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- --run src/features/calendar/export-range-schema.test.ts src/features/calendar/manual-booking-export.test.ts && npm run typecheck`

Expected: tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/calendar/export-range-schema.ts src/features/calendar/export-range-schema.test.ts src/features/calendar/manual-booking-export-service.ts src/app/api/manual-bookings-export/route.ts
git commit -m "Add private manual booking CSV endpoint"
```

### Task 5: Manual Entry and Export UI

**Files:**
- Modify: `src/features/calendar/calendar-workspace.tsx`
- Modify: `src/features/calendar/calendar-workspace.test.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/responsive.spec.ts`

- [ ] **Step 1: Write failing entry-field tests**

Open a new manual entry, fill `Guest name` and `Total payment (INR)`, save, and assert the local-entry request contains `privateBookingName` and numeric `paymentAmount`. Edit an existing local entry and assert defaults are populated.

- [ ] **Step 2: Write failing export-dialog tests**

Assert Export CSV opens an accessible dialog with inclusive start/end inputs, repeated submission is disabled while pending, a successful blob creates a download named for the selected dates, and a failed response leaves the dialog open with an error.

- [ ] **Step 3: Run component tests and verify RED**

Run: `npm test -- --run src/features/calendar/calendar-workspace.test.tsx`

Expected: FAIL because the fields and export dialog do not exist.

- [ ] **Step 4: Add guest/payment fields**

Rename the label to `Guest name`. Add number input `paymentAmount` with `min="0"`, `max="9999999999.99"`, `step="0.01"`, and `inputMode="decimal"`. Send null for blank values and a number otherwise. Render only for local manual entries.

- [ ] **Step 5: Add responsive export dialog**

Add a Download icon button with text `Export CSV` in the calendar controls. Default start to `visibleDate` and end to the last visible inclusive date. Fetch the protected endpoint, download the returned blob through a temporary object URL, revoke it, and show pending/error states. Use the established bottom-sheet dialog rules on mobile.

- [ ] **Step 6: Add responsive browser checks**

In Playwright, assert Export CSV opens on desktop and mobile, date controls and download button have at least 44px touch height, and no horizontal page overflow occurs. Save the open mobile dialog as `artifacts/screenshots/calendar-mobile-export-dialog.png` for final inspection.

- [ ] **Step 7: Run component and browser-focused tests**

Run: `npm test -- --run src/features/calendar/calendar-workspace.test.tsx`

Expected: component tests pass. The full Playwright run occurs in Task 7.

- [ ] **Step 8: Commit**

```bash
git add src/features/calendar/calendar-workspace.tsx src/features/calendar/calendar-workspace.test.tsx src/app/globals.css e2e/responsive.spec.ts
git commit -m "Add manual payment and CSV controls"
```

### Task 6: Deployment Documentation

**Files:**
- Modify: `DEPLOYMENT.md`

- [ ] **Step 1: Document migration ordering and smoke test**

Add migration `0005_manual_entry_payment.sql` after `0004`, state it must run before application deployment, and add a two-night INR 1,000 export smoke test expecting INR 500.00 on each occupied date.

- [ ] **Step 2: Verify documentation diff and commit**

Run: `git diff --check`

Expected: no whitespace errors.

```bash
git add DEPLOYMENT.md
git commit -m "Document manual revenue rollout"
```

### Task 7: Full Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run all automated code checks**

Run: `npm test && npm run lint && npm run typecheck && npm run build`

Expected: every command succeeds without warnings.

- [ ] **Step 2: Run responsive Playwright suite**

Run: `env DEMO_MODE=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 PLAYWRIGHT_WEB_SERVER_COMMAND='npm run dev -- --hostname 127.0.0.1 --port 3100' npm run test:e2e`

Expected: all desktop, tablet, and mobile projects pass.

- [ ] **Step 3: Inspect generated screenshots**

Inspect Calendar desktop, Calendar mobile export dialog, Today desktop, and Today mobile screenshots for overflow, fixed-navigation obstruction, and readable controls.

- [ ] **Step 4: Confirm repository hygiene**

Run: `git diff --check && git status --short`

Expected: clean worktree after restoring only generated verification artifacts.

- [ ] **Step 5: Prepare rollout handoff**

Do not push application code until the user has run `0005_manual_entry_payment.sql` in Supabase. Once confirmed, merge to `deploy-noirhaus-main`, rerun `npm test`, push `noirhaus/main`, and verify the Vercel production commit.
